import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const webRoot = join(import.meta.dirname, "..");
const outputRoot = join(webRoot, "public", "ocr-runtime");

const packageRoot = (packageName) =>
  dirname(require.resolve(`${packageName}/package.json`));

const tesseractRoot = packageRoot("tesseract.js");
const tesseractRequire = createRequire(join(tesseractRoot, "package.json"));
const coreRoot = dirname(tesseractRequire.resolve("tesseract.js-core/package.json"));
const languageRoot = packageRoot("@tesseract.js-data/eng");

const assets = [
  {
    source: join(tesseractRoot, "dist", "worker.min.js"),
    destination: join(outputRoot, "worker.min.js"),
  },
  {
    source: join(tesseractRoot, "LICENSE.md"),
    destination: join(outputRoot, "licenses", "tesseract.js-LICENSE.md"),
  },
  {
    source: join(coreRoot, "LICENSE"),
    destination: join(outputRoot, "licenses", "tesseract.js-core-LICENSE.txt"),
  },
  ...[
    "tesseract-core-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-relaxedsimd-lstm.wasm.js",
  ].map((fileName) => ({
    source: join(coreRoot, fileName),
    destination: join(outputRoot, "core", fileName),
  })),
  {
    source: join(languageRoot, "4.0.0_best_int", "eng.traineddata.gz"),
    destination: join(outputRoot, "lang", "eng.traineddata.gz"),
  },
];

for (const asset of assets) {
  await mkdir(dirname(asset.destination), { recursive: true });
  await copyFile(asset.source, asset.destination);
}

const packageMetadata = {
  "@tesseract.js-data/eng": JSON.parse(
    await readFile(join(languageRoot, "package.json"), "utf8"),
  ),
  "tesseract.js": JSON.parse(
    await readFile(join(tesseractRoot, "package.json"), "utf8"),
  ),
  "tesseract.js-core": JSON.parse(
    await readFile(join(coreRoot, "package.json"), "utf8"),
  ),
};
const manifest = {
  generated: true,
  language: "eng",
  packages: Object.fromEntries(
    Object.entries(packageMetadata).map(([name, metadata]) => [
      name,
      { license: metadata.license, version: metadata.version },
    ]),
  ),
};

await readFile(join(outputRoot, "worker.min.js"));
await readFile(join(outputRoot, "lang", "eng.traineddata.gz"));
await writeFile(
  join(outputRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  join(outputRoot, "THIRD_PARTY_NOTICES.txt"),
  `${Object.entries(packageMetadata)
    .map(
      ([name, metadata]) =>
        `${name} ${metadata.version} — ${metadata.license} — ${metadata.homepage ?? metadata.repository?.url ?? "See package metadata"}`,
    )
    .join("\n")}\n`,
);

console.log(
  `OCR assets: synced ${assets.length} files for Tesseract.js ${packageMetadata["tesseract.js"].version}.`,
);
