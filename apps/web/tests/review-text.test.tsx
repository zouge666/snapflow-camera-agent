import type { AxeResults, RunOptions } from "axe-core";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DemoPage from "../app/demo/page";
import { ReviewTextForm } from "../features/ocr-review/review-text-form";
import {
  createReviewTextState,
  MAX_TRANSCRIPT_LENGTH,
  reviewTextReducer,
  validateReviewText,
  type ReviewTextFields,
} from "../features/ocr-review/review-text";
import { northstarPlanningSample } from "../features/ocr-review/sample-review";

const sampleFields: ReviewTextFields = {
  transcript: northstarPlanningSample.transcript,
  locale: northstarPlanningSample.locale,
  timezone: northstarPlanningSample.timezone,
  referenceDate: northstarPlanningSample.referenceDate,
};

describe("review text state", () => {
  it("edits a field and invalidates an earlier confirmation", () => {
    const confirmed = reviewTextReducer(
      reviewTextReducer(createReviewTextState(sampleFields), {
        type: "toggle-confirmation",
        checked: true,
      }),
      { type: "submit" },
    );
    const edited = reviewTextReducer(confirmed, {
      type: "change-field",
      field: "transcript",
      value: "Corrected meeting text",
    });

    expect(confirmed.status).toBe("confirmed");
    expect(edited.fields.transcript).toBe("Corrected meeting text");
    expect(edited.confirmationChecked).toBe(false);
    expect(edited.status).toBe("editing");
  });

  it("resets edited values, validation and confirmation to the fixture", () => {
    const edited = reviewTextReducer(createReviewTextState(sampleFields), {
      type: "change-field",
      field: "timezone",
      value: "Europe/Berlin",
    });
    const rejected = reviewTextReducer(edited, { type: "submit" });
    const reset = reviewTextReducer(rejected, { type: "reset" });

    expect(reset.fields).toEqual(sampleFields);
    expect(reset.confirmationChecked).toBe(false);
    expect(reset.errors).toEqual({});
    expect(reset.status).toBe("editing");
  });

  it("rejects an empty transcript", () => {
    const rejected = reviewTextReducer(
      reviewTextReducer(
        createReviewTextState({ ...sampleFields, transcript: "  \n " }),
        { type: "toggle-confirmation", checked: true },
      ),
      { type: "submit" },
    );

    expect(rejected.errors.transcript).toMatch(/meeting text/i);
    expect(rejected.status).toBe("editing");
  });

  it("accepts the character limit and rejects text beyond it", () => {
    const atLimit = validateReviewText({
      ...sampleFields,
      transcript: "a".repeat(MAX_TRANSCRIPT_LENGTH),
    });
    const overLimit = reviewTextReducer(
      reviewTextReducer(
        createReviewTextState({
          ...sampleFields,
          transcript: "a".repeat(MAX_TRANSCRIPT_LENGTH + 1),
        }),
        { type: "toggle-confirmation", checked: true },
      ),
      { type: "submit" },
    );

    expect(atLimit.transcript).toBeUndefined();
    expect(overLimit.errors.transcript).toMatch(/12,000 characters or fewer/i);
    expect(overLimit.status).toBe("editing");
  });

  it("requires explicit confirmation before submission can pass", () => {
    const rejected = reviewTextReducer(createReviewTextState(sampleFields), {
      type: "submit",
    });
    const accepted = reviewTextReducer(
      reviewTextReducer(rejected, {
        type: "toggle-confirmation",
        checked: true,
      }),
      { type: "submit" },
    );

    expect(rejected.errors.confirmation).toMatch(/check this box/i);
    expect(rejected.status).toBe("editing");
    expect(accepted.errors).toEqual({});
    expect(accepted.status).toBe("confirmed");
  });
});

describe("review text interface", () => {
  it("renders the fixture image, editable context and honest handoff boundary", () => {
    const markup = renderToStaticMarkup(
      <ReviewTextForm sample={northstarPlanningSample} />,
    );

    expect(markup).toContain("Northstar planning board");
    expect(markup).toContain('name="transcript"');
    expect(markup).toContain("Europe/Copenhagen");
    expect(markup).toContain("2026-07-16");
    expect(markup).toContain("The next step sends text, not the image.");
    expect(markup).toContain('type="checkbox"');
    expect(markup).not.toContain("Text confirmed locally.");
  });

  it("has no automatic axe violations in the review workspace", async () => {
    const markup = renderToStaticMarkup(<DemoPage />);
    const dom = new JSDOM(
      `<!doctype html><html lang="en"><head><title>SnapFlow review test</title></head><body>${markup}</body></html>`,
      {
        pretendToBeVisual: true,
        runScripts: "outside-only",
        url: "http://localhost:3000/demo",
      },
    );

    dom.window.eval(axe.source);
    const axeWindow = dom.window as unknown as {
      axe: {
        run: (document: Document, options: RunOptions) => Promise<AxeResults>;
      };
    };
    const results = await axeWindow.axe.run(dom.window.document, {
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
