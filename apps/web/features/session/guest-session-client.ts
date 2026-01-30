type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type GuestSession = Readonly<{
  schema_version: "1.0";
  guest_session_id: string;
  access_token: string;
  token_type: "Bearer";
  expires_at: string;
  session_expires_at: string;
}>;

type CreateRunInput = Readonly<{
  source_text: string;
  locale: string;
  timezone: string;
  reference_date: string;
}>;

const STORAGE_KEY = "snapflow.guest-session.v1";
const REFRESH_MARGIN_MS = 60_000;

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
): Promise<string> {
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
    const body = (await response.json()) as Record<string, unknown>;
    const run = body.run as Record<string, unknown> | undefined;
    if (body.schema_version !== "1.0" || typeof run?.run_id !== "string") {
      throw new Error("invalid run response");
    }
    return run.run_id;
  } catch {
    throw new GuestSessionClientError(
      "The run store returned a response this app does not understand.",
    );
  }
}

export function createIdempotencyKey(): string {
  return `create-run:${crypto.randomUUID()}`;
}
