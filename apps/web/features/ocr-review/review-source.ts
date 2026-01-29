import type { CapturedOcrDraft } from "../capture/captured-ocr-draft";
import type { OcrResult } from "../ocr/ocr-result";
import type { ReviewTextFields } from "./review-text";
import type { ReviewSample } from "./sample-review";

export type ReviewTextSource = Readonly<{
  id: string;
  kind: "sample" | "ocr";
  title: string;
  badge: string;
  caption: string;
  image: Readonly<{
    src: string;
    width: number;
    height: number;
    alt: string;
    unoptimized: boolean;
  }>;
  initialFields: ReviewTextFields;
  ocrResult: OcrResult | null;
}>;

export function createSampleReviewSource(sample: ReviewSample): ReviewTextSource {
  return {
    id: `sample:${sample.id}`,
    kind: "sample",
    title: sample.title,
    badge: "Synthetic sample",
    caption: `Fixture ${sample.id}. No personal or confidential data.`,
    image: {
      ...sample.image,
      unoptimized: false,
    },
    initialFields: {
      transcript: sample.transcript,
      locale: sample.locale,
      timezone: sample.timezone,
      referenceDate: sample.referenceDate,
    },
    ocrResult: null,
  };
}

function getDateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${values.year ?? "1970"}-${values.month ?? "01"}-${values.day ?? "01"}`;
}

export function getBrowserReviewContext(
  date = new Date(),
  locale = globalThis.navigator?.language || "en-US",
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): Omit<ReviewTextFields, "transcript"> {
  return {
    locale,
    timezone,
    referenceDate: getDateInTimezone(date, timezone),
  };
}

export function createOcrReviewSource(
  draft: CapturedOcrDraft,
  context: Omit<ReviewTextFields, "transcript">,
): ReviewTextSource {
  const sourceLabel =
    draft.source === "camera" ? "Captured frame OCR" : "Uploaded image OCR";
  const fileDetail =
    draft.source === "upload" && draft.fileName ? ` from ${draft.fileName}` : "";

  return {
    id: `ocr:${draft.id}`,
    kind: "ocr",
    title:
      draft.source === "camera" ? "Captured meeting notes" : "Uploaded meeting notes",
    badge: sourceLabel,
    caption: `${sourceLabel}${fileDetail}. The image and OCR draft remain in this browser until you confirm the text.`,
    image: {
      src: draft.image.objectUrl,
      width: draft.image.width,
      height: draft.image.height,
      alt:
        draft.source === "camera"
          ? "Captured meeting notes used for OCR review"
          : "Uploaded meeting notes used for OCR review",
      unoptimized: true,
    },
    initialFields: {
      transcript: draft.result.text,
      ...context,
    },
    ocrResult: draft.result,
  };
}
