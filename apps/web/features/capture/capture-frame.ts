export type FrameOrientation = "landscape" | "portrait" | "square";

export type CapturedFrame = Readonly<{
  dataUrl: string;
  width: number;
  height: number;
  orientation: FrameOrientation;
}>;

type FrameCanvasContext = Readonly<{
  drawImage: (
    image: CanvasImageSource,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ) => void;
}>;

export type FrameCanvas = {
  width: number;
  height: number;
  getContext: (contextId: "2d") => FrameCanvasContext | null;
  toDataURL: (type: string, quality: number) => string;
};

export type FrameCanvasFactory = () => FrameCanvas;
export type FrameCapture = (video: HTMLVideoElement) => CapturedFrame;

export class FrameCaptureError extends Error {
  constructor() {
    super("A still frame could not be captured from the live preview.");
    this.name = "FrameCaptureError";
  }
}

export function getFrameOrientation(width: number, height: number): FrameOrientation {
  if (width === height) {
    return "square";
  }

  return width > height ? "landscape" : "portrait";
}

export function captureVideoFrame(
  video: HTMLVideoElement,
  createCanvas: FrameCanvasFactory = () =>
    document.createElement("canvas") as FrameCanvas,
): CapturedFrame {
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (width <= 0 || height <= 0) {
    throw new FrameCaptureError();
  }

  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  if (context === null) {
    throw new FrameCaptureError();
  }

  context.drawImage(video, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

  if (!dataUrl.startsWith("data:image/jpeg")) {
    throw new FrameCaptureError();
  }

  return {
    dataUrl,
    width,
    height,
    orientation: getFrameOrientation(width, height),
  };
}
