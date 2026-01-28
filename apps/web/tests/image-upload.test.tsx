import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CameraAccessPanel } from "../features/capture/camera-access-panel";
import type { CapturedFrame } from "../features/capture/capture-frame";
import type { CameraMediaAdapter } from "../features/capture/camera-permission";
import {
  browserImageDecoder,
  imagePickerAccept,
  ImageUploadError,
  loadImageFile,
  maxImageUploadBytes,
  validateImageFile,
  type ImageFileLoader,
} from "../features/capture/image-upload";

type MountedPanel = Readonly<{
  container: HTMLDivElement;
  root: Root;
  window: Window;
}>;

const jpegBytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10] as const;
const pngBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00] as const;
const uploadedFrame: CapturedFrame = {
  dataUrl: "data:image/png;base64,c25hcGZsb3c=",
  width: 1600,
  height: 1000,
  orientation: "landscape",
};
const mountedPanels: MountedPanel[] = [];

function createImageFile(bytes: readonly number[], name: string, type: string): File {
  return new File([new Uint8Array(bytes).buffer], name, { type });
}

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
  loadFile: ImageFileLoader,
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
    throw new Error("Image upload test root was not created.");
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
    root.render(<CameraAccessPanel adapter={adapter} loadFile={loadFile} />);
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

