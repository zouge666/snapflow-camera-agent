# SnapFlow

## Install

```bash
./scripts/pnpmw setup
```

## Development

```bash
./scripts/pnpmw dev
```

## Test

```bash
./scripts/pnpmw test
./scripts/pnpmw test:e2e:install
./scripts/pnpmw test:e2e
./scripts/pnpmw lint
./scripts/pnpmw typecheck
./scripts/pnpmw contracts:check
./scripts/pnpmw build
```

## Contracts

```bash
./scripts/pnpmw contracts:generate
./scripts/pnpmw contracts:check
```

## Format

```bash
./scripts/pnpmw format
./scripts/pnpmw format:check
```

## Web

```bash
./scripts/pnpmw dev:web
```

## API

```bash
./scripts/pnpmw dev:api
```

## Containers

```bash
docker compose config --quiet
docker compose up --build --wait
docker compose down
```
