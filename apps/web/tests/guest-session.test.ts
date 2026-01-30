import { describe, expect, it } from "vitest";

import { POST as proxyCreateSession } from "../app/api/guest-sessions/route";
import { POST as proxyRefreshSession } from "../app/api/guest-sessions/refresh/route";
import { POST as proxyCreateRun } from "../app/api/runs/route";
import {
  createGuestRun,
  ensureGuestSession,
  GuestSessionClientError,
} from "../features/session/guest-session-client";

class MemorySessionStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const now = Date.parse("2026-09-06T10:00:00Z");

function guestSession(
  token = "token-with-at-least-thirty-two-characters",
  expiresAt = "2099-09-06T10:30:00Z",
) {
  return {
    schema_version: "1.0",
    guest_session_id: "ses_browser-test",
    access_token: token,
    token_type: "Bearer",
    expires_at: expiresAt,
    session_expires_at: "2099-09-07T10:00:00Z",
  } as const;
}

describe("guest session client", () => {
  it("creates once and reuses credentials only from the supplied session storage", async () => {
    const storage = new MemorySessionStorage();
    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json(guestSession(), { status: 201 });
    };

    const first = await ensureGuestSession(fetcher, storage, () => now);
    const second = await ensureGuestSession(fetcher, storage, () => now);

    expect(first).toEqual(guestSession());
    expect(second).toEqual(first);
    expect(calls).toEqual(["/api/guest-sessions"]);
    expect(storage.length).toBe(1);
  });

  it("refreshes a nearly expired access token and replaces the stored value", async () => {
    const storage = new MemorySessionStorage();
    storage.setItem(
      "snapflow.guest-session.v1",
      JSON.stringify(
        guestSession(
          "old-token-with-at-least-thirty-two-chars",
          "2026-09-06T10:00:30Z",
        ),
      ),
    );
    let authorization = "";
    const refreshed = guestSession("refreshed-token-with-at-least-thirty-two-chars");

    const result = await ensureGuestSession(
      async (input, init) => {
        expect(String(input)).toBe("/api/guest-sessions/refresh");
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json(refreshed);
      },
      storage,
      () => now,
    );

    expect(authorization).toBe("Bearer old-token-with-at-least-thirty-two-chars");
    expect(result).toEqual(refreshed);
    expect(JSON.parse(storage.getItem("snapflow.guest-session.v1") ?? "")).toEqual(
      refreshed,
    );
  });

  it("drops invalid storage and recovers with a fresh guest", async () => {
    const storage = new MemorySessionStorage();
    storage.setItem("snapflow.guest-session.v1", "not-json");

    const result = await ensureGuestSession(
      async () => Response.json(guestSession(), { status: 201 }),
      storage,
      () => now,
    );

    expect(result.guest_session_id).toBe("ses_browser-test");
  });

  it("sends the same idempotency key and no image data when a create is retried", async () => {
    const storage = new MemorySessionStorage();
    const requests: RequestInit[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/api/guest-sessions") {
        return Response.json(guestSession(), { status: 201 });
      }
      requests.push(init ?? {});
      return Response.json({
        schema_version: "1.0",
        run: { run_id: "run_same-idempotent-result" },
      });
    };
    const input = {
      source_text: "Alex will prepare the release notes.",
      locale: "en-US",
      timezone: "Europe/Copenhagen",
      reference_date: "2026-09-06",
    };

    await createGuestRun(input, "create-run:fixed-key", fetcher, storage);
    await createGuestRun(input, "create-run:fixed-key", fetcher, storage);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(new Headers(request.headers).get("idempotency-key")).toBe(
        "create-run:fixed-key",
      );
      expect(String(request.body)).not.toMatch(/image|base64|data:image/i);
    }
  });

  it("returns safe errors for failed or malformed responses", async () => {
    await expect(
      ensureGuestSession(
        async () => new Response("private", { status: 500 }),
        new MemorySessionStorage(),
      ),
    ).rejects.toThrow(GuestSessionClientError);

    await expect(
      createGuestRun(
        {
          source_text: "Reviewed text",
          locale: "en-US",
          timezone: "UTC",
          reference_date: "2026-09-06",
        },
        "create-run:bad-response",
        async (input) =>
          String(input) === "/api/guest-sessions"
            ? Response.json(guestSession(), { status: 201 })
            : Response.json({ schema_version: "1.0", run: {} }),
        new MemorySessionStorage(),
      ),
    ).rejects.toThrow(/does not understand/i);
  });
});

describe("same-origin guest-run proxies", () => {
  it("forwards only required auth and idempotency headers", async () => {
    const originalFetch = globalThis.fetch;
    const originalBase = process.env.API_BASE_URL;
    const observed: Array<{ url: string; headers: Headers; body: string }> = [];
    process.env.API_BASE_URL = "http://api.internal:8123";
    globalThis.fetch = async (input, init) => {
      observed.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
      });
      return Response.json(guestSession());
    };

    try {
      await proxyCreateSession();
      await proxyRefreshSession(
        new Request("http://localhost/api/guest-sessions/refresh", {
          method: "POST",
          headers: { authorization: "Bearer safe-token" },
        }),
      );
      await proxyCreateRun(
        new Request("http://localhost/api/runs", {
          method: "POST",
          headers: {
            authorization: "Bearer safe-token",
            "content-type": "application/json",
            "idempotency-key": "create-run:proxy",
          },
          body: JSON.stringify({ source_text: "Reviewed text" }),
        }),
      );

      expect(observed.map(({ url }) => url)).toEqual([
        "http://api.internal:8123/api/guest-sessions",
        "http://api.internal:8123/api/guest-sessions/refresh",
        "http://api.internal:8123/api/runs",
      ]);
      expect(observed[1]!.headers.get("authorization")).toBe("Bearer safe-token");
      expect(observed[2]!.headers.get("idempotency-key")).toBe("create-run:proxy");
      expect(observed[2]!.body).toContain("Reviewed text");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBase === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = originalBase;
    }
  });
});
