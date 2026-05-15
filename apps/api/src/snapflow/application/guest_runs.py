"""Use cases for guest credentials and recoverable workflow runs."""

from dataclasses import dataclass
from datetime import datetime

from snapflow.domain.action_plan import ActionPlanRequest
from snapflow.domain.clarifications import ClarificationResolution
from snapflow.domain.run_contract import (
    ActionItem,
    ActionPriority,
    ApprovalRequest,
    ClarificationAnswerKind,
    ClarificationAnswerRequest,
    ClarificationQuestion,
    CreateRunRequest,
    Evidence,
    GuestSessionResponse,
    ResumeRunRequest,
    RunStatus,
    RunView,
    SafeTraceEvent,
    TraceOutcome,
)
from snapflow.persistence.guest_runs import CreatedRun, GuestRunRepository
from snapflow.security.guest_tokens import GuestPrincipal, GuestTokenService
from snapflow.workflow.graph import (
    ActionExtractionWorkflow,
    WorkflowApprovalConflictError,
    WorkflowCheckpointNotFoundError,
    WorkflowClarificationConflictError,
)
from snapflow.workflow.state import (
    ActionExtractionRun,
    ActionExtractionWorkflowError,
    WorkflowEventOutcome,
    WorkflowStatus,
)


@dataclass(frozen=True, slots=True)
class GuestRunService:
    """Coordinate token verification with persistent owner and run state."""

    repository: GuestRunRepository
    tokens: GuestTokenService
    workflow: ActionExtractionWorkflow | None = None

    def create_session(self) -> GuestSessionResponse:
        """Create a persistent guest and issue its first access token."""
        session = self.repository.create_guest_session()
        token, principal = self.tokens.issue(session.id, session.expires_at)
        return self._session_response(token, principal, session.expires_at)

    def refresh_session(self, bearer_token: str) -> GuestSessionResponse:
        """Rotate a valid access token while the guest owner is still live."""
        principal = self.tokens.verify(bearer_token)
        session = self.repository.require_guest_session(principal.session_id)
        token, refreshed = self.tokens.issue(session.id, session.expires_at)
        return self._session_response(token, refreshed, session.expires_at)

    def create_run(
        self,
        bearer_token: str,
        idempotency_key: str,
        request: CreateRunRequest,
    ) -> CreatedRun:
        """Persist one idempotent run and pause its durable workflow."""
        principal = self.tokens.verify(bearer_token)
        created = self.repository.create_run(
            principal.session_id,
            idempotency_key,
            request,
        )
        if self.workflow is None:
            return created

        try:
            workflow_run = self.workflow.recover_or_start(
                created.run.run_id,
                self._workflow_request(request),
            )
        except ActionExtractionWorkflowError:
            self.repository.update_run_status(
                principal.session_id,
                created.run.run_id,
                RunStatus.FATAL_FAILURE,
            )
            raise

        status = self._public_status(workflow_run.status)
        persisted = self.repository.update_run_status(
            principal.session_id,
            created.run.run_id,
            status,
        )
        return CreatedRun(
            run=self._run_view(persisted, workflow_run, status),
            created=created.created,
        )

    def resume_run(
        self,
        bearer_token: str,
        run_id: str,
        request: ResumeRunRequest,
    ) -> RunView:
        """Authorize and load the latest checkpoint without rerunning nodes."""
        del request
        principal = self.tokens.verify(bearer_token)
        persisted = self.repository.get_owned_run(principal.session_id, run_id)
        if self.workflow is None:
            raise WorkflowCheckpointNotFoundError
        workflow_run = self.workflow.load(run_id)
        status = self._public_status(workflow_run.status)
        if persisted.status is not status:
            persisted = self.repository.update_run_status(
                principal.session_id,
                run_id,
                status,
            )
        return self._run_view(persisted, workflow_run, status)

    def answer_clarification(
        self,
        bearer_token: str,
        run_id: str,
        request: ClarificationAnswerRequest,
    ) -> RunView:
        """Authorize and consume exactly the current clarification interrupt."""
        principal = self.tokens.verify(bearer_token)
        persisted = self.repository.get_owned_run(principal.session_id, run_id)
        if persisted.status is not RunStatus.INTERRUPTED_FOR_CLARIFICATION:
            raise WorkflowClarificationConflictError
        if self.workflow is None:
            raise WorkflowCheckpointNotFoundError
        resolution = ClarificationResolution(
            clarification_id=request.clarification_id,
            kind=request.kind.value,
            answer=request.answer,
        )
        try:
            workflow_run = self.workflow.answer_clarification(run_id, resolution)
        except ActionExtractionWorkflowError:
            self.repository.update_run_status(
                principal.session_id,
                run_id,
                RunStatus.FATAL_FAILURE,
            )
            raise
        status = self._public_status(workflow_run.status)
        persisted = self.repository.update_run_status(
            principal.session_id,
            run_id,
            status,
        )
        return self._run_view(persisted, workflow_run, status)

    def submit_approval(
        self,
        bearer_token: str,
        run_id: str,
        idempotency_key: str,
        request: ApprovalRequest,
    ) -> RunView:
        """Authorize, idempotently consume, and persist one approval command."""
        principal = self.tokens.verify(bearer_token)
        persisted = self.repository.get_owned_run(principal.session_id, run_id)
        if self.workflow is None:
            raise WorkflowCheckpointNotFoundError
        if persisted.status not in {
            RunStatus.INTERRUPTED_FOR_APPROVAL,
            RunStatus.APPROVAL_RECEIVED,
        }:
            raise WorkflowApprovalConflictError

        current = self.workflow.load(run_id)
        if current.status is WorkflowStatus.APPROVAL_RECEIVED:
            result = current.approval_result
            if result is None:
                raise WorkflowCheckpointNotFoundError
            if (
                result.idempotency_key != idempotency_key
                or result.accepted_request != request
            ):
                raise WorkflowApprovalConflictError
            status = self._public_status(current.status)
            if persisted.status is not status:
                persisted = self.repository.update_run_status(
                    principal.session_id,
                    run_id,
                    status,
                )
            return self._run_view(persisted, current, status)

        if persisted.status is not RunStatus.INTERRUPTED_FOR_APPROVAL:
            raise WorkflowApprovalConflictError
        workflow_run = self.workflow.submit_approval(
            run_id,
            idempotency_key,
            request,
        )
        status = self._public_status(workflow_run.status)
        persisted = self.repository.update_run_status(
            principal.session_id,
            run_id,
            status,
        )
        return self._run_view(persisted, workflow_run, status)

    @staticmethod
    def _workflow_request(request: CreateRunRequest) -> ActionPlanRequest:
        return ActionPlanRequest(
            source_text=request.source_text,
            locale=request.locale,
            timezone=request.timezone,
            reference_date=request.reference_date,
        )

    @staticmethod
    def _public_status(status: WorkflowStatus) -> RunStatus:
        status_map = {
            WorkflowStatus.NEEDS_CLARIFICATION: (
                RunStatus.INTERRUPTED_FOR_CLARIFICATION
            ),
            WorkflowStatus.READY_FOR_APPROVAL: RunStatus.INTERRUPTED_FOR_APPROVAL,
            WorkflowStatus.APPROVAL_RECEIVED: RunStatus.APPROVAL_RECEIVED,
        }
        try:
            return status_map[status]
        except KeyError as error:
            raise ValueError("workflow did not reach a recoverable pause") from error

    @staticmethod
    def _run_view(
        persisted: RunView,
        workflow_run: ActionExtractionRun,
        status: RunStatus,
    ) -> RunView:
        actions = tuple(
            ActionItem(
                id=action.id,
                title=action.title,
                owner=action.owner,
                due_date=action.due.iso_date if action.due is not None else None,
                due_text=action.due.raw_text if action.due is not None else None,
                priority=ActionPriority(action.priority),
                evidence=tuple(
                    Evidence(quote=item.quote, start=item.start, end=item.end)
                    for item in action.evidence
                ),
            )
            for action in workflow_run.plan.candidate_actions
        )
        questions = tuple(
            ClarificationQuestion(
                id=question.id,
                field_path=GuestRunService._public_field_path(question.field_path),
                question=question.question,
                reason=question.reason,
                answer_kind=ClarificationAnswerKind(question.answer_kind),
                options=question.options,
                evidence=(
                    Evidence(
                        quote=question.evidence.quote,
                        start=question.evidence.start,
                        end=question.evidence.end,
                    )
                    if question.evidence is not None
                    else None
                ),
            )
            for question in workflow_run.plan.clarifications[:1]
        )
        outcome_map = {
            WorkflowEventOutcome.SUCCEEDED: TraceOutcome.SUCCEEDED,
            WorkflowEventOutcome.FAILED: TraceOutcome.FAILED,
            WorkflowEventOutcome.RETRYING: TraceOutcome.RETRYING,
            WorkflowEventOutcome.WAITING: TraceOutcome.INTERRUPTED,
        }
        trace = tuple(
            SafeTraceEvent(
                sequence=sequence,
                node=event.node.value,
                outcome=outcome_map[event.outcome],
                occurred_at=event.occurred_at,
                provider=event.provider,
                schema_version="1.0",
                retry_count=event.retry_count,
            )
            for sequence, event in enumerate(workflow_run.safe_trace)
        )
        approval_decisions = (
            workflow_run.approval_result.decisions
            if workflow_run.approval_result is not None
            else ()
        )
        return RunView(
            schema_version="1.0",
            run_id=persisted.run_id,
            status=status,
            candidate_items=actions,
            clarification_questions=questions,
            approval_decisions=approval_decisions,
            clarification_count=workflow_run.clarification_count,
            safe_trace=trace,
            created_at=persisted.created_at,
            expires_at=persisted.expires_at,
        )

    @staticmethod
    def _public_field_path(field_path: str) -> str:
        return field_path.replace("candidate_actions", "candidate_items").replace(
            ".due", ".due_date"
        )

    @staticmethod
    def _session_response(
        token: str,
        principal: GuestPrincipal,
        session_expires_at: datetime,
    ) -> GuestSessionResponse:
        return GuestSessionResponse(
            schema_version="1.0",
            guest_session_id=principal.session_id,
            access_token=token,
            token_type="Bearer",
            expires_at=principal.expires_at,
            session_expires_at=session_expires_at,
        )