async function selectFile(
  mounted: MountedPanel,
  file: File,
): Promise<HTMLInputElement> {
  const input = mounted.container.querySelector<HTMLInputElement>('input[type="file"]');

  if (input === null) {
    throw new Error("Image file input was not rendered.");
  }

  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  await act(async () => {
    input.dispatchEvent(
      new (mounted.window as unknown as typeof window).Event("change", {
        bubbles: true,
      }),
    );
  });

  return input;
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
  Reflect.deleteProperty(globalThis, "createImageBitmap");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("local image validation", () => {
  it.each([
    ["notes.jpg", "image/jpeg", jpegBytes, "data:image/jpeg;base64,/9j/"],
    ["notes.png", "image/png", pngBytes, "data:image/png;base64,iVBORw=="],
  ] as const)(
    "accepts a matching %s signature and returns a local frame",
    async (name, type, bytes, dataUrl) => {
      const file = createImageFile(bytes, name, type);

      await expect(
        loadImageFile(
          file,
          vi.fn(async () => ({ width: 1600, height: 1000 })),
          vi.fn(async () => dataUrl),
        ),
      ).resolves.toEqual({
        dataUrl,
        width: 1600,
        height: 1000,
        orientation: "landscape",
      });
    },
  );

  it("rejects unlisted formats before attempting decode", async () => {
    const decodeImage = vi.fn();
    const file = createImageFile(pngBytes, "notes.gif", "image/gif");

    await expect(validateImageFile(file, decodeImage)).rejects.toMatchObject({
      code: "unsupported-format",
    });
    expect(decodeImage).not.toHaveBeenCalled();
  });

  it.each([
    [pngBytes, "notes.jpg", "image/jpeg"],
    [pngBytes, "notes.jpg", "image/png"],
    [jpegBytes, "notes.png", "image/jpeg"],
  ] as const)(
    "rejects mismatched content, name, and MIME declarations",
    async (bytes, name, type) => {
      const decodeImage = vi.fn();

      await expect(
        validateImageFile(createImageFile(bytes, name, type), decodeImage),
      ).rejects.toMatchObject({
        code: "type-mismatch",
      });
      expect(decodeImage).not.toHaveBeenCalled();
    },
  );

  it("rejects an oversized file before reading pixels", async () => {
    const decodeImage = vi.fn();
    const file = createImageFile(jpegBytes, "notes.jpg", "image/jpeg");
    Object.defineProperty(file, "size", {
      configurable: true,
      value: maxImageUploadBytes + 1,
    });

    await expect(validateImageFile(file, decodeImage)).rejects.toMatchObject({
      code: "file-too-large",
    });
    expect(decodeImage).not.toHaveBeenCalled();
  });

  it("maps decoder failures and invalid dimensions to safe errors", async () => {
    const file = createImageFile(pngBytes, "notes.png", "image/png");

    await expect(
      validateImageFile(
        file,
        vi.fn(async () => Promise.reject(new Error("bad"))),
      ),
    ).rejects.toMatchObject({
      code: "decode-failed",
    });
    await expect(
      validateImageFile(
        file,
        vi.fn(async () => ({ width: 0, height: 1000 })),
      ),
    ).rejects.toMatchObject({
      code: "decode-failed",
    });
  });

  it.each([
    [8193, 1000],
    [1000, 8193],
    [6000, 5000],
  ])("rejects unsafe decoded dimensions %d × %d", async (width, height) => {
    const file = createImageFile(pngBytes, "notes.png", "image/png");

    await expect(
      validateImageFile(
        file,
        vi.fn(async () => ({ width, height })),
      ),
    ).rejects.toMatchObject({
      code: "dimensions-too-large",
    });
  });

  it("closes the browser bitmap after reading dimensions", async () => {
    const close = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn(async () => ({
        width: 1200,
        height: 800,
        close,
      })),
    });
    const file = createImageFile(jpegBytes, "notes.jpg", "image/jpeg");

    await expect(browserImageDecoder(file)).resolves.toEqual({
      width: 1200,
      height: 800,
    });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("file picker fallback", () => {
  it("accepts a local image after camera denial without sending it anywhere", async () => {
    const denied = new Error("blocked");
    denied.name = "NotAllowedError";
    const loadFile = vi.fn(async () => uploadedFrame);
    const fetchSpy = vi.fn();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchSpy,
    });
    const mounted = await mountPanel(
      {
        getAvailability: () => "available",
        requestStream: vi.fn(async () => Promise.reject(denied)),
      },
      loadFile,
    );

    await act(async () => {
      getButton(mounted.container, "Use camera").click();
    });
    expect(mounted.container.textContent).toContain("Camera access was blocked.");

    const file = createImageFile(pngBytes, "planning-notes.png", "image/png");
    const input = await selectFile(mounted, file);

    expect(input.accept).toBe(imagePickerAccept);
    expect(input.value).toBe("");
    expect(loadFile).toHaveBeenCalledWith(file);
    expect(mounted.container.textContent).toContain("Review this image.");
    expect(mounted.container.textContent).toContain("planning-notes.png");
    expect(mounted.container.textContent).toContain("1600 × 1000");
    expect(mounted.container.textContent).toContain("has not been sent to the API");
    expect(
      mounted.container.querySelector<HTMLImageElement>(
        'img[alt="Selected meeting notes awaiting confirmation"]',
      )?.src,
    ).toBe(uploadedFrame.dataUrl);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stops an active camera before validating a selected file", async () => {
    const track = createTrack();
    let resolveFile: ((frame: CapturedFrame) => void) | undefined;
    const filePromise = new Promise<CapturedFrame>((resolve) => {
      resolveFile = resolve;
    });
    const mounted = await mountPanel(
      {
        getAvailability: () => "available",
        requestStream: vi.fn(async () => createStream(track)),
      },
      vi.fn(() => filePromise),
    );

    await act(async () => {
      getButton(mounted.container, "Use camera").click();
    });
    await selectFile(mounted, createImageFile(pngBytes, "notes.png", "image/png"));

    expect(track.stop).toHaveBeenCalledOnce();
    expect(mounted.container.textContent).toContain("Checking the selected image.");

    await act(async () => {
      resolveFile?.(uploadedFrame);
      await filePromise;
    });
    expect(mounted.container.textContent).toContain("Review this image.");
  });

  it("shows a local validation error and keeps API calls at zero", async () => {
    const fetchSpy = vi.fn();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchSpy,
    });
    const mounted = await mountPanel(
      {
        getAvailability: () => "unsupported",
        requestStream: vi.fn(),
      },
      vi.fn(async () => Promise.reject(new ImageUploadError("type-mismatch"))),
    );

    await selectFile(mounted, createImageFile(pngBytes, "fake.jpg", "image/jpeg"));

    expect(mounted.container.textContent).toContain(
      "The selected image was not accepted.",
    );
    expect(mounted.container.textContent).toContain("The file contents do not match");
    expect(mounted.container.querySelector("img")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
