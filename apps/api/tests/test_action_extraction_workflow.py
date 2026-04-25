"""Contract and topology tests for the mock LangGraph extraction workflow."""

import json
from dataclasses import dataclass
from importlib.metadata import version
from typing import Any, NoReturn, cast

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from snapflow.application.build_plan import BuildActionPlan
from snapflow.domain.action_plan import (
    ActionPlanRequest,
    ActionPlanResponse,
    CandidateAction,
    CandidateDue,
    Clarification,
    EvidenceRange,
)
from snapflow.domain.clarifications import ClarificationResolution
from snapflow.providers.base import (
    ActionExtractionProvider,
    ProviderTimeoutError,
)
from snapflow.providers.mock import MockProvider
from snapflow.workflow.graph import (
    ActionExtractionWorkflow,
    WorkflowCheckpointError,
    WorkflowCheckpointNotFoundError,
    WorkflowClarificationAnswerError,
    WorkflowClarificationConflictError,
    create_action_extraction_workflow,
)
from snapflow.workflow.state import (
    ActionExtractionStateSnapshot,
    ActionExtractionWorkflowError,
    IllegalWorkflowTransitionError,
    WorkflowFailureCode,
    WorkflowLimits,
    WorkflowNode,
    WorkflowStatus,
    initial_action_extraction_state,
)
from test_action_plan_contract import sample_request

pytestmark = pytest.mark.unit


@dataclass
class RecordingProvider:
    """Return one configured value while exposing only a call count to tests."""

    response: ActionPlanResponse
    calls: int = 0

    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        del request
        self.calls += 1
        return self.response


@dataclass
class InvalidProvider:
    calls: int = 0

    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        del request
        self.calls += 1
        return cast(ActionPlanResponse, {"candidate_actions": "not validated"})


@dataclass
class TimeoutProvider:
    calls: int = 0

    def extract_actions(self, request: ActionPlanRequest) -> ActionPlanResponse:
        del request
        self.calls += 1
        raise ProviderTimeoutError()


def workflow_for(
    provider: ActionExtractionProvider,
    *,
    limits: WorkflowLimits | None = None,
) -> ActionExtractionWorkflow:
    return create_action_extraction_workflow(
        BuildActionPlan(provider=provider),
        limits or WorkflowLimits(),
    )


def empty_plan(summary: str = "No actions were extracted.") -> ActionPlanResponse:
    return ActionPlanResponse(
        schema_version="1.0",
        provider="mock",
        summary=summary,
        candidate_actions=(),
        clarifications=(),
    )


def single_action_plan(
    source_text: str,
    *,
    due: CandidateDue | None = None,
    evidence_quote: str | None = None,
) -> ActionPlanResponse:
    return ActionPlanResponse(
        schema_version="1.0",
        provider="mock",
        summary="One candidate action.",
        candidate_actions=(
            CandidateAction(
                id="action-1",
                title="Ship the release",
                owner="Alex",
                due=due,
                priority="unknown",
                evidence=(
                    EvidenceRange(
                        quote=evidence_quote or source_text,
                        start=0,
                        end=len(source_text),
                    ),
                ),
            ),
        ),
        clarifications=(),
    )


def test_langgraph_version_is_exactly_pinned() -> None:
    assert version("langgraph") == "1.0.6"


def test_compiled_topology_matches_the_reviewed_single_workflow() -> None:
    graph_json = workflow_for(MockProvider()).graph.get_graph().to_json()
    nodes = sorted(str(node["id"]) for node in graph_json["nodes"])
    edges = sorted(
        (
            str(edge["source"]),
            str(edge["target"]),
            bool(edge.get("conditional", False)),
        )
        for edge in graph_json["edges"]
    )

    assert nodes == [
        "__end__",
        "__start__",
        "clarification_limit",
        "extract_actions",
        "fail",
        "needs_clarification",
        "normalize_dates",
        "ready_for_approval",
        "retry_provider",
        "validate_clarifications",
        "validate_evidence",
        "validate_input",
        "validate_schema",
        "wait_for_approval",
        "wait_for_clarification",
    ]
    assert edges == [
        ("__start__", "validate_input", False),
        ("clarification_limit", "__end__", False),
        ("extract_actions", "fail", True),
        ("extract_actions", "retry_provider", True),
        ("extract_actions", "validate_schema", True),
        ("fail", "__end__", False),
        ("needs_clarification", "wait_for_clarification", False),
        ("normalize_dates", "fail", True),
        ("normalize_dates", "validate_clarifications", True),
        ("ready_for_approval", "wait_for_approval", False),
        ("retry_provider", "extract_actions", False),
        ("validate_clarifications", "clarification_limit", True),
        ("validate_clarifications", "fail", True),
        ("validate_clarifications", "needs_clarification", True),
        ("validate_clarifications", "ready_for_approval", True),
        ("validate_evidence", "fail", True),
        ("validate_evidence", "normalize_dates", True),
        ("validate_input", "extract_actions", True),
        ("validate_input", "fail", True),
        ("validate_schema", "fail", True),
        ("validate_schema", "validate_evidence", True),
        ("wait_for_approval", "__end__", False),
        ("wait_for_clarification", "__end__", False),
    ]
    assert all("agent" not in node and "router" not in node for node in nodes)


