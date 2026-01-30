const DEFAULT_API_BASE_URL = "http://localhost:8000";

function apiUrl(): URL {
  const configuredBaseUrl = process.env.API_BASE_URL?.trim();
  return new URL("/api/runs", configuredBaseUrl || DEFAULT_API_BASE_URL);
}

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization");
    const idempotencyKey = request.headers.get("idempotency-key");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorization !== null) headers.authorization = authorization;
    if (idempotencyKey !== null) headers["idempotency-key"] = idempotencyKey;

    const upstream = await fetch(apiUrl(), {
      method: "POST",
      headers,
      body: await request.text(),
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
