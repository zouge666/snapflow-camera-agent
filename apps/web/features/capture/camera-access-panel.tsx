"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import {
  captureVideoFrame,
  type CapturedFrame,
  type FrameCapture,
} from "./capture-frame";
import type {
  CameraFacingMode,
  CameraMediaAdapter,
  CameraPermissionState,
} from "./camera-permission";
import {
  getImageUploadErrorMessage,
  imagePickerAccept,
  loadImageFile,
  type ImageFileLoader,
} from "./image-upload";
import { useCameraPermission } from "./use-camera-permission";

type CameraAccessPanelProps = Readonly<{
  adapter?: CameraMediaAdapter;
  captureFrame?: FrameCapture;
  loadFile?: ImageFileLoader;
}>;

type CameraPreviewProps = Readonly<{
  facingMode: CameraFacingMode;
  stream: MediaStream;
  captureFrame: FrameCapture;
  onCapture: (frame: CapturedFrame) => void;
  onCaptureError: () => void;
}>;

type SelectedFrame = Readonly<{
  frame: CapturedFrame;
  source: "camera" | "upload";
  fileName?: string;
}>;

const statusCopy: Readonly<
  Record<CameraPermissionState["status"], Readonly<{ title: string; detail: string }>>
> = {
  idle: {
    title: "Camera access is off.",
    detail:
      "Nothing is requested on page load. Start a camera when you want, or choose a local image instead.",
  },
  requesting: {
    title: "Waiting for your browser.",
    detail: "Use the browser prompt to allow or block camera access.",
  },
  granted: {
    title: "Live preview is ready.",
    detail:
      "Frame capture stays in this browser. Taking a photo stops the live stream immediately.",
  },
  denied: {
    title: "Camera access was blocked.",
    detail:
      "Change this site's permission in browser settings, retry, choose a local image, or continue with the synthetic sample.",
  },
  unavailable: {
    title: "Camera access is unavailable.",
    detail:
      "Use HTTPS or localhost with camera support, choose a local image, or continue with the synthetic sample.",
  },
  error: {
    title: "The camera could not start.",
    detail:
      "The device may be busy. Try again, choose a local image, or use the synthetic sample.",
  },
};

function CameraPreview({
  facingMode,
  stream,
  captureFrame,
  onCapture,
  onCaptureError,
}: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;

    if (video === null) {
      return;
    }

    video.srcObject = stream;
    setIsReady(false);

    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  const capture = () => {
    const video = videoRef.current;

    if (video === null) {
      onCaptureError();
      return;
    }

    try {
      onCapture(captureFrame(video));
    } catch {
      onCaptureError();
    }
  };

  return (
    <div className="camera-preview">
      <div className="camera-preview-viewport">
        <video
          ref={videoRef}
          className={
            facingMode === "user" ? "camera-preview-video is-front-facing" : ""
          }
          aria-label="Live camera preview"
          autoPlay
          muted
          playsInline
          onLoadedMetadata={() => setIsReady(true)}
        />
        <span className="camera-preview-badge">Live · device only</span>
      </div>
      <div className="camera-preview-footer">
        <p>
          The preview is not streamed to SnapFlow. Capture creates one local still
          frame.
        </p>
        <button
          className="button button--primary"
          type="button"
          disabled={!isReady}
          onClick={capture}
        >
          {isReady ? "Capture frame" : "Starting preview…"}
        </button>
      </div>
    </div>
  );
}

