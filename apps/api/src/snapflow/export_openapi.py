"""CLI that exports the deterministic SnapFlow contract OpenAPI document."""

import argparse
import json
from pathlib import Path

from snapflow.contract import create_contract_app


def parse_args() -> argparse.Namespace:
    """Read the explicit output path used by the Node orchestrator."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def export_openapi(output: Path) -> None:
    """Write a stable, reviewable OpenAPI snapshot to ``output``."""
    document = create_contract_app().openapi()
    serialized = json.dumps(
        document,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(f"{serialized}\n", encoding="utf-8")


def main() -> None:
    """Parse CLI arguments and export the snapshot."""
    args = parse_args()
    export_openapi(args.output)


if __name__ == "__main__":  # pragma: no cover - exercised through the CLI
    main()
