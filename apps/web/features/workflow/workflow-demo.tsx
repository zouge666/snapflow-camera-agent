"use client";

import { useReducer, useRef } from "react";

import { DemoStepper } from "../../app/_components/demo-stepper";
import { ReviewTextForm } from "../ocr-review/review-text-form";
import type { ReviewTextFields } from "../ocr-review/review-text";
import type { ReviewSample } from "../ocr-review/sample-review";
import {
  ActionPlanClientError,
  requestActionPlan,
  type ActionPlanRequest,
} from "./action-plan-client";
import { ActionPlanPanel } from "./action-plan-panel";
import { initialWorkflowState, workflowReducer } from "./workflow-state";

type WorkflowDemoProps = Readonly<{
  sample: ReviewSample;
}>;

function toActionPlanRequest(fields: ReviewTextFields): ActionPlanRequest {
  return {
    source_text: fields.transcript,
    locale: fields.locale,
    timezone: fields.timezone,
    reference_date: fields.referenceDate,
  };
}

export function WorkflowDemo({ sample }: WorkflowDemoProps) {
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState);
  const lastRequest = useRef<ActionPlanRequest | null>(null);
  const requestVersion = useRef(0);

  const runRequest = async (request: ActionPlanRequest) => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    lastRequest.current = request;
    dispatch({ type: "request-plan" });

    try {
      const plan = await requestActionPlan(request);
      if (requestVersion.current === version) {
        dispatch({ type: "receive-plan", plan, request });
      }
    } catch (error) {
      if (requestVersion.current === version) {
        dispatch({
          type: "fail-plan",
          message:
            error instanceof ActionPlanClientError
              ? error.message
              : "The demo service returned an unexpected error.",
        });
      }
    }
  };

  const invalidatePlan = () => {
    requestVersion.current += 1;
    lastRequest.current = null;
    dispatch({ type: "invalidate-plan" });
  };

  return (
    <>
      <DemoStepper currentStep={state.status === "review" ? 1 : 2} />
      <div className="demo-provider-banner">
        <div>
          <span className="provider-dot" aria-hidden="true" />
          <strong>Demo provider</strong>
        </div>
        <p>
          This workflow uses deterministic fixture logic. It does not call DeepSeek or
          any other external model.
        </p>
      </div>
      <ReviewTextForm
        sample={sample}
        isBuilding={state.status === "loading"}
        onBuildPlan={(fields) => void runRequest(toActionPlanRequest(fields))}
        onReviewChange={invalidatePlan}
      />
      <ActionPlanPanel
        state={state}
        onRetry={() => {
          if (lastRequest.current) {
            void runRequest(lastRequest.current);
          }
        }}
      />
    </>
  );
}
