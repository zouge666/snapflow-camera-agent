import type { EvidenceRange } from "./action-plan-client";

export function EvidenceRangeView({ range }: Readonly<{ range: EvidenceRange }>) {
  return (
    <div className="action-evidence">
      <blockquote>“{range.quote}”</blockquote>
      <span>
        Source characters {range.start}–{range.end}
      </span>
    </div>
  );
}
