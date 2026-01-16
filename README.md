# SnapFlow

## Install

```bash
corepack enable
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
pnpm install --frozen-lockfile
```

## Test

```bash
source .venv/bin/activate
pnpm test
pnpm typecheck:web
pnpm build:web
```

## Web

```bash
pnpm dev:web
```