def test_typed_success_is_schema_validated_before_publication() -> None:
    provider_plan = empty_plan("Typed provider success.")
    provider = RecordingProvider(provider_plan)

    result = workflow_for(provider).run(sample_request())

    assert provider.calls == 1
    assert result.status is WorkflowStatus.READY_FOR_APPROVAL
    assert result.plan == provider_plan
    assert result.plan is not provider_plan
    assert [event.node for event in result.safe_trace] == [
        WorkflowNode.VALIDATE_INPUT,
        WorkflowNode.EXTRACT_ACTIONS,
        WorkflowNode.VALIDATE_SCHEMA,
        WorkflowNode.VALIDATE_EVIDENCE,
        WorkflowNode.NORMALIZE_DATES,
        WorkflowNode.VALIDATE_CLARIFICATIONS,
        WorkflowNode.READY_FOR_APPROVAL,
    ]


def test_workflow_normalizes_an_evidence_backed_date_before_publication() -> None:
    source_text = "Alex will ship by Friday."
    request = sample_request().model_copy(update={"source_text": source_text})
    provider_plan = single_action_plan(
        source_text,
        due=CandidateDue(
            iso_date=None,
            raw_text="by Friday",
            resolution="relative",
        ),
    )

    result = workflow_for(RecordingProvider(provider_plan)).run(request)

    due = result.plan.candidate_actions[0].due
    assert due is not None
    assert due.iso_date is not None
    assert due.iso_date.isoformat() == "2026-01-16"
    assert due.raw_text == "by Friday"
    assert result.safe_trace[-3].node is WorkflowNode.NORMALIZE_DATES


def test_invalid_evidence_cannot_reach_the_ui_boundary() -> None:
    source_text = "Alex will ship by Friday."
    request = sample_request().model_copy(update={"source_text": source_text})
    provider = RecordingProvider(
        single_action_plan(source_text, evidence_quote="A mismatched provider quote")
    )

    with pytest.raises(ActionExtractionWorkflowError) as raised:
        workflow_for(provider).execute(request)

    assert provider.calls == 1
    assert raised.value.code is WorkflowFailureCode.INVALID_EVIDENCE
    assert source_text not in str(raised.value)


def test_invalid_date_interpretation_cannot_reach_the_ui_boundary() -> None:
    source_text = "Alex will ship by Friday."
    request = sample_request().model_copy(update={"source_text": source_text})
    provider = RecordingProvider(
        single_action_plan(
            source_text,
            due=CandidateDue(
                iso_date=sample_request().reference_date,
                raw_text="by Friday",
                resolution="relative",
            ),
        )
    )

    with pytest.raises(ActionExtractionWorkflowError) as raised:
        workflow_for(provider).execute(request)

    assert provider.calls == 1
    assert raised.value.code is WorkflowFailureCode.INVALID_DATE
    assert source_text not in str(raised.value)


def test_invalid_timezone_stops_before_the_provider_call() -> None:
    provider = RecordingProvider(empty_plan())
    invalid_request = sample_request().model_copy(
        update={"timezone": "server-local-time"}
    )

    with pytest.raises(ActionExtractionWorkflowError) as raised:
        workflow_for(provider).execute(invalid_request)

    assert provider.calls == 0
    assert raised.value.code is WorkflowFailureCode.INVALID_DATE
    assert str(raised.value) == "The request timezone is invalid."


def test_mock_plan_with_questions_stops_before_the_future_interrupt() -> None:
    result = workflow_for(MockProvider()).run(sample_request())

    assert result.status is WorkflowStatus.NEEDS_CLARIFICATION
    assert len(result.plan.candidate_actions) == 3
    assert len(result.plan.clarifications) == 1
    assert result.clarification_count == 0
    assert result.safe_trace[-1].node is WorkflowNode.NEEDS_CLARIFICATION


