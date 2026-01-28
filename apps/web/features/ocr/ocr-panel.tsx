"use client";

import { useEffect, useRef, useState } from "react";

import {
  createOcrRunner,
  OcrCancelledError,
  type OcrProgress,
  type OcrRunner,
} from "./ocr-runner";
import type { OcrConfidenceLevel, OcrResult } from "./ocr-result";

type OcrPanelProps = Readonly<{
  imageUrl: string;
  runner?: OcrRunner;
}>;

type OcrPanelState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "running"; progress: OcrProgress }>
  | Readonly<{ status: "success"; result: OcrResult }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "error" }>;

const confidenceLabels: Readonly<Record<OcrConfidenceLevel, string>> = {
  high: "High confidence",
  review: "Check this text",
  low: "Low confidence",
  unknown: "Unknown confidence",
};

export function OcrPanel({ imageUrl, runner: suppliedRunner }: OcrPanelProps) {
  const [runner] = useState<OcrRunner>(() => suppliedRunner ?? createOcrRunner());
  const runVersionRef = useRef(0);
  const [state, setState] = useState<OcrPanelState>({ status: "idle" });

  useEffect(() => {
    const currentRunner = runner;

    return () => {
      runVersionRef.current += 1;
      void currentRunner.dispose();
    };
  }, [runner]);

  const runOcr = async () => {
    const runVersion = runVersionRef.current + 1;
    runVersionRef.current = runVersion;
    setState({
      status: "running",
      progress: {
        phase: "loading",
        label: "Preparing local OCR",
        progress: 0,
      },
    });

    try {
      const result = await runner.recognize(imageUrl, {
        onProgress: (progress) => {
          if (runVersionRef.current === runVersion) {
            setState({ status: "running", progress });
          }
        },
      });

      if (runVersionRef.current === runVersion) {
        setState({ status: "success", result });
      }
    } catch (error) {
      if (
        runVersionRef.current === runVersion &&
        !(error instanceof OcrCancelledError)
      ) {
        setState({ status: "error" });
      }
    }
  };

  const cancelOcr = () => {
    runVersionRef.current += 1;
    setState({ status: "cancelled" });
    void runner.cancel();
  };

  return (
    <section className="ocr-panel" aria-labelledby="ocr-panel-title">
      <div className="ocr-panel-heading">
        <div>
          <p className="section-kicker">On-device OCR</p>
          <h4 id="ocr-panel-title">Read the processed image locally.</h4>
        </div>
        <span className="status-pill status-pill--neutral">English · local</span>
      </div>
      <p className="ocr-panel-intro">
        The first run loads the bundled OCR engine and English model from this site.
        Recognition runs in a reusable browser worker; the image is not uploaded.
      </p>

      {state.status === "idle" ? (
        <button
          className="button button--primary"
          type="button"
          onClick={() => void runOcr()}
        >
          Read text on this device
        </button>
      ) : null}

      {state.status === "running" ? (
        <div className="ocr-progress" role="status" aria-live="polite">
          <div>
            <strong>{state.progress.label}</strong>
            <span>{Math.round(state.progress.progress * 100)}%</span>
          </div>
          <progress value={state.progress.progress} max={1}>
            {Math.round(state.progress.progress * 100)}%
          </progress>
          <button className="button button--quiet" type="button" onClick={cancelOcr}>
            Cancel OCR
          </button>
        </div>
      ) : null}

      {state.status === "cancelled" ? (
        <div className="ocr-message" role="status">
          <strong>OCR cancelled.</strong>
          <p>The worker was stopped and the image stayed on this device.</p>
          <button
            className="button button--quiet"
            type="button"
            onClick={() => void runOcr()}
          >
            Try OCR again
          </button>
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="ocr-message ocr-message--error" role="alert">
          <strong>OCR could not finish.</strong>
          <p>
            The local worker was reset. Try again or continue with the synthetic
            transcript.
          </p>
          <button
            className="button button--quiet"
            type="button"
            onClick={() => void runOcr()}
          >
            Retry local OCR
          </button>
        </div>
      ) : null}

      {state.status === "success" ? (
        <div className="ocr-result">
          <div className="ocr-result-summary">
            <strong>OCR draft</strong>
            <span>
              Overall confidence:{" "}
              {state.result.confidence === null
                ? "unknown"
                : `${Math.round(state.result.confidence)}%`}
            </span>
          </div>
          {state.result.text.length > 0 ? (
            <>
              <p className="ocr-highlighted-text" aria-label="OCR confidence review">
                {state.result.segments.map((segment) => (
                  <mark
                    key={`${segment.start}-${segment.end}`}
                    className={`ocr-confidence ocr-confidence--${segment.level}`}
                    title={
                      segment.confidence === null
                        ? confidenceLabels.unknown
                        : `${confidenceLabels[segment.level]}: ${Math.round(segment.confidence)}%`
                    }
                  >
                    {segment.text}
                  </mark>
                ))}
              </p>
              <ul className="ocr-confidence-legend" aria-label="Confidence legend">
                {(["high", "review", "low", "unknown"] as const).map((level) => (
                  <li key={level}>
                    <span
                      className={`ocr-confidence-swatch ocr-confidence--${level}`}
                      aria-hidden="true"
                    />
                    {confidenceLabels[level]}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="ocr-empty-result">
              No printed English text was detected. Confidence remains unknown.
            </p>
          )}
          <button
            className="button button--quiet"
            type="button"
            onClick={() => void runOcr()}
          >
            Run OCR again
          </button>
        </div>
      ) : null}
    </section>
  );
}
