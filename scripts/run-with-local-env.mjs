import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

const [command, ...arguments_] = process.argv.slice(2);
if (!command) throw new Error("a command is required");

const environmentFile = resolve(".env");
if (existsSync(environmentFile)) loadEnvFile(environmentFile);

const child = spawn(command, arguments_, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  process.stderr.write(`Local command could not start: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
