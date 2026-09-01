type EdgeResult = { status: number; data: unknown };

function getServerConfig() {
  // Uses environment variables if present, otherwise uses your specific Supabase credentials as fallback strings
  const url = process.env["SUPABASE_URL"] 
    ?? process.env["VITE_SUPABASE_URL"] 
    ?? "https://gvxiwqbuurwksvjqsuoy.supabase.co";

  const anon = process.env["SUPABASE_PUBLISHABLE_KEY"]
    ?? process.env["SUPABASE_ANON_KEY"]
    ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"]
    ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2eGl3cWJ1dXJ3a3N2anFzdW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDMyNDIsImV4cCI6MjA5NDc3OTI0Mn0.XazR4Te9STYeIYe-9sHbSWnn6jZX229QbIEvm1-9UU4";

  // Bypasses the missing variable by embedding the local secret directly
  const secret = process.env["INTERNAL_FN_SECRET"] 
    ?? "chelseafc";

  if (!url || !anon || !secret) {
    throw new Error("Server settings proxy is not configured");
  }

  return { url, anon, secret };
}

export async function callEdge(path: string, body: unknown): Promise<EdgeResult> {
  const { url, anon, secret } = getServerConfig();
  const response = await fetch(`${url}/functions/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-fn-secret": secret,
      apikey: anon,
      Authorization: `Bearer ${anon}`,
    },
    body: JSON.stringify(body ?? {}),
  });

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: response.status, data };
}
