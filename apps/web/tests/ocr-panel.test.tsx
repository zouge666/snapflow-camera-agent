import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OcrPanel } from "../features/ocr/ocr-panel";
import type { OcrResult } from "../features/ocr/ocr-result";
import type { OcrProgress, OcrRunOptions, OcrRunner } from "../features/ocr/ocr-runner";

type MountedPanel = Readonly<{
  container: HTMLDivElement;
  root: Root;
}>;

const result: OcrResult = {
  text: "Plan Friday",
  language: "eng",
  confidence: 81.6,
  segments: [
    {
      text: "Plan",
      start: 0,
      end: 4,
      confidence: 92,
      level: "high",
    },
    {
      text: " ",
      start: 4,
      end: 5,
      confidence: null,
      level: "unknown",
    },
    {
      text: "Friday",
      start: 5,
      end: 11,
      confidence: 55,
      level: "low",
    },
  ],
};
const mountedPanels: MountedPanel[] = [];

async function mountPanel(
  runner: OcrRunner,
  onResult?: (ocrResult: OcrResult) => void,
): Promise<MountedPanel> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    {
      pretendToBeVisual: true,
      url: "http://localhost:3000/demo",
    },
  );
  const container = dom.window.document.querySelector<HTMLDivElement>("#root");
  if (container === null) {
    throw new Error("OCR panel test root was not created.");
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

  const root = createRoot(container);
  const mounted = { container, root };
  mountedPanels.push(mounted);

  await act(async () => {
    root.render(
      <OcrPanel
        imageUrl="blob:processed-image"
        runner={runner}
        {...(onResult ? { onResult } : {})}
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

function createRunner(
  recognize: (imageUrl: string, options?: OcrRunOptions) => Promise<OcrResult>,
): OcrRunner {
  return {
    recognize: vi.fn(recognize),
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

afterEach(async () => {
  while (mountedPanels.length > 0) {
    const mounted = mountedPanels.pop();
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

describe("OCR review panel", () => {
  it("shows progress, numeric and unknown confidence, and text highlights", async () => {
    const onResult = vi.fn();
    const progress: OcrProgress = {
      phase: "recognizing",
      label: "Reading text on this device",
      progress: 0.64,
    };
    const runner = createRunner(async (_imageUrl, options) => {
      options?.onProgress?.(progress);
      return result;
    });
    const mounted = await mountPanel(runner, onResult);

    await act(async () => {
      getButton(mounted.container, "Read text on this device").click();
    });

    expect(runner.recognize).toHaveBeenCalledWith(
      "blob:processed-image",
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(mounted.container.textContent).toContain("Overall confidence: 82%");
    expect(mounted.container.textContent).toContain("Plan Friday");
    expect(
      mounted.container.querySelector('mark[title="High confidence: 92%"]')
        ?.textContent,
    ).toBe("Plan");
    expect(
      mounted.container.querySelector('mark[title="Unknown confidence"]')?.textContent,
    ).toBe(" ");
    expect(
      mounted.container.querySelector('mark[title="Low confidence: 55%"]')?.textContent,
    ).toBe("Friday");
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it("cancels immediately and offers a safe retry", async () => {
    const pending = new Promise<OcrResult>(() => undefined);
    const runner = createRunner(async () => pending);
    const mounted = await mountPanel(runner);

    await act(async () => {
      getButton(mounted.container, "Read text on this device").click();
    });
    await act(async () => {
      getButton(mounted.container, "Cancel OCR").click();
    });

    expect(runner.cancel).toHaveBeenCalled();
    expect(mounted.container.textContent).toContain("OCR cancelled.");
    expect(getButton(mounted.container, "Try OCR again")).toBeDefined();
  });

  it("shows a recoverable error and succeeds on retry", async () => {
    const onResult = vi.fn();
    const recognize = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker failed"))
      .mockResolvedValueOnce(result);
    const runner = createRunner(recognize);
    const mounted = await mountPanel(runner, onResult);

    await act(async () => {
      getButton(mounted.container, "Read text on this device").click();
    });
    expect(mounted.container.textContent).toContain("OCR could not finish.");
    expect(onResult).not.toHaveBeenCalled();

    await act(async () => {
      getButton(mounted.container, "Retry local OCR").click();
    });
    expect(mounted.container.textContent).toContain("OCR draft");
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledOnce();
  });
});
