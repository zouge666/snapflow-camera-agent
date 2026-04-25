import type {
  ActionItem,
  ClarificationAnswerKind,
  ClarificationQuestion,
  Evidence,
  RunStatus,
  RunView,
  SafeTraceEvent,
  TraceOutcome,
} from "../../lib/api/generated/types.gen";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type GuestSession = Readonly<{
  schema_version: "1.0";
  guest_session_id: string;
  access_token: string;
  token_type: "Bearer";
  expires_at: string;
  session_expires_at: string;
}>;

export type CreateRunInput = Readonly<{
  source_text: string;
  locale: string;
  timezone: string;
  reference_date: string;
}>;

const STORAGE_KEY = "snapflow.guest-session.v1";
const ACTIVE_RUN_KEY = "snapflow.active-run.v1";
const REFRESH_MARGIN_MS = 60_000;

const runStatuses = new Set<RunStatus>([
  "received",
  "input_validated",
  "extracting",
  "schema_validated",
  "evidence_checked",
  "interrupted_for_clarification",
  "clarification_received",
  "interrupted_for_approval",
  "approval_received",
  "exporting",
  "completed",
  "retryable_failure",
  "retrying",
  "fatal_failure",
  "expired",
  "deleted",
]);
const priorities = new Set(["low", "medium", "high", "unknown"]);
const traceOutcomes = new Set<TraceOutcome>([
  "started",
  "succeeded",
  "interrupted",
  "retrying",
  "failed",
]);

export type ActiveGuestRun = Readonly<{
  runId: string;
  referenceDate: string;
}>;

export class GuestSessionClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuestSessionClientError";
  }
}

function invalidSession(): never {
  throw new GuestSessionClientError(
    "The guest session service returned an invalid response.",
  );
}

function invalidRun(): never {
  throw new GuestSessionClientError(
    "The run store returned a response this app does not understand.",
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidRun();
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return invalidRun();
  return value;
}

function readNullableString(value: unknown): string | null {
  return value === null ? null : readString(value);
}

function readArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return invalidRun();
  return value;
}

function readEvidence(value: unknown): Evidence {
  const record = readRecord(value);
  if (
    typeof record.start !== "number" ||
    !Number.isInteger(record.start) ||
    record.start < 0 ||
    typeof record.end !== "number" ||
    !Number.isInteger(record.end) ||
    record.end <= record.start
  ) {
    return invalidRun();
  }
  return {
    quote: readString(record.quote),
    start: record.start,
    end: record.end,
  };
}

function readAction(value: unknown): ActionItem {
  const record = readRecord(value);
  const priority = readString(record.priority);
  const evidence = readArray(record.evidence).map(readEvidence);
  if (!priorities.has(priority) || evidence.length === 0) return invalidRun();
  return {
    id: readString(record.id),
    title: readString(record.title),
    owner: readNullableString(record.owner),
    due_date: readNullableString(record.due_date),
    due_text: readNullableString(record.due_text),
    priority: priority as ActionItem["priority"],
    evidence,
  };
}

function readClarification(value: unknown): ClarificationQuestion {
  const record = readRecord(value);
  const answerKind = readString(record.answer_kind);
  const options = readArray(record.options ?? []).map(readString);
  if (answerKind !== "option" && answerKind !== "free_text") {
    return invalidRun();
  }
  if (
    (answerKind === "option" && options.length < 2) ||
    (answerKind === "free_text" && options.length > 0)
  ) {
    return invalidRun();
  }
  return {
    id: readString(record.id),
    field_path: readString(record.field_path),
    question: readString(record.question),
    reason: readString(record.reason),
    answer_kind: answerKind,
    options,
    evidence: record.evidence === null ? null : readEvidence(record.evidence),
  };
}

