"""Composition and application boundary for the extraction StateGraph."""

from dataclasses import dataclass
from typing import cast

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from snapflow.application.build_plan import BuildActionPlan
from snapflow.domain.action_plan import ActionPlanRequest, ActionPlanResponse
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


@dataclass(frozen=True, slots=True)
class ActionExtractionWorkflow:
    """Run the compiled graph and publish only a validated terminal plan."""

    graph: CompiledActionExtractionGraph

    def run(self, request: ActionPlanRequest) -> ActionExtractionRun:
        """Return a typed result with safe metadata for tests and future tracing."""
        raw_state = cast(
            dict[str, object],
            self.graph.invoke(initial_action_extraction_state(request)),
        )
        state = ActionExtractionStateSnapshot.model_validate(raw_state)
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
) -> ActionExtractionWorkflow:
    """Compile one deterministic graph without a checkpointer or agent router."""
    nodes = ActionExtractionNodes(
        planner=planner,
        limits=limits,
        evidence_validator=EvidenceValidator(),
        date_normalizer=DateNormalizer(),
    )
    builder = StateGraph(ActionExtractionState)
    builder.add_node(WorkflowNode.VALIDATE_INPUT.value, nodes.validate_input)
    builder.add_node(WorkflowNode.EXTRACT_ACTIONS.value, nodes.extract_actions)
    builder.add_node(WorkflowNode.RETRY_PROVIDER.value, nodes.retry_provider)
    builder.add_node(WorkflowNode.VALIDATE_SCHEMA.value, nodes.validate_schema)
    builder.add_node(WorkflowNode.VALIDATE_EVIDENCE.value, nodes.validate_evidence)
    builder.add_node(WorkflowNode.NORMALIZE_DATES.value, nodes.normalize_dates)
    builder.add_node(
        WorkflowNode.NEEDS_CLARIFICATION.value,
        nodes.mark_needs_clarification,
    )
    builder.add_node(
        WorkflowNode.READY_FOR_APPROVAL.value,
        nodes.mark_ready_for_approval,
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
    builder.add_edge(WorkflowNode.NEEDS_CLARIFICATION.value, END)
    builder.add_edge(WorkflowNode.READY_FOR_APPROVAL.value, END)
    builder.add_edge(WorkflowNode.CLARIFICATION_LIMIT.value, END)
    builder.add_edge(WorkflowNode.FAIL.value, END)

    graph = cast(
        CompiledActionExtractionGraph,
        builder.compile(name="snapflow_action_extraction"),
    )
    return ActionExtractionWorkflow(graph=graph)
