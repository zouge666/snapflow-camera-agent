import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const result = spawnSync(
  "docker",
  ["compose", "--file", "docker-compose.yml", "config", "--format", "json"],
  { cwd: repositoryRoot, encoding: "utf8" },
);

if (result.error) {
  throw result.error;
}
assert.equal(result.status, 0, result.stderr);

const config = JSON.parse(result.stdout);
const api = config.services.api;
const postgres = config.services.postgres;

assert.equal(config.name, "snapflow-local");
assert.deepEqual(Object.keys(config.services).sort(), ["api", "postgres"]);
assert.ok(config.volumes.postgres_data);

assert.match(postgres.image, /^postgres:18\.4-bookworm@sha256:[0-9a-f]{64}$/);
assert.equal(postgres.environment.POSTGRES_DB, "snapflow");
assert.equal(postgres.environment.POSTGRES_USER, "snapflow");
assert.equal(postgres.environment.POSTGRES_PASSWORD, "snapflow-local-only");
assert.ok(postgres.healthcheck);
assert.ok(
  postgres.volumes.some(
    (volume) =>
      volume.type === "volume" && volume.target === "/var/lib/postgresql",
  ),
);

assert.equal(resolve(api.build.context), resolve(repositoryRoot));
assert.equal(api.build.dockerfile, "infra/docker/api.dev.Dockerfile");
assert.equal(api.depends_on.postgres.condition, "service_healthy");
assert.equal(api.environment.APP_ENV, "local");
assert.equal(api.environment.MODEL_PROVIDER, "mock");
assert.equal(
  api.environment.DATABASE_URL,
  "postgresql://snapflow:snapflow-local-only@postgres:5432/snapflow",
);
assert.ok(api.healthcheck);
assert.notEqual(api.privileged, true);
assert.equal(api.read_only, true);
assert.ok(
  api.volumes.some(
    (volume) =>
      volume.type === "bind" &&
      volume.target === "/workspace/apps/api/src" &&
      volume.read_only === true,
  ),
);

for (const [serviceName, target] of [
  ["api", 8000],
  ["postgres", 5432],
]) {
  const service = config.services[serviceName];
  const port = service.ports.find((candidate) => candidate.target === target);
  assert.ok(port, `${serviceName} must publish port ${target}`);
  assert.equal(port.host_ip, "127.0.0.1");
  assert.equal(String(port.published), String(target));
}

for (const forbidden of [
  "DEEPSEEK_API_KEY",
  "GUEST_TOKEN_SIGNING_KEY",
  "production",
]) {
  assert.ok(
    !result.stdout.includes(forbidden),
    `${forbidden} must stay out of Compose`,
  );
}

const dockerfile = readFileSync(
  join(repositoryRoot, "infra/docker/api.dev.Dockerfile"),
  "utf8",
);
assert.match(
  dockerfile,
  /^FROM python:3\.13\.14-slim-bookworm@sha256:[0-9a-f]{64}$/m,
);
assert.ok(!/^COPY\s+\.\s/m.test(dockerfile));

const dockerignore = readFileSync(
  join(repositoryRoot, ".dockerignore"),
  "utf8",
);
assert.ok(dockerignore.startsWith("**\n"));
assert.ok(!dockerignore.includes("!.env"));
assert.ok(!dockerignore.includes("!spec.md"));

console.log("Compose policy checks passed");
