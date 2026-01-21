import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureRoot, "..", "..");
const textRoot = join(fixtureRoot, "text");
const webPublicRoot = join(repositoryRoot, "apps", "web", "public");
const sampleRoot = join(webPublicRoot, "samples");
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
  throw new Error(`${relative(repositoryRoot, filePath)}: ${message}`);
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

function isInside(directory, filePath) {
  return resolve(filePath).startsWith(`${resolve(directory)}${sep}`);
}

function toPublicPath(filePath) {
  return `/${relative(webPublicRoot, filePath).split(sep).join("/")}`;
}

async function checkArtifact(manifestPath, name, artifact) {
  const artifactPath = resolve(repositoryRoot, artifact.repository_path);
  if (!isInside(sampleRoot, artifactPath)) {
    fail(manifestPath, `artifacts.${name}.repository_path leaves the public sample directory`);
  }

  const expectedPublicPath = toPublicPath(artifactPath);
  if (artifact.public_path !== expectedPublicPath) {
    fail(
      manifestPath,
      `artifacts.${name}.public_path is ${artifact.public_path}, expected ${expectedPublicPath}`,
    );
  }

  let content;
  try {
    content = await readFile(artifactPath);
  } catch (error) {
    fail(manifestPath, `artifacts.${name} cannot be read: ${error.message}`);
  }

  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== artifact.sha256) {
    fail(
      manifestPath,
      `artifacts.${name} SHA-256 is ${actualHash}, expected ${artifact.sha256}`,
    );
  }

  return { content, path: artifactPath };
}

async function checkImageFixture(filePath, fixture) {
  const requiredTags = ["synthetic-demo", "relative-date", "missing-owner"];
  for (const tag of requiredTags) {
    if (!fixture.scenario_tags.includes(tag)) {
      fail(filePath, `image fixture is missing required scenario tag ${tag}`);
    }
  }

  if (!fixture.gold.actions.some((action) => action.owner === null)) {
    fail(filePath, "image fixture must include an action with a missing owner");
  }
  if (!fixture.gold.actions.some((action) => action.due?.resolution === "relative")) {
    fail(filePath, "image fixture must include a relative date");
  }

  const artifacts = {};
  for (const [name, artifact] of Object.entries(fixture.artifacts)) {
    artifacts[name] = await checkArtifact(filePath, name, artifact);
  }

  const png = artifacts.image.content;
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 24 || !png.subarray(0, 8).equals(pngSignature)) {
    fail(filePath, "artifacts.image is not a valid PNG header");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== fixture.artifacts.image.width || height !== fixture.artifacts.image.height) {
    fail(
      filePath,
      `artifacts.image dimensions are ${width}x${height}, expected ${fixture.artifacts.image.width}x${fixture.artifacts.image.height}`,
    );
  }

  const transcript = artifacts.transcript.content
    .toString("utf8")
    .replaceAll("\r\n", "\n")
    .replace(/\n$/, "");
  if (transcript !== fixture.input.text) {
    fail(filePath, "artifacts.transcript does not match input.text");
  }

  const sourceDesign = artifacts.source_design.content.toString("utf8");
  const forbiddenSourcePatterns = [
    [/<image\b/i, "embedded image"],
    [/<script\b/i, "script"],
    [/<foreignObject\b/i, "foreignObject"],
    [/@font-face/i, "embedded font"],
    [/(?:href|xlink:href)\s*=/i, "external reference"],
    [/url\(\s*["']?https?:/i, "remote URL"],
  ];
  for (const [pattern, label] of forbiddenSourcePatterns) {
    if (pattern.test(sourceDesign)) {
      fail(filePath, `artifacts.source_design contains a forbidden ${label}`);
    }
  }
  for (const action of fixture.gold.actions) {
    for (const evidence of action.evidence) {
      if (!sourceDesign.includes(evidence.quote)) {
        fail(filePath, `source design does not contain action evidence ${JSON.stringify(evidence.quote)}`);
      }
    }
  }

  const attribution = artifacts.attribution.content.toString("utf8");
  for (const marker of [fixture.id, fixture.source.license, "synthetic", "Source URL: none"]) {
    if (!attribution.includes(marker)) {
      fail(filePath, `attribution is missing ${JSON.stringify(marker)}`);
    }
  }
}

const textFiles = await listJsonFiles(textRoot);
const sampleFiles = (await listJsonFiles(sampleRoot)).filter((filePath) => filePath.endsWith("manifest.json"));
if (textFiles.length < 6) {
  throw new Error(`Expected at least 6 text fixtures, found ${textFiles.length}`);
}
if (sampleFiles.length < 1) {
  throw new Error("Expected at least one public sample manifest");
}
const files = [...textFiles, ...sampleFiles];

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

  if (fixture.kind === "image") {
    await checkImageFixture(filePath, fixture);
  }
}

for (const expectedSplit of ["dev", "holdout"]) {
  if (!splitCounts.has(expectedSplit)) {
    throw new Error(`No fixtures found for split ${expectedSplit}`);
  }
}

console.log(
  `Semantic fixture checks passed: ${files.length} fixtures (${textFiles.length} text, ${sampleFiles.length} public sample; ${splitCounts.get("dev")} dev, ${splitCounts.get("holdout")} holdout)`,
);
