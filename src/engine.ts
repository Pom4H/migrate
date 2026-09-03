import { checkMigration } from "./check.js";
import { diffSnapshots } from "./diff.js";
import { extractSnapshot } from "./extract.js";
import { resolveSnapshot } from "./merge.js";
import {
  loadOverrides,
  readDiff,
  readSnapshotDirectory,
  readStatePrevious,
  resolveOutputPaths,
  writeRawSnapshot,
  writeSnapshotDirectory,
  writeState,
} from "./storage.js";
import type {
  CheckReport,
  JsonObject,
  MigrationConfig,
  MigrationLogger,
  PullResult,
  SourceContext,
  SourceDocument,
  SyncResult,
} from "./types.js";
import { mapLimit, uniqueSorted } from "./util.js";

export type EngineOptions = {
  cwd?: string;
  signal?: AbortSignal;
  logger?: MigrationLogger;
};

export type SyncOptions = EngineOptions & {
  dryRun?: boolean;
};

export function consoleLogger(verbose = false): MigrationLogger {
  return {
    log(level, message, details) {
      if (level === "debug" && !verbose) return;
      const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
      const output = level === "error" || level === "warn" ? console.error : console.log;
      output(`[${level}] ${message}${suffix}`);
    },
  };
}

function contextFor(options: EngineOptions): SourceContext {
  const context: SourceContext = {
    cwd: options.cwd ?? process.cwd(),
    logger: options.logger ?? consoleLogger(false),
  };
  if (options.signal) context.signal = options.signal;
  return context;
}

async function fetchDocuments(
  config: MigrationConfig,
  options: EngineOptions,
): Promise<SourceDocument[]> {
  const context = contextFor(options);
  const urls = uniqueSorted(await config.source.discover(context));
  const concurrency = config.source.concurrency ?? 6;
  const documents = await mapLimit(urls, concurrency, async (url) => {
    const document = await config.source.fetch(url, context);
    context.logger.log(
      document.status >= 400 ? "warn" : "debug",
      `${document.status} ${document.url}`,
    );
    return document;
  });
  return documents.sort((left, right) => left.url.localeCompare(right.url));
}

export async function pullMigration(
  config: MigrationConfig,
  options: EngineOptions = {},
): Promise<PullResult> {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? consoleLogger(false);
  const paths = resolveOutputPaths(config, cwd);
  const documents = await fetchDocuments(config, { ...options, cwd, logger });
  const raw = await writeRawSnapshot(config.name, config.source.name, documents, paths.raw);
  logger.log("info", `Saved raw snapshot to ${raw.directory}`);
  return { documents, rawDirectory: raw.directory, manifest: raw.manifest };
}

export async function syncMigration(
  config: MigrationConfig,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? consoleLogger(false);
  const paths = resolveOutputPaths(config, cwd);
  const previous = await readSnapshotDirectory(paths.generated);
  const documents = await fetchDocuments(config, { ...options, cwd, logger });
  const generated = await extractSnapshot(config, documents, logger);
  const overrides = await loadOverrides(paths.overrides);
  const resolved = await resolveSnapshot(generated, overrides);
  const diff = diffSnapshots(previous, generated);
  const checks = await checkMigration({ config, generated, resolved, previous, diff, overrides });

  let rawDirectory = "(dry-run)";
  if (!options.dryRun) {
    const raw = await writeRawSnapshot(config.name, config.source.name, documents, paths.raw);
    rawDirectory = raw.directory;
    await writeSnapshotDirectory(paths.generated, generated);
    await writeSnapshotDirectory(paths.resolved, resolved);
    await writeState(paths.state, previous, generated, diff);
    logger.log("info", `Wrote generated data to ${paths.generated}`);
    logger.log("info", `Wrote resolved data to ${paths.resolved}`);
  }

  return { generated, resolved, previous, diff, checks, paths, rawDirectory };
}

export async function checkCurrentMigration(
  config: MigrationConfig,
  options: EngineOptions = {},
): Promise<CheckReport> {
  const cwd = options.cwd ?? process.cwd();
  const paths = resolveOutputPaths(config, cwd);
  const generated = await readSnapshotDirectory(paths.generated);
  const resolved = await readSnapshotDirectory(paths.resolved);
  if (!generated || !resolved) {
    throw new Error("No generated migration data. Run `migrate sync` first.");
  }
  const previous = await readStatePrevious(paths.state);
  const diff = (await readDiff(paths.state)) ?? diffSnapshots(previous, generated);
  const overrides = await loadOverrides(paths.overrides);
  return checkMigration({ config, generated, resolved, previous, diff, overrides });
}

export function logDetails(logger: MigrationLogger, details: Record<string, unknown>): void {
  logger.log("debug", "Migration details", details as JsonObject);
}
