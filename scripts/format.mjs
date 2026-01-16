import { basename, extname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { formatText } from "./lib/format-text.mjs";

const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const textFiles = new Set([
  ".editorconfig",
  ".env.example",
  ".nvmrc",
  ".python-version",
  "LICENSE",
  "Makefile",
]);

const listed = spawnSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
);

if (listed.error) {
  throw listed.error;
}
if (listed.status !== 0) {
  process.exit(listed.status ?? 1);
}

const candidates = listed.stdout
  .split("\0")
  .filter(Boolean)
  .filter(
    (file) => textExtensions.has(extname(file)) || textFiles.has(basename(file)),
  );
let updated = 0;

for (const file of candidates) {
  const source = readFileSync(file, "utf8");
  if (source.includes("\0")) {
    continue;
  }

  const formatted = formatText(source, {
    preserveTrailingWhitespace: extname(file) === ".md",
  });
  if (formatted !== source) {
    writeFileSync(file, formatted);
    updated += 1;
  }
}

console.log(`format: checked ${candidates.length} files, updated ${updated}`);