def test_zero_action_plan_remains_a_valid_typed_result() -> None:
    request = sample_request().model_copy(
        update={"source_text": "No follow-up work was recorded."}
    )

    result = workflow_for(MockProvider()).run(request)

    assert result.status is WorkflowStatus.READY_FOR_APPROVAL
    assert result.plan.candidate_actions == ()
    assert result.plan.clarifications == ()


def test_invalid_provider_output_fails_without_reaching_the_ui_boundary() -> None:
    provider = InvalidProvider()

    with pytest.raises(ActionExtractionWorkflowError) as raised:
        workflow_for(provider).execute(sample_request())

    assert provider.calls == 1
    assert raised.value.code is WorkflowFailureCode.PROVIDER_INVALID_OUTPUT
    assert raised.value.retryable is False
    assert raised.value.retry_count == 0
    assert str(raised.value) == "The action provider returned invalid output."


def test_timeout_retries_twice_then_fails_closed() -> None:
    provider = TimeoutProvider()

    with pytest.raises(ActionExtractionWorkflowError) as raised:
        workflow_for(provider).execute(sample_request())

    assert provider.calls == 3
    assert raised.value.code is WorkflowFailureCode.PROVIDER_TIMEOUT
    assert raised.value.retryable is False
    assert raised.value.retry_count == 2
    assert str(raised.value) == (
        "Action extraction stopped after the provider retry limit."
    )


def test_checkpoint_pause_load_and_duplicate_load_do_not_rerun_nodes() -> None:
    provider = RecordingProvider(empty_plan())
    workflow = create_action_extraction_workflow(
        BuildActionPlan(provider),
        WorkflowLimits(),
        checkpointer=InMemorySaver(),
    )

    started = workflow.start("run_checkpoint-test", sample_request())
    loaded = workflow.load("run_checkpoint-test")
    loaded_again = workflow.load("run_checkpoint-test")

    assert started.status is WorkflowStatus.READY_FOR_APPROVAL
    assert loaded == started
    assert loaded_again == started
    assert provider.calls == 1
    assert workflow.graph.get_state(
        workflow._checkpoint_config("run_checkpoint-test")
    ).next == (WorkflowNode.WAIT_FOR_APPROVAL.value,)


def test_clarification_path_uses_a_typed_dynamic_interrupt() -> None:
    workflow = create_action_extraction_workflow(
        BuildActionPlan(MockProvider()),
        WorkflowLimits(),
        checkpointer=InMemorySaver(),
    )

    started = workflow.start("run_clarification-checkpoint", sample_request())

    assert started.status is WorkflowStatus.NEEDS_CLARIFICATION
    snapshot = workflow.graph.get_state(
        workflow._checkpoint_config("run_clarification-checkpoint")
    )
    assert snapshot.next == (WorkflowNode.WAIT_FOR_CLARIFICATION.value,)
    assert len(snapshot.interrupts) == 1
    assert snapshot.interrupts[0].value == {
        "id": "clarification-1",
        "field_path": "candidate_actions[1].due",
        "question": "What date is the pilot review for the support FAQ deadline?",
        "reason": (
            "The pilot review deadline cannot be resolved to an ISO date from this "
            "text alone."
        ),
        "answer_kind": "free_text",
        "options": [],
        "evidence": {
            "quote": "before the pilot review",
            "start": 133,
            "end": 156,
        },
    }


def test_free_text_answer_resumes_same_checkpoint_without_provider_rerun() -> None:
    provider = RecordingProvider(MockProvider().extract_actions(sample_request()))
    workflow = create_action_extraction_workflow(
        BuildActionPlan(provider),
        WorkflowLimits(),
        checkpointer=InMemorySaver(),
    )
    run_id = "run_free-text-answer"
    started = workflow.start(run_id, sample_request())

    answered = workflow.answer_clarification(
        run_id,
        ClarificationResolution(
            clarification_id="clarification-1",
            kind="free_text",
            answer="The pilot review is on 2026-01-22.",
        ),
    )

    assert started.status is WorkflowStatus.NEEDS_CLARIFICATION
    assert answered.status is WorkflowStatus.READY_FOR_APPROVAL
    assert answered.clarification_count == 1
    assert answered.plan.clarifications == ()
    answered_due = answered.plan.candidate_actions[1].due
    assert answered_due is not None
    assert answered_due.iso_date is not None
    assert answered_due.iso_date.isoformat() == "2026-01-22"
    assert answered_due.raw_text == "before the pilot review"
    assert provider.calls == 1
    serialized_trace = json.dumps(
        [event.model_dump(mode="json") for event in answered.safe_trace]
    )
    assert "The pilot review is on" not in serialized_trace
    assert answered.safe_trace[-2].node is WorkflowNode.WAIT_FOR_CLARIFICATION
    assert answered.safe_trace[-2].status is WorkflowStatus.CLARIFICATION_RECEIVED


