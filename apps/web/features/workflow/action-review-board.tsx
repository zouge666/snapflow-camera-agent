"use client";

import { useReducer, useRef, useState } from "react";

import type { CandidateAction } from "./action-plan-client";
import {
  actionReviewReducer,
  createActionReviewState,
  getActionAuditDiff,
  selectApprovedActions,
  summarizeActionDecisions,
  type ActionDecision,
  type ActionPriority,
  type ActionReviewAction,
  type ActionReviewItem,
  type ActionReviewState,
} from "./action-review";
import { EvidenceRangeView } from "./evidence-range";
import {
  createIcsExportRequest,
  downloadIcsFile,
  IcsExportClientError,
  requestIcsExport,
  type IcsExportWarning,
} from "./ics-export-client";

type ActionReviewBoardProps = Readonly<{
  candidates: readonly CandidateAction[];
  referenceDate: string;
}>;

type ActionReviewBoardViewProps = Readonly<{
  state: ActionReviewState;
  exportState: IcsDownloadState;
  onAction: (action: ActionReviewAction) => void;
  onDownload: () => void;
}>;

export type IcsDownloadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{
      status: "success";
      exportedCount: number;
      warnings: readonly IcsExportWarning[];
    }>
  | Readonly<{ status: "error"; message: string }>;

export const initialIcsDownloadState: IcsDownloadState = { status: "idle" };

const priorities: readonly ActionPriority[] = ["unknown", "low", "medium", "high"];

function decisionLabel(decision: ActionDecision): string {
  switch (decision) {
    case "pending":
      return "Pending review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
  }
}

function fieldErrorId(id: string, field: "title" | "owner" | "dueDate") {
  return `${id}-${field}-error`;
}

