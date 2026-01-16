from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft7Validator, FormatChecker


FIXTURE_ROOT = Path(__file__).resolve().parent
SCHEMA_PATH = FIXTURE_ROOT / "manifest.schema.json"
TEXT_ROOT = FIXTURE_ROOT / "text"


def main() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft7Validator.check_schema(schema)
    validator = Draft7Validator(schema, format_checker=FormatChecker())
    fixture_paths = sorted(TEXT_ROOT.rglob("*.json"))

    if not fixture_paths:
        raise SystemExit("No text fixtures found")

    failures: list[str] = []
    for fixture_path in fixture_paths:
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        for error in sorted(validator.iter_errors(fixture), key=lambda item: list(item.path)):
            location = ".".join(str(part) for part in error.absolute_path) or "<root>"
            failures.append(f"{fixture_path.relative_to(FIXTURE_ROOT)}:{location}: {error.message}")

    if failures:
        raise SystemExit("\n".join(failures))

    print(f"Schema-valid fixtures: {len(fixture_paths)}")


if __name__ == "__main__":
    main()
