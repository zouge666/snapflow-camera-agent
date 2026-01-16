# Fixture commands

Run these commands from the repository root.

## Validate all fixtures

```bash
python3 -B tests/fixtures/check_schema.py
node tests/fixtures/check-fixtures.mjs
```

## Check staged formatting

```bash
git diff --cached --check
```

Web and API start commands will be added only after those services exist.
