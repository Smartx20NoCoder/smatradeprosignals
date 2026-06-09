// MetaApi connection health check.
// Reads provisioning API for connectionStatus + state. If state=DEPLOYED but
// connectionStatus=DISCONNECTED, calls redeploy to force a reconnect.
// Returns { status: "connected" | "reconnecting" | "error", ... }.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkInternalAuth, corsHeaders, safeError } from "../_shared/auth.ts";

const PROVISIONING_BASE = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";

type HealthStatus = "connected" | "reconnecting" | "error";

async function runHealthCheck(opts: { force?: boolean } = {}): Promise<{
  status: HealthStatus;
  state?: string;
  connectionStatus?: string;
  redeployed?: boolean;
  reason?: string;
}> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: cfg } = await supabase
    .from("app_settings").select("*").eq("id", "singleton").maybeSingle();
  const c: any = cfg ?? {};
  const isLive = ((c?.metaapi_active_mode as string | null) ?? "demo") === "live";
  const accountId = isLive
    ? ((c?.metaapi_account_id_live as string | null) ?? (c?.metaapi_account_id as string | null))
    : (c?.metaapi_account_id as string | null);
  const token = isLive
    ? ((c?.metaapi_token_live as string | null) || (c?.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null)
    : ((c?.metaapi_token as string | null) || Deno.env.get("METAAPI_TOKEN") || null);

  if (!accountId) return { status: "error", reason: "broker account not configured" };
  if (!token) return { status: "error", reason: "broker token not configured" };

  const url = `${PROVISIONING_BASE}/users/current/accounts/${accountId}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "auth-token": token } });
  } catch (e) {
    console.error("provisioning fetch failed", e);
    return { status: "error", reason: "provisioning fetch failed" };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("provisioning non-ok", res.status, t.slice(0, 200));
    return { status: "error", reason: `provisioning ${res.status}` };
  }
  const data: any = await res.json().catch(() => ({}));
  const state = String(data?.state ?? "unknown");
  const connectionStatus = String(data?.connectionStatus ?? "unknown");

  const needsRedeploy = state.toUpperCase() === "DEPLOYED" && connectionStatus.toUpperCase() === "DISCONNECTED";
  if (needsRedeploy || opts.force) {
    const redeployUrl = `${PROVISIONING_BASE}/users/current/accounts/${accountId}/redeploy`;
    try {
      const r = await fetch(redeployUrl, {
        method: "POST",
        headers: { "auth-token": token, "Content-Type": "application/json" },
      });
      const txt = await r.text().catch(() => "");
      console.log(`metaapi-health-check redeploy -> ${r.status} ${txt.slice(0, 120)}`);
      if (!r.ok && r.status !== 204) {
        return { status: "error", state, connectionStatus, redeployed: false, reason: `redeploy ${r.status}` };
      }
      return { status: "reconnecting", state, connectionStatus, redeployed: true };
    } catch (e) {
      console.error("redeploy exception", e);
      return { status: "error", state, connectionStatus, redeployed: false, reason: "redeploy failed" };
    }
  }

  const connected = connectionStatus.toUpperCase() === "CONNECTED"
    && state.toUpperCase() === "DEPLOYED";
  return {
    status: connected ? "connected" : "error",
    state,
    connectionStatus,
    reason: connected ? undefined : `state=${state} connection=${connectionStatus}`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const unauth = checkInternalAuth(req);
  if (unauth) return unauth;
  try {
    const body = await req.json().catch(() => ({}));
    const force = !!(body as any)?.force;
    const result = await runHealthCheck({ force });
    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("metaapi-health-check error", e);
    return safeError("health check failed", 200);
  }
});
