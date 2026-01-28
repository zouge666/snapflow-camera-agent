import { describe, expect, it, vi } from "vitest";

import type { CapturedFrame } from "../features/capture/capture-frame";
import {
  assertSafeSourceDimensions,
  createLocalImageProcessor,
  fitProcessedDimensions,
  ImageProcessingError,
  maxProcessedEdge,
  resolveCropRect,
  validateCropRect,
} from "../features/image-processing/image-processing";

const frame: CapturedFrame = {
  dataUrl: "data:image/jpeg;base64,RVhJRi1wcml2YXRl",
  width: 4000,
  height: 3000,
  orientation: "landscape",
};

function createHarness(width = 4000, height = 3000) {
  const close = vi.fn();
  const bitmap = {
    width,
    height,
    close,
  } as unknown as ImageBitmap;
  const context = {
    fillStyle: "",
    fillRect: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    drawImage: vi.fn(),
    restore: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  const outputBlob = new Blob(["pixels-without-source-metadata"], {
    type: "image/jpeg",
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback) => callback(outputBlob)),
  } as unknown as HTMLCanvasElement;
  const createObjectUrl = vi.fn(() => "blob:snapflow-processed");
  const revokeObjectUrl = vi.fn();
  const decode = vi.fn(async () => bitmap);
  const processor = createLocalImageProcessor({
    decode,
    createCanvas: () => canvas,
    createObjectUrl,
    revokeObjectUrl,
  });

  return {
    bitmap,
    canvas,
    close,
    context,
    createObjectUrl,
    decode,
    outputBlob,
    processor,
    revokeObjectUrl,
  };
}

describe("bounded image transforms", () => {
  it("uses predictable centered crop bounds", () => {
    expect(resolveCropRect({ width: 1600, height: 1000 }, "square")).toEqual({
      x: 300,
      y: 0,
      width: 1000,
      height: 1000,
    });
    expect(resolveCropRect({ width: 1000, height: 1600 }, "four-three")).toEqual({
      x: 0,
      y: 425,
      width: 1000,
      height: 750,
    });
  });

  it.each([
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: 90, y: 0, width: 11, height: 10 },
    { x: 0.5, y: 0, width: 10, height: 10 },
  ])("rejects an unsafe crop rectangle: %o", (crop) => {
    expect(() => validateCropRect(crop, { width: 100, height: 100 })).toThrow(
      ImageProcessingError,
    );
  });

  it("does not enlarge small images and downsamples large images", () => {
    expect(fitProcessedDimensions({ width: 640, height: 480 })).toEqual({
      width: 640,
      height: 480,
      wasDownsampled: false,
    });

    const large = fitProcessedDimensions({ width: 6000, height: 4000 });
    expect(large.width).toBeLessThanOrEqual(maxProcessedEdge);
    expect(large.height).toBeLessThanOrEqual(maxProcessedEdge);
    expect(large.width * large.height).toBeLessThanOrEqual(4_000_000);
    expect(large.wasDownsampled).toBe(true);
  });

  it("enforces decoded pixel and RGBA memory limits", () => {
    expect(() => assertSafeSourceDimensions({ width: 6000, height: 5000 })).toThrow(
      ImageProcessingError,
    );
    expect(() =>
      assertSafeSourceDimensions({ width: Number.MAX_SAFE_INTEGER, height: 2 }),
    ).toThrow(ImageProcessingError);
  });
});

describe("browser-local image pipeline", () => {
  it("crops, rotates, downsamples, re-encodes, and returns only an object URL", async () => {
    const harness = createHarness();

    const image = await harness.processor.process(frame, {
      rotation: 90,
      cropPreset: "square",
    });

    expect(harness.decode).toHaveBeenCalledOnce();
    expect(harness.canvas.width).toBe(2000);
    expect(harness.canvas.height).toBe(2000);
    expect(harness.context.translate).toHaveBeenCalledWith(3000, 0);
    expect(harness.context.rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(harness.context.drawImage).toHaveBeenCalledWith(
      harness.bitmap,
      500,
      0,
      3000,
      3000,
      0,
      0,
      3000,
      3000,
    );
    expect(harness.canvas.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/jpeg",
      0.9,
    );
    expect(harness.createObjectUrl).toHaveBeenCalledWith(harness.outputBlob);
    expect(image).toEqual({
      objectUrl: "blob:snapflow-processed",
      width: 2000,
      height: 2000,
      orientation: "square",
      rotation: 90,
      crop: { x: 500, y: 0, width: 3000, height: 3000 },
      wasDownsampled: true,
      metadataRemoved: true,
    });
    expect("dataUrl" in image).toBe(false);
    expect("blob" in image).toBe(false);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("releases the generated object URL through the same processing port", async () => {
    const harness = createHarness(640, 480);
    const image = await harness.processor.process(
      { ...frame, width: 640, height: 480 },
      { rotation: 0, cropPreset: "full" },
    );

    harness.processor.release(image);

    expect(image.width).toBe(640);
    expect(image.height).toBe(480);
    expect(image.wasDownsampled).toBe(false);
    expect(harness.revokeObjectUrl).toHaveBeenCalledWith("blob:snapflow-processed");
  });

  it("closes decoded pixels when source limits reject the image", async () => {
    const harness = createHarness(6000, 5000);

    await expect(
      harness.processor.process(frame, {
        rotation: 0,
        cropPreset: "full",
      }),
    ).rejects.toBeInstanceOf(ImageProcessingError);
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.createObjectUrl).not.toHaveBeenCalled();
  });
});
