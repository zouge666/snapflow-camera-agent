"use client";

import Image from "next/image";
import { useRef, type KeyboardEvent } from "react";

import type { ReviewSample } from "../ocr-review/sample-review";

type SamplePickerProps = Readonly<{
  samples: readonly ReviewSample[];
  selectedSampleId: string;
  onSelect: (sampleId: string) => void;
}>;

const nextIndexForKey = (
  key: string,
  currentIndex: number,
  sampleCount: number,
): number | null => {
  if (sampleCount === 0) {
    return null;
  }

  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (currentIndex + 1) % sampleCount;
    case "ArrowLeft":
    case "ArrowUp":
      return (currentIndex - 1 + sampleCount) % sampleCount;
    case "Home":
      return 0;
    case "End":
      return sampleCount - 1;
    default:
      return null;
  }
};

export function SamplePicker({
  samples,
  selectedSampleId,
  onSelect,
}: SamplePickerProps) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedSample =
    samples.find((sample) => sample.id === selectedSampleId) ?? samples[0];

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const nextIndex = nextIndexForKey(event.key, currentIndex, samples.length);

    if (nextIndex === null) {
      return;
    }

    const nextSample = samples[nextIndex];
    if (nextSample === undefined) {
      return;
    }

    event.preventDefault();
    onSelect(nextSample.id);
    optionRefs.current[nextIndex]?.focus();
  };

  return (
    <section className="sample-picker" aria-labelledby="sample-picker-title">
      <div className="sample-picker-heading">
        <div>
          <p className="section-kicker">Fastest demo path</p>
          <h2 id="sample-picker-title">Choose a synthetic meeting.</h2>
        </div>
        <p id="sample-picker-help">
          No camera permission or API key is needed. Every option is fictional and loads
          from this site.
        </p>
      </div>

      <div
        className="sample-picker-grid"
        role="radiogroup"
        aria-label="Synthetic meeting samples"
        aria-describedby="sample-picker-help"
      >
        {samples.map((sample, index) => {
          const isSelected = sample.id === selectedSampleId;

          return (
            <button
              key={sample.id}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              className="sample-picker-option"
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(sample.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <span className="sample-picker-image">
                <Image
                  src={sample.image.src}
                  width={sample.image.width}
                  height={sample.image.height}
                  sizes="(max-width: 40rem) calc(100vw - 3.5rem), 20rem"
                  alt=""
                  loading="lazy"
                />
              </span>
              <span className="sample-picker-option-copy">
                <span className="sample-picker-option-topline">
                  <strong>{sample.title}</strong>
                  <span>{isSelected ? "Selected" : "Choose"}</span>
                </span>
                <span>{sample.summary}</span>
                <small>
                  Synthetic · {sample.languageLabel} · {sample.image.width} ×{" "}
                  {sample.image.height}
                </small>
              </span>
            </button>
          );
        })}
      </div>

      {selectedSample ? (
        <div className="sample-picker-footer">
          <p role="status">
            Selected: <strong>{selectedSample.title}</strong>
          </p>
          <a className="button button--primary" href="#review-title">
            Review selected sample
          </a>
        </div>
      ) : (
        <p className="sample-picker-empty">No synthetic sample is available.</p>
      )}
    </section>
  );
}
