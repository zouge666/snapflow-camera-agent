import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { POST as proxyIcsExport } from "../app/api/demo/exports/ics/route";
import type { CandidateAction } from "../features/workflow/action-plan-client";
import {
  actionReviewReducer,
  createActionReviewState,
  selectApprovedActions,
} from "../features/workflow/action-review";
import {
  ActionReviewBoardView,
  initialIcsDownloadState,
} from "../features/workflow/action-review-board";
import {
  createIcsExportRequest,
  downloadIcsFile,
  IcsExportClientError,
  parseIcsExportResponse,
  requestIcsExport,
  type IcsExportResponse,
} from "../features/workflow/ics-export-client";

const candidates: readonly CandidateAction[] = [
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
];

const response: IcsExportResponse = {
  schema_version: "1.0",
  filename: "snapflow-approved-actions.ics",
  content_type: "text/calendar; charset=utf-8",
  content: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n",
  exported_action_ids: ["action-1"],
  warnings: [
    {
      action_id: "action-2",
      code: "missing_due_date",
      message: "action-2 was skipped because no approved date is available.",
    },
  ],
};

function approvedReviewState() {
  const initial = createActionReviewState(candidates);
  const withDatedApproval = actionReviewReducer(initial, {
    type: "decide",
    id: "action-1",
    decision: "approved",
  });
  return actionReviewReducer(withDatedApproval, {
    type: "decide",
    id: "action-2",
    decision: "approved",
  });
}

describe("basic ICS export client", () => {
  it("serializes only individually approved items for the typed route", async () => {
    const state = actionReviewReducer(createActionReviewState(candidates), {
      type: "decide",
      id: "action-1",
      decision: "approved",
    });
    const exportRequest = createIcsExportRequest(
      selectApprovedActions(state),
      "2026-07-16",
    );
    let sentInput: string | URL | Request | undefined;
    let sentInit: RequestInit | undefined;

    const result = await requestIcsExport(exportRequest, async (input, init) => {
      sentInput = input;
      sentInit = init;
      return Response.json(response);
    });

    expect(sentInput).toBe("/api/demo/exports/ics");
    expect(sentInit?.method).toBe("POST");
    expect(JSON.parse(String(sentInit?.body))).toEqual({
      schema_version: "1.0",
      reference_date: "2026-07-16",
      approved_items: [
        {
          id: "action-1",
          title: "Send the revised onboarding checklist",
          owner: "Alex",
          due_date: "2026-07-17",
          priority: "unknown",
          evidence: candidates[0]!.evidence,
          decision: "approved",
        },
      ],
    });
    expect(String(sentInit?.body)).not.toContain("action-2");
    expect(result).toEqual(response);
  });

  it("rejects malformed responses and returns safe request errors", async () => {
    expect(() =>
      parseIcsExportResponse({ ...response, content_type: "text/plain" }),
    ).toThrow(IcsExportClientError);
    expect(() =>
      parseIcsExportResponse({
        ...response,
        warnings: [{ ...response.warnings[0], code: "made_up_date" }],
      }),
    ).toThrow(IcsExportClientError);

    const request = createIcsExportRequest([], "2026-07-16");
    await expect(
      requestIcsExport(request, async () => {
        throw new Error("private network detail");
      }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      requestIcsExport(request, async () => new Response("private", { status: 500 })),
    ).rejects.toThrow(/could not prepare/i);
  });

  it("creates and revokes a browser object URL for the in-memory file", async () => {
    let capturedBlob: Blob | undefined;
    let clicked: readonly string[] | undefined;
    let revoked = "";

    downloadIcsFile(response, {
      createObjectUrl: (blob) => {
        capturedBlob = blob;
        return "blob:snapflow-test";
      },
      clickDownload: (url, filename) => {
        clicked = [url, filename];
      },
      revokeObjectUrl: (url) => {
        revoked = url;
      },
    });

    expect(capturedBlob?.type).toBe("text/calendar; charset=utf-8");
    expect(await capturedBlob?.text()).toBe(response.content);
    expect(clicked).toEqual(["blob:snapflow-test", "snapflow-approved-actions.ics"]);
    expect(revoked).toBe("blob:snapflow-test");
  });
});

describe("same-origin ICS proxy", () => {
  it("forwards the approved-item JSON without exposing the API URL", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiBaseUrl = process.env.API_BASE_URL;
    let upstreamUrl = "";
    let upstreamBody = "";
    const exportRequest = createIcsExportRequest(
      selectApprovedActions(approvedReviewState()),
      "2026-07-16",
    );

    process.env.API_BASE_URL = "http://api.internal:8123";
    globalThis.fetch = async (input, init) => {
      upstreamUrl = String(input);
      upstreamBody = String(init?.body);
      return Response.json(response);
    };

    try {
      const proxyResponse = await proxyIcsExport(
        new Request("http://localhost:3000/api/demo/exports/ics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(exportRequest),
        }),
      );

      expect(proxyResponse.status).toBe(200);
      expect(upstreamUrl).toBe("http://api.internal:8123/api/demo/exports/ics");
      expect(JSON.parse(upstreamBody)).toEqual(exportRequest);
      expect(await proxyResponse.json()).toEqual(response);
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

describe("basic ICS download interface", () => {
  it("keeps download disabled until at least one item is approved", () => {
    const markup = renderToStaticMarkup(
      <ActionReviewBoardView
        state={createActionReviewState(candidates)}
        exportState={initialIcsDownloadState}
        onAction={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(markup).toContain("Download approved dates.");
    expect(markup).toMatch(/disabled[^>]*>Download approved \.ics/);
    expect(markup).toContain("Only individually approved items");
  });

  it("warns about undated approvals and surfaces the server result", () => {
    const state = approvedReviewState();
    const beforeMarkup = renderToStaticMarkup(
      <ActionReviewBoardView
        state={state}
        exportState={initialIcsDownloadState}
        onAction={() => undefined}
        onDownload={() => undefined}
      />,
    );
    const afterMarkup = renderToStaticMarkup(
      <ActionReviewBoardView
        state={state}
        exportState={{
          status: "success",
          exportedCount: 1,
          warnings: response.warnings,
        }}
        onAction={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(beforeMarkup).toContain("1 approved item has no date and will be skipped.");
    expect(beforeMarkup).not.toMatch(/disabled[^>]*>Download approved \.ics/);
    expect(afterMarkup).toContain("1 calendar event downloaded.");
    expect(afterMarkup).toContain("action-2 was skipped");
  });
});
