import { fileURLToPath } from "node:url";

const libraryUrl = new URL("../dist/index.js", import.meta.url);
const cliUrl = new URL("../dist/bin.js", import.meta.url);
const api = (await import(libraryUrl.href)) as Record<string, unknown>;

for (const exported of ["defineMigration", "entity", "field", "website", "syncMigration"]) {
  if (typeof api[exported] !== "function" && (exported !== "field" || typeof api[exported] !== "object")) {
    throw new Error(`Built package is missing the ${exported} export`);
  }
}

const cli = Bun.spawnSync({
  cmd: [process.execPath, "run", fileURLToPath(cliUrl), "--version"],
  stdout: "pipe",
  stderr: "pipe",
});
const stdout = new TextDecoder().decode(cli.stdout).trim();
const stderr = new TextDecoder().decode(cli.stderr).trim();
if (cli.exitCode !== 0 || stdout !== "0.1.0") {
  throw new Error(`Built CLI failed (exit ${cli.exitCode}): ${stderr || stdout}`);
}

const firstLine = (await Bun.file(cliUrl).text()).split("\n", 1)[0];
if (firstLine !== "#!/usr/bin/env bun") {
  throw new Error("Built CLI is missing its Bun shebang");
}

console.log("Package smoke passed");
