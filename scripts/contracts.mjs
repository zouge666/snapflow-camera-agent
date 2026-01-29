import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findContractDrift } from "./lib/contract-drift.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkedOpenApi = join(repositoryRoot, "packages/contracts/openapi.json");
const checkedClient = join(repositoryRoot, "apps/web/lib/api/generated");
const localPython = join(repositoryRoot, ".venv/bin/python");
const openApiTypeScript = join(repositoryRoot, "node_modules/.bin/openapi-ts");

async function command(executable, args) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    child.on("error", rejectCommand);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveCommand();
      } else {
        rejectCommand(
          new Error(`${executable} exited with status ${String(code)}`),
        );
      }
    });
  });
}

async function pythonExecutable() {
  try {
    await access(localPython);
    return localPython;
  } catch {
    return process.env.PYTHON || "python";
  }
}

async function generate(openApiPath, clientPath) {
  await command(await pythonExecutable(), [
    "-m",
    "snapflow.export_openapi",
    "--output",
    openApiPath,
  ]);
  await command(openApiTypeScript, [
    "--input",
    openApiPath,
    "--output",
    clientPath,
  ]);
}

async function generateCheckedArtifacts() {
  await generate(checkedOpenApi, checkedClient);
  console.log("contracts: regenerated OpenAPI snapshot and TypeScript client");
}

async function checkArtifacts() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "snapflow-contracts-"));
  const actualOpenApi = join(temporaryRoot, "openapi.json");
  const actualClient = join(temporaryRoot, "client");

  try {
    await generate(actualOpenApi, actualClient);
    const drift = await findContractDrift({
      expectedOpenApi: checkedOpenApi,
      actualOpenApi,
      expectedClient: checkedClient,
      actualClient,
    });

    if (drift.length > 0) {
      console.error("Contract drift detected:");
      for (const item of drift) {
        console.error(`- ${item}`);
      }
      console.error("Run `pnpm contracts:generate` and review the result.");
      process.exitCode = 1;
      return;
    }

    console.log("contracts: OpenAPI snapshot and generated client are current");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === "generate") {
  await generateCheckedArtifacts();
} else if (mode === "check") {
  await checkArtifacts();
} else {
  console.error("Usage: node scripts/contracts.mjs <generate|check>");
  process.exitCode = 2;
}
