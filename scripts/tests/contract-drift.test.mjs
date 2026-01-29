import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findContractDrift } from "../lib/contract-drift.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "snapflow-contract-drift-test-"));
  const expectedClient = join(root, "expected-client");
  const actualClient = join(root, "actual-client");
  await mkdir(expectedClient);
  await mkdir(actualClient);

  return {
    root,
    expectedOpenApi: join(root, "expected-openapi.json"),
    actualOpenApi: join(root, "actual-openapi.json"),
    expectedClient,
    actualClient,
  };
}

test("reports no drift for identical generated artifacts", async () => {
  const paths = await fixture();
  try {
    await writeFile(paths.expectedOpenApi, '{"openapi":"3.1.0"}\n');
    await writeFile(paths.actualOpenApi, '{"openapi":"3.1.0"}\n');
    await writeFile(join(paths.expectedClient, "types.gen.ts"), "export {};\n");
    await writeFile(join(paths.actualClient, "types.gen.ts"), "export {};\n");

    assert.deepEqual(await findContractDrift(paths), []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("reports snapshot, content, missing, and unexpected client drift", async () => {
  const paths = await fixture();
  try {
    await writeFile(paths.expectedOpenApi, '{"openapi":"3.1.0"}\n');
    await writeFile(paths.actualOpenApi, '{"openapi":"3.1.1"}\n');
    await writeFile(join(paths.expectedClient, "types.gen.ts"), "old\n");
    await writeFile(join(paths.actualClient, "types.gen.ts"), "new\n");
    await writeFile(join(paths.expectedClient, "sdk.gen.ts"), "sdk\n");
    await writeFile(join(paths.actualClient, "extra.gen.ts"), "extra\n");

    assert.deepEqual(await findContractDrift(paths), [
      "changed openapi.json",
      "unexpected generated client file: extra.gen.ts",
      "missing generated client file: sdk.gen.ts",
      "changed client/types.gen.ts",
    ]);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
