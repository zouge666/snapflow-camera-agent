import type { ActionPlanResponse, EvidenceRange } from "./action-plan-client";
import type { WorkflowState } from "./workflow-state";

type ActionPlanPanelProps = Readonly<{
  state: WorkflowState;
  onRetry: () => void;
}>;

function Evidence({ range }: Readonly<{ range: EvidenceRange }>) {
  return (
    <div className="action-evidence">
      <blockquote>“{range.quote}”</blockquote>
      <span>
        Source characters {range.start}–{range.end}
      </span>
    </div>
  );
}

function ReadyPlan({ plan }: Readonly<{ plan: ActionPlanResponse }>) {
  return (
    <>
      <div className="plan-summary">
        <p className="section-kicker">Plan summary</p>
        <h2 id="action-plan-title">{plan.summary}</h2>
        <p>
          These are deterministic candidates for review, not approved tasks. Unknown
          values stay unknown.
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
        <ol className="candidate-list" aria-label="Candidate actions">
          {plan.candidate_actions.map((candidate, index) => (
            <li className="candidate-card" key={candidate.id}>
              <div className="candidate-heading">
                <span className="candidate-number">
                  Candidate {String(index + 1).padStart(2, "0")}
                </span>
                <span className="candidate-id">{candidate.id}</span>
              </div>
              <h3>{candidate.title}</h3>
              <dl className="candidate-fields">
                <div>
                  <dt>Owner</dt>
                  <dd className={candidate.owner === null ? "is-unknown" : undefined}>
                    {candidate.owner ?? "unknown"}
                  </dd>
                </div>
                <div>
                  <dt>Date</dt>
                  <dd
                    className={
                      candidate.due?.iso_date == null ? "is-unknown" : undefined
                    }
                  >
                    {candidate.due?.iso_date ?? "unknown"}
                  </dd>
                </div>
                <div>
                  <dt>Priority</dt>
                  <dd
                    className={
                      candidate.priority === "unknown" ? "is-unknown" : undefined
                    }
                  >
                    {candidate.priority}
                  </dd>
                </div>
              </dl>
              {candidate.due ? (
                <p className="due-source">
                  Interpreted from <q>{candidate.due.raw_text}</q> ·{" "}
                  {candidate.due.resolution}
                </p>
              ) : null}
              <div className="candidate-evidence-list">
                <strong>Evidence</strong>
                {candidate.evidence.map((range) => (
                  <Evidence
                    key={`${candidate.id}-${range.start}-${range.end}`}
                    range={range}
                  />
                ))}
              </div>
            </li>
          ))}
        </ol>
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
                <Evidence range={clarification.evidence} />
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