def test_invalid_stale_and_duplicate_answers_do_not_consume_an_interrupt() -> None:
    workflow = create_action_extraction_workflow(
        BuildActionPlan(MockProvider()),
        WorkflowLimits(),
        checkpointer=InMemorySaver(),
    )
    run_id = "run_answer-guards"
    workflow.start(run_id, sample_request())

    with pytest.raises(WorkflowClarificationConflictError):
        workflow.answer_clarification(
            run_id,
            ClarificationResolution(
                clarification_id="clarification-99",
                kind="free_text",
                answer="2026-01-22",
            ),
        )
    with pytest.raises(WorkflowClarificationAnswerError):
        workflow.answer_clarification(
            run_id,
            ClarificationResolution(
                clarification_id="clarification-1",
                kind="free_text",
                answer="sometime after the review",
            ),
        )
    assert workflow.load(run_id).clarification_count == 0

    workflow.answer_clarification(
        run_id,
        ClarificationResolution(
            clarification_id="clarification-1",
            kind="free_text",
            answer="2026-01-22",
        ),
    )
    with pytest.raises(WorkflowClarificationConflictError):
        workflow.answer_clarification(
            run_id,
            ClarificationResolution(
                clarification_id="clarification-1",
                kind="free_text",
                answer="2026-01-22",
            ),
        )


def test_option_answer_resolves_an_evidence_backed_ambiguous_owner() -> None:
    source_text = "Alex or Mina: ship the release."
    request = sample_request().model_copy(update={"source_text": source_text})
    plan = single_action_plan(source_text).model_copy(
        update={
            "candidate_actions": (
                single_action_plan(source_text)
                .candidate_actions[0]
                .model_copy(update={"owner": None}),
            ),
            "clarifications": (
                Clarification(
                    id="clarification-1",
                    field_path="candidate_actions[0].owner",
                    question="Who owns the ship the release action?",
                    reason="The reviewed text names two possible owners.",
                    answer_kind="option",
                    options=("Alex", "Mina"),
                    evidence=EvidenceRange(
                        quote="Alex or Mina",
                        start=0,
                        end=12,
                    ),
                ),
            ),
        }
    )
    workflow = create_action_extraction_workflow(
        BuildActionPlan(RecordingProvider(plan)),
        WorkflowLimits(),
        checkpointer=InMemorySaver(),
    )
    run_id = "run_owner-option"
    workflow.start(run_id, request)

    answered = workflow.answer_clarification(
        run_id,
        ClarificationResolution(
            clarification_id="clarification-1",
            kind="option",
            answer="Mina",
        ),
    )

    assert answered.plan.candidate_actions[0].owner == "Mina"
    assert answered.status is WorkflowStatus.READY_FOR_APPROVAL


def test_optional_owner_absence_does_not_create_a_question() -> None:
    source_text = "Prepare the release notes."
    request = sample_request().model_copy(update={"source_text": source_text})
    action = (
        single_action_plan(source_text)
        .candidate_actions[0]
        .model_copy(update={"owner": None})
    )
    provider = RecordingProvider(
        single_action_plan(source_text).model_copy(
            update={"candidate_actions": (action,)}
        )
    )

    result = workflow_for(provider).run(request)

    assert result.status is WorkflowStatus.READY_FOR_APPROVAL
    assert result.plan.candidate_actions[0].owner is None
    assert result.plan.clarifications == ()


def test_required_question_evidence_cannot_be_missing() -> None:
    source_text = "Alex or Mina should prepare the release notes."
    request = sample_request().model_copy(update={"source_text": source_text})
    base = single_action_plan(source_text)
    plan = base.model_copy(
        update={
            "candidate_actions": (
                base.candidate_actions[0].model_copy(update={"owner": None}),
            ),
            "clarifications": (
                Clarification(
                    id="clarification-1",
                    field_path="candidate_actions[0].owner",
                    question="Who owns the release notes action?",
                    reason="The reviewed text names two possible owners.",
                    answer_kind="option",
                    options=("Alex", "Mina"),
                    evidence=None,
                ),
            ),
        }
    )

    with pytest.raises(ActionExtractionWorkflowError) as raised:
        workflow_for(RecordingProvider(plan)).run(request)

    assert raised.value.code is WorkflowFailureCode.INVALID_CLARIFICATION


