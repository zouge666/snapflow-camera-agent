"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { RunView } from "../../lib/api/generated/types.gen";

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
  answerGuestRunClarification,
  clearActiveGuestRun,
  createGuestRun,
  createIdempotencyKey,
  GuestSessionClientError,
  readActiveGuestRun,
  resumeGuestRun,
} from "../session/guest-session-client";
import type { ActionPlanRequest, ActionPlanResponse } from "./action-plan-client";
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

function planFromRun(run: RunView): ActionPlanResponse {
  return {
    schema_version: "1.0",
    provider: "mock",
    summary: `${run.candidate_items.length} reviewed candidate ${
      run.candidate_items.length === 1 ? "action is" : "actions are"
    } ready for approval.`,
    candidate_actions: run.candidate_items.map((item) => ({
      id: item.id,
      title: item.title,
      owner: item.owner,
      due:
        item.due_text === null && item.due_date === null
          ? null
          : {
              iso_date: item.due_date,
              raw_text: item.due_text ?? item.due_date ?? "Unspecified date",
              resolution:
                item.due_date === null
                  ? "ambiguous"
                  : /^\d{4}-\d{2}-\d{2}$/.test(item.due_text ?? "")
                    ? "absolute"
                    : "relative",
            },
      priority: item.priority,
      evidence: item.evidence,
    })),
    clarifications: [],
  };
}

export function WorkflowDemo({ samples, cameraPanelProps }: WorkflowDemoProps) {
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [selectedSampleId, setSelectedSampleId] = useState(samples[0].id);
  const [reviewSource, setReviewSource] = useState(() =>
    createSampleReviewSource(samples[0]),
  );
  const lastRequest = useRef<ActionPlanRequest | null>(null);
  const lastIdempotencyKey = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const selectedSample =
    samples.find((sample) => sample.id === selectedSampleId) ?? samples[0];

  const showRun = useCallback(
    (run: RunView, referenceDate: string, request?: ActionPlanRequest) => {
      if (run.status === "interrupted_for_clarification") {
        dispatch({ type: "receive-clarification", run, referenceDate });
        return;
      }
      if (run.status === "interrupted_for_approval") {
        dispatch({
          type: "receive-plan",
          plan: planFromRun(run),
          request: request ?? { reference_date: referenceDate },
        });
        return;
      }
      dispatch({
        type: "fail-plan",
        message: "The saved run is not at a reviewable workflow step.",
      });
    },
    [],
  );

  useEffect(() => {
    const activeRun = readActiveGuestRun();
    if (activeRun === null) return;
    let cancelled = false;
    dispatch({ type: "request-plan" });
    void resumeGuestRun(activeRun.runId)
      .then((run) => {
        if (!cancelled) showRun(run, activeRun.referenceDate);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "fail-plan",
            message:
              error instanceof GuestSessionClientError
                ? error.message
                : "The saved run could not be resumed.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showRun]);

  const runRequest = async (request: ActionPlanRequest) => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    lastRequest.current = request;
    const idempotencyKey = lastIdempotencyKey.current ?? createIdempotencyKey();
    lastIdempotencyKey.current = idempotencyKey;
    dispatch({ type: "request-plan" });

    try {
      const run = await createGuestRun(request, idempotencyKey);
      if (requestVersion.current === version) {
        showRun(run, request.reference_date, request);
      }
    } catch (error) {
      if (requestVersion.current === version) {
        dispatch({
          type: "fail-plan",
          message:
            error instanceof GuestSessionClientError
              ? error.message
              : "The demo service returned an unexpected error.",
        });
      }
    }
  };

  const invalidatePlan = () => {
    requestVersion.current += 1;
    lastRequest.current = null;
    lastIdempotencyKey.current = null;
    clearActiveGuestRun();
    dispatch({ type: "invalidate-plan" });
  };

  const answerClarification = async (answer: string) => {
    if (state.status !== "clarifying") return;
    const question = state.run.clarification_questions[0];
    if (question === undefined) return;
    dispatch({ type: "request-clarification-answer" });
    try {
      const run = await answerGuestRunClarification(
        state.run.run_id,
        question.id,
        question.answer_kind,
        answer,
      );
      showRun(run, state.referenceDate, lastRequest.current ?? undefined);
    } catch (error) {
      dispatch({
        type: "fail-clarification-answer",
        message:
          error instanceof GuestSessionClientError
            ? error.message
            : "The clarification answer could not be saved.",
      });
    }
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
        onAnswerClarification={(answer) => void answerClarification(answer)}
        onRetry={() => {
          if (lastRequest.current) {
            void runRequest(lastRequest.current);
          }
        }}
      />
    </>
  );
}
