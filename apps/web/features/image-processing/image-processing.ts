import { getFrameOrientation, type CapturedFrame } from "../capture/capture-frame";

export const maxProcessedEdge = 2048;
export const maxProcessedPixels = 4_000_000;
export const maxSourcePixels = 24_000_000;
export const maxSourceRgbaBytes = 128 * 1024 * 1024;

export type QuarterTurn = 0 | 90 | 180 | 270;
export type CropPreset = "full" | "square" | "four-three";

export type ImageTransform = Readonly<{
  rotation: QuarterTurn;
  cropPreset: CropPreset;
}>;

export type CropRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type ImageDimensions = Readonly<{
  width: number;
  height: number;
}>;

export type ProcessedImage = Readonly<{
  objectUrl: string;
  width: number;
  height: number;
  orientation: CapturedFrame["orientation"];
  rotation: QuarterTurn;
  crop: CropRect;
  wasDownsampled: boolean;
  metadataRemoved: true;
}>;

export type LocalImageProcessor = Readonly<{
  process: (frame: CapturedFrame, transform: ImageTransform) => Promise<ProcessedImage>;
  release: (image: ProcessedImage) => void;
}>;

export const initialImageTransform: ImageTransform = {
  rotation: 0,
  cropPreset: "full",
};

export class ImageProcessingError extends Error {
  constructor() {
    super("The image could not be processed safely in this browser.");
    this.name = "ImageProcessingError";
  }
}

function assertPositiveInteger(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ImageProcessingError();
  }
}

export function assertSafeSourceDimensions({ width, height }: ImageDimensions): void {
  assertPositiveInteger(width);
  assertPositiveInteger(height);

  const pixels = width * height;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels > maxSourcePixels ||
    pixels * 4 > maxSourceRgbaBytes
  ) {
    throw new ImageProcessingError();
  }
}

export function validateCropRect(crop: CropRect, source: ImageDimensions): CropRect {
  assertSafeSourceDimensions(source);

  const values = [crop.x, crop.y, crop.width, crop.height];
  if (
    values.some((value) => !Number.isInteger(value)) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x + crop.width > source.width ||
    crop.y + crop.height > source.height
  ) {
    throw new ImageProcessingError();
  }

  return crop;
}

export function resolveCropRect(source: ImageDimensions, preset: CropPreset): CropRect {
  assertSafeSourceDimensions(source);

  if (preset === "full") {
    return { x: 0, y: 0, width: source.width, height: source.height };
  }

  const targetRatio = preset === "square" ? 1 : 4 / 3;
  const sourceRatio = source.width / source.height;
  let width = source.width;
  let height = source.height;

  if (sourceRatio > targetRatio) {
    width = Math.max(1, Math.round(source.height * targetRatio));
  } else {
    height = Math.max(1, Math.round(source.width / targetRatio));
  }

  return validateCropRect(
    {
      x: Math.floor((source.width - width) / 2),
      y: Math.floor((source.height - height) / 2),
      width,
      height,
    },
    source,
  );
}

export function getRotatedDimensions(
  source: ImageDimensions,
  rotation: QuarterTurn,
): ImageDimensions {
  assertSafeSourceDimensions(source);

  return rotation === 90 || rotation === 270
    ? { width: source.height, height: source.width }
    : source;
}

export function fitProcessedDimensions(
  source: ImageDimensions,
): ImageDimensions & Readonly<{ wasDownsampled: boolean }> {
  assertSafeSourceDimensions(source);

  const scale = Math.min(
    1,
    maxProcessedEdge / Math.max(source.width, source.height),
    Math.sqrt(maxProcessedPixels / (source.width * source.height)),
  );

  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
    wasDownsampled: scale < 1,
  };
}

type DecodedBitmap = CanvasImageSource &
  Readonly<{
    width: number;
    height: number;
    close: () => void;
  }>;

type ProcessingEnvironment = Readonly<{
  decode: (blob: Blob) => Promise<DecodedBitmap>;
  createCanvas: () => HTMLCanvasElement;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
}>;

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
    dataUrl,
  );

  if (match === null) {
    throw new ImageProcessingError();
  }

  try {
    const mediaType = match[1];
    const encodedBytes = match[2];
    if (mediaType === undefined || encodedBytes === undefined) {
      throw new ImageProcessingError();
    }

    const bytes = Uint8Array.from(atob(encodedBytes), (value) => value.charCodeAt(0));
    return new Blob([bytes], { type: mediaType });
  } catch {
    throw new ImageProcessingError();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new ImageProcessingError());
          return;
        }

        resolve(blob);
      },
      "image/jpeg",
      0.9,
    );
  });
}

function drawRotatedCrop(
  context: CanvasRenderingContext2D,
  bitmap: DecodedBitmap,
  crop: CropRect,
  rotation: QuarterTurn,
  output: ImageDimensions,
): void {
  const rotated = getRotatedDimensions(
    { width: crop.width, height: crop.height },
    rotation,
  );

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, output.width, output.height);
  context.save();
  context.scale(output.width / rotated.width, output.height / rotated.height);

  if (rotation === 90) {
    context.translate(crop.height, 0);
    context.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    context.translate(crop.width, crop.height);
    context.rotate(Math.PI);
  } else if (rotation === 270) {
    context.translate(0, crop.width);
    context.rotate(-Math.PI / 2);
  }

  context.drawImage(
    bitmap,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  context.restore();
}

export function createLocalImageProcessor(
  environment: ProcessingEnvironment,
): LocalImageProcessor {
  return {
    async process(frame, transform) {
      const inputBlob = dataUrlToBlob(frame.dataUrl);
      let bitmap: DecodedBitmap;

      try {
        bitmap = await environment.decode(inputBlob);
      } catch {
        throw new ImageProcessingError();
      }

      try {
        const source = { width: bitmap.width, height: bitmap.height };
        assertSafeSourceDimensions(source);
        const crop = resolveCropRect(source, transform.cropPreset);
        const rotated = getRotatedDimensions(
          { width: crop.width, height: crop.height },
          transform.rotation,
        );
        const output = fitProcessedDimensions(rotated);
        const canvas = environment.createCanvas();
        canvas.width = output.width;
        canvas.height = output.height;
        const context = canvas.getContext("2d");

        if (context === null) {
          throw new ImageProcessingError();
        }

        drawRotatedCrop(context, bitmap, crop, transform.rotation, output);
        const outputBlob = await canvasToBlob(canvas);
        const objectUrl = environment.createObjectUrl(outputBlob);

        return {
          objectUrl,
          width: output.width,
          height: output.height,
          orientation: getFrameOrientation(output.width, output.height),
          rotation: transform.rotation,
          crop,
          wasDownsampled: output.wasDownsampled,
          metadataRemoved: true,
        };
      } catch (error) {
        if (error instanceof ImageProcessingError) {
          throw error;
        }

        throw new ImageProcessingError();
      } finally {
        bitmap.close();
      }
    },
    release(image) {
      environment.revokeObjectUrl(image.objectUrl);
    },
  };
}

const browserEnvironment: ProcessingEnvironment = {
  decode: async (blob) =>
    createImageBitmap(blob, {
      imageOrientation: "from-image",
    }) as Promise<DecodedBitmap>,
  createCanvas: () => document.createElement("canvas"),
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
};

export const browserLocalImageProcessor = createLocalImageProcessor(browserEnvironment);