def test_free_text_answer_can_resolve_an_ambiguous_action_referent() -> None:
    source_text = "Update it before launch."
    request = sample_request().model_copy(update={"source_text": source_text})
    base = single_action_plan(source_text)
    plan = base.model_copy(
        update={
            "candidate_actions": (
                base.candidate_actions[0].model_copy(
                    update={"title": "Update the unresolved launch item"}
                ),
            ),
            "clarifications": (
                Clarification(
                    id="clarification-1",
                    field_path="candidate_actions[0].title",
                    question="What does 'it' refer to in this launch action?",
                    reason="The action referent is ambiguous in the reviewed text.",
                    evidence=EvidenceRange(
                        quote=source_text,
                        start=0,
                        end=len(source_text),
                    ),
                ),
            ),
        }
    )
    workflow = create_action_extraction_workflow(
        BuildActionPlan(RecordingProvider(plan)),
        WorkflowLimits(),
        checkpointer=InMemorySaver(),
    )
    run_id = "run_referent-answer"
    workflow.start(run_id, request)

    answered = workflow.answer_clarification(
        run_id,
        ClarificationResolution(
            clarification_id="clarification-1",
            kind="free_text",
            answer="Update the launch checklist",
        ),
    )

    assert answered.plan.candidate_actions[0].title == "Update the launch checklist"


def test_two_answer_rounds_fail_closed_when_a_third_question_remains() -> None:
    source_text = "Alex or Mina should update it after the pilot review."
    request = sample_request().model_copy(update={"source_text": source_text})
    evidence = EvidenceRange(quote=source_text, start=0, end=len(source_text))
    plan = ActionPlanResponse(
        schema_version="1.0",
        provider="mock",
        summary="One action has three explicit ambiguities.",
        candidate_actions=(
            CandidateAction(
                id="action-1",
                title="Update the unresolved item",
                owner=None,
                due=CandidateDue(
                    iso_date=None,
                    raw_text="after the pilot review",
                    resolution="ambiguous",
                ),
                priority="unknown",
                evidence=(evidence,),
            ),
        ),
        clarifications=(
            Clarification(
                id="clarification-1",
                field_path="candidate_actions[0].title",
                question="What does 'it' refer to in this action?",
                reason="The action referent is ambiguous.",
                evidence=evidence,
            ),
            Clarification(
                id="clarification-2",
                field_path="candidate_actions[0].owner",
                question="Who owns the update action?",
                reason="The reviewed text names two possible owners.",
                answer_kind="option",
                options=("Alex", "Mina"),
                evidence=evidence,
            ),
            Clarification(
                id="clarification-3",
                field_path="candidate_actions[0].due",
                question="What date is the pilot review?",
                reason="The reviewed text does not give the review date.",
                evidence=evidence,
            ),
        ),
    )
    workflow = create_action_extraction_workflow(
        BuildActionPlan(RecordingProvider(plan)),
        WorkflowLimits(max_clarifications=2),
        checkpointer=InMemorySaver(),
    )
    run_id = "run_two-round-limit"
    workflow.start(run_id, request)
    second_round = workflow.answer_clarification(
        run_id,
        ClarificationResolution(
            clarification_id="clarification-1",
            kind="free_text",
            answer="Update the launch checklist",
        ),
    )

    assert second_round.status is WorkflowStatus.NEEDS_CLARIFICATION
    assert second_round.clarification_count == 1
    assert second_round.plan.clarifications[0].id == "clarification-2"
    with pytest.raises(ActionExtractionWorkflowError) as raised:
        workflow.answer_clarification(
            run_id,
            ClarificationResolution(
                clarification_id="clarification-2",
                kind="option",
                answer="Alex",
            ),
        )

    assert raised.value.code is WorkflowFailureCode.CLARIFICATION_LIMIT
    assert raised.value.retry_count == 0


def test_missing_checkpoint_fails_without_starting_the_provider() -> None:
    provider = RecordingProvider(empty_plan())
    workflow = create_action_extraction_workflow(
        BuildActionPlan(provider),
        WorkflowLimits(),
        checkpointer=InMemorySaver(),
    )

    with pytest.raises(WorkflowCheckpointNotFoundError):
        workflow.load("run_missing-checkpoint")

    assert provider.calls == 0


