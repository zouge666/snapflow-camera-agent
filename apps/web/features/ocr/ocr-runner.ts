import { createOcrResult, type OcrResult, type OcrWord } from "./ocr-result";

export type OcrProgress = Readonly<{
  phase: "loading" | "recognizing";
  label: string;
  progress: number;
}>;

export type OcrRunOptions = Readonly<{
  onProgress?: (progress: OcrProgress) => void;
}>;

export type RawOcrPage = Readonly<{
  text: string;
  confidence: unknown;
  words: readonly OcrWord[];
}>;

export type OcrWorkerPort = Readonly<{
  recognize: (imageUrl: string) => Promise<RawOcrPage>;
  terminate: () => Promise<void>;
}>;

export type OcrWorkerFactory = (
  onProgress: (progress: OcrProgress) => void,
) => Promise<OcrWorkerPort>;

export type OcrRunner = Readonly<{
  recognize: (imageUrl: string, options?: OcrRunOptions) => Promise<OcrResult>;
  cancel: () => Promise<void>;
  dispose: () => Promise<void>;
}>;

export class OcrCancelledError extends Error {
  constructor() {
    super("OCR was cancelled.");
    this.name = "OcrCancelledError";
  }
}

export class OcrRunnerError extends Error {
  constructor(message = "OCR could not read this image.") {
    super(message);
    this.name = "OcrRunnerError";
  }
}

function toProgress(status: string, value: number): OcrProgress {
  const progress = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const phase = status === "recognizing text" ? "recognizing" : "loading";
  const labels: Readonly<Record<string, string>> = {
    "loading tesseract core": "Loading the local OCR engine",
    "loading language traineddata": "Loading the English language model",
    "initializing api": "Preparing the OCR worker",
    "recognizing text": "Reading text on this device",
  };

  return {
    phase,
    label: labels[status] ?? (phase === "recognizing" ? "Reading text" : "Loading OCR"),
    progress,
  };
}

type TesseractWord = Readonly<{
  text: string;
  confidence?: number | null;
}>;

type TesseractLine = Readonly<{ words?: readonly TesseractWord[] }>;
type TesseractParagraph = Readonly<{ lines?: readonly TesseractLine[] }>;
type TesseractBlock = Readonly<{ paragraphs?: readonly TesseractParagraph[] }>;

function flattenWords(blocks: readonly TesseractBlock[] | null): readonly OcrWord[] {
  return (
    blocks?.flatMap(
      (block) =>
        block.paragraphs?.flatMap(
          (paragraph) => paragraph.lines?.flatMap((line) => line.words ?? []) ?? [],
        ) ?? [],
    ) ?? []
  ).map((word) => ({
    text: word.text,
    ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
  }));
}

export const ocrRuntimePaths = {
  workerPath: "/ocr-runtime/worker.min.js",
  corePath: "/ocr-runtime/core",
  langPath: "/ocr-runtime/lang",
} as const;

export const createBrowserOcrWorker: OcrWorkerFactory = async (onProgress) => {
  const { createWorker, OEM } = await import("tesseract.js");
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    ...ocrRuntimePaths,
    workerBlobURL: false,
    gzip: true,
    cacheMethod: "write",
    logger: (message) => {
      onProgress(toProgress(message.status, message.progress));
    },
  });

  return {
    async recognize(imageUrl) {
      const { data } = await worker.recognize(
        imageUrl,
        {},
        { text: true, blocks: true },
      );

      return {
        text: data.text,
        confidence: data.confidence,
        words: flattenWords(data.blocks),
      };
    },
    async terminate() {
      await worker.terminate();
    },
  };
};

export function createOcrRunner(
  factory: OcrWorkerFactory = createBrowserOcrWorker,
): OcrRunner {
  let workerPromise: Promise<OcrWorkerPort> | null = null;
  let cleanupPromise: Promise<void> = Promise.resolve();
  let progressListener: (progress: OcrProgress) => void = () => undefined;
  let activeRun: Readonly<{
    rejectCancellation: (error: OcrCancelledError) => void;
  }> | null = null;

  const getWorker = () => {
    workerPromise ??= cleanupPromise.then(() =>
      factory((progress) => progressListener(progress)),
    );
    return workerPromise;
  };

  const resetWorker = () => {
    const workerToTerminate = workerPromise;
    workerPromise = null;

    if (workerToTerminate === null) {
      return cleanupPromise;
    }

    cleanupPromise = cleanupPromise.then(async () => {
      try {
        const worker = await workerToTerminate;
        await worker.terminate();
      } catch {
        // A worker that failed during initialization has nothing left to terminate.
      }
    });

    return cleanupPromise;
  };

  return {
    async recognize(imageUrl, options = {}) {
      if (activeRun !== null) {
        throw new OcrRunnerError("Wait for the current OCR run or cancel it first.");
      }

      if (!imageUrl.startsWith("blob:")) {
        throw new OcrRunnerError("OCR only accepts a processed local image.");
      }

      progressListener = options.onProgress ?? (() => undefined);
      let rejectCancellation: ((error: OcrCancelledError) => void) | undefined;
      const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      const run = {
        rejectCancellation: (error: OcrCancelledError) => rejectCancellation?.(error),
      };
      activeRun = run;

      try {
        const rawPage = await Promise.race([
          getWorker().then((worker) => {
            if (activeRun !== run) {
              throw new OcrCancelledError();
            }

            return worker.recognize(imageUrl);
          }),
          cancellation,
        ]);

        return createOcrResult(rawPage.text, rawPage.confidence, rawPage.words);
      } catch (error) {
        if (error instanceof OcrCancelledError) {
          throw error;
        }

        await resetWorker();
        throw new OcrRunnerError();
      } finally {
        if (activeRun === run) {
          activeRun = null;
        }
        progressListener = () => undefined;
      }
    },
    async cancel() {
      const run = activeRun;
      activeRun = null;
      run?.rejectCancellation(new OcrCancelledError());
      await resetWorker();
    },
    async dispose() {
      const run = activeRun;
      activeRun = null;
      run?.rejectCancellation(new OcrCancelledError());
      await resetWorker();
    },
  };
}
