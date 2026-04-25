"use client";

import { useState, type FormEvent } from "react";

import type { ActionPlanRequest, ActionPlanResponse } from "./action-plan-client";
import { ActionReviewBoard } from "./action-review-board";
import { EvidenceRangeView } from "./evidence-range";
import type { WorkflowState } from "./workflow-state";

type ActionPlanPanelProps = Readonly<{
  state: WorkflowState;
  onRetry: () => void;
  onAnswerClarification: (answer: string) => void;
}>;

function ClarificationForm({
  state,
  onAnswer,
}: Readonly<{
  state: Extract<WorkflowState, { status: "clarifying" }>;
  onAnswer: (answer: string) => void;
}>) {
  const question = state.run.clarification_questions[0];
  const [answer, setAnswer] = useState("");
  if (question === undefined) return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = answer.trim();
    if (normalized) onAnswer(normalized);
  };

  return (
    <section className="clarification-list" aria-labelledby="clarification-title">
      <p className="section-kicker">
        Clarification {state.run.clarification_count + 1} of 2
      </p>
      <h2 id="clarification-title">{question.question}</h2>
      <p>{question.reason}</p>
      <span>{question.field_path}</span>
      {question.evidence ? <EvidenceRangeView range={question.evidence} /> : null}
      <form className="clarification-form" onSubmit={submit}>
        {question.answer_kind === "option" ? (
          <fieldset>
            <legend>Choose the value supported by your notes</legend>
            {(question.options ?? []).map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name="clarification-answer"
                  value={option}
                  checked={answer === option}
                  onChange={() => setAnswer(option)}
                />
                <span>{option}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <label>
            <span>Your answer</span>
            <input
              type="text"
              value={answer}
              maxLength={1000}
              placeholder="For example, 2026-01-22"
              onChange={(event) => setAnswer(event.currentTarget.value)}
            />
          </label>
        )}
        <p className="privacy-note">
          This resumes the same saved run. It does not create another model request.
        </p>
        {state.message ? <p role="alert">{state.message}</p> : null}
        <button
          className="button button--accent"
          type="submit"
          disabled={state.isAnswering || !answer.trim()}
        >
          {state.isAnswering ? "Saving answer…" : "Resume this run"}
        </button>
      </form>
    </section>
  );
}

function ReadyPlan({
  plan,
  request,
}: Readonly<{
  plan: ActionPlanResponse;
  request: Pick<ActionPlanRequest, "reference_date">;
}>) {
  return (
    <>
      <div className="plan-summary">
        <p className="section-kicker">Plan summary</p>
        <h2 id="action-plan-title">{plan.summary}</h2>
        <p>
          These are deterministic candidates, not approved tasks. Review every item;
          unknown values stay unknown until you explicitly edit them.
        </p>
      </div>

      {plan.candidate_actions.length === 0 ? (
        <div className="plan-empty">
          <strong>No candidate actions found.</strong>
          <p>
            The demo only recognizes the supported synthetic sample and will not invent
            actions from other text.
          </p>
        </div>
      ) : (
        <ActionReviewBoard
          candidates={plan.candidate_actions}
          referenceDate={request.reference_date}
        />
      )}

      {plan.clarifications.length > 0 ? (
        <section className="clarification-list" aria-labelledby="clarification-title">
          <p className="section-kicker">Needs clarification</p>
          <h2 id="clarification-title">
            The demo left {plan.clarifications.length}{" "}
            {plan.clarifications.length === 1 ? "detail" : "details"} unresolved.
          </h2>
          {plan.clarifications.map((clarification) => (
            <article key={clarification.id}>
              <span>{clarification.field_path}</span>
              <h3>{clarification.question}</h3>
              <p>{clarification.reason}</p>
              {clarification.evidence ? (
                <EvidenceRangeView range={clarification.evidence} />
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
    </>
  );
}

export function ActionPlanPanel({
  state,
  onRetry,
  onAnswerClarification,
}: ActionPlanPanelProps) {
  if (state.status === "review") {
    return null;
  }

  return (
    <section className="action-plan-shell" aria-labelledby="action-plan-title">
      <div className="provider-strip">
        <div>
          <span className="provider-dot" aria-hidden="true" />
          <strong>Demo provider</strong>
        </div>
        <span>Mock contract · schema 1.0</span>
      </div>

      {state.status === "loading" ? (
        <div className="plan-message" role="status" aria-live="polite">
          <span className="loading-mark" aria-hidden="true" />
          <div>
            <h2 id="action-plan-title">Building the deterministic plan…</h2>
            <p>The reviewed text is being sent to the local mock API.</p>
          </div>
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="plan-message plan-message--error" role="alert">
          <div>
            <h2 id="action-plan-title">The demo plan could not be loaded.</h2>
            <p>{state.message}</p>
          </div>
          <button className="button button--quiet" type="button" onClick={onRetry}>
            Retry demo request
          </button>
        </div>
      ) : null}

      {state.status === "clarifying" ? (
        <ClarificationForm
          key={state.run.clarification_questions[0]?.id}
          state={state}
          onAnswer={onAnswerClarification}
        />
      ) : null}

      {state.status === "ready" ? (
        <ReadyPlan plan={state.plan} request={state.request} />
      ) : null}
    </section>
  );
}
