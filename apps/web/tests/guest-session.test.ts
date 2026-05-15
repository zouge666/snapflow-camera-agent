import { describe, expect, it } from "vitest";

import { POST as proxyCreateSession } from "../app/api/guest-sessions/route";
import { POST as proxyRefreshSession } from "../app/api/guest-sessions/refresh/route";
import { POST as proxyCreateRun } from "../app/api/runs/route";
import { POST as proxySubmitApproval } from "../app/api/runs/[runId]/approval/route";
import { POST as proxyAnswerClarification } from "../app/api/runs/[runId]/clarifications/route";
import { POST as proxyResumeRun } from "../app/api/runs/[runId]/resume/route";
import {
  answerGuestRunClarification,
  createGuestRun,
  ensureGuestSession,
  GuestSessionClientError,
  parseRunResponse,
  readActiveGuestRun,
  resumeGuestRun,
  submitGuestRunApproval,
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

const FIXED_TEST_TIME = Date.parse("2026-01-15T10:00:00Z");

function guestSession(
  token = "token-with-at-least-thirty-two-characters",
  expiresAt = "2099-01-15T10:30:00Z",
) {
  return {
    schema_version: "1.0",
    guest_session_id: "ses_browser-test",
    access_token: token,
    token_type: "Bearer",
    expires_at: expiresAt,
    session_expires_at: "2099-01-16T10:00:00Z",
  } as const;
}

function runResponse(
  status:
    | "interrupted_for_clarification"
    | "interrupted_for_approval"
    | "approval_received" = "interrupted_for_approval",
) {
  return {
    schema_version: "1.0",
    run: {
      schema_version: "1.0",
      run_id: "run_same-idempotent-result",
      status,
      candidate_items: [
        {
          id: "action-1",
          title: "Prepare the release notes",
          owner: "Alex",
          due_date: "2026-01-22",
          due_text: "before the review",
          priority: "unknown",
          evidence: [{ quote: "Prepare the release notes", start: 0, end: 25 }],
        },
      ],
      clarification_questions:
        status === "interrupted_for_clarification"
          ? [
              {
                id: "clarification-1",
                field_path: "candidate_items[0].due_date",
                question: "What date is the review?",
                reason: "The reviewed text does not contain a calendar date.",
                answer_kind: "free_text",
                options: [],
                evidence: { quote: "before the review", start: 26, end: 43 },
              },
            ]
          : [],
      clarification_count: status === "interrupted_for_approval" ? 1 : 0,
      approval_decisions:
        status === "approval_received"
          ? [
              {
                action_id: "action-1",
                decision: "approve",
                reviewed: {
                  title: "Prepare the final release notes",
                  owner: "Alex",
                  due_date: "2026-01-23",
                  priority: "high",
                },
                audit_diff: [
                  {
                    field: "title",
                    before: "Prepare the release notes",
                    after: "Prepare the final release notes",
                  },
                ],
              },
            ]
          : [],
      safe_trace: [
        {
          sequence: 0,
          node: "needs_clarification",
          outcome: "interrupted",
          occurred_at: "2026-01-15T10:00:00Z",
          provider: "mock",
          schema_version: "1.0",
          retry_count: 0,
        },
      ],
      created_at: "2026-01-15T10:00:00Z",
      expires_at: "2026-01-16T10:00:00Z",
    },
  } as const;
}

describe("guest session client", () => {
  it("rejects an option clarification that cannot offer a real choice", () => {
    const response = runResponse("interrupted_for_clarification");
    const run = {
      ...response.run,
      clarification_questions: [
        {
          ...response.run.clarification_questions[0],
          answer_kind: "option",
          options: ["Alex"],
        },
      ],
    };

    expect(() => parseRunResponse({ ...response, run })).toThrow(
      "response this app does not understand",
    );
  });

  it("creates once and reuses credentials only from the supplied session storage", async () => {
    const storage = new MemorySessionStorage();
    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json(guestSession(), { status: 201 });
    };

    const first = await ensureGuestSession(fetcher, storage, () => FIXED_TEST_TIME);
    const second = await ensureGuestSession(fetcher, storage, () => FIXED_TEST_TIME);

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
          "2026-01-15T10:00:30Z",
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
      () => FIXED_TEST_TIME,
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
      () => FIXED_TEST_TIME,
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
      return Response.json(runResponse());
    };
    const input = {
      source_text: "Alex will prepare the release notes.",
      locale: "en-US",
      timezone: "Europe/Copenhagen",
      reference_date: "2026-01-15",
    };

    const first = await createGuestRun(input, "create-run:fixed-key", fetcher, storage);
    const second = await createGuestRun(
      input,
      "create-run:fixed-key",
      fetcher,
      storage,
    );

    expect(requests).toHaveLength(2);
    expect(first.run_id).toBe("run_same-idempotent-result");
    expect(second).toEqual(first);
    expect(readActiveGuestRun(storage)).toEqual({
      runId: first.run_id,
      referenceDate: input.reference_date,
    });
    for (const request of requests) {
      expect(new Headers(request.headers).get("idempotency-key")).toBe(
        "create-run:fixed-key",
      );
      expect(String(request.body)).not.toMatch(/image|base64|data:image/i);
    }
  });

  it("resumes and answers the current clarification with the stored guest", async () => {
    const storage = new MemorySessionStorage();
    storage.setItem("snapflow.guest-session.v1", JSON.stringify(guestSession()));
    const requests: Array<{ path: string; body: unknown }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      requests.push({ path, body: JSON.parse(String(init?.body)) });
      return Response.json(
        path.endsWith("/resume")
          ? runResponse("interrupted_for_clarification")
          : runResponse("interrupted_for_approval"),
      );
    };

    const resumed = await resumeGuestRun(
      "run_same-idempotent-result",
      fetcher,
      storage,
    );
    const answered = await answerGuestRunClarification(
      resumed.run_id,
      "clarification-1",
      "free_text",
      "2026-01-22",
      fetcher,
      storage,
    );

    expect(resumed.status).toBe("interrupted_for_clarification");
    expect(answered.status).toBe("interrupted_for_approval");
    expect(requests).toEqual([
      {
        path: "/api/runs/run_same-idempotent-result/resume",
        body: { schema_version: "1.0" },
      },
      {
        path: "/api/runs/run_same-idempotent-result/clarifications",
        body: {
          schema_version: "1.0",
          clarification_id: "clarification-1",
          kind: "free_text",
          answer: "2026-01-22",
        },
      },
    ]);
  });

  it("submits a complete approval with a retry key and parses server audit", async () => {
    const storage = new MemorySessionStorage();
    storage.setItem("snapflow.guest-session.v1", JSON.stringify(guestSession()));
    let observed: { path: string; headers: Headers; body: unknown } | undefined;
    const run = await submitGuestRunApproval(
      "run_same-idempotent-result",
      [
        {
          action_id: "action-1",
          decision: "approve",
          reviewed: {
            title: "Prepare the final release notes",
            owner: "Alex",
            due_date: "2026-01-23",
            priority: "high",
          },
        },
      ],
      "approve-run:browser-test",
      async (input, init) => {
        observed = {
          path: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        };
        return Response.json(runResponse("approval_received"));
      },
      storage,
    );

    expect(observed?.path).toBe("/api/runs/run_same-idempotent-result/approval");
    expect(observed?.headers.get("idempotency-key")).toBe("approve-run:browser-test");
    expect(observed?.body).toEqual({
      schema_version: "1.0",
      decisions: [
        {
          action_id: "action-1",
          decision: "approve",
          reviewed: {
            title: "Prepare the final release notes",
            owner: "Alex",
            due_date: "2026-01-23",
            priority: "high",
          },
        },
      ],
    });
    expect(run.status).toBe("approval_received");
    expect(run.approval_decisions[0]?.audit_diff[0]?.field).toBe("title");
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
          reference_date: "2026-01-15",
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
      await proxyResumeRun(
        new Request("http://localhost/api/runs/run_proxy-test/resume", {
          method: "POST",
          headers: {
            authorization: "Bearer safe-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ schema_version: "1.0" }),
        }),
        { params: Promise.resolve({ runId: "run_proxy-test" }) },
      );
      await proxyAnswerClarification(
        new Request("http://localhost/api/runs/run_proxy-test/clarifications", {
          method: "POST",
          headers: {
            authorization: "Bearer safe-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            schema_version: "1.0",
            clarification_id: "clarification-1",
            kind: "free_text",
            answer: "2026-01-22",
          }),
        }),
        { params: Promise.resolve({ runId: "run_proxy-test" }) },
      );
      await proxySubmitApproval(
        new Request("http://localhost/api/runs/run_proxy-test/approval", {
          method: "POST",
          headers: {
            authorization: "Bearer safe-token",
            "content-type": "application/json",
            "idempotency-key": "approve-run:proxy",
          },
          body: JSON.stringify({ schema_version: "1.0", decisions: [] }),
        }),
        { params: Promise.resolve({ runId: "run_proxy-test" }) },
      );

      expect(observed.map(({ url }) => url)).toEqual([
        "http://api.internal:8123/api/guest-sessions",
        "http://api.internal:8123/api/guest-sessions/refresh",
        "http://api.internal:8123/api/runs",
        "http://api.internal:8123/api/runs/run_proxy-test/resume",
        "http://api.internal:8123/api/runs/run_proxy-test/clarifications",
        "http://api.internal:8123/api/runs/run_proxy-test/approval",
      ]);
      expect(observed[1]!.headers.get("authorization")).toBe("Bearer safe-token");
      expect(observed[2]!.headers.get("idempotency-key")).toBe("create-run:proxy");
      expect(observed[2]!.body).toContain("Reviewed text");
      expect(observed[3]!.headers.get("authorization")).toBe("Bearer safe-token");
      expect(observed[4]!.body).toContain("clarification-1");
      expect(observed[5]!.headers.get("idempotency-key")).toBe("approve-run:proxy");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBase === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = originalBase;
    }
  });
});
