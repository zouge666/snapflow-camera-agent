"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  browserCameraMediaAdapter,
  classifyCameraError,
  createCameraConstraints,
  initialCameraPermissionState,
  stopMediaStream,
  type CameraMediaAdapter,
  type CameraPermissionState,
} from "./camera-permission";

type CameraPermissionController = Readonly<{
  state: CameraPermissionState;
  stream: MediaStream | null;
  requestCamera: () => Promise<void>;
  releaseCamera: () => void;
}>;

export function useCameraPermission(
  adapter: CameraMediaAdapter = browserCameraMediaAdapter,
): CameraPermissionController {
  const [state, setState] = useState(initialCameraPermissionState);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestVersionRef = useRef(0);
  const mountedRef = useRef(false);

  const releaseCamera = useCallback(() => {
    requestVersionRef.current += 1;
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setState(initialCameraPermissionState);
  }, []);

  const requestCamera = useCallback(async () => {
    const availability = adapter.getAvailability();

    if (availability !== "available") {
      setState({
        status: "unavailable",
        reason:
          availability === "insecure-context" ? "insecure-context" : "unsupported",
      });
      return;
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setState({ status: "requesting" });

    try {
      const stream = await adapter.requestStream(createCameraConstraints());

      if (!mountedRef.current || requestVersionRef.current !== requestVersion) {
        stopMediaStream(stream);
        return;
      }

      streamRef.current = stream;
      setStream(stream);
      setState({ status: "granted" });
    } catch (error) {
      if (mountedRef.current && requestVersionRef.current === requestVersion) {
        setState(classifyCameraError(error));
      }
    }
  }, [adapter]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      requestVersionRef.current += 1;
      stopMediaStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  return {
    state,
    stream,
    requestCamera,
    releaseCamera,
  };
}
