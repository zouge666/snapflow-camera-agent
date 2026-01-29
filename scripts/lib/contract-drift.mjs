import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }

  return files.sort();
}

async function compareFile(expectedPath, actualPath, label) {
  let expected;
  let actual;

  try {
    expected = await readFile(expectedPath);
  } catch {
    return [`missing checked-in ${label}`];
  }

  try {
    actual = await readFile(actualPath);
  } catch {
    return [`generator did not produce ${label}`];
  }

  return expected.equals(actual) ? [] : [`changed ${label}`];
}

export async function findContractDrift({
  expectedOpenApi,
  actualOpenApi,
  expectedClient,
  actualClient,
}) {
  const drift = await compareFile(expectedOpenApi, actualOpenApi, "openapi.json");
  let expectedFiles;
  let actualFiles;

  try {
    expectedFiles = await listFiles(expectedClient);
  } catch {
    return [...drift, "missing checked-in generated client"];
  }

  try {
    actualFiles = await listFiles(actualClient);
  } catch {
    return [...drift, "generator did not produce a client"];
  }

  const allFiles = [...new Set([...expectedFiles, ...actualFiles])].sort();
  for (const file of allFiles) {
    if (!expectedFiles.includes(file)) {
      drift.push(`unexpected generated client file: ${file}`);
      continue;
    }
    if (!actualFiles.includes(file)) {
      drift.push(`missing generated client file: ${file}`);
      continue;
    }
    drift.push(
      ...(await compareFile(
        join(expectedClient, file),
        join(actualClient, file),
        `client/${file}`,
      )),
    );
  }

  return drift;
}
