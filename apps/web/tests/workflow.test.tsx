import type { AxeResults, RunOptions } from "axe-core";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { POST as proxyActionPlan } from "../app/api/demo/action-plan/route";
import {
  ActionPlanClientError,
  parseActionPlanResponse,
  requestActionPlan,
  type ActionPlanRequest,
  type ActionPlanResponse,
} from "../features/workflow/action-plan-client";
import { ActionPlanPanel } from "../features/workflow/action-plan-panel";
import {
  initialWorkflowState,
  workflowReducer,
  type WorkflowState,
} from "../features/workflow/workflow-state";

const request: ActionPlanRequest = {
  source_text:
    "Northstar launch planning — 2026-07-16\n\nActions\n- Alex: Send the revised onboarding checklist by Friday.",
  locale: "en-US",
  timezone: "Europe/Copenhagen",
  reference_date: "2026-07-16",
};

const plan: ActionPlanResponse = {
  schema_version: "1.0",
  provider: "mock",
  summary: "3 candidate actions found. 1 detail needs clarification.",
  candidate_actions: [
    {
      id: "action-1",
      title: "Send the revised onboarding checklist",
      owner: "Alex",
      due: {
        iso_date: "2026-07-17",
        raw_text: "by Friday",
        resolution: "relative",
      },
      priority: "unknown",
      evidence: [
        {
          quote: "Alex: Send the revised onboarding checklist by Friday.",
          start: 54,
          end: 108,
        },
      ],
    },
    {
      id: "action-2",
      title: "Prepare the support FAQ",
      owner: null,
      due: {
        iso_date: null,
        raw_text: "before the pilot review",
        resolution: "ambiguous",
      },
      priority: "unknown",
      evidence: [
        {
          quote: "Prepare the support FAQ before the pilot review.",
          start: 111,
          end: 159,
        },
      ],
    },
  ],
  clarifications: [
    {
      id: "clarification-1",
      field_path: "candidate_actions[1].due",
      question: "What date is the pilot review for the support FAQ deadline?",
      reason: "The deadline cannot be resolved from this text alone.",
      evidence: {
        quote: "before the pilot review",
        start: 135,
        end: 158,
      },
    },
  ],
};

const emptyPlan: ActionPlanResponse = {
  ...plan,
  summary: "No candidate actions matched the supported synthetic sample context.",
  candidate_actions: [],
  clarifications: [],
};

const renderPanel = (state: WorkflowState) =>
  renderToStaticMarkup(<ActionPlanPanel state={state} onRetry={() => undefined} />);

describe("temporary action-plan client", () => {
  it("posts only the confirmed text context and parses the typed response", async () => {
    let sentInput: string | URL | Request | undefined;
    let sentInit: RequestInit | undefined;
    const result = await requestActionPlan(request, async (input, init) => {
      sentInput = input;
      sentInit = init;
      return Response.json(plan);
    });

    expect(sentInput).toBe("/api/demo/action-plan");
    expect(sentInit?.method).toBe("POST");
    expect(JSON.parse(String(sentInit?.body))).toEqual(request);
    expect(String(sentInit?.body)).not.toMatch(/image|base64|data:image/i);
    expect(result).toEqual(plan);
  });

  it("rejects invalid provider and evidence contracts", () => {
    expect(() => parseActionPlanResponse({ ...plan, provider: "deepseek" })).toThrow(
      ActionPlanClientError,
    );
    expect(() =>
      parseActionPlanResponse({
        ...plan,
        candidate_actions: [
          {
            ...plan.candidate_actions[0],
            evidence: [{ quote: "bad range", start: 9, end: 9 }],
          },
        ],
      }),
    ).toThrow(ActionPlanClientError);
  });

  it("turns network and HTTP failures into safe client errors", async () => {
    await expect(
      requestActionPlan(request, async () => {
        throw new Error("private network detail");
      }),
    ).rejects.toThrow(/unavailable/i);

    await expect(
      requestActionPlan(
        request,
        async () => new Response("internal detail", { status: 500 }),
      ),
    ).rejects.toThrow(/could not build/i);
  });
});

