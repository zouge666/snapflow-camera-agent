const DEFAULT_API_BASE_URL = "http://localhost:8000";

function apiUrl(path: string): URL {
  const configuredBaseUrl = process.env.API_BASE_URL?.trim();
  return new URL(path, configuredBaseUrl || DEFAULT_API_BASE_URL);
}

export async function POST() {
  try {
    const upstream = await fetch(apiUrl("/api/guest-sessions"), {
      method: "POST",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return Response.json({ detail: "The local API is unavailable." }, { status: 502 });
  }
}
