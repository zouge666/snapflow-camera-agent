import type { ActionPlanRequest, ActionPlanResponse } from "./action-plan-client";
import type { RunView } from "../../lib/api/generated/types.gen";

type ActionPlanContext = Pick<ActionPlanRequest, "reference_date">;

export type WorkflowState =
  | Readonly<{ status: "review" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{
      status: "clarifying";
      run: RunView;
      referenceDate: string;
      isAnswering: boolean;
      message?: string;
    }>
  | Readonly<{
      status: "ready";
      plan: ActionPlanResponse;
      request: ActionPlanContext;
    }>;

export type WorkflowAction =
  | Readonly<{ type: "request-plan" }>
  | Readonly<{
      type: "receive-plan";
      plan: ActionPlanResponse;
      request: ActionPlanContext;
    }>
  | Readonly<{ type: "fail-plan"; message: string }>
  | Readonly<{
      type: "receive-clarification";
      run: RunView;
      referenceDate: string;
    }>
  | Readonly<{ type: "request-clarification-answer" }>
  | Readonly<{ type: "fail-clarification-answer"; message: string }>
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
      return { status: "ready", plan: action.plan, request: action.request };
    case "fail-plan":
      return { status: "error", message: action.message };
    case "receive-clarification":
      return {
        status: "clarifying",
        run: action.run,
        referenceDate: action.referenceDate,
        isAnswering: false,
      };
    case "request-clarification-answer":
      if (_state.status !== "clarifying") return _state;
      return {
        status: "clarifying",
        run: _state.run,
        referenceDate: _state.referenceDate,
        isAnswering: true,
      };
    case "fail-clarification-answer":
      return _state.status === "clarifying"
        ? { ..._state, isAnswering: false, message: action.message }
        : _state;
    case "invalidate-plan":
      return initialWorkflowState;
  }
}