function readTrace(value: unknown): SafeTraceEvent {
  const record = readRecord(value);
  const outcome = readString(record.outcome);
  if (
    !traceOutcomes.has(outcome as TraceOutcome) ||
    typeof record.sequence !== "number" ||
    !Number.isInteger(record.sequence) ||
    record.sequence < 0 ||
    record.schema_version !== "1.0"
  ) {
    return invalidRun();
  }
  const provider =
    record.provider === undefined ? undefined : readNullableString(record.provider);
  const retryCount =
    typeof record.retry_count === "number" ? record.retry_count : undefined;
  return {
    sequence: record.sequence,
    node: readString(record.node),
    outcome: outcome as TraceOutcome,
    occurred_at: readString(record.occurred_at),
    schema_version: "1.0",
    ...(provider === undefined ? {} : { provider }),
    ...(retryCount === undefined ? {} : { retry_count: retryCount }),
  };
}

export function parseRunResponse(value: unknown): RunView {
  const envelope = readRecord(value);
  const run = readRecord(envelope.run);
  const status = readString(run.status) as RunStatus;
  const questions = readArray(run.clarification_questions).map(readClarification);
  if (
    envelope.schema_version !== "1.0" ||
    run.schema_version !== "1.0" ||
    !runStatuses.has(status) ||
    typeof run.clarification_count !== "number" ||
    !Number.isInteger(run.clarification_count) ||
    run.clarification_count < 0 ||
    run.clarification_count > 2 ||
    (status === "interrupted_for_clarification" && questions.length !== 1)
  ) {
    return invalidRun();
  }
  return {
    schema_version: "1.0",
    run_id: readString(run.run_id),
    status,
    candidate_items: readArray(run.candidate_items).map(readAction),
    clarification_questions: questions,
    clarification_count: run.clarification_count,
    safe_trace: readArray(run.safe_trace).map(readTrace),
    created_at: readString(run.created_at),
    expires_at: readString(run.expires_at),
  };
}

function readGuestSession(value: unknown): GuestSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidSession();
  }
  const record = value as Record<string, unknown>;
  for (const field of [
    "guest_session_id",
    "access_token",
    "expires_at",
    "session_expires_at",
  ]) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      return invalidSession();
    }
  }
  if (record.schema_version !== "1.0" || record.token_type !== "Bearer") {
    return invalidSession();
  }
  const session = record as GuestSession;
  if (
    !session.guest_session_id.startsWith("ses_") ||
    !Number.isFinite(Date.parse(session.expires_at)) ||
    !Number.isFinite(Date.parse(session.session_expires_at)) ||
    Date.parse(session.expires_at) > Date.parse(session.session_expires_at)
  ) {
    return invalidSession();
  }
  return session;
}

function readStoredSession(storage: Storage): GuestSession | null {
  const serialized = storage.getItem(STORAGE_KEY);
  if (serialized === null) {
    return null;
  }
  try {
    return readGuestSession(JSON.parse(serialized));
  } catch {
    storage.removeItem(STORAGE_KEY);
    return null;
  }
}

async function readResponse(response: Response): Promise<GuestSession> {
  if (!response.ok) {
    throw new GuestSessionClientError(
      "The guest session service is unavailable. Check the local API and database.",
    );
  }
  try {
    return readGuestSession(await response.json());
  } catch (error) {
    if (error instanceof GuestSessionClientError) {
      throw error;
    }
    return invalidSession();
  }
}

async function createSession(fetcher: Fetcher): Promise<GuestSession> {
  try {
    return readResponse(
      await fetcher("/api/guest-sessions", {
        method: "POST",
        headers: { accept: "application/json" },
      }),
    );
  } catch (error) {
    if (error instanceof GuestSessionClientError) throw error;
    throw new GuestSessionClientError(
      "The guest session service is unavailable. Check the local API and database.",
    );
  }
}