export function CameraAccessPanel({
  adapter,
  captureFrame = captureVideoFrame,
  loadFile = loadImageFile,
}: CameraAccessPanelProps) {
  const camera = useCameraPermission(adapter);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadVersionRef = useRef(0);
  const [facingMode, setFacingMode] = useState<CameraFacingMode>("environment");
  const [selectedFrame, setSelectedFrame] = useState<SelectedFrame | null>(null);
  const [captureError, setCaptureError] = useState(false);
  const [uploadState, setUploadState] = useState<
    Readonly<{ status: "idle" | "validating" | "error"; message?: string }>
  >({ status: "idle" });
  const copy = statusCopy[camera.state.status];
  const isRequesting = camera.state.status === "requesting";
  const isGranted = camera.state.status === "granted" && camera.stream !== null;
  const isUploadValidating = uploadState.status === "validating";
  const isBusy = isRequesting || isUploadValidating;
  const isError =
    camera.state.status === "denied" ||
    camera.state.status === "unavailable" ||
    camera.state.status === "error" ||
    uploadState.status === "error";

  useEffect(
    () => () => {
      uploadVersionRef.current += 1;
    },
    [],
  );

  const stopAndUseSample = () => {
    uploadVersionRef.current += 1;
    camera.releaseCamera();
    setSelectedFrame(null);
    setCaptureError(false);
    setUploadState({ status: "idle" });
    document.getElementById("review-title")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const handleCapture = (frame: CapturedFrame) => {
    uploadVersionRef.current += 1;
    setSelectedFrame({
      frame,
      source: "camera",
    });
    setCaptureError(false);
    setUploadState({ status: "idle" });
    camera.releaseCamera();
  };

  const retake = () => {
    uploadVersionRef.current += 1;
    setSelectedFrame(null);
    setCaptureError(false);
    setUploadState({ status: "idle" });
    void camera.requestCamera(facingMode);
  };

  const startCamera = () => {
    uploadVersionRef.current += 1;
    setUploadState({ status: "idle" });
    void camera.requestCamera(facingMode);
  };

  const handleFileSelection = async (file: File | undefined) => {
    if (file === undefined) {
      return;
    }

    const uploadVersion = uploadVersionRef.current + 1;
    uploadVersionRef.current = uploadVersion;
    camera.releaseCamera();
    setSelectedFrame(null);
    setCaptureError(false);
    setUploadState({ status: "validating" });

    try {
      const frame = await loadFile(file);
      if (uploadVersionRef.current === uploadVersion) {
        setSelectedFrame({
          frame,
          source: "upload",
          fileName: file.name,
        });
        setUploadState({ status: "idle" });
      }
    } catch (error) {
      if (uploadVersionRef.current === uploadVersion) {
        setUploadState({
          status: "error",
          message: getImageUploadErrorMessage(error),
        });
      }
    }
  };

  const chooseAnotherImage = () => {
    uploadInputRef.current?.click();
  };

  const selectedImage = selectedFrame?.frame ?? null;

  return (
    <section className="camera-access-card" aria-labelledby="camera-access-title">
      <div className="camera-access-glyph" aria-hidden="true">
        <span />
      </div>
      <div className="camera-access-copy">
        <p className="section-kicker">Optional live source</p>
        <h2 id="camera-access-title">Capture one frame when you choose.</h2>
        <p>
          SnapFlow asks for camera access only after a click. Browsers require a secure
          HTTPS page or localhost. Use the deployed HTTPS version for reliable phone
          testing. Local fallback accepts JPEG or PNG files up to 10 MiB.
        </p>
        {selectedImage === null ? (
          <div
            className={`camera-access-status camera-access-status--${
              captureError || uploadState.status === "error"
                ? "error"
                : camera.state.status
            }`}
            role={isError || captureError ? "alert" : "status"}
            aria-live={isError || captureError ? "assertive" : "polite"}
          >
            <span aria-hidden="true" />
            <div>
              <strong>
                {captureError
                  ? "The frame could not be captured."
                  : uploadState.status === "validating"
                    ? "Checking the selected image."
                    : uploadState.status === "error"
                      ? "The selected image was not accepted."
                      : copy.title}
              </strong>
              <p>
                {captureError
                  ? "Wait for the preview to settle, then try the capture again."
                  : uploadState.status === "validating"
                    ? "The file stays in this browser while its type, size, and dimensions are validated."
                    : uploadState.status === "error"
                      ? uploadState.message
                      : copy.detail}
              </p>
            </div>
          </div>
        ) : null}
      </div>
      {selectedImage === null ? (
        <div className="camera-access-actions">
          <label className="camera-facing-field">
            <span>Camera</span>
            <select
              value={facingMode}
              disabled={isBusy}
              onChange={(event) => {
                const nextFacingMode = event.target.value as CameraFacingMode;
                setFacingMode(nextFacingMode);
                setCaptureError(false);
                if (isGranted) {
                  void camera.requestCamera(nextFacingMode);
                }
              }}
            >
              <option value="environment">Rear camera</option>
              <option value="user">Front camera</option>
            </select>
          </label>
          {isGranted ? (
            <button
              className="button button--quiet"
              type="button"
              disabled={isUploadValidating}
              onClick={camera.releaseCamera}
            >
              Turn camera off
            </button>
          ) : (
            <button
              className="button button--primary"
              type="button"
              disabled={isBusy}
              onClick={startCamera}
            >
              {isRequesting ? "Requesting camera…" : "Use camera"}
            </button>
          )}
          <label
            className={`button button--quiet camera-upload-button${
              isUploadValidating ? " is-disabled" : ""
            }`}
          >
            <span>{isUploadValidating ? "Checking image…" : "Choose image"}</span>
            <input
              ref={uploadInputRef}
              type="file"
              accept={imagePickerAccept}
              disabled={isUploadValidating}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void handleFileSelection(file);
              }}
            />
          </label>
          <button
            className="button button--quiet"
            type="button"
            disabled={isUploadValidating}
            onClick={stopAndUseSample}
          >
            Continue with sample
          </button>
        </div>
      ) : null}
      {isGranted && selectedImage === null ? (
        <CameraPreview
          facingMode={facingMode}
          stream={camera.stream}
          captureFrame={captureFrame}
          onCapture={handleCapture}
          onCaptureError={() => setCaptureError(true)}
        />
      ) : null}
      {selectedFrame !== null ? (
        <div className="camera-capture-review">
          <div className="camera-capture-review-image">
            <Image
              src={selectedFrame.frame.dataUrl}
              alt={
                selectedFrame.source === "camera"
                  ? "Captured meeting notes awaiting confirmation"
                  : "Selected meeting notes awaiting confirmation"
              }
              width={selectedFrame.frame.width}
              height={selectedFrame.frame.height}
              unoptimized
            />
          </div>
          <div className="camera-capture-review-copy">
            <p className="section-kicker">
              {selectedFrame.source === "camera" ? "Static frame" : "Local image"}
            </p>
            <h3>
              {selectedFrame.source === "camera"
                ? "Review this capture."
                : "Review this image."}
            </h3>
            <p>
              The camera is off. This {selectedFrame.frame.orientation} image stays in
              browser memory and has not been sent to the API.
            </p>
            {selectedFrame.fileName ? (
              <p className="camera-capture-file-name">
                Selected file: <strong>{selectedFrame.fileName}</strong>
              </p>
            ) : null}
            <dl>
              <div>
                <dt>Dimensions</dt>
                <dd>
                  {selectedFrame.frame.width} × {selectedFrame.frame.height}
                </dd>
              </div>
              <div>
                <dt>Orientation</dt>
                <dd>{selectedFrame.frame.orientation}</dd>
              </div>
            </dl>
            <div className="camera-capture-review-actions">
              {selectedFrame.source === "camera" ? (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={retake}
                >
                  Retake
                </button>
              ) : (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={chooseAnotherImage}
                >
                  Choose another image
                </button>
              )}
              {selectedFrame.source === "upload" ? (
                <input
                  ref={uploadInputRef}
                  className="camera-upload-review-input"
                  type="file"
                  accept={imagePickerAccept}
                  aria-label="Choose another local image"
                  tabIndex={-1}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void handleFileSelection(file);
                  }}
                />
              ) : null}
              <button
                className="button button--quiet"
                type="button"
                onClick={stopAndUseSample}
              >
                Continue with sample
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
