type EdgeResult = { status: number; data: unknown };

function getServerConfig() {
  const url = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"] ?? "";
  const anon = process.env["SUPABASE_PUBLISHABLE_KEY"]
    ?? process.env["SUPABASE_ANON_KEY"]
    ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"]
    ?? "";
  const secret = process.env["INTERNAL_FN_SECRET"] ?? "";

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
