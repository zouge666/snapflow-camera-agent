"use client";

import { useReducer, useRef, useState } from "react";

import { DemoStepper } from "../../app/_components/demo-stepper";
import {
  CameraAccessPanel,
  type CameraAccessPanelProps,
} from "../capture/camera-access-panel";
import { SamplePicker } from "../capture/sample-picker";
import { ReviewTextForm } from "../ocr-review/review-text-form";
import type { ReviewTextFields } from "../ocr-review/review-text";
import {
  createOcrReviewSource,
  createSampleReviewSource,
  getBrowserReviewContext,
} from "../ocr-review/review-source";
import type { ReviewSample } from "../ocr-review/sample-review";
import {
  ActionPlanClientError,
  requestActionPlan,
  type ActionPlanRequest,
} from "./action-plan-client";
import { ActionPlanPanel } from "./action-plan-panel";
import { initialWorkflowState, workflowReducer } from "./workflow-state";

type WorkflowDemoProps = Readonly<{
  samples: readonly [ReviewSample, ...ReviewSample[]];
  cameraPanelProps?: Omit<CameraAccessPanelProps, "onOcrInvalidated" | "onOcrResult">;
}>;

function toActionPlanRequest(fields: ReviewTextFields): ActionPlanRequest {
  return {
    source_text: fields.transcript,
    locale: fields.locale,
    timezone: fields.timezone,
    reference_date: fields.referenceDate,
  };
}

export function WorkflowDemo({ samples, cameraPanelProps }: WorkflowDemoProps) {
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [selectedSampleId, setSelectedSampleId] = useState(samples[0].id);
  const [reviewSource, setReviewSource] = useState(() =>
    createSampleReviewSource(samples[0]),
  );
  const lastRequest = useRef<ActionPlanRequest | null>(null);
  const requestVersion = useRef(0);
  const selectedSample =
    samples.find((sample) => sample.id === selectedSampleId) ?? samples[0];

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

  const selectSample = (sampleId: string) => {
    if (sampleId === selectedSample.id && reviewSource.kind === "sample") {
      return;
    }

    const sample = samples.find((candidate) => candidate.id === sampleId);
    if (sample === undefined) {
      return;
    }

    invalidatePlan();
    setSelectedSampleId(sampleId);
    setReviewSource(createSampleReviewSource(sample));
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
      <SamplePicker
        samples={samples}
        selectedSampleId={selectedSample.id}
        onSelect={selectSample}
      />
      <CameraAccessPanel
        {...cameraPanelProps}
        onOcrInvalidated={() => {
          invalidatePlan();
          setReviewSource((current) =>
            current.kind === "ocr" ? createSampleReviewSource(selectedSample) : current,
          );
        }}
        onOcrResult={(draft) => {
          invalidatePlan();
          setReviewSource(createOcrReviewSource(draft, getBrowserReviewContext()));
        }}
      />
      <ReviewTextForm
        key={reviewSource.id}
        source={reviewSource}
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
