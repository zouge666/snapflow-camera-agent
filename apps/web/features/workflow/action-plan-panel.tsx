import type { ActionPlanResponse } from "./action-plan-client";
import { ActionReviewBoard } from "./action-review-board";
import { EvidenceRangeView } from "./evidence-range";
import type { WorkflowState } from "./workflow-state";

type ActionPlanPanelProps = Readonly<{
  state: WorkflowState;
  onRetry: () => void;
}>;

function ReadyPlan({ plan }: Readonly<{ plan: ActionPlanResponse }>) {
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
        <ActionReviewBoard candidates={plan.candidate_actions} />
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

export function ActionPlanPanel({ state, onRetry }: ActionPlanPanelProps) {
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

      {state.status === "ready" ? <ReadyPlan plan={state.plan} /> : null}
    </section>
  );
}