async function refreshSession(
  session: GuestSession,
  fetcher: Fetcher,
): Promise<GuestSession> {
  return readResponse(
    await fetcher("/api/guest-sessions/refresh", {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${session.access_token}`,
      },
    }),
  );
}

export async function ensureGuestSession(
  fetcher: Fetcher = fetch,
  storage: Storage = window.sessionStorage,
  now: () => number = Date.now,
): Promise<GuestSession> {
  const stored = readStoredSession(storage);
  if (stored !== null && Date.parse(stored.expires_at) > now() + REFRESH_MARGIN_MS) {
    return stored;
  }

  let session: GuestSession;
  if (
    stored !== null &&
    Date.parse(stored.session_expires_at) > now() + REFRESH_MARGIN_MS
  ) {
    try {
      session = await refreshSession(stored, fetcher);
    } catch {
      storage.removeItem(STORAGE_KEY);
      session = await createSession(fetcher);
    }
  } else {
    storage.removeItem(STORAGE_KEY);
    session = await createSession(fetcher);
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

export async function createGuestRun(
  request: CreateRunInput,
  idempotencyKey: string,
  fetcher: Fetcher = fetch,
  storage: Storage = window.sessionStorage,
): Promise<RunView> {
  const session = await ensureGuestSession(fetcher, storage);
  let response: Response;
  try {
    response = await fetcher("/api/runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ schema_version: "1.0", ...request }),
    });
  } catch {
    throw new GuestSessionClientError(
      "The run store is unavailable. Check the local API and database.",
    );
  }
  if (!response.ok) {
    throw new GuestSessionClientError(
      response.status === 409
        ? "This run request conflicts with an earlier retry."
        : "The confirmed text could not be saved as a guest run.",
    );
  }
  try {
    const run = parseRunResponse(await response.json());
    storeActiveGuestRun(
      { runId: run.run_id, referenceDate: request.reference_date },
      storage,
    );
    return run;
  } catch (error) {
    if (error instanceof GuestSessionClientError) throw error;
    return invalidRun();
  }
}

export async function resumeGuestRun(
  runId: string,
  fetcher: Fetcher = fetch,
  storage: Storage = window.sessionStorage,
): Promise<RunView> {
  const session = await ensureGuestSession(fetcher, storage);
  let response: Response;
  try {
    response = await fetcher(`/api/runs/${encodeURIComponent(runId)}/resume`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ schema_version: "1.0" }),
    });
  } catch {
    throw new GuestSessionClientError(
      "The saved run is temporarily unavailable. Check the local API and database.",
    );
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 409) {
      clearActiveGuestRun(storage);
    }
    throw new GuestSessionClientError("The saved run could not be resumed.");
  }
  return parseRunResponse(await response.json());
}

export async function answerGuestRunClarification(
  runId: string,
  clarificationId: string,
  kind: ClarificationAnswerKind,
  answer: string,
  fetcher: Fetcher = fetch,
  storage: Storage = window.sessionStorage,
): Promise<RunView> {
  const session = await ensureGuestSession(fetcher, storage);
  let response: Response;
  try {
    response = await fetcher(`/api/runs/${encodeURIComponent(runId)}/clarifications`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema_version: "1.0",
        clarification_id: clarificationId,
        kind,
        answer,
      }),
    });
  } catch {
    throw new GuestSessionClientError(
      "The clarification service is temporarily unavailable.",
    );
  }
  if (!response.ok) {
    throw new GuestSessionClientError(
      response.status === 409
        ? "This clarification is stale or has already been answered."
        : response.status === 422
          ? "That answer does not resolve the current clarification."
          : "The clarification answer could not be saved.",
    );
  }
  return parseRunResponse(await response.json());
}

export function readActiveGuestRun(
  storage: Storage = window.sessionStorage,
): ActiveGuestRun | null {
  const value = storage.getItem(ACTIVE_RUN_KEY);
  if (value === null) return null;
  try {
    const record = readRecord(JSON.parse(value));
    const runId = readString(record.runId);
    const referenceDate = readString(record.referenceDate);
    if (!runId.startsWith("run_") || !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) {
      throw new Error("invalid active run");
    }
    return { runId, referenceDate };
  } catch {
    storage.removeItem(ACTIVE_RUN_KEY);
    return null;
  }
}

export function storeActiveGuestRun(
  run: ActiveGuestRun,
  storage: Storage = window.sessionStorage,
): void {
  storage.setItem(ACTIVE_RUN_KEY, JSON.stringify(run));
}

export function clearActiveGuestRun(storage: Storage = window.sessionStorage): void {
  storage.removeItem(ACTIVE_RUN_KEY);
}

export function createIdempotencyKey(): string {
  return `create-run:${crypto.randomUUID()}`;
}
