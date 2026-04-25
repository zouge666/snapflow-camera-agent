const DEFAULT_API_BASE_URL = "http://localhost:8000";

type RouteContext = Readonly<{ params: Promise<{ runId: string }> }>;

function apiUrl(runId: string): URL {
  const configuredBaseUrl = process.env.API_BASE_URL?.trim();
  return new URL(
    `/api/runs/${encodeURIComponent(runId)}/clarifications`,
    configuredBaseUrl || DEFAULT_API_BASE_URL,
  );
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { runId } = await context.params;
    const authorization = request.headers.get("authorization");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorization !== null) headers.authorization = authorization;
    const upstream = await fetch(apiUrl(runId), {
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
