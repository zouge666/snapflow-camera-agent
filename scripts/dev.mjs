import { spawn } from "node:child_process";

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error("Start development with ./scripts/pnpmw dev.");
}

const services = [
  { name: "web", script: "dev:web" },
  { name: "api", script: "dev:api" },
];
const children = new Set();
let stopping = false;

function signalChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill(signal);
}

function stop(exitCode, signal = "SIGTERM") {
  if (stopping) {
    return;
  }

  stopping = true;
  for (const child of children) {
    signalChild(child, signal);
  }

  const forceTimer = setTimeout(() => {
    for (const child of children) {
      signalChild(child, "SIGKILL");
    }
  }, 5_000);

  Promise.all(
    [...children].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", resolve);
        }),
    ),
  ).then(() => {
    clearTimeout(forceTimer);
    process.exit(exitCode);
  });
}

for (const service of services) {
  const child = spawn(process.execPath, [pnpmCli, "run", service.script], {
    env: process.env,
    stdio: "inherit",
  });

  children.add(child);
  child.on("error", (error) => {
    console.error(`[dev] ${service.name} failed to start: ${error.message}`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      console.error(`[dev] ${service.name} stopped with ${reason}.`);
      stop(code ?? 1);
    }
  });
}

process.once("SIGINT", () => stop(0, "SIGINT"));
process.once("SIGTERM", () => stop(0, "SIGTERM"));
