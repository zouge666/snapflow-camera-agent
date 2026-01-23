import type { ActionPlanResponse } from "./action-plan-client";

export type WorkflowState =
  | Readonly<{ status: "review" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{ status: "ready"; plan: ActionPlanResponse }>;

export type WorkflowAction =
  | Readonly<{ type: "request-plan" }>
  | Readonly<{ type: "receive-plan"; plan: ActionPlanResponse }>
  | Readonly<{ type: "fail-plan"; message: string }>
  | Readonly<{ type: "invalidate-plan" }>;

export const initialWorkflowState: WorkflowState = { status: "review" };

export function workflowReducer(
  _state: WorkflowState,
  action: WorkflowAction,
): WorkflowState {
  switch (action.type) {
    case "request-plan":
      return { status: "loading" };
    case "receive-plan":
      return { status: "ready", plan: action.plan };
    case "fail-plan":
      return { status: "error", message: action.message };
    case "invalidate-plan":
      return initialWorkflowState;
  }
}