describe("same-origin action-plan proxy", () => {
  it("forwards the JSON request to the configured API without exposing its URL", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiBaseUrl = process.env.API_BASE_URL;
    let upstreamUrl = "";
    let upstreamBody = "";

    process.env.API_BASE_URL = "http://api.internal:8123";
    globalThis.fetch = async (input, init) => {
      upstreamUrl = String(input);
      upstreamBody = String(init?.body);
      return Response.json(plan);
    };

    try {
      const response = await proxyActionPlan(
        new Request("http://localhost:3000/api/demo/action-plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        }),
      );

      expect(response.status).toBe(200);
      expect(upstreamUrl).toBe("http://api.internal:8123/api/demo/action-plan");
      expect(JSON.parse(upstreamBody)).toEqual(request);
      expect(await response.json()).toEqual(plan);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiBaseUrl === undefined) {
        delete process.env.API_BASE_URL;
      } else {
        process.env.API_BASE_URL = originalApiBaseUrl;
      }
    }
  });
});

describe("workflow states", () => {
  it("moves through loading, error, empty and actions results", () => {
    const loading = workflowReducer(initialWorkflowState, {
      type: "request-plan",
    });
    const error = workflowReducer(loading, {
      type: "fail-plan",
      message: "Try again.",
    });
    const empty = workflowReducer(error, {
      type: "receive-plan",
      plan: emptyPlan,
      request,
    });
    const actions = workflowReducer(empty, {
      type: "receive-plan",
      plan,
      request,
    });
    const invalidated = workflowReducer(actions, { type: "invalidate-plan" });

    expect(loading.status).toBe("loading");
    expect(error).toEqual({ status: "error", message: "Try again." });
    expect(empty).toEqual({ status: "ready", plan: emptyPlan, request });
    expect(actions).toEqual({ status: "ready", plan, request });
    expect(invalidated).toEqual(initialWorkflowState);
  });

  it("renders explicit loading and retryable error states", () => {
    const loadingMarkup = renderPanel({ status: "loading" });
    const errorMarkup = renderPanel({
      status: "error",
      message: "The demo service is unavailable.",
    });

    expect(loadingMarkup).toContain('role="status"');
    expect(loadingMarkup).toContain("Building the deterministic plan");
    expect(loadingMarkup).toContain("Demo provider");
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain("Retry demo request");
  });

  it("renders an honest empty state without inventing candidates", () => {
    const markup = renderPanel({ status: "ready", plan: emptyPlan, request });

    expect(markup).toContain("No candidate actions found.");
    expect(markup).toContain("will not invent actions");
    expect(markup).not.toContain("candidate-card");
  });

  it("renders actions, unknown values, clarifications and source ranges", () => {
    const markup = renderPanel({ status: "ready", plan, request });

    expect(markup).toContain(plan.summary);
    expect(markup).toContain("Send the revised onboarding checklist");
    expect(markup).toContain("Prepare the support FAQ");
    expect(markup).toContain(">unknown</dd>");
    expect(markup).toContain("Source characters 54–108");
    expect(markup).toContain("Alex: Send the revised onboarding checklist by Friday.");
    expect(markup).toContain("What date is the pilot review");
    expect(markup).toContain("Mock contract · schema 1.0");
    expect(markup.match(/>Approve</g)).toHaveLength(plan.candidate_actions.length);
    expect(markup.match(/>Reject</g)).toHaveLength(plan.candidate_actions.length);
    expect(markup).toContain("Nothing is approved by default.");
    expect(markup).toContain("Download approved .ics");
    expect(markup).not.toContain("Approve all");
  });

  it("has no automatic axe violations in the populated action plan", async () => {
    const markup = renderPanel({ status: "ready", plan, request });
    const dom = new JSDOM(
      `<!doctype html><html lang="en"><head><title>SnapFlow plan test</title></head><body><main>${markup}</main></body></html>`,
      {
        pretendToBeVisual: true,
        runScripts: "outside-only",
        url: "http://localhost:3000/demo",
      },
    );

    dom.window.eval(axe.source);
    const axeWindow = dom.window as unknown as {
      axe: {
        run: (document: Document, options: RunOptions) => Promise<AxeResults>;
      };
    };
    const results = await axeWindow.axe.run(dom.window.document, {
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
