"use client";

import type { CameraMediaAdapter, CameraPermissionState } from "./camera-permission";
import { useCameraPermission } from "./use-camera-permission";

type CameraAccessPanelProps = Readonly<{
  adapter?: CameraMediaAdapter;
}>;

const statusCopy: Readonly<
  Record<CameraPermissionState["status"], Readonly<{ title: string; detail: string }>>
> = {
  idle: {
    title: "Camera access is off.",
    detail:
      "Nothing is requested on page load. Press the button when you want to grant access.",
  },
  requesting: {
    title: "Waiting for your browser.",
    detail: "Use the browser prompt to allow or block camera access.",
  },
  granted: {
    title: "Camera access is ready.",
    detail:
      "The stream is active only in this page. Live preview and capture arrive in the next step.",
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

export function CameraAccessPanel({ adapter }: CameraAccessPanelProps) {
  const camera = useCameraPermission(adapter);
  const copy = statusCopy[camera.state.status];
  const isRequesting = camera.state.status === "requesting";
  const isGranted = camera.state.status === "granted";
  const isError =
    camera.state.status === "denied" ||
    camera.state.status === "unavailable" ||
    camera.state.status === "error";

  const stopAndUseSample = () => {
    camera.releaseCamera();
    document.getElementById("review-title")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  return (
    <section className="camera-access-card" aria-labelledby="camera-access-title">
      <div className="camera-access-glyph" aria-hidden="true">
        <span />
      </div>
      <div className="camera-access-copy">
        <p className="section-kicker">Optional live source</p>
        <h2 id="camera-access-title">Use your camera when you choose.</h2>
        <p>
          SnapFlow asks for the rear camera only after a click. Browsers require a
          secure HTTPS page or localhost. Use the deployed HTTPS version for reliable
          phone testing.
        </p>
        <div
          className={`camera-access-status camera-access-status--${camera.state.status}`}
          role={isError ? "alert" : "status"}
          aria-live={isError ? "assertive" : "polite"}
        >
          <span aria-hidden="true" />
          <div>
            <strong>{copy.title}</strong>
            <p>{copy.detail}</p>
          </div>
        </div>
      </div>
      <div className="camera-access-actions">
        {isGranted ? (
          <button
            className="button button--primary"
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
            onClick={() => void camera.requestCamera()}
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
    </section>
  );
}