function ActionEditForm({
  item,
  onAction,
}: Readonly<{
  item: ActionReviewItem;
  onAction: (action: ActionReviewAction) => void;
}>) {
  const id = item.original.id;

  return (
    <form
      className="action-edit-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onAction({ type: "save-edit", id });
      }}
    >
      <div className="action-edit-grid">
        <div className="action-edit-field action-edit-field--title">
          <label htmlFor={`${id}-title`}>Action title</label>
          <input
            id={`${id}-title`}
            value={item.draft.title}
            aria-describedby={item.errors.title ? fieldErrorId(id, "title") : undefined}
            aria-invalid={Boolean(item.errors.title)}
            onChange={(event) =>
              onAction({
                type: "change-text-field",
                id,
                field: "title",
                value: event.target.value,
              })
            }
          />
          {item.errors.title ? (
            <p className="field-error" id={fieldErrorId(id, "title")}>
              {item.errors.title}
            </p>
          ) : null}
        </div>

        <div className="action-edit-field">
          <label htmlFor={`${id}-owner`}>Owner</label>
          <input
            id={`${id}-owner`}
            value={item.draft.owner}
            placeholder="Leave blank for unknown"
            aria-describedby={item.errors.owner ? fieldErrorId(id, "owner") : undefined}
            aria-invalid={Boolean(item.errors.owner)}
            onChange={(event) =>
              onAction({
                type: "change-text-field",
                id,
                field: "owner",
                value: event.target.value,
              })
            }
          />
          {item.errors.owner ? (
            <p className="field-error" id={fieldErrorId(id, "owner")}>
              {item.errors.owner}
            </p>
          ) : null}
        </div>

        <div className="action-edit-field">
          <label htmlFor={`${id}-date`}>Date</label>
          <input
            id={`${id}-date`}
            type="date"
            value={item.draft.dueDate}
            aria-describedby={
              item.errors.dueDate ? fieldErrorId(id, "dueDate") : undefined
            }
            aria-invalid={Boolean(item.errors.dueDate)}
            onChange={(event) =>
              onAction({
                type: "change-text-field",
                id,
                field: "dueDate",
                value: event.target.value,
              })
            }
          />
          {item.errors.dueDate ? (
            <p className="field-error" id={fieldErrorId(id, "dueDate")}>
              {item.errors.dueDate}
            </p>
          ) : null}
        </div>

        <div className="action-edit-field">
          <label htmlFor={`${id}-priority`}>Priority</label>
          <select
            id={`${id}-priority`}
            value={item.draft.priority}
            onChange={(event) => {
              const priority = priorities.find(
                (candidate) => candidate === event.target.value,
              );
              if (priority) {
                onAction({ type: "change-priority", id, priority });
              }
            }}
          >
            {priorities.map((priority) => (
              <option value={priority} key={priority}>
                {priority}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="edit-decision-note">
        Saving an edit returns this item to pending review. Original evidence stays
        locked.
      </p>
      <div className="action-edit-buttons">
        <button
          className="button button--quiet"
          type="button"
          onClick={() => onAction({ type: "cancel-edit", id })}
        >
          Cancel
        </button>
        <button className="button button--primary" type="submit">
          Save changes
        </button>
      </div>
    </form>
  );
}

function ActionAudit({ item }: Readonly<{ item: ActionReviewItem }>) {
  const changes = getActionAuditDiff(item);

  return (
    <div className="action-audit">
      <div className="action-audit-heading">
        <h4>Audit diff</h4>
        <span>{changes.length === 0 ? "Original candidate" : "Edited locally"}</span>
      </div>
      {changes.length === 0 ? (
        <p>No saved field edits.</p>
      ) : (
        <dl>
          {changes.map((change) => (
            <div key={change.field}>
              <dt>{change.field}</dt>
              <dd>
                <span>{change.before}</span>
                <span aria-hidden="true">→</span>
                <strong>{change.after}</strong>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="evidence-lock-note">
        Evidence below always comes from the original candidate.
      </p>
    </div>
  );
}

function CandidateReviewCard({
  item,
  index,
  onAction,
}: Readonly<{
  item: ActionReviewItem;
  index: number;
  onAction: (action: ActionReviewAction) => void;
}>) {
  const id = item.original.id;

  return (
    <li className="candidate-card" data-decision={item.decision}>
      <div className="candidate-heading">
        <div>
          <span className="candidate-number">
            Candidate {String(index + 1).padStart(2, "0")}
          </span>
          <span className="candidate-id">{id}</span>
        </div>
        <span
          className={`status-pill status-pill--decision status-pill--${item.decision}`}
        >
          {decisionLabel(item.decision)}
        </span>
      </div>

      {item.mode === "editing" ? (
        <ActionEditForm item={item} onAction={onAction} />
      ) : (
        <>
          <h3>{item.current.title}</h3>
          <dl className="candidate-fields">
            <div>
              <dt>Owner</dt>
              <dd className={item.current.owner === null ? "is-unknown" : undefined}>
                {item.current.owner ?? "unknown"}
              </dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd className={item.current.dueDate === null ? "is-unknown" : undefined}>
                {item.current.dueDate ?? "unknown"}
              </dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd
                className={
                  item.current.priority === "unknown" ? "is-unknown" : undefined
                }
              >
                {item.current.priority}
              </dd>
            </div>
          </dl>
          {item.original.due ? (
            <p className="due-source">
              Model interpretation from <q>{item.original.due.raw_text}</q> ·{" "}
              {item.original.due.resolution}
            </p>
          ) : null}

          <div className="candidate-decision-controls">
            <button
              className="button button--quiet"
              type="button"
              onClick={() => onAction({ type: "start-edit", id })}
            >
              Edit
            </button>
            <button
              className="button button--reject"
              type="button"
              aria-pressed={item.decision === "rejected"}
              onClick={() => onAction({ type: "decide", id, decision: "rejected" })}
            >
              Reject
            </button>
            <button
              className="button button--primary"
              type="button"
              aria-pressed={item.decision === "approved"}
              onClick={() => onAction({ type: "decide", id, decision: "approved" })}
            >
              Approve
            </button>
          </div>
        </>
      )}

      <ActionAudit item={item} />
      <div className="candidate-evidence-list">
        <strong>Original evidence</strong>
        {item.original.evidence.map((range) => (
          <EvidenceRangeView key={`${id}-${range.start}-${range.end}`} range={range} />
        ))}
      </div>
    </li>
  );
}

function ActionExportPanel({
  reviewState,
  exportState,
  onDownload,
}: Readonly<{
  reviewState: ActionReviewState;
  exportState: IcsDownloadState;
  onDownload: () => void;
}>) {
  const approvedItems = selectApprovedActions(reviewState);
  const datedCount = approvedItems.filter((item) => item.dueDate !== null).length;
  const undatedCount = approvedItems.length - datedCount;
  const isLoading = exportState.status === "loading";

  return (
    <section className="action-export-panel" aria-labelledby="action-export-title">
      <div className="action-export-heading">
        <div>
          <p className="section-kicker">Controlled export</p>
          <h2 id="action-export-title">Download approved dates.</h2>
        </div>
        <p>
          The local demo API builds this calendar in memory. It does not keep a file,
          and it never invents a date for an undated item.
        </p>
      </div>

      <dl className="export-counts">
        <div>
          <dt>Approved</dt>
          <dd>{approvedItems.length}</dd>
        </div>
        <div>
          <dt>Calendar-ready</dt>
          <dd>{datedCount}</dd>
        </div>
        <div>
          <dt>Without a date</dt>
          <dd>{undatedCount}</dd>
        </div>
      </dl>

      {undatedCount > 0 && exportState.status !== "success" ? (
        <p className="export-warning" role="note">
          {undatedCount} approved {undatedCount === 1 ? "item has" : "items have"} no
          date and will be skipped.
        </p>
      ) : null}

      {exportState.status === "success" ? (
        <div className="export-result" role="status" aria-live="polite">
          <strong>
            {exportState.exportedCount > 0
              ? `${exportState.exportedCount} calendar ${
                  exportState.exportedCount === 1 ? "event" : "events"
                } downloaded.`
              : "No file was downloaded because the approved items have no date."}
          </strong>
          {exportState.warnings.map((warning) => (
            <span key={`${warning.action_id}-${warning.code}`}>{warning.message}</span>
          ))}
        </div>
      ) : null}

      {exportState.status === "error" ? (
        <p className="export-error" role="alert">
          {exportState.message}
        </p>
      ) : null}

      <button
        className="button button--primary action-export-button"
        type="button"
        disabled={approvedItems.length === 0 || isLoading}
        onClick={onDownload}
      >
        {isLoading ? "Preparing calendar…" : "Download approved .ics"}
      </button>
      <p className="export-boundary-note">
        Only individually approved items are sent to this demo route. Pending and
        rejected items stay out of the file.
      </p>
    </section>
  );
}

export function ActionReviewBoardView({
  state,
  exportState,
  onAction,
  onDownload,
}: ActionReviewBoardViewProps) {
  const summary = summarizeActionDecisions(state);

  return (
    <section className="action-review-board" aria-labelledby="action-review-title">
      <div className="action-review-heading">
        <div>
          <p className="section-kicker">Human review</p>
          <h2 id="action-review-title">Decide each candidate separately.</h2>
        </div>
        <p>
          Nothing is approved by default. Approved items reach the local demo API only
          when you choose the calendar download below.
        </p>
      </div>

      <div className="decision-summary" role="status" aria-live="polite">
        <strong>{summary.approved} approved</strong>
        <span>{summary.rejected} rejected</span>
        <span>{summary.pending} pending</span>
      </div>

      <ol className="candidate-list" aria-label="Candidate action reviews">
        {state.items.map((item, index) => (
          <CandidateReviewCard
            item={item}
            index={index}
            onAction={onAction}
            key={item.original.id}
          />
        ))}
      </ol>
      <ActionExportPanel
        reviewState={state}
        exportState={exportState}
        onDownload={onDownload}
      />
    </section>
  );
}

export function ActionReviewBoard({
  candidates,
  referenceDate,
}: ActionReviewBoardProps) {
  const [state, dispatch] = useReducer(
    actionReviewReducer,
    createActionReviewState(candidates),
  );
  const [exportState, setExportState] = useState<IcsDownloadState>(
    initialIcsDownloadState,
  );
  const exportVersion = useRef(0);

  const handleAction = (action: ActionReviewAction) => {
    exportVersion.current += 1;
    setExportState(initialIcsDownloadState);
    dispatch(action);
  };

  const handleDownload = async () => {
    const approvedItems = selectApprovedActions(state);
    if (approvedItems.length === 0) {
      return;
    }

    const version = exportVersion.current + 1;
    exportVersion.current = version;
    setExportState({ status: "loading" });

    try {
      const response = await requestIcsExport(
        createIcsExportRequest(approvedItems, referenceDate),
      );
      if (exportVersion.current !== version) {
        return;
      }
      if (response.exported_action_ids.length > 0) {
        downloadIcsFile(response);
      }
      setExportState({
        status: "success",
        exportedCount: response.exported_action_ids.length,
        warnings: response.warnings,
      });
    } catch (error) {
      if (exportVersion.current !== version) {
        return;
      }
      setExportState({
        status: "error",
        message:
          error instanceof IcsExportClientError
            ? error.message
            : "The browser could not download this calendar file.",
      });
    }
  };

  return (
    <ActionReviewBoardView
      state={state}
      exportState={exportState}
      onAction={handleAction}
      onDownload={() => void handleDownload()}
    />
  );
}