def test_checkpoint_write_failure_is_safe_and_does_not_claim_a_pause(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = RecordingProvider(empty_plan())
    saver = InMemorySaver()

    def fail_write(*args: object, **kwargs: object) -> NoReturn:
        del args, kwargs
        raise OSError("private checkpoint storage detail")

    monkeypatch.setattr(saver, "put", fail_write)
    workflow = create_action_extraction_workflow(
        BuildActionPlan(provider),
        WorkflowLimits(),
        checkpointer=saver,
    )

    with pytest.raises(WorkflowCheckpointError) as raised:
        workflow.start("run_failed-checkpoint", sample_request())

    assert str(raised.value) == "The workflow checkpoint could not be saved."
    assert "Northstar" not in str(raised.value)


def test_incomplete_checkpoint_continues_without_rerunning_completed_nodes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = RecordingProvider(empty_plan())
    saver = InMemorySaver()
    original_put = saver.put
    writes = 0

    def fail_fourth_write(*args: Any, **kwargs: Any) -> Any:
        nonlocal writes
        writes += 1
        if writes == 4:
            raise OSError("transient checkpoint failure")
        return original_put(*args, **kwargs)

    monkeypatch.setattr(saver, "put", fail_fourth_write)
    workflow = create_action_extraction_workflow(
        BuildActionPlan(provider),
        WorkflowLimits(),
        checkpointer=saver,
    )

    with pytest.raises(WorkflowCheckpointError):
        workflow.start("run_incomplete-checkpoint", sample_request())
    assert provider.calls == 1

    monkeypatch.setattr(saver, "put", original_put)
    recovered = workflow.recover_or_start(
        "run_incomplete-checkpoint",
        sample_request(),
    )

    assert recovered.status is WorkflowStatus.READY_FOR_APPROVAL
    assert provider.calls == 1


def test_checkpointed_provider_retry_limit_is_not_reset_by_loading() -> None:
    provider = TimeoutProvider()
    workflow = create_action_extraction_workflow(
        BuildActionPlan(provider),
        WorkflowLimits(max_provider_retries=2),
        checkpointer=InMemorySaver(),
    )

    with pytest.raises(ActionExtractionWorkflowError) as started:
        workflow.start("run_retry-checkpoint", sample_request())
    with pytest.raises(ActionExtractionWorkflowError) as loaded:
        workflow.load("run_retry-checkpoint")

    assert started.value.retry_count == 2
    assert loaded.value.retry_count == 2
    assert provider.calls == 3


def test_clarification_round_limit_is_a_real_terminal_path() -> None:
    workflow = workflow_for(MockProvider())
    state = initial_action_extraction_state(sample_request())
    state["clarification_count"] = 2

    raw_result = workflow.graph.invoke(state)
    result = ActionExtractionStateSnapshot.model_validate(raw_result)

    assert result.status is WorkflowStatus.FATAL_FAILURE
    assert result.failure is not None
    assert result.failure.code is WorkflowFailureCode.CLARIFICATION_LIMIT
    assert result.clarification_count == 2
    assert result.safe_trace[-1].node is WorkflowNode.CLARIFICATION_LIMIT


def test_node_rejects_an_illegal_direct_transition() -> None:
    workflow = workflow_for(MockProvider())
    received_state = initial_action_extraction_state(sample_request())

    with pytest.raises(IllegalWorkflowTransitionError) as raised:
        workflow.graph.nodes[WorkflowNode.EXTRACT_ACTIONS.value].invoke(received_state)

    assert raised.value.node is WorkflowNode.EXTRACT_ACTIONS
    assert raised.value.status is WorkflowStatus.RECEIVED
    assert "Northstar" not in str(raised.value)


def test_safe_trace_schema_cannot_leak_source_text_or_provider_payload() -> None:
    request = sample_request().model_copy(
        update={"source_text": "private-source-canary with no supported action"}
    )

    result = workflow_for(MockProvider()).run(request)
    serialized_trace = json.dumps(
        [event.model_dump(mode="json") for event in result.safe_trace],
        sort_keys=True,
    )

    assert "private-source-canary" not in serialized_trace
    assert "source_text" not in serialized_trace
    assert "prompt" not in serialized_trace
    assert "raw" not in serialized_trace
    assert "secret" not in serialized_trace
    assert "request" not in result.model_fields_set
