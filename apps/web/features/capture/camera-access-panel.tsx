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
import { useCameraPermission } from "./use-camera-permission";

type CameraAccessPanelProps = Readonly<{
  adapter?: CameraMediaAdapter;
  captureFrame?: FrameCapture;
}>;

type CameraPreviewProps = Readonly<{
  facingMode: CameraFacingMode;
  stream: MediaStream;
  captureFrame: FrameCapture;
  onCapture: (frame: CapturedFrame) => void;
  onCaptureError: () => void;
}>;

const statusCopy: Readonly<
  Record<CameraPermissionState["status"], Readonly<{ title: string; detail: string }>>
> = {
  idle: {
    title: "Camera access is off.",
    detail:
      "Nothing is requested on page load. Choose a camera, then press the button when you want to grant access.",
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
      "You can change this site's camera permission in your browser settings, retry, or continue with the synthetic sample.",
  },
  unavailable: {
    title: "Camera access is unavailable.",
    detail:
      "Use HTTPS or localhost in a browser with camera support, or continue with the synthetic sample.",
  },
  error: {
    title: "The camera could not start.",
    detail:
      "The device may be busy. Close other camera apps, then try again or use the synthetic sample.",
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
}: CameraAccessPanelProps) {
  const camera = useCameraPermission(adapter);
  const [facingMode, setFacingMode] = useState<CameraFacingMode>("environment");
  const [capturedFrame, setCapturedFrame] = useState<CapturedFrame | null>(null);
  const [captureError, setCaptureError] = useState(false);
  const copy = statusCopy[camera.state.status];
  const isRequesting = camera.state.status === "requesting";
  const isGranted = camera.state.status === "granted" && camera.stream !== null;
  const isError =
    camera.state.status === "denied" ||
    camera.state.status === "unavailable" ||
    camera.state.status === "error";

  const stopAndUseSample = () => {
    camera.releaseCamera();
    setCapturedFrame(null);
    setCaptureError(false);
    document.getElementById("review-title")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const handleCapture = (frame: CapturedFrame) => {
    setCapturedFrame(frame);
    setCaptureError(false);
    camera.releaseCamera();
  };

  const retake = () => {
    setCapturedFrame(null);
    setCaptureError(false);
    void camera.requestCamera(facingMode);
  };

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
          testing.
        </p>
        {capturedFrame === null ? (
          <div
            className={`camera-access-status camera-access-status--${
              captureError ? "error" : camera.state.status
            }`}
            role={isError || captureError ? "alert" : "status"}
            aria-live={isError || captureError ? "assertive" : "polite"}
          >
            <span aria-hidden="true" />
            <div>
              <strong>
                {captureError ? "The frame could not be captured." : copy.title}
              </strong>
              <p>
                {captureError
                  ? "Wait for the preview to settle, then try the capture again."
                  : copy.detail}
              </p>
            </div>
          </div>
        ) : null}
      </div>
      {capturedFrame === null ? (
        <div className="camera-access-actions">
          <label className="camera-facing-field">
            <span>Camera</span>
            <select
              value={facingMode}
              disabled={isRequesting}
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
              onClick={camera.releaseCamera}
            >
              Turn camera off
            </button>
          ) : (
            <button
              className="button button--primary"
              type="button"
              disabled={isRequesting}
              onClick={() => void camera.requestCamera(facingMode)}
            >
              {isRequesting ? "Requesting camera…" : "Use camera"}
            </button>
          )}
          <button
            className="button button--quiet"
            type="button"
            onClick={stopAndUseSample}
          >
            Continue with sample
          </button>
        </div>
      ) : null}
      {isGranted && capturedFrame === null ? (
        <CameraPreview
          facingMode={facingMode}
          stream={camera.stream}
          captureFrame={captureFrame}
          onCapture={handleCapture}
          onCaptureError={() => setCaptureError(true)}
        />
      ) : null}
      {capturedFrame !== null ? (
        <div className="camera-capture-review">
          <div className="camera-capture-review-image">
            <Image
              src={capturedFrame.dataUrl}
              alt="Captured meeting notes awaiting confirmation"
              width={capturedFrame.width}
              height={capturedFrame.height}
              unoptimized
            />
          </div>
          <div className="camera-capture-review-copy">
            <p className="section-kicker">Static frame</p>
            <h3>Review this capture.</h3>
            <p>
              The camera is off. This {capturedFrame.orientation} frame stays in browser
              memory and has not been uploaded.
            </p>
            <dl>
              <div>
                <dt>Dimensions</dt>
                <dd>
                  {capturedFrame.width} × {capturedFrame.height}
                </dd>
              </div>
              <div>
                <dt>Orientation</dt>
                <dd>{capturedFrame.orientation}</dd>
              </div>
            </dl>
            <div className="camera-capture-review-actions">
              <button className="button button--primary" type="button" onClick={retake}>
                Retake
              </button>
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
