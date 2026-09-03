import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { checkCurrentMigration, consoleLogger, pullMigration, syncMigration } from "./engine.js";
import { formatCheckReport } from "./check.js";
import { formatDiff } from "./diff.js";
import { loadConfig } from "./config.js";
import { readDiff, resolveOutputPaths, writeTextFile } from "./storage.js";
import { configTemplate, gitignoreTemplate, overridesTemplate, workflowTemplate } from "./templates.js";
import { errorMessage, stableStringify, toJsonValue } from "./util.js";
import { VERSION } from "./version.js";

const HELP = `Migrate ${VERSION} — migration-as-code for live web products

Usage:
  migrate init <origin> [--force]
  migrate pull [--config path]
  migrate sync [--dry-run] [--check] [--config path]
  migrate diff [--json] [--config path]
  migrate check [--json] [--config path]
  migrate ci [--force]

Global options:
  --cwd <path>       Run from another directory
  --config <path>    Use a specific migration config
  --verbose          Print source requests and diagnostics
  --json             Emit machine-readable JSON where supported
  --help             Show this help
  --version          Show the version
`;

type ParsedArguments = {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
};

function parseArguments(argv: string[]): ParsedArguments {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const valueFlags = new Set(["cwd", "config"]);

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const [rawName, inlineValue] = argument.slice(2).split("=", 2);
    if (!rawName) continue;
    if (inlineValue !== undefined) {
      flags.set(rawName, inlineValue);
      continue;
    }
    if (valueFlags.has(rawName)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`--${rawName} needs a value`);
      flags.set(rawName, value);
    } else {
      flags.set(rawName, true);
    }
  }

  return {
    command: positionals.shift() ?? "help",
    positionals,
    flags,
  };
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

async function mergeGitignore(path: string): Promise<boolean> {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    // New file.
  }
  const lines = new Set(current.split(/\r?\n/).filter(Boolean));
  let changed = false;
  for (const line of gitignoreTemplate.trim().split("\n")) {
    if (!lines.has(line)) {
      lines.add(line);
      changed = true;
    }
  }
  if (!changed && current) return false;
  await ensureParent(path);
  await writeFile(path, `${[...lines].join("\n")}\n`, "utf8");
  return true;
}

async function initialize(cwd: string, origin: string, force: boolean): Promise<void> {
  const normalizedOrigin = new URL(origin).origin;
  const files = [
    [resolve(cwd, "migrate.config.ts"), configTemplate(normalizedOrigin)],
    [resolve(cwd, "content/overrides.ts"), overridesTemplate],
    [resolve(cwd, ".github/workflows/migrate.yml"), workflowTemplate],
  ] as const;

  for (const [path, content] of files) {
    const written = await writeTextFile(path, content, force);
    console.log(`${written ? "created" : "kept"} ${path}`);
  }
  const ignored = await mergeGitignore(resolve(cwd, ".gitignore"));
  console.log(`${ignored ? "updated" : "kept"} ${resolve(cwd, ".gitignore")}`);
  console.log("\nNext: bun add -d @pom4h/migrate && bunx @pom4h/migrate sync --check");
}

async function writeCi(cwd: string, force: boolean): Promise<void> {
  const path = resolve(cwd, ".github/workflows/migrate.yml");
  const written = await writeTextFile(path, workflowTemplate, force);
  console.log(`${written ? "created" : "kept"} ${path}`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed.flags.has("version") || parsed.command === "version") {
    console.log(VERSION);
    return 0;
  }
  if (parsed.flags.has("help") || parsed.command === "help") {
    console.log(HELP);
    return 0;
  }

  const cwd = resolve(flagString(parsed.flags, "cwd") ?? process.cwd());
  const configPath = flagString(parsed.flags, "config");
  const verbose = parsed.flags.has("verbose");
  const logger = consoleLogger(verbose);
  const json = parsed.flags.has("json");

  try {
    if (parsed.command === "init") {
      const origin = parsed.positionals[0];
      if (!origin) throw new Error("Usage: migrate init <origin>");
      await initialize(cwd, origin, parsed.flags.has("force"));
      return 0;
    }
    if (parsed.command === "ci") {
      await writeCi(cwd, parsed.flags.has("force"));
      return 0;
    }

    const { config } = await loadConfig(cwd, configPath);
    if (parsed.command === "pull") {
      const result = await pullMigration(config, { cwd, logger });
      console.log(`Pulled ${result.documents.length} pages into ${result.rawDirectory}`);
      return 0;
    }
    if (parsed.command === "sync") {
      const result = await syncMigration(config, {
        cwd,
        logger,
        dryRun: parsed.flags.has("dry-run"),
      });
      if (json) console.log(stableStringify(toJsonValue({ diff: result.diff, checks: result.checks })));
      else {
        console.log(`\n${formatDiff(result.diff)}\n`);
        console.log(formatCheckReport(result.checks));
      }
      return parsed.flags.has("check") && !result.checks.ok ? 1 : 0;
    }
    if (parsed.command === "diff") {
      const paths = resolveOutputPaths(config, cwd);
      const diff = await readDiff(paths.state);
      if (!diff) throw new Error("No semantic diff found. Run `migrate sync` first.");
      console.log(json ? stableStringify(toJsonValue(diff)) : formatDiff(diff));
      return 0;
    }
    if (parsed.command === "check") {
      const report = await checkCurrentMigration(config, { cwd, logger });
      console.log(json ? stableStringify(toJsonValue(report)) : formatCheckReport(report));
      return report.ok ? 0 : 1;
    }

    throw new Error(`Unknown command: ${parsed.command}`);
  } catch (error) {
    console.error(`migrate: ${errorMessage(error)}`);
    if (verbose && error instanceof Error && error.stack) console.error(error.stack);
    return 1;
  }
}
