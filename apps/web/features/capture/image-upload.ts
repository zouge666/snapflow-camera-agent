import { getFrameOrientation, type CapturedFrame } from "./capture-frame";

export const acceptedImageMediaTypes = ["image/jpeg", "image/png"] as const;
export const imagePickerAccept = ".jpg,.jpeg,.png,image/jpeg,image/png";
export const maxImageUploadBytes = 10 * 1024 * 1024;
export const maxImageUploadDimension = 8192;
export const maxImageUploadPixels = 24_000_000;

export type AcceptedImageMediaType = (typeof acceptedImageMediaTypes)[number];

export type ImageUploadErrorCode =
  | "unsupported-format"
  | "type-mismatch"
  | "file-too-large"
  | "decode-failed"
  | "dimensions-too-large";

export type DecodedImageDimensions = Readonly<{
  width: number;
  height: number;
}>;

export type ImageDecoder = (file: File) => Promise<DecodedImageDimensions>;
export type ImageDataUrlReader = (file: File) => Promise<string>;
export type ImageFileLoader = (file: File) => Promise<CapturedFrame>;

export class ImageUploadError extends Error {
  readonly code: ImageUploadErrorCode;

  constructor(code: ImageUploadErrorCode) {
    super(code);
    this.name = "ImageUploadError";
    this.code = code;
  }
}

const uploadErrorMessages: Readonly<Record<ImageUploadErrorCode, string>> = {
  "unsupported-format": "Choose a JPEG or PNG image.",
  "type-mismatch": "The file contents do not match its name and declared image type.",
  "file-too-large": "Choose an image no larger than 10 MiB.",
  "decode-failed":
    "This image could not be decoded. Try exporting it again as JPEG or PNG.",
  "dimensions-too-large":
    "Choose an image no larger than 8192 px per side or 24 megapixels.",
};

export function getImageUploadErrorMessage(error: unknown): string {
  return error instanceof ImageUploadError
    ? uploadErrorMessages[error.code]
    : uploadErrorMessages["decode-failed"];
}

function isAcceptedMediaType(value: string): value is AcceptedImageMediaType {
  return acceptedImageMediaTypes.some((mediaType) => mediaType === value);
}

function detectImageMediaType(bytes: Uint8Array): AcceptedImageMediaType | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length >= pngSignature.length &&
    pngSignature.every((value, index) => bytes[index] === value)
  ) {
    return "image/png";
  }

  return null;
}

function extensionMatchesMediaType(
  fileName: string,
  mediaType: AcceptedImageMediaType,
): boolean {
  const lowerName = fileName.toLowerCase();

  if (mediaType === "image/jpeg") {
    return lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg");
  }

  return lowerName.endsWith(".png");
}

export async function validateImageFile(
  file: File,
  decodeImage: ImageDecoder = browserImageDecoder,
): Promise<DecodedImageDimensions> {
  if (!isAcceptedMediaType(file.type)) {
    throw new ImageUploadError("unsupported-format");
  }

  if (file.size <= 0 || file.size > maxImageUploadBytes) {
    throw new ImageUploadError("file-too-large");
  }

  let header: Uint8Array;
  try {
    header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  } catch {
    throw new ImageUploadError("decode-failed");
  }
  const detectedMediaType = detectImageMediaType(header);

  if (
    detectedMediaType !== file.type ||
    !extensionMatchesMediaType(file.name, file.type)
  ) {
    throw new ImageUploadError("type-mismatch");
  }

  let dimensions: DecodedImageDimensions;
  try {
    dimensions = await decodeImage(file);
  } catch {
    throw new ImageUploadError("decode-failed");
  }

  const { width, height } = dimensions;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new ImageUploadError("decode-failed");
  }

  if (
    width > maxImageUploadDimension ||
    height > maxImageUploadDimension ||
    width * height > maxImageUploadPixels
  ) {
    throw new ImageUploadError("dimensions-too-large");
  }

  return dimensions;
}

export async function browserImageDecoder(file: File): Promise<DecodedImageDimensions> {
  if (typeof createImageBitmap !== "function") {
    throw new ImageUploadError("decode-failed");
  }

  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    return {
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

export function browserImageDataUrlReader(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ImageUploadError("decode-failed"));
    reader.onabort = () => reject(new ImageUploadError("decode-failed"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new ImageUploadError("decode-failed"));
        return;
      }

      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export async function loadImageFile(
  file: File,
  decodeImage: ImageDecoder = browserImageDecoder,
  readDataUrl: ImageDataUrlReader = browserImageDataUrlReader,
): Promise<CapturedFrame> {
  const { width, height } = await validateImageFile(file, decodeImage);
  const dataUrl = await readDataUrl(file);

  if (!dataUrl.startsWith(`data:${file.type};base64,`)) {
    throw new ImageUploadError("decode-failed");
  }

  return {
    dataUrl,
    width,
    height,
    orientation: getFrameOrientation(width, height),
  };
}
