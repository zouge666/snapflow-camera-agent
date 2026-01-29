import type {
  ApprovedActionItem as GeneratedApprovedActionExportItem,
  IcsExportRequest,
  IcsExportResponse,
  IcsExportWarning,
} from "../../lib/api/generated/types.gen";
import type { ApprovedActionItem } from "./action-review";

export type ApprovedActionExportItem = GeneratedApprovedActionExportItem;
export type {
  IcsExportRequest,
  IcsExportResponse,
  IcsExportWarning,
} from "../../lib/api/generated/types.gen";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type IcsDownloadEnvironment = Readonly<{
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  clickDownload: (url: string, filename: string) => void;
}>;

const ICS_EXPORT_PATH = "/api/demo/exports/ics";

export class IcsExportClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IcsExportClientError";
  }
}

function invalidContract(): never {
  throw new IcsExportClientError(
    "The demo service returned a calendar export this app does not understand.",
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return invalidContract();
  }
  return value.map(readString);
}

function readWarning(value: unknown): IcsExportWarning {
  const record = readRecord(value);
  if (record.code !== "missing_due_date") {
    return invalidContract();
  }
  return {
    action_id: readString(record.action_id),
    code: "missing_due_date",
    message: readString(record.message),
  };
}

export function createIcsExportRequest(
  approvedItems: readonly ApprovedActionItem[],
  referenceDate: string,
): IcsExportRequest {
  return {
    schema_version: "1.0",
    reference_date: referenceDate,
    approved_items: approvedItems.map((item) => ({
      id: item.id,
      title: item.title,
      owner: item.owner,
      due_date: item.dueDate,
      priority: item.priority,
      evidence: [...item.evidence],
      decision: "approved",
    })),
  };
}

export function parseIcsExportResponse(value: unknown): IcsExportResponse {
  const record = readRecord(value);
  const content = readString(record.content);

  if (
    record.schema_version !== "1.0" ||
    record.filename !== "snapflow-approved-actions.ics" ||
    record.content_type !== "text/calendar; charset=utf-8" ||
    !content.startsWith("BEGIN:VCALENDAR\r\n") ||
    !content.endsWith("END:VCALENDAR\r\n") ||
    !Array.isArray(record.warnings)
  ) {
    return invalidContract();
  }

  return {
    schema_version: "1.0",
    filename: "snapflow-approved-actions.ics",
    content_type: "text/calendar; charset=utf-8",
    content,
    exported_action_ids: readStringArray(record.exported_action_ids),
    warnings: record.warnings.map(readWarning),
  };
}

export async function requestIcsExport(
  request: IcsExportRequest,
  fetcher: Fetcher = fetch,
): Promise<IcsExportResponse> {
  let response: Response;

  try {
    response = await fetcher(ICS_EXPORT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    throw new IcsExportClientError(
      "The local calendar service is unavailable. Check that both services are running.",
    );
  }

  if (!response.ok) {
    throw new IcsExportClientError(
      "The demo service could not prepare this calendar export.",
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return invalidContract();
  }
  return parseIcsExportResponse(body);
}

function browserDownloadEnvironment(): IcsDownloadEnvironment {
  return {
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    clickDownload: (url, filename) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
    },
  };
}

export function downloadIcsFile(
  response: IcsExportResponse,
  environment: IcsDownloadEnvironment = browserDownloadEnvironment(),
): void {
  const blob = new Blob([response.content], { type: response.content_type });
  const url = environment.createObjectUrl(blob);
  try {
    environment.clickDownload(url, response.filename);
  } finally {
    environment.revokeObjectUrl(url);
  }
}
