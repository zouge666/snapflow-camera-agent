import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewTextForm } from "../features/ocr-review/review-text-form";
import { createOcrReviewSource } from "../features/ocr-review/review-source";
import type { OcrResult } from "../features/ocr/ocr-result";

type MountedReview = Readonly<{
  container: HTMLDivElement;
  root: Root;
  window: Window;
}>;

const result: OcrResult = {
  text: "Plan café Friday",
  language: "eng",
  confidence: 72,
  segments: [
    { text: "Plan", start: 0, end: 4, confidence: 94, level: "high" },
    { text: " ", start: 4, end: 5, confidence: null, level: "unknown" },
    { text: "café", start: 5, end: 9, confidence: 68, level: "review" },
    { text: " ", start: 9, end: 10, confidence: null, level: "unknown" },
    { text: "Friday", start: 10, end: 16, confidence: 52, level: "low" },
  ],
};
const source = createOcrReviewSource(
  {
    id: "blob:review-source:1",
    source: "upload",
    fileName: "notes.png",
    image: {
      objectUrl: "blob:review-source",
      width: 800,
      height: 500,
      orientation: "landscape",
      rotation: 0,
      crop: { x: 0, y: 0, width: 800, height: 500 },
      wasDownsampled: false,
      metadataRemoved: true,
    },
    result,
  },
  {
    locale: "en-US",
    timezone: "Europe/Copenhagen",
    referenceDate: "2026-07-29",
  },
);
const mountedReviews: MountedReview[] = [];

async function mountReview(
  onBuildPlan = vi.fn(),
  onReviewChange = vi.fn(),
): Promise<MountedReview> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    {
      pretendToBeVisual: true,
      url: "http://localhost:3000/demo",
    },
  );
  const container = dom.window.document.querySelector<HTMLDivElement>("#root");
  if (container === null) {
    throw new Error("OCR review test root was not created.");
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value(this: HTMLElement, eventName: string, listener: EventListener) {
      this.addEventListener(eventName.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value(this: HTMLElement, eventName: string, listener: EventListener) {
      this.removeEventListener(eventName.replace(/^on/, ""), listener);
    },
  });

  const root = createRoot(container);
  const mounted = {
    container,
    root,
    window: dom.window as unknown as Window,
  };
  mountedReviews.push(mounted);

  await act(async () => {
    root.render(
      <ReviewTextForm
        source={source}
        onBuildPlan={onBuildPlan}
        onReviewChange={onReviewChange}
      />,
    );
  });

  return mounted;
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) {
    throw new Error(`Button "${label}" was not found.`);
  }
  return button;
}

async function setTextarea(
  mounted: MountedReview,
  value: string,
): Promise<HTMLTextAreaElement> {
  const textarea = mounted.container.querySelector<HTMLTextAreaElement>("#transcript");
  if (textarea === null) {
    throw new Error("Transcript editor was not rendered.");
  }
  const valueSetter = Object.getOwnPropertyDescriptor(
    (mounted.window as unknown as typeof window).HTMLTextAreaElement.prototype,
    "value",
  )?.set;

  await act(async () => {
    textarea.focus();
    valueSetter?.call(textarea, value);
    const event = new (mounted.window as unknown as typeof window).Event(
      "propertychange",
      { bubbles: true },
    );
    Object.defineProperty(event, "propertyName", { value: "value" });
    textarea.dispatchEvent(event);
  });

  return textarea;
}

afterEach(async () => {
  while (mountedReviews.length > 0) {
    const mounted = mountedReviews.pop();
    if (mounted) {
      await act(async () => {
        mounted.root.unmount();
      });
    }
  }

  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("capture-to-transcript review", () => {
  it("locates low-confidence text and guards stale ranges after editing", async () => {
    const mounted = await mountReview();
    const textarea =
      mounted.container.querySelector<HTMLTextAreaElement>("#transcript");
    const lowConfidenceButton = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Low confidence"]',
    );

    if (textarea === null || lowConfidenceButton === null) {
      throw new Error("Low-confidence review controls were not rendered.");
    }

    await act(async () => {
      lowConfidenceButton.click();
    });
    expect(textarea.selectionStart).toBe(10);
    expect(textarea.selectionEnd).toBe(16);
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe(
      "Friday",
    );

    await setTextarea(mounted, "📷 Plan café next Friday");

    expect(mounted.container.textContent).toContain("Unsaved edits");
    expect(mounted.container.textContent).toContain(
      "Original confidence links are paused",
    );
    expect(lowConfidenceButton.disabled).toBe(true);

    const unloadEvent = new (mounted.window as unknown as typeof window).Event(
      "beforeunload",
      { cancelable: true },
    );
    mounted.window.dispatchEvent(unloadEvent);
    expect(unloadEvent.defaultPrevented).toBe(true);

    await act(async () => {
      getButton(mounted.container, "Undo last edit").click();
    });
    expect(textarea.value).toBe(result.text);
    expect(lowConfidenceButton.disabled).toBe(false);
    expect(mounted.container.textContent).toContain("Needs review");
  });

  it("allows only the explicitly confirmed edited version to build a plan", async () => {
    const onBuildPlan = vi.fn();
    const mounted = await mountReview(onBuildPlan);
    const finalText = "📷 Plan café next Friday — reviewed";
    const textarea = await setTextarea(mounted, finalText);

    expect(onBuildPlan).not.toHaveBeenCalled();
    expect(mounted.container.querySelector("button.button--accent")).toBeNull();

    const checkbox = mounted.container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const form = mounted.container.querySelector("form");
    if (checkbox === null || form === null) {
      throw new Error("Review confirmation controls were not rendered.");
    }

    await act(async () => {
      checkbox.click();
      form.dispatchEvent(
        new (mounted.window as unknown as typeof window).Event("submit", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await act(async () => {
      getButton(mounted.container, "Build demo action plan").click();
    });

    expect(textarea.value).toBe(finalText);
    expect(onBuildPlan).toHaveBeenCalledWith({
      transcript: finalText,
      locale: "en-US",
      timezone: "Europe/Copenhagen",
      referenceDate: "2026-07-29",
    });

    const unloadEvent = new (mounted.window as unknown as typeof window).Event(
      "beforeunload",
      { cancelable: true },
    );
    mounted.window.dispatchEvent(unloadEvent);
    expect(unloadEvent.defaultPrevented).toBe(false);
  });
});
