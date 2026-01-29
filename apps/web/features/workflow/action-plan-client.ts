import type {
  ActionPlanRequest,
  ActionPlanResponse,
  CandidateAction,
  CandidateDue,
  Clarification,
  EvidenceRange,
} from "../../lib/api/generated/types.gen";

export type {
  ActionPlanRequest,
  ActionPlanResponse,
  CandidateAction,
  CandidateDue,
  Clarification,
  EvidenceRange,
} from "../../lib/api/generated/types.gen";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ACTION_PLAN_PATH = "/api/demo/action-plan";
const priorities = new Set(["low", "medium", "high", "unknown"]);
const dueResolutions = new Set(["absolute", "relative", "ambiguous"]);

export class ActionPlanClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionPlanClientError";
  }
}

function invalidContract(): never {
  throw new ActionPlanClientError(
    "The demo service returned an action plan this app does not understand.",
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidContract();
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalidContract();
  }

  return value;
}

function readNullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  return readString(value);
}

function readArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    return invalidContract();
  }

  return value;
}

function readEvidence(value: unknown): EvidenceRange {
  const record = readRecord(value);
  const start = record.start;
  const end = record.end;

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (start as number) < 0 ||
    (end as number) <= (start as number)
  ) {
    return invalidContract();
  }

  return {
    quote: readString(record.quote),
    start: start as number,
    end: end as number,
  };
}

function readDue(value: unknown): CandidateDue | null {
  if (value === null) {
    return null;
  }

  const record = readRecord(value);
  const resolution = readString(record.resolution);

  if (!dueResolutions.has(resolution)) {
    return invalidContract();
  }

  return {
    iso_date: readNullableString(record.iso_date),
    raw_text: readString(record.raw_text),
    resolution: resolution as CandidateDue["resolution"],
  };
}

function readCandidate(value: unknown): CandidateAction {
  const record = readRecord(value);
  const priority = readString(record.priority);
  const evidence = readArray(record.evidence).map(readEvidence);

  if (!priorities.has(priority) || evidence.length === 0) {
    return invalidContract();
  }

  return {
    id: readString(record.id),
    title: readString(record.title),
    owner: readNullableString(record.owner),
    due: readDue(record.due),
    priority: priority as CandidateAction["priority"],
    evidence,
  };
}

function readClarification(value: unknown): Clarification {
  const record = readRecord(value);

  return {
    id: readString(record.id),
    field_path: readString(record.field_path),
    question: readString(record.question),
    reason: readString(record.reason),
    evidence: record.evidence === null ? null : readEvidence(record.evidence),
  };
}

export function parseActionPlanResponse(value: unknown): ActionPlanResponse {
  const record = readRecord(value);

  if (record.schema_version !== "1.0" || record.provider !== "mock") {
    return invalidContract();
  }

  return {
    schema_version: "1.0",
    provider: "mock",
    summary: readString(record.summary),
    candidate_actions: readArray(record.candidate_actions).map(readCandidate),
    clarifications: readArray(record.clarifications).map(readClarification),
  };
}

export async function requestActionPlan(
  request: ActionPlanRequest,
  fetcher: Fetcher = fetch,
): Promise<ActionPlanResponse> {
  let response: Response;

  try {
    response = await fetcher(ACTION_PLAN_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serializeActionPlanRequest(request),
    });
  } catch {
    throw new ActionPlanClientError(
      "The demo service is unavailable. Check that the web and API services are running.",
    );
  }

  if (!response.ok) {
    throw new ActionPlanClientError(
      "The demo service could not build an action plan from this text.",
    );
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new ActionPlanClientError(
      "The demo service returned an action plan this app does not understand.",
    );
  }

  return parseActionPlanResponse(body);
}

export function serializeActionPlanRequest(request: ActionPlanRequest): string {
  return JSON.stringify({
    source_text: request.source_text,
    locale: request.locale,
    timezone: request.timezone,
    reference_date: request.reference_date,
  });
}
