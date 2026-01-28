import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CameraAccessPanel } from "../features/capture/camera-access-panel";
import {
  captureVideoFrame,
  FrameCaptureError,
  getFrameOrientation,
  type CapturedFrame,
  type FrameCanvas,
} from "../features/capture/capture-frame";
import {
  createCameraConstraints,
  type CameraMediaAdapter,
} from "../features/capture/camera-permission";

type MountedPanel = Readonly<{
  container: HTMLDivElement;
  root: Root;
  window: Window;
}>;

const mountedPanels: MountedPanel[] = [];
const capturedFrame: CapturedFrame = {
  dataUrl: "data:image/jpeg;base64,c3RpbGwtZnJhbWU=",
  width: 1080,
  height: 1920,
  orientation: "portrait",
};

function createTrack() {
  return {
    stop: vi.fn(),
  };
}

function createStream(track: ReturnType<typeof createTrack>) {
  return {
    getTracks: () => [track],
  } as unknown as MediaStream;
}

async function mountPanel(
  adapter: CameraMediaAdapter,
  captureFrame = vi.fn(() => capturedFrame),
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
    throw new Error("Camera capture test root was not created.");
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });

  const root = createRoot(container);
  const mounted = {
    container,
    root,
    window: dom.window as unknown as Window,
  };
  mountedPanels.push(mounted);

  await act(async () => {
    root.render(<CameraAccessPanel adapter={adapter} captureFrame={captureFrame} />);
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

async function startReadyPreview(mounted: MountedPanel): Promise<HTMLVideoElement> {
  await act(async () => {
    getButton(mounted.container, "Use camera").click();
  });
  const video = mounted.container.querySelector("video");

  if (video === null) {
    throw new Error("Live preview was not rendered.");
  }

  await act(async () => {
    video.dispatchEvent(
      new (mounted.window as unknown as typeof window).Event("loadedmetadata", {
        bubbles: true,
      }),
    );
  });

  return video;
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
  Reflect.deleteProperty(globalThis, "navigator");
  Reflect.deleteProperty(globalThis, "fetch");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("static frame capture", () => {
  it("renders the stream, captures locally, and stops the camera immediately", async () => {
    const track = createTrack();
    const captureFrame = vi.fn(() => capturedFrame);
    const fetchSpy = vi.fn();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchSpy,
    });
    const mounted = await mountPanel(
      {
        getAvailability: () => "available",
        requestStream: vi.fn(async () => createStream(track)),
      },
      captureFrame,
    );
    const video = await startReadyPreview(mounted);

    expect(video.srcObject).not.toBeNull();
    expect(getButton(mounted.container, "Capture frame").disabled).toBe(false);

    await act(async () => {
      getButton(mounted.container, "Capture frame").click();
    });

    expect(captureFrame).toHaveBeenCalledWith(video);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(mounted.container.textContent).toContain("Review this capture.");
    expect(mounted.container.textContent).toContain("The camera is off.");
    expect(mounted.container.textContent).toContain("1080 × 1920");
    expect(mounted.container.textContent).toContain("portrait");
    expect(
      mounted.container.querySelector<HTMLImageElement>(
        'img[alt="Captured meeting notes awaiting confirmation"]',
      )?.src,
    ).toBe(capturedFrame.dataUrl);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the selected front camera and obtains a fresh stream for retake", async () => {
    const firstTrack = createTrack();
    const secondTrack = createTrack();
    const requestStream = vi
      .fn()
      .mockResolvedValueOnce(createStream(firstTrack))
      .mockResolvedValueOnce(createStream(secondTrack));
    const mounted = await mountPanel({
      getAvailability: () => "available",
      requestStream,
    });
    const cameraSelect = mounted.container.querySelector<HTMLSelectElement>("select");

    if (cameraSelect === null) {
      throw new Error("Camera direction selector was not rendered.");
    }

    await act(async () => {
      cameraSelect.value = "user";
      cameraSelect.dispatchEvent(
        new (mounted.window as unknown as typeof window).Event("change", {
          bubbles: true,
        }),
      );
    });
    await startReadyPreview(mounted);

    expect(requestStream).toHaveBeenNthCalledWith(1, createCameraConstraints("user"));

    await act(async () => {
      getButton(mounted.container, "Capture frame").click();
    });
    await act(async () => {
      getButton(mounted.container, "Retake").click();
    });

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(requestStream).toHaveBeenNthCalledWith(2, createCameraConstraints("user"));
    expect(mounted.container.querySelector("video")).not.toBeNull();

    await act(async () => {
      mounted.root.unmount();
    });
    mountedPanels.pop();

    expect(secondTrack.stop).toHaveBeenCalledOnce();
  });

  it("keeps the live stream active when canvas capture fails", async () => {
    const track = createTrack();
    const mounted = await mountPanel(
      {
        getAvailability: () => "available",
        requestStream: vi.fn(async () => createStream(track)),
      },
      vi.fn(() => {
        throw new FrameCaptureError();
      }),
    );
    await startReadyPreview(mounted);

    await act(async () => {
      getButton(mounted.container, "Capture frame").click();
    });

    expect(mounted.container.textContent).toContain("The frame could not be captured.");
    expect(track.stop).not.toHaveBeenCalled();
    expect(getButton(mounted.container, "Capture frame")).toBeDefined();
  });
});

describe("canvas frame adapter", () => {
  it.each([
    [1920, 1080, "landscape"],
    [1080, 1920, "portrait"],
    [1200, 1200, "square"],
  ] as const)("classifies %d × %d as %s", (width, height, orientation) => {
    expect(getFrameOrientation(width, height)).toBe(orientation);
  });

  it("draws the source frame at its native orientation and returns JPEG data", () => {
    const drawImage = vi.fn();
    const canvas: FrameCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: vi.fn(() => capturedFrame.dataUrl),
    };
    const video = {
      videoWidth: 1080,
      videoHeight: 1920,
    } as HTMLVideoElement;

    expect(captureVideoFrame(video, () => canvas)).toEqual(capturedFrame);
    expect(canvas.width).toBe(1080);
    expect(canvas.height).toBe(1920);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1080, 1920);
    expect(canvas.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.92);
  });

  it("rejects previews without pixels and unavailable canvas contexts", () => {
    expect(() =>
      captureVideoFrame(
        {
          videoWidth: 0,
          videoHeight: 0,
        } as HTMLVideoElement,
        vi.fn(),
      ),
    ).toThrow(FrameCaptureError);
    expect(() =>
      captureVideoFrame(
        {
          videoWidth: 640,
          videoHeight: 480,
        } as HTMLVideoElement,
        () => ({
          width: 0,
          height: 0,
          getContext: () => null,
          toDataURL: vi.fn(),
        }),
      ),
    ).toThrow(FrameCaptureError);
  });
});
