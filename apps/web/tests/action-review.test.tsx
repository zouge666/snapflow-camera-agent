import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CandidateAction } from "../features/workflow/action-plan-client";
import {
  actionReviewReducer,
  createActionReviewState,
  getActionAuditDiff,
  selectApprovedActions,
  summarizeActionDecisions,
  type ActionReviewAction,
  type ActionReviewState,
} from "../features/workflow/action-review";
import {
  ActionReviewBoardView,
  initialIcsDownloadState,
} from "../features/workflow/action-review-board";

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
  {
    id: "action-3",
    title: "Book a 30-minute pilot review",
    owner: "Mina",
    due: {
      iso_date: "2026-07-22",
      raw_text: "on 2026-07-22",
      resolution: "absolute",
    },
    priority: "unknown",
    evidence: [
      {
        quote: "Mina: Book a 30-minute pilot review on 2026-07-22.",
        start: 162,
        end: 216,
      },
    ],
  },
];

function apply(
  state: ActionReviewState,
  ...actions: readonly ActionReviewAction[]
): ActionReviewState {
  return actions.reduce(actionReviewReducer, state);
}

describe("action review domain", () => {
  it("starts every candidate pending with no default approvals", () => {
    const state = createActionReviewState(candidates);

    expect(state.items.map((item) => item.decision)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(summarizeActionDecisions(state)).toEqual({
      approved: 0,
      rejected: 0,
      pending: 3,
    });
    expect(selectApprovedActions(state)).toEqual([]);
  });

  it("supports partial approval without deciding untouched items", () => {
    const state = apply(
      createActionReviewState(candidates),
      { type: "decide", id: "action-1", decision: "approved" },
      { type: "decide", id: "action-2", decision: "rejected" },
    );

    expect(summarizeActionDecisions(state)).toEqual({
      approved: 1,
      rejected: 1,
      pending: 1,
    });
    expect(selectApprovedActions(state).map((item) => item.id)).toEqual(["action-1"]);
  });

  it("blocks empty titles, invalid dates and overlong owners", () => {
    const state = apply(
      createActionReviewState(candidates),
      { type: "start-edit", id: "action-2" },
      {
        type: "change-text-field",
        id: "action-2",
        field: "title",
        value: "   ",
      },
      {
        type: "change-text-field",
        id: "action-2",
        field: "owner",
        value: "x".repeat(121),
      },
      {
        type: "change-text-field",
        id: "action-2",
        field: "dueDate",
        value: "2026-02-30",
      },
      { type: "save-edit", id: "action-2" },
    );
    const item = state.items[1]!;

    expect(item.mode).toBe("editing");
    expect(item.errors.title).toMatch(/title/i);
    expect(item.errors.owner).toMatch(/120/);
    expect(item.errors.dueDate).toMatch(/real date/i);
    expect(item.current).toEqual({
      title: "Prepare the support FAQ",
      owner: null,
      dueDate: null,
      priority: "unknown",
    });
    expect(
      actionReviewReducer(state, {
        type: "decide",
        id: "action-2",
        decision: "approved",
      }).items[1]!.decision,
    ).toBe("pending");
  });

  it("records saved field changes while retaining original evidence", () => {
    const originalEvidence = candidates[1]!.evidence;
    const approved = actionReviewReducer(createActionReviewState(candidates), {
      type: "decide",
      id: "action-2",
      decision: "approved",
    });
    const state = apply(
      approved,
      { type: "start-edit", id: "action-2" },
      {
        type: "change-text-field",
        id: "action-2",
        field: "owner",
        value: "  Dana  ",
      },
      {
        type: "change-text-field",
        id: "action-2",
        field: "dueDate",
        value: "2026-07-21",
      },
      {
        type: "change-priority",
        id: "action-2",
        priority: "high",
      },
      { type: "save-edit", id: "action-2" },
    );
    const item = state.items[1]!;

    expect(item.current).toEqual({
      title: "Prepare the support FAQ",
      owner: "Dana",
      dueDate: "2026-07-21",
      priority: "high",
    });
    expect(item.decision).toBe("pending");
    expect(getActionAuditDiff(item)).toEqual([
      { field: "Owner", before: "unknown", after: "Dana" },
      { field: "Date", before: "unknown", after: "2026-07-21" },
      { field: "Priority", before: "unknown", after: "high" },
    ]);
    expect(item.original.owner).toBeNull();
    expect(item.original.due?.iso_date).toBeNull();
    expect(item.original.evidence).toBe(originalEvidence);

    const reapproved = actionReviewReducer(state, {
      type: "decide",
      id: "action-2",
      decision: "approved",
    });
    expect(selectApprovedActions(reapproved)).toEqual([
      {
        id: "action-2",
        title: "Prepare the support FAQ",
        owner: "Dana",
        dueDate: "2026-07-21",
        priority: "high",
        evidence: originalEvidence,
      },
    ]);
  });

  it("can reject every item one by one without creating approved output", () => {
    const state = candidates.reduce(
      (current, candidate) =>
        actionReviewReducer(current, {
          type: "decide",
          id: candidate.id,
          decision: "rejected",
        }),
      createActionReviewState(candidates),
    );

    expect(summarizeActionDecisions(state)).toEqual({
      approved: 0,
      rejected: 3,
      pending: 0,
    });
    expect(selectApprovedActions(state)).toEqual([]);
  });
});

describe("action review interface", () => {
  it("renders only per-item decisions and explains the local boundary", () => {
    const markup = renderToStaticMarkup(
      <ActionReviewBoardView
        state={createActionReviewState(candidates)}
        exportState={initialIcsDownloadState}
        onAction={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(markup.match(/>Approve</g)).toHaveLength(3);
    expect(markup.match(/>Reject</g)).toHaveLength(3);
    expect(markup.match(/Pending review/g)).toHaveLength(3);
    expect(markup).toContain("0 approved");
    expect(markup).toContain("Nothing is approved by default.");
    expect(markup).toContain("local demo API only");
    expect(markup).toContain("Download approved .ics");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("Approve all");
  });

  it("shows the audit diff beside unchanged original evidence", () => {
    const edited = apply(
      createActionReviewState(candidates),
      { type: "start-edit", id: "action-2" },
      {
        type: "change-text-field",
        id: "action-2",
        field: "owner",
        value: "Dana",
      },
      {
        type: "change-text-field",
        id: "action-2",
        field: "dueDate",
        value: "2026-07-21",
      },
      { type: "save-edit", id: "action-2" },
      { type: "decide", id: "action-2", decision: "approved" },
    );
    const markup = renderToStaticMarkup(
      <ActionReviewBoardView
        state={edited}
        exportState={initialIcsDownloadState}
        onAction={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(markup).toContain("Edited locally");
    expect(markup).toContain("Dana");
    expect(markup).toContain("2026-07-21");
    expect(markup).toContain(
      "Evidence below always comes from the original candidate.",
    );
    expect(markup).toContain("Prepare the support FAQ before the pilot review.");
    expect(markup).toContain("Source characters 111–159");
    expect(markup).toContain("1 approved");
    expect(markup).toContain("<dt>Calendar-ready</dt><dd>1</dd>");
  });
});
