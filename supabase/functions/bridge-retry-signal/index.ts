import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type, x-fn-secret"};

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response(null,{headers:corsHeaders});
  const expected=Deno.env.get("INTERNAL_FN_SECRET")??"";
  if(!expected || req.headers.get("x-fn-secret")!==expected)
    return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:{...corsHeaders,"Content-Type":"application/json"}});
  try{
    const {signal_id}=await req.json();
    if(!signal_id) throw new Error("signal_id required");
    const sb=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const {data:sig,error:readError}=await sb.from("signals")
      .select("id,pair,status,created_at,executed_at,metaapi_execution_status")
      .eq("id",signal_id).maybeSingle();
    if(readError) throw readError;
    if(!sig) return new Response(JSON.stringify({ok:false,reason:"Signal not found"}),{status:404,headers:{...corsHeaders,"Content-Type":"application/json"}});
    const ageMs=Date.now()-new Date(sig.created_at).getTime();
    if(ageMs>=6*60*60*1000) return new Response(JSON.stringify({ok:false,reason:"Signal is older than 6 hours and has expired"}),{status:409,headers:{...corsHeaders,"Content-Type":"application/json"}});
    if(sig.executed_at || sig.status==="executed") return new Response(JSON.stringify({ok:false,reason:"Signal is already executed"}),{status:409,headers:{...corsHeaders,"Content-Type":"application/json"}});
    const {data:cfg}=await sb.from("app_settings").select("pair_auto_execute").eq("id","singleton").maybeSingle();
    const pairs=(cfg?.pair_auto_execute??{}) as Record<string,boolean>;
    if(pairs[String(sig.pair)]!==true) return new Response(JSON.stringify({ok:false,reason:`${sig.pair} bridge execution is disabled in Settings`}),{status:409,headers:{...corsHeaders,"Content-Type":"application/json"}});
    const {data:updated,error}=await sb.from("signals").update({
      status:"pending", outcome_r:null, closed_at:null,
      metaapi_execution_status:"none", metaapi_execution_channel:null,
      metaapi_execution_error:null, bridge_claimed_at:null
    }).eq("id",signal_id).select("id,pair,status,metaapi_execution_status,bridge_claimed_at").single();
    if(error) throw error;
    return new Response(JSON.stringify({ok:true,signal:updated}),{headers:{...corsHeaders,"Content-Type":"application/json"}});
  }catch(e){
    console.error("bridge-retry-signal error",e);
    return new Response(JSON.stringify({ok:false,error:e instanceof Error?e.message:"Bridge retry failed"}),{status:400,headers:{...corsHeaders,"Content-Type":"application/json"}});
  }
});