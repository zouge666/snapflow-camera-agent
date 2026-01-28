const DEFAULT_API_BASE_URL = "http://localhost:8000";

function icsExportUrl(): URL {
  const configuredBaseUrl = process.env.API_BASE_URL?.trim();
  return new URL("/api/demo/exports/ics", configuredBaseUrl || DEFAULT_API_BASE_URL);
}

export async function POST(request: Request) {
  try {
    const upstream = await fetch(icsExportUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    return Response.json(
      {
        detail:
          "The local calendar API is unavailable. Start both services and try again.",
      },
      { status: 502 },
    );
  }
}
