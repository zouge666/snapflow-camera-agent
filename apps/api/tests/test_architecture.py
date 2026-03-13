"""Small boundary checks required by the API bootstrap task."""

import ast
from pathlib import Path
from typing import get_type_hints

import pytest

from snapflow.domain.action_plan import ActionPlanResponse
from snapflow.providers.base import ActionExtractionProvider
from snapflow.providers.mock import MockProvider

APPLICATION_ROOT = Path(__file__).parents[1] / "src" / "snapflow" / "application"
DOMAIN_ROOT = Path(__file__).parents[1] / "src" / "snapflow" / "domain"
PROVIDERS_ROOT = Path(__file__).parents[1] / "src" / "snapflow" / "providers"
WORKFLOW_ROOT = Path(__file__).parents[1] / "src" / "snapflow" / "workflow"
TOOLS_ROOT = Path(__file__).parents[1] / "src" / "snapflow" / "tools"
pytestmark = pytest.mark.unit


def test_domain_does_not_import_frameworks_or_infrastructure() -> None:
    forbidden_prefixes = ("fastapi", "langgraph", "sqlalchemy")
    violations: list[str] = []

    for path in DOMAIN_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [node.module or ""]
            else:
                continue

            imports_forbidden_dependency = any(
                module == prefix or module.startswith(f"{prefix}.")
                for module in modules
                for prefix in forbidden_prefixes
            )
            if imports_forbidden_dependency:
                violations.append(str(path.relative_to(DOMAIN_ROOT)))

    assert violations == []


def test_mock_provider_has_no_network_client_dependency() -> None:
    forbidden_roots = {
        "aiohttp",
        "httpx",
        "httpx2",
        "openai",
        "requests",
        "socket",
        "urllib",
    }
    violations: list[str] = []

    for path in (PROVIDERS_ROOT / "mock.py",):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [node.module or ""]
            else:
                continue

            if any(
                module.split(".", maxsplit=1)[0] in forbidden_roots
                for module in modules
            ):
                violations.append(str(path.relative_to(PROVIDERS_ROOT)))

    assert violations == []


def test_provider_returns_a_validated_domain_model_not_a_raw_mapping() -> None:
    port_return_type = get_type_hints(ActionExtractionProvider.extract_actions)[
        "return"
    ]
    adapter_return_type = get_type_hints(MockProvider.extract_actions)["return"]

    assert port_return_type is ActionPlanResponse
    assert adapter_return_type is ActionPlanResponse


def test_workflow_layers_do_not_import_model_sdks() -> None:
    forbidden_prefixes = ("anthropic", "deepseek", "google.generativeai", "openai")
    violations: list[str] = []

    roots = (APPLICATION_ROOT, WORKFLOW_ROOT)
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    modules = [node.module or ""]
                else:
                    continue

                if any(
                    module == prefix or module.startswith(f"{prefix}.")
                    for module in modules
                    for prefix in forbidden_prefixes
                ):
                    relative_path = path.relative_to(Path(__file__).parents[1] / "src")
                    violations.append(f"{relative_path}:{modules}")

    assert violations == []


def test_model_config_stays_outside_workflow_and_provider_modules() -> None:
    forbidden_modules = {"os", "snapflow.config"}
    violations: list[str] = []

    for root in (APPLICATION_ROOT, PROVIDERS_ROOT, WORKFLOW_ROOT):
        if not root.exists():
            continue
        for path in root.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    modules = [node.module or ""]
                else:
                    continue

                if any(module in forbidden_modules for module in modules):
                    relative_path = path.relative_to(Path(__file__).parents[1] / "src")
                    violations.append(f"{relative_path}:{modules}")

    assert violations == []


def test_workflow_does_not_use_prebuilt_agents_or_multi_agent_helpers() -> None:
    forbidden_prefixes = (
        "langgraph.prebuilt",
        "langgraph_supervisor",
        "langgraph_swarm",
    )
    violations: list[str] = []

    for path in WORKFLOW_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [node.module or ""]
            else:
                continue

            if any(
                module == prefix or module.startswith(f"{prefix}.")
                for module in modules
                for prefix in forbidden_prefixes
            ):
                violations.append(str(path.relative_to(WORKFLOW_ROOT)))

    assert violations == []


def test_export_tools_have_no_file_system_dependency() -> None:
    forbidden_roots = {"os", "pathlib", "shutil", "tempfile"}
    violations: list[str] = []

    for path in TOOLS_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [node.module or ""]
            else:
                modules = []

            if any(
                module.split(".", maxsplit=1)[0] in forbidden_roots
                for module in modules
            ):
                violations.append(str(path.relative_to(TOOLS_ROOT)))

            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "open"
            ):
                violations.append(str(path.relative_to(TOOLS_ROOT)))

    assert violations == []
