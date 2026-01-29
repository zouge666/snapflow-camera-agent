"use client";

import Image from "next/image";
import { useEffect, useReducer, useRef } from "react";

import {
  countTranscriptWords,
  createReviewTextState,
  MAX_TRANSCRIPT_LENGTH,
  reviewTextReducer,
  type ReviewTextFields,
} from "./review-text";
import type { ReviewTextSource } from "./review-source";
import type { OcrTextSegment } from "../ocr/ocr-result";

type ReviewTextFormProps = Readonly<{
  source: ReviewTextSource;
  isBuilding?: boolean;
  onBuildPlan?: (fields: ReviewTextFields) => void;
  onReviewChange?: () => void;
}>;

const fieldErrorId = (field: keyof ReviewTextFields) => `${field}-error`;

const confidenceLabel = (segment: OcrTextSegment) => {
  if (segment.confidence === null) {
    return "Unknown confidence";
  }

  if (segment.level === "low") {
    return `Low confidence · ${Math.round(segment.confidence)}%`;
  }

  return `Check this text · ${Math.round(segment.confidence)}%`;
};

export function ReviewTextForm({
  source,
  isBuilding = false,
  onBuildPlan,
  onReviewChange,
}: ReviewTextFormProps) {
  const [state, dispatch] = useReducer(
    reviewTextReducer,
    source.initialFields,
    createReviewTextState,
  );
  const transcriptRef = useRef<HTMLTextAreaElement>(null);
  const wordCount = countTranscriptWords(state.fields.transcript);
  const flaggedSegments =
    source.ocrResult?.segments.filter(
      (segment) => segment.level !== "high" && segment.text.trim().length > 0,
    ) ?? [];
  const confidenceNavigationAvailable = !state.isDirty;

  useEffect(() => {
    if (!state.isDirty || state.status === "confirmed") {
      return;
    }

    const guardDirtyReview = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", guardDirtyReview);
    return () => window.removeEventListener("beforeunload", guardDirtyReview);
  }, [state.isDirty, state.status]);

  const updateField = (field: keyof ReviewTextFields, value: string) => {
    dispatch({ type: "change-field", field, value });
    onReviewChange?.();
  };

  const focusOriginalSegment = (segment: OcrTextSegment) => {
    const textarea = transcriptRef.current;

    if (
      textarea === null ||
      !confidenceNavigationAvailable ||
      state.fields.transcript.slice(segment.start, segment.end) !== segment.text
    ) {
      return;
    }

    textarea.focus();
    textarea.setSelectionRange(segment.start, segment.end);
  };

  return (
    <section className="review-shell" aria-labelledby="review-title">
      <div className="review-layout">
        <figure className="sample-card">
          <div className="sample-card-heading">
            <div>
              <p className="section-kicker">Source image</p>
              <h2>{source.title}</h2>
            </div>
            <span className="status-pill status-pill--review">{source.badge}</span>
          </div>
          <div className="sample-image-frame">
            <Image
              src={source.image.src}
              width={source.image.width}
              height={source.image.height}
              sizes="(max-width: 52rem) calc(100vw - 3rem), 42vw"
              alt={source.image.alt}
              priority={source.kind === "sample"}
              unoptimized={source.image.unoptimized}
            />
          </div>
          <figcaption>{source.caption}</figcaption>
        </figure>

        <form
          className="review-form"
          noValidate
          onReset={() => {
            dispatch({ type: "reset" });
            onReviewChange?.();
          }}
          onSubmit={(event) => {
            event.preventDefault();
            dispatch({ type: "submit" });
          }}
        >
          <div className="workspace-card-heading review-form-heading">
            <div>
              <span>Step 02</span>
              <h2 id="review-title">
                {source.kind === "sample"
                  ? "Review the sample transcript"
                  : "Review the OCR transcript"}
              </h2>
            </div>
            <span className="status-pill status-pill--neutral">
              {state.status === "confirmed"
                ? "Confirmed"
                : state.isDirty
                  ? "Unsaved edits"
                  : "Needs review"}
            </span>
          </div>

          {source.ocrResult !== null ? (
            <section className="ocr-review-map" aria-labelledby="ocr-review-map-title">
              <div className="ocr-review-map-heading">
                <div>
                  <p className="section-kicker">Confidence review</p>
                  <h3 id="ocr-review-map-title">
                    {flaggedSegments.length === 0
                      ? "No text range was flagged."
                      : `${flaggedSegments.length.toLocaleString("en-US")} text ${
                          flaggedSegments.length === 1 ? "range" : "ranges"
                        } to check.`}
                  </h3>
                </div>
                <span>
                  Overall:{" "}
                  {source.ocrResult.confidence === null
                    ? "unknown"
                    : `${Math.round(source.ocrResult.confidence)}%`}
                </span>
              </div>
              {flaggedSegments.length > 0 ? (
                <ol className="ocr-review-segments">
                  {flaggedSegments.map((segment) => (
                    <li key={`${segment.start}-${segment.end}`}>
                      <button
                        type="button"
                        disabled={!confidenceNavigationAvailable}
                        aria-label={`${confidenceLabel(segment)}. Review original characters ${segment.start} to ${segment.end}.`}
                        onClick={() => focusOriginalSegment(segment)}
                      >
                        <span
                          className={`ocr-confidence ocr-confidence--${segment.level}`}
                        >
                          {confidenceLabel(segment)}
                        </span>
                        <q>{segment.text}</q>
                        <small>
                          Original characters {segment.start}–{segment.end}
                        </small>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="ocr-review-map-empty">
                  Confidence is still only a hint. Read the complete draft before
                  confirming it.
                </p>
              )}
              {state.isDirty ? (
                <p className="ocr-review-map-guard" role="status">
                  Original confidence links are paused after editing so stale offsets
                  cannot select the wrong text. Undo or reset to use them again.
                </p>
              ) : (
                <p className="ocr-review-map-help">
                  Select a flagged range to focus the matching text in the editor.
                </p>
              )}
            </section>
          ) : null}

          <div className="form-field form-field--transcript">
            <div className="field-heading">
              <label htmlFor="transcript">Meeting text</label>
              <span
                className={
                  state.fields.transcript.length > MAX_TRANSCRIPT_LENGTH
                    ? "character-count character-count--over"
                    : "character-count"
                }
                aria-live="polite"
              >
                {state.fields.transcript.length.toLocaleString("en-US")} /{" "}
                {MAX_TRANSCRIPT_LENGTH.toLocaleString("en-US")} characters ·{" "}
                {wordCount.toLocaleString("en-US")} {wordCount === 1 ? "word" : "words"}
              </span>
            </div>
            <p id="transcript-help" className="field-help">
              {source.kind === "sample"
                ? "Correct anything the OCR step got wrong. This fixture starts with a saved transcript so the review flow works offline."
                : "Use the confidence links as a starting point, then correct the full OCR draft. Only the version you explicitly confirm can leave this device."}
            </p>
            <textarea
              ref={transcriptRef}
              id="transcript"
              name="transcript"
              rows={12}
              value={state.fields.transcript}
              aria-describedby={`transcript-help${state.errors.transcript ? ` ${fieldErrorId("transcript")}` : ""}`}
              aria-invalid={Boolean(state.errors.transcript)}
              onChange={(event) => updateField("transcript", event.target.value)}
            />
            {state.errors.transcript ? (
              <p className="field-error" id={fieldErrorId("transcript")}>
                {state.errors.transcript}
              </p>
            ) : null}
          </div>

          <fieldset className="context-fields">
            <legend>Interpretation context</legend>
            <p className="field-help">
              These values make relative dates such as “Friday” deterministic.
            </p>
            <div className="context-field-grid">
              <div className="form-field">
                <label htmlFor="locale">Locale</label>
                <input
                  id="locale"
                  name="locale"
                  type="text"
                  value={state.fields.locale}
                  aria-describedby={
                    state.errors.locale ? fieldErrorId("locale") : undefined
                  }
                  aria-invalid={Boolean(state.errors.locale)}
                  onChange={(event) => updateField("locale", event.target.value)}
                />
                {state.errors.locale ? (
                  <p className="field-error" id={fieldErrorId("locale")}>
                    {state.errors.locale}
                  </p>
                ) : null}
              </div>
              <div className="form-field">
                <label htmlFor="timezone">Timezone</label>
                <input
                  id="timezone"
                  name="timezone"
                  type="text"
                  value={state.fields.timezone}
                  aria-describedby={
                    state.errors.timezone ? fieldErrorId("timezone") : undefined
                  }
                  aria-invalid={Boolean(state.errors.timezone)}
                  onChange={(event) => updateField("timezone", event.target.value)}
                />
                {state.errors.timezone ? (
                  <p className="field-error" id={fieldErrorId("timezone")}>
                    {state.errors.timezone}
                  </p>
                ) : null}
              </div>
              <div className="form-field">
                <label htmlFor="referenceDate">Reference date</label>
                <input
                  id="referenceDate"
                  name="referenceDate"
                  type="date"
                  value={state.fields.referenceDate}
                  aria-describedby={
                    state.errors.referenceDate
                      ? fieldErrorId("referenceDate")
                      : undefined
                  }
                  aria-invalid={Boolean(state.errors.referenceDate)}
                  onChange={(event) => updateField("referenceDate", event.target.value)}
                />
                {state.errors.referenceDate ? (
                  <p className="field-error" id={fieldErrorId("referenceDate")}>
                    {state.errors.referenceDate}
                  </p>
                ) : null}
              </div>
            </div>
          </fieldset>

          <div className="handoff-note" id="handoff-note">
            <span className="handoff-icon" aria-hidden="true">
              →
            </span>
            <div>
              <strong>The next step sends text, not the image.</strong>
              <p>
                Nothing is sent while you edit. After confirmation, the next step will
                send only this final text and its interpretation context to the
                action-plan service. The image stays on this device.
              </p>
            </div>
          </div>

          <div className="confirmation-field">
            <label>
              <input
                type="checkbox"
                checked={state.confirmationChecked}
                aria-describedby={
                  state.errors.confirmation
                    ? "confirmation-error handoff-note"
                    : "handoff-note"
                }
                aria-invalid={Boolean(state.errors.confirmation)}
                onChange={(event) =>
                  dispatch({
                    type: "toggle-confirmation",
                    checked: event.target.checked,
                  })
                }
              />
              <span>I reviewed this text and want to use it in the next step.</span>
            </label>
            {state.errors.confirmation ? (
              <p className="field-error" id="confirmation-error">
                {state.errors.confirmation}
              </p>
            ) : null}
          </div>

          {state.status === "confirmed" ? (
            <div className="confirmation-success" role="status">
              <strong>Text confirmed locally.</strong>
              <span>
                This exact reviewed version is now the only text eligible for the next
                request. No request has been sent yet.
              </span>
              {onBuildPlan ? (
                <button
                  className="button button--accent"
                  type="button"
                  disabled={isBuilding}
                  onClick={() => onBuildPlan(state.fields)}
                >
                  {isBuilding ? "Building demo plan…" : "Build demo action plan"}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="review-actions">
            <button
              className="button button--quiet"
              type="button"
              disabled={state.history.length === 0}
              onClick={() => {
                dispatch({ type: "undo" });
                onReviewChange?.();
              }}
            >
              Undo last edit
            </button>
            <button
              className="button button--quiet"
              type="reset"
              disabled={!state.isDirty && state.status !== "confirmed"}
            >
              {source.kind === "sample" ? "Reset sample" : "Reset OCR draft"}
            </button>
            <button className="button button--primary" type="submit">
              Confirm reviewed text
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
