import type { ProcessedImage } from "../image-processing/image-processing";
import type { OcrResult } from "../ocr/ocr-result";

export type CapturedOcrDraft = Readonly<{
  id: string;
  source: "camera" | "upload";
  fileName?: string;
  image: ProcessedImage;
  result: OcrResult;
}>;
