export type CameraAvailability = "available" | "insecure-context" | "unsupported";

export type CameraPermissionStatus =
  "idle" | "requesting" | "granted" | "denied" | "unavailable" | "error";

export type CameraPermissionReason =
  | "insecure-context"
  | "unsupported"
  | "permission-denied"
  | "device-unavailable"
  | "request-failed";

export type CameraPermissionState = Readonly<{
  status: CameraPermissionStatus;
  reason?: CameraPermissionReason;
}>;

export type CameraMediaAdapter = Readonly<{
  getAvailability: () => CameraAvailability;
  requestStream: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}>;

export const initialCameraPermissionState: CameraPermissionState = {
  status: "idle",
};

export function createCameraConstraints(): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: {
        ideal: "environment",
      },
    },
  };
}

export function classifyCameraError(error: unknown): CameraPermissionState {
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
      ? error.name
      : "";

  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      status: "denied",
      reason: "permission-denied",
    };
  }

  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      status: "unavailable",
      reason: "device-unavailable",
    };
  }

  return {
    status: "error",
    reason: "request-failed",
  };
}

export function stopMediaStream(stream: MediaStream | null): void {
  if (stream === null) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export const browserCameraMediaAdapter: CameraMediaAdapter = {
  getAvailability() {
    if (typeof window === "undefined" || !window.isSecureContext) {
      return "insecure-context";
    }

    if (
      typeof navigator === "undefined" ||
      navigator.mediaDevices?.getUserMedia === undefined
    ) {
      return "unsupported";
    }

    return "available";
  },
  requestStream(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints);
  },
};
