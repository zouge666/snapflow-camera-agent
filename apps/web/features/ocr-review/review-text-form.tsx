"use client";

import Image from "next/image";
import { useReducer } from "react";

import {
  createReviewTextState,
  MAX_TRANSCRIPT_LENGTH,
  reviewTextReducer,
  type ReviewTextFields,
} from "./review-text";
import type { ReviewSample } from "./sample-review";

type ReviewTextFormProps = Readonly<{
  sample: ReviewSample;
  isBuilding?: boolean;
  onBuildPlan?: (fields: ReviewTextFields) => void;
  onReviewChange?: () => void;
}>;

const fieldErrorId = (field: keyof ReviewTextFields) => `${field}-error`;

export function ReviewTextForm({
  sample,
  isBuilding = false,
  onBuildPlan,
  onReviewChange,
}: ReviewTextFormProps) {
  const [state, dispatch] = useReducer(
    reviewTextReducer,
    {
      transcript: sample.transcript,
      locale: sample.locale,
      timezone: sample.timezone,
      referenceDate: sample.referenceDate,
    },
    createReviewTextState,
  );

  const updateField = (field: keyof ReviewTextFields, value: string) => {
    dispatch({ type: "change-field", field, value });
    onReviewChange?.();
  };

  return (
    <section className="review-shell" aria-labelledby="review-title">
      <div className="review-layout">
        <figure className="sample-card">
          <div className="sample-card-heading">
            <div>
              <p className="section-kicker">Source image</p>
              <h2>Northstar planning board</h2>
            </div>
            <span className="status-pill status-pill--review">Synthetic sample</span>
          </div>
          <div className="sample-image-frame">
            <Image
              src={sample.image.src}
              width={sample.image.width}
              height={sample.image.height}
              sizes="(max-width: 52rem) calc(100vw - 3rem), 42vw"
              alt={sample.image.alt}
              priority
            />
          </div>
          <figcaption>
            Fixture <code>{sample.id}</code>. No personal or confidential data.
          </figcaption>
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
              <h2 id="review-title">Review the sample transcript</h2>
            </div>
            <span className="status-pill status-pill--neutral">
              {state.status === "confirmed" ? "Confirmed" : "Needs review"}
            </span>
          </div>

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
                {MAX_TRANSCRIPT_LENGTH.toLocaleString("en-US")}
              </span>
            </div>
            <p id="transcript-help" className="field-help">
              Correct anything the OCR step got wrong. This fixture starts with a saved
              transcript so the review flow works offline.
            </p>
            <textarea
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
                send only this text and its interpretation context to the action-plan
                service. The image stays on this device.
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
                The review gate is complete. No request has been sent yet. Build the
                demo plan when you are ready.
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
            <button className="button button--quiet" type="reset">
              Reset sample
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
