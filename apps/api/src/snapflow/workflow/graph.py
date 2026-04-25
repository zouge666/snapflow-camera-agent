"""Composition and application boundary for the extraction StateGraph."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command, StateSnapshot

from snapflow.application.build_plan import BuildActionPlan
from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse
from snapflow.domain.clarifications import (
    ClarificationResolution,
    ClarificationResolver,
    ClarificationValidationError,
    InvalidClarificationAnswerError,
    StaleClarificationAnswerError,
)
from snapflow.domain.dates import DateNormalizer
from snapflow.domain.evidence import EvidenceValidator
from snapflow.workflow.nodes import ActionExtractionNodes
from snapflow.workflow.state import (
    ActionExtractionRun,
    ActionExtractionState,
    ActionExtractionStateSnapshot,
    ActionExtractionWorkflowError,
    IllegalWorkflowTransitionError,
    WorkflowLimits,
    WorkflowNode,
    WorkflowStatus,
    initial_action_extraction_state,
)

CompiledActionExtractionGraph = CompiledStateGraph[
    ActionExtractionState,
    None,
    ActionExtractionState,
    ActionExtractionState,
]
CHECKPOINT_NAMESPACE = ""


class WorkflowCheckpointNotFoundError(LookupError):
    """The authorized run has no durable graph snapshot."""


class WorkflowCheckpointError(RuntimeError):
    """A checkpoint could not be written or loaded safely."""


class WorkflowClarificationConflictError(RuntimeError):
    """A stale or duplicate answer cannot consume a current interrupt."""


class WorkflowClarificationAnswerError(ValueError):
    """A current answer cannot deterministically resolve its target field."""


@dataclass(frozen=True, slots=True)
class ActionExtractionWorkflow:
    """Run the compiled graph and publish only a validated terminal plan."""

    graph: CompiledActionExtractionGraph
    clarification_resolver: ClarificationResolver

    def run(self, request: ActionPlanRequest) -> ActionExtractionRun:
        """Return a typed result with safe metadata for tests and future tracing."""
        raw_state = cast(
            dict[str, object],
            self.graph.invoke(initial_action_extraction_state(request)),
        )
        return self._run_from_state(raw_state)

    def start(self, run_id: str, request: ActionPlanRequest) -> ActionExtractionRun:
        """Execute a new durable thread until its reviewed pause boundary."""
        return self._invoke_checkpointed(
            initial_action_extraction_state(request),
            run_id,
        )

    def recover_or_start(
        self,
        run_id: str,
        request: ActionPlanRequest,
    ) -> ActionExtractionRun:
        """Continue an incomplete write safely or create the first checkpoint."""
        try:
            snapshot = self.graph.get_state(self._checkpoint_config(run_id))
        except Exception as error:
            raise WorkflowCheckpointError(
                "The workflow checkpoint could not be loaded."
            ) from error
        if not snapshot.values:
            return self.start(run_id, request)

        state = self._validate_snapshot(snapshot.values)
        if state.status is WorkflowStatus.NEEDS_CLARIFICATION:
            if self._has_pending_clarification_interrupt(snapshot, state):
                return self._run_from_snapshot(state)
            return self._invoke_checkpointed(None, run_id)
        if state.status in {
            WorkflowStatus.READY_FOR_APPROVAL,
            WorkflowStatus.FATAL_FAILURE,
        }:
            return self._run_from_snapshot(state)
        return self._invoke_checkpointed(None, run_id)

    def load(self, run_id: str) -> ActionExtractionRun:
        """Load the latest durable state without executing another graph node."""
        try:
            snapshot = self.graph.get_state(self._checkpoint_config(run_id))
        except Exception as error:
            raise WorkflowCheckpointError(
                "The workflow checkpoint could not be loaded."
            ) from error
        if not snapshot.values:
            raise WorkflowCheckpointNotFoundError
        state = self._validate_snapshot(snapshot.values)
        if state.status is WorkflowStatus.NEEDS_CLARIFICATION and not (
            self._has_pending_clarification_interrupt(snapshot, state)
        ):
            raise WorkflowCheckpointError(
                "The workflow has not reached a recoverable pause."
            )
        if state.status not in {
            WorkflowStatus.NEEDS_CLARIFICATION,
            WorkflowStatus.READY_FOR_APPROVAL,
            WorkflowStatus.FATAL_FAILURE,
        }:
            raise WorkflowCheckpointError(
                "The workflow has not reached a recoverable pause."
            )
        return self._run_from_snapshot(state)

    def answer_clarification(
        self,
        run_id: str,
        resolution: ClarificationResolution,
    ) -> ActionExtractionRun:
        """Resume exactly the current dynamic interrupt with one typed answer."""
        try:
            snapshot = self.graph.get_state(self._checkpoint_config(run_id))
        except Exception as error:
            raise WorkflowCheckpointError(
                "The workflow checkpoint could not be loaded."
            ) from error
        if not snapshot.values:
            raise WorkflowCheckpointNotFoundError
        state = self._validate_snapshot(snapshot.values)
        if state.status is not WorkflowStatus.NEEDS_CLARIFICATION or not (
            self._has_pending_clarification_interrupt(snapshot, state)
        ):
            raise WorkflowClarificationConflictError
        if state.candidate_plan is None:
            raise WorkflowCheckpointError(
                "The workflow checkpoint contains invalid state."
            )
        try:
            self.clarification_resolver.resolve(
                state.request,
                state.candidate_plan,
                resolution,
            )
        except StaleClarificationAnswerError as error:
            raise WorkflowClarificationConflictError from error
        except InvalidClarificationAnswerError as error:
            raise WorkflowClarificationAnswerError from error
        except ClarificationValidationError as error:
            raise WorkflowCheckpointError(
                "The workflow checkpoint contains invalid state."
            ) from error
        return self._invoke_checkpointed(
            cast(
                ActionExtractionState,
                Command(resume=resolution.model_dump(mode="json")),
            ),
            run_id,
        )

    def _invoke_checkpointed(
        self,
        input_state: ActionExtractionState | None,
        run_id: str,
    ) -> ActionExtractionRun:
        try:
            raw_state = cast(
                dict[str, object],
                self.graph.invoke(
                    input_state,
                    config=self._checkpoint_config(run_id),
                    durability="sync",
                ),
            )
        except Exception as error:
            raise WorkflowCheckpointError(
                "The workflow checkpoint could not be saved."
            ) from error
        return self._run_from_state(raw_state)

    @staticmethod
    def _checkpoint_config(run_id: str) -> RunnableConfig:
        return cast(
            RunnableConfig,
            {
                "configurable": {
                    "thread_id": run_id,
                    "checkpoint_ns": CHECKPOINT_NAMESPACE,
                }
            },
        )

    @staticmethod
    def _has_pending_clarification_interrupt(
        snapshot: StateSnapshot,
        state: ActionExtractionStateSnapshot,
    ) -> bool:
        if snapshot.next != (WorkflowNode.WAIT_FOR_CLARIFICATION.value,):
            return False
        if len(snapshot.interrupts) != 1 or state.candidate_plan is None:
            return False
        questions = state.candidate_plan.clarifications
        if not questions:
            return False
        value = snapshot.interrupts[0].value
        return isinstance(value, dict) and value.get("id") == questions[0].id

    @staticmethod
    def _run_from_state(raw_state: dict[str, object]) -> ActionExtractionRun:
        state = ActionExtractionWorkflow._validate_snapshot(
            {key: value for key, value in raw_state.items() if key != "__interrupt__"}
        )
        return ActionExtractionWorkflow._run_from_snapshot(state)

    @staticmethod
    def _validate_snapshot(raw_state: object) -> ActionExtractionStateSnapshot:
        try:
            return ActionExtractionStateSnapshot.model_validate(raw_state)
        except Exception as error:
            raise WorkflowCheckpointError(
                "The workflow checkpoint contains invalid state."
            ) from error

    @staticmethod
    def _run_from_snapshot(
        state: ActionExtractionStateSnapshot,
    ) -> ActionExtractionRun:
        if state.status is WorkflowStatus.FATAL_FAILURE:
            if state.failure is None:
                raise IllegalWorkflowTransitionError(
                    WorkflowNode.FAIL,
                    state.status,
                )
            raise ActionExtractionWorkflowError(state.failure, state.retry_count)
        if state.candidate_plan is None:
            raise IllegalWorkflowTransitionError(WorkflowNode.FAIL, state.status)
        return ActionExtractionRun(
            status=state.status,
            plan=ActionPlanResponse.model_validate(
                state.candidate_plan.model_dump(mode="python")
            ),
            retry_count=state.retry_count,
            clarification_count=state.clarification_count,
            safe_trace=state.safe_trace,
        )

    def execute(self, request: ActionPlanRequest) -> ActionPlanResponse:
        """Serve the existing HTTP contract after the graph reaches a terminal."""
        return self.run(request).plan


def create_action_extraction_workflow(
    planner: BuildActionPlan,
    limits: WorkflowLimits,
    *,
    checkpointer: BaseCheckpointSaver[Any] | None = None,
    clock: Callable[[], datetime] | None = None,
) -> ActionExtractionWorkflow:
    """Compile the single extraction graph, optionally with durable pauses."""
    date_normalizer = DateNormalizer()
    clarification_resolver = ClarificationResolver(date_normalizer)
    nodes = ActionExtractionNodes(
        planner=planner,
        limits=limits,
        evidence_validator=EvidenceValidator(),
        date_normalizer=date_normalizer,
        clarification_resolver=clarification_resolver,
        interrupts_enabled=checkpointer is not None,
        **({"clock": clock} if clock is not None else {}),
    )
    builder = StateGraph(ActionExtractionState)
    builder.add_node(WorkflowNode.VALIDATE_INPUT.value, nodes.validate_input)
    builder.add_node(WorkflowNode.EXTRACT_ACTIONS.value, nodes.extract_actions)
    builder.add_node(WorkflowNode.RETRY_PROVIDER.value, nodes.retry_provider)
    builder.add_node(WorkflowNode.VALIDATE_SCHEMA.value, nodes.validate_schema)
    builder.add_node(WorkflowNode.VALIDATE_EVIDENCE.value, nodes.validate_evidence)
    builder.add_node(WorkflowNode.NORMALIZE_DATES.value, nodes.normalize_dates)
    builder.add_node(
        WorkflowNode.VALIDATE_CLARIFICATIONS.value,
        nodes.validate_clarifications,
    )
    builder.add_node(
        WorkflowNode.NEEDS_CLARIFICATION.value,
        nodes.mark_needs_clarification,
    )
    builder.add_node(
        WorkflowNode.READY_FOR_APPROVAL.value,
        nodes.mark_ready_for_approval,
    )
    builder.add_node(
        WorkflowNode.WAIT_FOR_CLARIFICATION.value,
        nodes.hold_clarification_checkpoint,
    )
    builder.add_node(
        WorkflowNode.WAIT_FOR_APPROVAL.value,
        nodes.hold_approval_checkpoint,
    )
    builder.add_node(
        WorkflowNode.CLARIFICATION_LIMIT.value,
        nodes.mark_clarification_limit,
    )
    builder.add_node(WorkflowNode.FAIL.value, nodes.mark_failure)

    builder.add_edge(START, WorkflowNode.VALIDATE_INPUT.value)
    builder.add_conditional_edges(
        WorkflowNode.VALIDATE_INPUT.value,
        nodes.route_after_input,
    )
    builder.add_conditional_edges(
        WorkflowNode.EXTRACT_ACTIONS.value,
        nodes.route_after_extraction,
    )
    builder.add_edge(
        WorkflowNode.RETRY_PROVIDER.value,
        WorkflowNode.EXTRACT_ACTIONS.value,
    )
    builder.add_conditional_edges(
        WorkflowNode.VALIDATE_SCHEMA.value,
        nodes.route_after_schema,
    )
    builder.add_conditional_edges(
        WorkflowNode.VALIDATE_EVIDENCE.value,
        nodes.route_after_evidence,
    )
    builder.add_conditional_edges(
        WorkflowNode.NORMALIZE_DATES.value,
        nodes.route_after_dates,
    )
    builder.add_conditional_edges(
        WorkflowNode.VALIDATE_CLARIFICATIONS.value,
        nodes.route_after_clarification_validation,
    )
    builder.add_edge(
        WorkflowNode.NEEDS_CLARIFICATION.value,
        WorkflowNode.WAIT_FOR_CLARIFICATION.value,
    )
    builder.add_edge(
        WorkflowNode.READY_FOR_APPROVAL.value,
        WorkflowNode.WAIT_FOR_APPROVAL.value,
    )
    if checkpointer is None:
        builder.add_edge(WorkflowNode.WAIT_FOR_CLARIFICATION.value, END)
    else:
        builder.add_conditional_edges(
            WorkflowNode.WAIT_FOR_CLARIFICATION.value,
            nodes.route_after_clarification_answer,
        )
    builder.add_edge(WorkflowNode.WAIT_FOR_APPROVAL.value, END)
    builder.add_edge(WorkflowNode.CLARIFICATION_LIMIT.value, END)
    builder.add_edge(WorkflowNode.FAIL.value, END)

    graph = cast(
        CompiledActionExtractionGraph,
        builder.compile(
            checkpointer=checkpointer,
            interrupt_before=(
                [WorkflowNode.WAIT_FOR_APPROVAL.value]
                if checkpointer is not None
                else None
            ),
            name="snapflow_action_extraction",
        ),
    )
    return ActionExtractionWorkflow(
        graph=graph,
        clarification_resolver=clarification_resolver,
    )
