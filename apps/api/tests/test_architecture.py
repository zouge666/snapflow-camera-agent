"""Small boundary checks required by the API bootstrap task."""

import ast
from pathlib import Path

import pytest

DOMAIN_ROOT = Path(__file__).parents[1] / "src" / "snapflow" / "domain"
pytestmark = pytest.mark.unit


def test_domain_does_not_import_fastapi() -> None:
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

            imports_fastapi = any(
                module == "fastapi" or module.startswith("fastapi.")
                for module in modules
            )
            if imports_fastapi:
                violations.append(str(path.relative_to(DOMAIN_ROOT)))

    assert violations == []
