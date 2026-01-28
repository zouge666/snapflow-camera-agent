import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SamplePicker } from "../features/capture/sample-picker";
import type { ReviewSample } from "../features/ocr-review/sample-review";
import { northstarPlanningSample } from "../features/ocr-review/sample-review";
import { WorkflowDemo } from "../features/workflow/workflow-demo";

type MountedView = Readonly<{
  container: HTMLDivElement;
  root: Root;
  window: Window;
}>;

const secondSample: ReviewSample = {
  ...northstarPlanningSample,
  id: "image-dev-second-synthetic-002",
  title: "Fictional launch retro",
  summary: "A second fictional sample used to verify deterministic selection.",
  languageLabel: "English",
  transcript: "Launch retro\n\nKai: Share the rollout notes on 2026-08-03.",
};
const samples = [northstarPlanningSample, secondSample] as const;
const mountedViews: MountedView[] = [];

async function mount(element: ReactNode): Promise<MountedView> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    {
      pretendToBeVisual: true,
      url: "http://localhost:3000/demo",
    },
  );
  const container = dom.window.document.querySelector<HTMLDivElement>("#root");

  if (container === null) {
    throw new Error("Sample picker test root was not created.");
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });

  const root = createRoot(container);
  const mounted = {
    container,
    root,
    window: dom.window as unknown as Window,
  };
  mountedViews.push(mounted);

  await act(async () => {
    root.render(element);
  });

  return mounted;
}

afterEach(async () => {
  while (mountedViews.length > 0) {
    const mounted = mountedViews.pop();
    if (mounted) {
      await act(async () => {
        mounted.root.unmount();
      });
    }
  }

  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "navigator");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("synthetic sample picker", () => {
  it("renders known image dimensions with native lazy loading", () => {
    const markup = renderToStaticMarkup(
      <SamplePicker
        samples={[northstarPlanningSample]}
        selectedSampleId={northstarPlanningSample.id}
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('width="1600"');
    expect(markup).toContain('height="1000"');
    expect(markup).toContain("Synthetic · English · 1600 × 1000");
    expect(markup).toContain('href="#review-title"');
  });

  it("moves selection and focus with radio-group arrow keys", async () => {
    const onSelect = vi.fn();

    function PickerHarness() {
      const [selectedSampleId, setSelectedSampleId] = useState(samples[0].id);

      return (
        <SamplePicker
          samples={samples}
          selectedSampleId={selectedSampleId}
          onSelect={(sampleId) => {
            onSelect(sampleId);
            setSelectedSampleId(sampleId);
          }}
        />
      );
    }

    const mounted = await mount(<PickerHarness />);
    const options = [
      ...mounted.container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ];
    const firstOption = options[0];
    const secondOption = options[1];

    if (firstOption === undefined || secondOption === undefined) {
      throw new Error("Expected two sample options.");
    }

    expect(firstOption.getAttribute("aria-checked")).toBe("true");
    expect(firstOption.tabIndex).toBe(0);
    expect(secondOption.tabIndex).toBe(-1);

    firstOption.focus();
    await act(async () => {
      firstOption.dispatchEvent(
        new (mounted.window as unknown as typeof window).KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(onSelect).toHaveBeenLastCalledWith(secondSample.id);
    expect(secondOption.getAttribute("aria-checked")).toBe("true");
    expect(secondOption.tabIndex).toBe(0);
    expect(mounted.window.document.activeElement).toBe(secondOption);

    await act(async () => {
      secondOption.dispatchEvent(
        new (mounted.window as unknown as typeof window).KeyboardEvent("keydown", {
          bubbles: true,
          key: "Home",
        }),
      );
    });

    expect(onSelect).toHaveBeenLastCalledWith(northstarPlanningSample.id);
    expect(mounted.window.document.activeElement).toBe(firstOption);
  });

  it("replaces the review fixture when a different sample is selected", async () => {
    const mounted = await mount(<WorkflowDemo samples={samples} />);
    const options = [
      ...mounted.container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ];
    const secondOption = options[1];

    if (secondOption === undefined) {
      throw new Error("Expected the second sample option.");
    }

    await act(async () => {
      secondOption.click();
    });

    const transcript =
      mounted.container.querySelector<HTMLTextAreaElement>("#transcript");

    expect(mounted.container.textContent).toContain(secondSample.title);
    expect(mounted.container.textContent).toContain(`Selected: ${secondSample.title}`);
    expect(transcript?.value).toBe(secondSample.transcript);
  });
});
