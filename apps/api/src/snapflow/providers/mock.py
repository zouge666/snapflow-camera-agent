"""Deterministic provider for the synthetic Northstar demo fixture."""

from datetime import date

from snapflow.domain.action_plan import (
    ActionPlanRequest,
    ActionPlanResponse,
    CandidateAction,
    CandidateDue,
    Clarification,
    EvidenceRange,
)

_EXPECTED_LOCALE = "en-US"
_EXPECTED_TIMEZONE = "Europe/Copenhagen"
_EXPECTED_REFERENCE_DATE = date(2026, 7, 16)

_CHECKLIST_QUOTE = "Alex: Send the revised onboarding checklist by Friday."
_FAQ_QUOTE = "Prepare the support FAQ before the pilot review."
_FAQ_DUE_QUOTE = "before the pilot review"
_PILOT_REVIEW_QUOTE = "Mina: Book a 30-minute pilot review on 2026-07-22."


def _find_evidence(source_text: str, quote: str) -> EvidenceRange | None:
    start = source_text.find(quote)
    if start < 0:
        return None
    return EvidenceRange(quote=quote, start=start, end=start + len(quote))


class MockProvider:
    """Return stable fixture-backed candidates without network access."""

    def build_plan(self, request: ActionPlanRequest) -> ActionPlanResponse:
        """Recognize the documented sample phrases in their original context."""
        if not self._has_supported_context(request):
            return ActionPlanResponse(
                summary=(
                    "No candidate actions matched the supported synthetic sample "
                    "context."
                ),
                candidate_actions=(),
                clarifications=(),
            )

        actions: list[CandidateAction] = []
        clarifications: list[Clarification] = []

        checklist_evidence = _find_evidence(request.source_text, _CHECKLIST_QUOTE)
        if checklist_evidence is not None:
            actions.append(
                CandidateAction(
                    id="action-1",
                    title="Send the revised onboarding checklist",
                    owner="Alex",
                    due=CandidateDue(
                        iso_date=date(2026, 7, 17),
                        raw_text="by Friday",
                        resolution="relative",
                    ),
                    priority="unknown",
                    evidence=(checklist_evidence,),
                )
            )

        faq_evidence = _find_evidence(request.source_text, _FAQ_QUOTE)
        if faq_evidence is not None:
            faq_index = len(actions)
            actions.append(
                CandidateAction(
                    id="action-2",
                    title="Prepare the support FAQ",
                    owner=None,
                    due=CandidateDue(
                        iso_date=None,
                        raw_text=_FAQ_DUE_QUOTE,
                        resolution="ambiguous",
                    ),
                    priority="unknown",
                    evidence=(faq_evidence,),
                )
            )
            due_evidence = _find_evidence(request.source_text, _FAQ_DUE_QUOTE)
            clarifications.append(
                Clarification(
                    id="clarification-1",
                    field_path=f"candidate_actions[{faq_index}].due",
                    question=(
                        "What date is the pilot review for the support FAQ deadline?"
                    ),
                    reason=(
                        "The pilot review deadline cannot be resolved to an ISO date "
                        "from this text alone."
                    ),
                    evidence=due_evidence,
                )
            )

        pilot_evidence = _find_evidence(request.source_text, _PILOT_REVIEW_QUOTE)
        if pilot_evidence is not None:
            actions.append(
                CandidateAction(
                    id="action-3",
                    title="Book a 30-minute pilot review",
                    owner="Mina",
                    due=CandidateDue(
                        iso_date=date(2026, 7, 22),
                        raw_text="on 2026-07-22",
                        resolution="absolute",
                    ),
                    priority="unknown",
                    evidence=(pilot_evidence,),
                )
            )

        return ActionPlanResponse(
            summary=self._summary(len(actions), len(clarifications)),
            candidate_actions=tuple(actions),
            clarifications=tuple(clarifications),
        )

    @staticmethod
    def _has_supported_context(request: ActionPlanRequest) -> bool:
        return (
            request.locale == _EXPECTED_LOCALE
            and request.timezone == _EXPECTED_TIMEZONE
            and request.reference_date == _EXPECTED_REFERENCE_DATE
        )

    @staticmethod
    def _summary(action_count: int, clarification_count: int) -> str:
        action_label = "action" if action_count == 1 else "actions"
        detail_label = "detail" if clarification_count == 1 else "details"
        detail_verb = "needs" if clarification_count == 1 else "need"
        return (
            f"{action_count} candidate {action_label} found. "
            f"{clarification_count} {detail_label} {detail_verb} clarification."
        )
