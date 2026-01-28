export const highConfidenceThreshold = 85;
export const reviewConfidenceThreshold = 60;

export type OcrConfidenceLevel = "high" | "review" | "low" | "unknown";

export type OcrWord = Readonly<{
  text: string;
  confidence?: number | null;
}>;

export type OcrTextSegment = Readonly<{
  text: string;
  start: number;
  end: number;
  confidence: number | null;
  level: OcrConfidenceLevel;
}>;

export type OcrResult = Readonly<{
  text: string;
  language: "eng";
  confidence: number | null;
  segments: readonly OcrTextSegment[];
}>;

export function normalizeConfidence(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
}

export function getConfidenceLevel(confidence: number | null): OcrConfidenceLevel {
  if (confidence === null) {
    return "unknown";
  }

  if (confidence >= highConfidenceThreshold) {
    return "high";
  }

  if (confidence >= reviewConfidenceThreshold) {
    return "review";
  }

  return "low";
}

function createSegment(
  text: string,
  start: number,
  end: number,
  confidence: number | null,
): OcrTextSegment {
  return {
    text: text.slice(start, end),
    start,
    end,
    confidence,
    level: getConfidenceLevel(confidence),
  };
}

export function mapWordsToTextSegments(
  text: string,
  words: readonly OcrWord[],
): readonly OcrTextSegment[] {
  if (text.length === 0) {
    return [];
  }

  const segments: OcrTextSegment[] = [];
  let cursor = 0;

  for (const word of words) {
    if (word.text.length === 0) {
      continue;
    }

    const start = text.indexOf(word.text, cursor);
    if (start < cursor) {
      continue;
    }

    if (start > cursor) {
      segments.push(createSegment(text, cursor, start, null));
    }

    const end = start + word.text.length;
    segments.push(
      createSegment(text, start, end, normalizeConfidence(word.confidence)),
    );
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push(createSegment(text, cursor, text.length, null));
  }

  return segments;
}

export function createOcrResult(
  text: string,
  confidence: unknown,
  words: readonly OcrWord[],
): OcrResult {
  return {
    text,
    language: "eng",
    confidence: normalizeConfidence(confidence),
    segments: mapWordsToTextSegments(text, words),
  };
}
