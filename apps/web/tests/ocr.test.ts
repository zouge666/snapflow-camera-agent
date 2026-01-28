import { describe, expect, it, vi } from "vitest";

import {
  createOcrResult,
  getConfidenceLevel,
  mapWordsToTextSegments,
  normalizeConfidence,
} from "../features/ocr/ocr-result";
import {
  createOcrRunner,
  ocrRuntimePaths,
  OcrCancelledError,
  OcrRunnerError,
  type OcrProgress,
  type OcrWorkerPort,
} from "../features/ocr/ocr-runner";

const rawPage = {
  text: "Plan Friday",
  confidence: 88,
  words: [
    { text: "Plan", confidence: 91 },
    { text: "Friday", confidence: 72 },
  ],
} as const;

function successfulWorker(): OcrWorkerPort {
  return {
    recognize: vi.fn(async () => rawPage),
    terminate: vi.fn(async () => undefined),
  };
}

describe("OCR confidence mapping", () => {
  it.each([
    [100, "high"],
    [85, "high"],
    [84.999, "review"],
    [60, "review"],
    [59.999, "low"],
    [0, "low"],
    [null, "unknown"],
  ] as const)("maps confidence %s to %s", (confidence, level) => {
    expect(getConfidenceLevel(confidence)).toBe(level);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 101, "90"])(
    "keeps invalid confidence %s unknown",
    (confidence) => {
      expect(normalizeConfidence(confidence)).toBeNull();
    },
  );

  it("maps words to UTF-16-safe ranges without inventing missing confidence", () => {
    const text = "📷 Plan café\nFriday";
    const segments = mapWordsToTextSegments(text, [
      { text: "Plan", confidence: 85 },
      { text: "café" },
      { text: "Friday", confidence: 59 },
    ]);

    expect(segments.map(({ text: segment }) => segment).join("")).toBe(text);
    expect(segments).toEqual([
      {
        text: "📷 ",
        start: 0,
        end: 3,
        confidence: null,
        level: "unknown",
      },
      {
        text: "Plan",
        start: 3,
        end: 7,
        confidence: 85,
        level: "high",
      },
      {
        text: " ",
        start: 7,
        end: 8,
        confidence: null,
        level: "unknown",
      },
      {
        text: "café",
        start: 8,
        end: 12,
        confidence: null,
        level: "unknown",
      },
      {
        text: "\n",
        start: 12,
        end: 13,
        confidence: null,
        level: "unknown",
      },
      {
        text: "Friday",
        start: 13,
        end: 19,
        confidence: 59,
        level: "low",
      },
    ]);
    for (const segment of segments) {
      expect(text.slice(segment.start, segment.end)).toBe(segment.text);
    }
  });

  it("returns an explicit unknown page confidence and empty word coverage", () => {
    expect(createOcrResult("Unmapped text", undefined, [])).toEqual({
      text: "Unmapped text",
      language: "eng",
      confidence: null,
      segments: [
        {
          text: "Unmapped text",
          start: 0,
          end: 13,
          confidence: null,
          level: "unknown",
        },
      ],
    });
  });
});

describe("reusable OCR runner", () => {
  it("uses only same-origin worker, core, and language paths", () => {
    expect(ocrRuntimePaths).toEqual({
      workerPath: "/ocr-runtime/worker.min.js",
      corePath: "/ocr-runtime/core",
      langPath: "/ocr-runtime/lang",
    });
    expect(JSON.stringify(ocrRuntimePaths)).not.toMatch(/https?:|cdn/i);
  });

  it("lazy-loads one worker, forwards progress, and reuses it sequentially", async () => {
    const worker = successfulWorker();
    const reported: OcrProgress[] = [];
    const factory = vi.fn(async (onProgress: (progress: OcrProgress) => void) => {
      onProgress({
        phase: "loading",
        label: "Loading the English language model",
        progress: 0.5,
      });
      return worker;
    });
    const runner = createOcrRunner(factory);

    await expect(
      runner.recognize("blob:first", {
        onProgress: (progress) => reported.push(progress),
      }),
    ).resolves.toEqual(createOcrResult(rawPage.text, 88, rawPage.words));
    await expect(runner.recognize("blob:second")).resolves.toMatchObject({
      text: "Plan Friday",
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(worker.recognize).toHaveBeenNthCalledWith(1, "blob:first");
    expect(worker.recognize).toHaveBeenNthCalledWith(2, "blob:second");
    expect(reported).toEqual([
      {
        phase: "loading",
        label: "Loading the English language model",
        progress: 0.5,
      },
    ]);

    await runner.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("cancels an active job, terminates its worker, and recreates on retry", async () => {
    let resolveFirst: ((page: typeof rawPage) => void) | undefined;
    const firstRecognition = new Promise<typeof rawPage>((resolve) => {
      resolveFirst = resolve;
    });
    const firstWorker: OcrWorkerPort = {
      recognize: vi.fn(() => firstRecognition),
      terminate: vi.fn(async () => undefined),
    };
    const secondWorker = successfulWorker();
    const factory = vi
      .fn()
      .mockResolvedValueOnce(firstWorker)
      .mockResolvedValueOnce(secondWorker);
    const runner = createOcrRunner(factory);
    const firstRun = runner.recognize("blob:first");
    await vi.waitFor(() => expect(firstWorker.recognize).toHaveBeenCalledOnce());

    await runner.cancel();

    await expect(firstRun).rejects.toBeInstanceOf(OcrCancelledError);
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    await expect(runner.recognize("blob:retry")).resolves.toMatchObject({
      text: "Plan Friday",
    });
    expect(factory).toHaveBeenCalledTimes(2);

    resolveFirst?.(rawPage);
    await runner.dispose();
  });

  it("cancels during lazy worker initialization without starting recognition", async () => {
    let resolveWorker: ((worker: OcrWorkerPort) => void) | undefined;
    const workerPromise = new Promise<OcrWorkerPort>((resolve) => {
      resolveWorker = resolve;
    });
    const worker = successfulWorker();
    const factory = vi.fn(() => workerPromise);
    const runner = createOcrRunner(factory);
    const run = runner.recognize("blob:initializing");
    const cancellation = runner.cancel();

    resolveWorker?.(worker);
    await cancellation;

    await expect(run).rejects.toBeInstanceOf(OcrCancelledError);
    expect(worker.recognize).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("resets a failed worker and recovers on the next run", async () => {
    const failedWorker: OcrWorkerPort = {
      recognize: vi.fn(async () => Promise.reject(new Error("wasm failed"))),
      terminate: vi.fn(async () => undefined),
    };
    const recoveredWorker = successfulWorker();
    const factory = vi
      .fn()
      .mockResolvedValueOnce(failedWorker)
      .mockResolvedValueOnce(recoveredWorker);
    const runner = createOcrRunner(factory);

    await expect(runner.recognize("blob:broken")).rejects.toBeInstanceOf(
      OcrRunnerError,
    );
    expect(failedWorker.terminate).toHaveBeenCalledOnce();
    await expect(runner.recognize("blob:recovered")).resolves.toMatchObject({
      confidence: 88,
    });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("rejects non-local image inputs before creating a worker", async () => {
    const factory = vi.fn(async () => successfulWorker());
    const runner = createOcrRunner(factory);

    await expect(
      runner.recognize("https://example.com/private.png"),
    ).rejects.toBeInstanceOf(OcrRunnerError);
    expect(factory).not.toHaveBeenCalled();
  });
});
