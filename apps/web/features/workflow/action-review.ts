import type { CandidateAction, EvidenceRange } from "./action-plan-client";

export type ActionDecision = "pending" | "approved" | "rejected";
export type ActionPriority = CandidateAction["priority"];

export type ReviewedActionFields = Readonly<{
  title: string;
  owner: string | null;
  dueDate: string | null;
  priority: ActionPriority;
}>;

export type ActionEditDraft = Readonly<{
  title: string;
  owner: string;
  dueDate: string;
  priority: ActionPriority;
}>;

export type ActionEditErrors = Partial<Record<"title" | "owner" | "dueDate", string>>;

export type ActionReviewItem = Readonly<{
  original: CandidateAction;
  current: ReviewedActionFields;
  draft: ActionEditDraft;
  decision: ActionDecision;
  mode: "view" | "editing";
  errors: ActionEditErrors;
}>;

export type ActionReviewState = Readonly<{
  items: readonly ActionReviewItem[];
}>;

export type ActionReviewAction =
  | Readonly<{ type: "start-edit"; id: string }>
  | Readonly<{ type: "cancel-edit"; id: string }>
  | Readonly<{
      type: "change-text-field";
      id: string;
      field: "title" | "owner" | "dueDate";
      value: string;
    }>
  | Readonly<{
      type: "change-priority";
      id: string;
      priority: ActionPriority;
    }>
  | Readonly<{ type: "save-edit"; id: string }>
  | Readonly<{
      type: "decide";
      id: string;
      decision: "approved" | "rejected";
    }>;

export type ActionAuditChange = Readonly<{
  field: "Title" | "Owner" | "Date" | "Priority";
  before: string;
  after: string;
}>;

export type ApprovedActionItem = Readonly<{
  id: string;
  title: string;
  owner: string | null;
  dueDate: string | null;
  priority: ActionPriority;
  evidence: readonly EvidenceRange[];
}>;

export type ActionDecisionSummary = Readonly<{
  approved: number;
  rejected: number;
  pending: number;
}>;

function currentFields(candidate: CandidateAction): ReviewedActionFields {
  return {
    title: candidate.title,
    owner: candidate.owner,
    dueDate: candidate.due?.iso_date ?? null,
    priority: candidate.priority,
  };
}

function draftFields(fields: ReviewedActionFields): ActionEditDraft {
  return {
    title: fields.title,
    owner: fields.owner ?? "",
    dueDate: fields.dueDate ?? "",
    priority: fields.priority,
  };
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return false;
  }

  const [, year, month, day] = match;
  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

export function validateActionEdit(draft: ActionEditDraft): ActionEditErrors {
  const errors: ActionEditErrors = {};
  const title = draft.title.trim();
  const owner = draft.owner.trim();

  if (title.length === 0) {
    errors.title = "Add an action title before saving.";
  } else if (title.length > 240) {
    errors.title = "Keep the action title at 240 characters or fewer.";
  }

  if (owner.length > 120) {
    errors.owner = "Keep the owner at 120 characters or fewer.";
  }

  if (draft.dueDate.length > 0 && !isValidIsoDate(draft.dueDate)) {
    errors.dueDate = "Use a real date in YYYY-MM-DD format or leave it unknown.";
  }

  return errors;
}

export function createActionReviewState(
  candidates: readonly CandidateAction[],
): ActionReviewState {
  return {
    items: candidates.map((candidate) => {
      const current = currentFields(candidate);

      return {
        original: candidate,
        current,
        draft: draftFields(current),
        decision: "pending",
        mode: "view",
        errors: {},
      };
    }),
  };
}

function updateItem(
  state: ActionReviewState,
  id: string,
  update: (item: ActionReviewItem) => ActionReviewItem,
): ActionReviewState {
  let found = false;
  const items = state.items.map((item) => {
    if (item.original.id !== id) {
      return item;
    }

    found = true;
    return update(item);
  });

  return found ? { items } : state;
}

export function actionReviewReducer(
  state: ActionReviewState,
  action: ActionReviewAction,
): ActionReviewState {
  switch (action.type) {
    case "start-edit":
      return updateItem(state, action.id, (item) => ({
        ...item,
        draft: draftFields(item.current),
        mode: "editing",
        errors: {},
      }));
    case "cancel-edit":
      return updateItem(state, action.id, (item) => ({
        ...item,
        draft: draftFields(item.current),
        mode: "view",
        errors: {},
      }));
    case "change-text-field":
      return updateItem(state, action.id, (item) => {
        if (item.mode !== "editing") {
          return item;
        }

        const errors = { ...item.errors };
        delete errors[action.field];

        return {
          ...item,
          draft: { ...item.draft, [action.field]: action.value },
          errors,
        };
      });
    case "change-priority":
      return updateItem(state, action.id, (item) =>
        item.mode === "editing"
          ? {
              ...item,
              draft: { ...item.draft, priority: action.priority },
            }
          : item,
      );
    case "save-edit":
      return updateItem(state, action.id, (item) => {
        if (item.mode !== "editing") {
          return item;
        }

        const errors = validateActionEdit(item.draft);
        if (Object.keys(errors).length > 0) {
          return { ...item, errors };
        }

        const current: ReviewedActionFields = {
          title: item.draft.title.trim(),
          owner: item.draft.owner.trim() || null,
          dueDate: item.draft.dueDate || null,
          priority: item.draft.priority,
        };

        return {
          ...item,
          current,
          draft: draftFields(current),
          decision: "pending",
          mode: "view",
          errors: {},
        };
      });
    case "decide":
      return updateItem(state, action.id, (item) =>
        item.mode === "view" ? { ...item, decision: action.decision } : item,
      );
  }
}

function displayValue(value: string | null): string {
  return value ?? "unknown";
}

export function getActionAuditDiff(
  item: ActionReviewItem,
): readonly ActionAuditChange[] {
  const comparisons: readonly ActionAuditChange[] = [
    {
      field: "Title",
      before: item.original.title,
      after: item.current.title,
    },
    {
      field: "Owner",
      before: displayValue(item.original.owner),
      after: displayValue(item.current.owner),
    },
    {
      field: "Date",
      before: displayValue(item.original.due?.iso_date ?? null),
      after: displayValue(item.current.dueDate),
    },
    {
      field: "Priority",
      before: item.original.priority,
      after: item.current.priority,
    },
  ];

  return comparisons.filter((change) => change.before !== change.after);
}

export function summarizeActionDecisions(
  state: ActionReviewState,
): ActionDecisionSummary {
  return state.items.reduce<ActionDecisionSummary>(
    (summary, item) => ({
      ...summary,
      [item.decision]: summary[item.decision] + 1,
    }),
    { approved: 0, rejected: 0, pending: 0 },
  );
}

export function selectApprovedActions(
  state: ActionReviewState,
): readonly ApprovedActionItem[] {
  return state.items
    .filter((item) => item.decision === "approved")
    .map((item) => ({
      id: item.original.id,
      ...item.current,
      evidence: item.original.evidence,
    }));
}
