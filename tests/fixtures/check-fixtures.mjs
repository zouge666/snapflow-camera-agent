import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const textRoot = join(fixtureRoot, "text");
const forbiddenSensitiveMarkers = ["confidential:", "customer id:", "incident id:", "api key:"];

async function listJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = join(directory, entry.name);
      return entry.isDirectory() ? listJsonFiles(entryPath) : [entryPath];
    }),
  );

  return nested.flat().filter((filePath) => filePath.endsWith(".json")).sort();
}

function fail(filePath, message) {
  throw new Error(`${relative(fixtureRoot, filePath)}: ${message}`);
}

function checkEvidence(filePath, text, evidence, location) {
  if (evidence.end <= evidence.start) {
    fail(filePath, `${location} has a non-positive range`);
  }

  const actual = text.slice(evidence.start, evidence.end);
  if (actual !== evidence.quote) {
    fail(
      filePath,
      `${location} range produced ${JSON.stringify(actual)}, expected ${JSON.stringify(evidence.quote)}`,
    );
  }
}

const files = await listJsonFiles(textRoot);
if (files.length < 6) {
  throw new Error(`Expected at least 6 fixtures, found ${files.length}`);
}

const fixtureIds = new Set();
const splitCounts = new Map();

for (const filePath of files) {
  const raw = await readFile(filePath, "utf8");
  const lowered = raw.toLowerCase();
  for (const marker of forbiddenSensitiveMarkers) {
    if (lowered.includes(marker)) {
      fail(filePath, `contains forbidden sensitive-data marker ${JSON.stringify(marker)}`);
    }
  }

  const fixture = JSON.parse(raw);
  if (fixtureIds.has(fixture.id)) {
    fail(filePath, `duplicate fixture id ${fixture.id}`);
  }
  fixtureIds.add(fixture.id);
  splitCounts.set(fixture.split, (splitCounts.get(fixture.split) ?? 0) + 1);

  if (fixture.source.provenance !== "synthetic") {
    fail(filePath, "seed fixtures must use synthetic provenance");
  }
  if (fixture.source.source_url !== null) {
    fail(filePath, "synthetic seed fixture must have a null source_url");
  }
  if (fixture.source.contains_personal_data || fixture.source.contains_confidential_data) {
    fail(filePath, "public seed fixture cannot contain personal or confidential data");
  }
  if (fixture.gold.expected_action_count !== fixture.gold.actions.length) {
    fail(filePath, "expected_action_count does not match actions.length");
  }

  const actionIds = new Set();
  for (const [actionIndex, action] of fixture.gold.actions.entries()) {
    if (actionIds.has(action.id)) {
      fail(filePath, `duplicate action id ${action.id}`);
    }
    actionIds.add(action.id);

    for (const [evidenceIndex, evidence] of action.evidence.entries()) {
      checkEvidence(filePath, fixture.input.text, evidence, `actions[${actionIndex}].evidence[${evidenceIndex}]`);
    }
    if (action.due && !fixture.input.text.includes(action.due.raw_text)) {
      fail(filePath, `actions[${actionIndex}].due.raw_text is not present in input text`);
    }
  }

  for (const [clarificationIndex, clarification] of fixture.gold.clarifications.entries()) {
    if (clarification.evidence) {
      checkEvidence(
        filePath,
        fixture.input.text,
        clarification.evidence,
        `clarifications[${clarificationIndex}].evidence`,
      );
    }
  }

  const normalizedTitles = fixture.gold.actions.map((action) => action.title.toLowerCase());
  for (const forbiddenAction of fixture.gold.forbidden_actions) {
    if (normalizedTitles.includes(forbiddenAction.toLowerCase())) {
      fail(filePath, `forbidden action is also present in gold actions: ${forbiddenAction}`);
    }
  }
}

for (const expectedSplit of ["dev", "holdout"]) {
  if (!splitCounts.has(expectedSplit)) {
    throw new Error(`No fixtures found for split ${expectedSplit}`);
  }
}

console.log(
  `Semantic fixture checks passed: ${files.length} fixtures (${splitCounts.get("dev")} dev, ${splitCounts.get("holdout")} holdout)`,
);
