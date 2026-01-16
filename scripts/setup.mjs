import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const expectedPython = readFileSync(".python-version", "utf8").trim();
const [pythonMajor, pythonMinor] = expectedPython.split(".");
const python = `python${pythonMajor}.${pythonMinor}`;
const virtualenvPython = ".venv/bin/python";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });

  if (result.error) {
    throw new Error(
      `SnapFlow needs Python ${expectedPython}. Install ${python} and run setup again.`,
    );
  }

  return `${result.stdout}${result.stderr}`.trim().replace(/^Python\s+/, "");
}

const installedPython = readVersion(python);
if (installedPython !== expectedPython) {
  throw new Error(
    `Expected ${python} to be ${expectedPython}, found ${installedPython}.`,
  );
}

if (!existsSync(virtualenvPython)) {
  run(python, ["-m", "venv", ".venv"]);
}

const virtualenvVersion = readVersion(virtualenvPython);
if (virtualenvVersion !== expectedPython) {
  throw new Error(
    `The existing .venv uses Python ${virtualenvVersion}. Recreate it with ${python}.`,
  );
}

run(virtualenvPython, [
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "-r",
  "requirements-dev.txt",
]);
run("pnpm", ["install", "--frozen-lockfile"]);
