import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CameraAccessPanel } from "../features/capture/camera-access-panel";
import {
  classifyCameraError,
  createCameraConstraints,
  stopMediaStream,
  type CameraMediaAdapter,
} from "../features/capture/camera-permission";

type MountedPanel = Readonly<{
  container: HTMLDivElement;
  root: Root;
  window: Window;
}>;

const mountedPanels: MountedPanel[] = [];

function createTrack() {
  return {
    stop: vi.fn(),
  };
}

function createStream(...tracks: ReturnType<typeof createTrack>[]) {
  return {
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

async function mountPanel(adapter: CameraMediaAdapter): Promise<MountedPanel> {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    {
      pretendToBeVisual: true,
      url: "http://localhost:3000/demo",
    },
  );
  const container = dom.window.document.querySelector<HTMLDivElement>("#root");

  if (container === null) {
    throw new Error("Camera test root was not created.");
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
    root.render(<CameraAccessPanel adapter={adapter} />);
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
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("camera permission state", () => {
  it("requests the environment-facing camera only after a user click", async () => {
    const track = createTrack();
    const requestStream = vi.fn(async () => createStream(track));
    const mounted = await mountPanel({
      getAvailability: () => "available",
      requestStream,
    });

    expect(requestStream).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain("Camera access is off.");

    await act(async () => {
      getButton(mounted.container, "Use camera").click();
    });

    expect(requestStream).toHaveBeenCalledOnce();
    expect(requestStream).toHaveBeenCalledWith(createCameraConstraints());
    expect(mounted.container.textContent).toContain("Live preview is ready.");
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("stops every active track when the camera is turned off", async () => {
    const firstTrack = createTrack();
    const secondTrack = createTrack();
    const mounted = await mountPanel({
      getAvailability: () => "available",
      requestStream: vi.fn(async () => createStream(firstTrack, secondTrack)),
    });

    await act(async () => {
      getButton(mounted.container, "Use camera").click();
    });
    await act(async () => {
      getButton(mounted.container, "Turn camera off").click();
    });

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(secondTrack.stop).toHaveBeenCalledOnce();
    expect(mounted.container.textContent).toContain("Camera access is off.");
  });

  it("stops the stream before switching back to the sample", async () => {
    const track = createTrack();
    const mounted = await mountPanel({
      getAvailability: () => "available",
      requestStream: vi.fn(async () => createStream(track)),
    });

    await act(async () => {
      getButton(mounted.container, "Use camera").click();
    });
    await act(async () => {
      getButton(mounted.container, "Continue with sample").click();
    });

    expect(track.stop).toHaveBeenCalledOnce();
    expect(mounted.container.textContent).toContain("Camera access is off.");
  });

  it("stops an active stream when the panel leaves the page", async () => {
    const track = createTrack();
    const mounted = await mountPanel({
      getAvailability: () => "available",
      requestStream: vi.fn(async () => createStream(track)),
    });

    await act(async () => {
      getButton(mounted.container, "Use camera").click();
    });
    await act(async () => {
      mounted.root.unmount();
    });
    mountedPanels.pop();

    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("stops a late stream if permission resolves after unmount", async () => {
    const track = createTrack();
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const streamPromise = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const mounted = await mountPanel({
      getAvailability: () => "available",
      requestStream: vi.fn(() => streamPromise),
    });

    await act(async () => {
      getButton(mounted.container, "Use camera").click();
    });
    await act(async () => {
      mounted.root.unmount();
    });
    mountedPanels.pop();

    await act(async () => {
      resolveStream?.(createStream(track));
      await streamPromise;
    });

    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("shows denied permission without pretending the camera started", async () => {
    const denied = new Error("blocked");
    denied.name = "NotAllowedError";
    const mounted = await mountPanel({
      getAvailability: () => "available",
      requestStream: vi.fn(async () => Promise.reject(denied)),
    });

    await act(async () => {
      getButton(mounted.container, "Use camera").click();
    });

    expect(mounted.container.textContent).toContain("Camera access was blocked.");
    expect(mounted.container.textContent).toContain("browser settings");
    expect(getButton(mounted.container, "Use camera").disabled).toBe(false);
  });

  it.each(["insecure-context", "unsupported"] as const)(
    "explains an %s environment without calling media APIs",
    async (availability) => {
      const requestStream = vi.fn();
      const mounted = await mountPanel({
        getAvailability: () => availability,
        requestStream,
      });

      await act(async () => {
        getButton(mounted.container, "Use camera").click();
      });

      expect(requestStream).not.toHaveBeenCalled();
      expect(mounted.container.textContent).toContain("Use HTTPS or localhost");
    },
  );
});

describe("camera permission helpers", () => {
  it("builds explicit rear and front camera constraints", () => {
    expect(createCameraConstraints("environment")).toEqual({
      audio: false,
      video: {
        facingMode: {
          ideal: "environment",
        },
      },
    });
    expect(createCameraConstraints("user")).toEqual({
      audio: false,
      video: {
        facingMode: {
          ideal: "user",
        },
      },
    });
  });

  it("classifies missing devices and unexpected failures separately", () => {
    expect(classifyCameraError({ name: "NotFoundError" })).toEqual({
      status: "unavailable",
      reason: "device-unavailable",
    });
    expect(classifyCameraError(new Error("busy"))).toEqual({
      status: "error",
      reason: "request-failed",
    });
  });

  it("stops all tracks and accepts an empty stream reference", () => {
    const firstTrack = createTrack();
    const secondTrack = createTrack();

    stopMediaStream(createStream(firstTrack, secondTrack));
    stopMediaStream(null);

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(secondTrack.stop).toHaveBeenCalledOnce();
  });
});
