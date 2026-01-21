from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft7Validator, FormatChecker


FIXTURE_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = FIXTURE_ROOT.parents[1]
SCHEMA_PATH = FIXTURE_ROOT / "manifest.schema.json"
TEXT_ROOT = FIXTURE_ROOT / "text"
SAMPLE_ROOT = REPOSITORY_ROOT / "apps" / "web" / "public" / "samples"


def main() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft7Validator.check_schema(schema)
    validator = Draft7Validator(schema, format_checker=FormatChecker())
    text_fixture_paths = sorted(TEXT_ROOT.rglob("*.json"))
    sample_fixture_paths = sorted(SAMPLE_ROOT.rglob("manifest.json"))
    fixture_paths = text_fixture_paths + sample_fixture_paths

    if not text_fixture_paths:
        raise SystemExit("No text fixtures found")
    if not sample_fixture_paths:
        raise SystemExit("No public sample manifests found")

    failures: list[str] = []
    for fixture_path in fixture_paths:
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        for error in sorted(validator.iter_errors(fixture), key=lambda item: list(item.path)):
            location = ".".join(str(part) for part in error.absolute_path) or "<root>"
            failures.append(
                f"{fixture_path.relative_to(REPOSITORY_ROOT)}:{location}: {error.message}"
            )

    if failures:
        raise SystemExit("\n".join(failures))

    print(
        "Schema-valid fixtures: "
        f"{len(fixture_paths)} ({len(text_fixture_paths)} text, "
        f"{len(sample_fixture_paths)} public sample)"
    )


if __name__ == "__main__":
    main()
