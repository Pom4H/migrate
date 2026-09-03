import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isOverrideSet } from "./merge.js";
import type {
  MigrationConfig,
  MigrationDiff,
  MigrationSnapshot,
  OverrideSet,
  RawManifest,
  ResolvedOutputPaths,
  SourceDocument,
} from "./types.js";
import { safeFileName, stableStringify, timestampId, toJsonValue } from "./util.js";

const fromCwd = (cwd: string, value: string) => (isAbsolute(value) ? value : resolve(cwd, value));

export function resolveOutputPaths(config: MigrationConfig, cwd = process.cwd()): ResolvedOutputPaths {
  const root = fromCwd(cwd, config.output?.root ?? ".migrate");
  const path = (value: string | undefined, fallback: string) =>
    value ? fromCwd(cwd, value) : join(root, fallback);
  return {
    root,
    raw: path(config.output?.raw, "raw"),
    generated: path(config.output?.generated, "generated"),
    resolved: path(config.output?.resolved, "resolved"),
    overrides: path(config.output?.overrides, "overrides.ts"),
    state: path(config.output?.state, "state"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function documentExtension(document: SourceDocument): string {
  const contentType = document.contentType ?? "";
  if (contentType.includes("html")) return ".html";
  if (contentType.includes("xml")) return ".xml";
  if (contentType.includes("json")) return ".json";
  return extname(new URL(document.url).pathname) || ".txt";
}

export async function writeRawSnapshot(
  migration: string,
  source: string,
  documents: SourceDocument[],
  rawRoot: string,
): Promise<{ directory: string; manifest: RawManifest }> {
  const createdAt = new Date().toISOString();
  const directory = join(rawRoot, timestampId(new Date(createdAt)));
  const pagesDirectory = join(directory, "pages");
  await mkdir(pagesDirectory, { recursive: true });

  const pages = [];
  for (const document of documents) {
    const file = join("pages", `${document.hash}${documentExtension(document)}`);
    const absolute = join(directory, file);
    if (!(await exists(absolute))) await atomicWrite(absolute, document.body);
    const { body: _body, ...metadata } = document;
    pages.push({ ...metadata, file });
  }

  pages.sort((left, right) => left.url.localeCompare(right.url));
  const manifest: RawManifest = {
    schemaVersion: 1,
    migration,
    createdAt,
    source,
    pages,
  };
  await atomicWrite(join(directory, "manifest.json"), stableStringify(toJsonValue(manifest)));
  await atomicWrite(
    join(rawRoot, "latest.json"),
    stableStringify(toJsonValue({ directory, createdAt, manifest: join(directory, "manifest.json") })),
  );
  return { directory, manifest };
}

export async function writeSnapshotDirectory(
  directory: string,
  snapshot: MigrationSnapshot,
): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(join(directory, "entities"), { recursive: true });
  await atomicWrite(join(directory, "snapshot.json"), stableStringify(toJsonValue(snapshot)));

  const grouped = new Map<string, typeof snapshot.entities>();
  for (const entity of snapshot.entities) {
    const entries = grouped.get(entity.type) ?? [];
    entries.push(entity);
    grouped.set(entity.type, entries);
  }
  for (const [type, entities] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    await atomicWrite(
      join(directory, "entities", `${safeFileName(type)}.json`),
      stableStringify(toJsonValue(entities)),
    );
  }

  await atomicWrite(join(directory, "routes.json"), stableStringify(toJsonValue(snapshot.routes)));
  await atomicWrite(join(directory, "assets.json"), stableStringify(toJsonValue(snapshot.assets)));
  await atomicWrite(
    join(directory, "manifest.json"),
    stableStringify(
      toJsonValue({
        schemaVersion: snapshot.schemaVersion,
        layer: snapshot.layer,
        migration: snapshot.migration,
        generatedAt: snapshot.generatedAt,
        fingerprint: snapshot.fingerprint,
        source: snapshot.source,
        entityTypes: [...grouped].map(([type, entities]) => ({ type, count: entities.length })),
        routes: snapshot.routes.length,
        assets: snapshot.assets.length,
      }),
    ),
  );
}

export async function readSnapshotDirectory(directory: string): Promise<MigrationSnapshot | null> {
  const path = join(directory, "snapshot.json");
  if (!(await exists(path))) return null;
  const value = JSON.parse(await readFile(path, "utf8")) as MigrationSnapshot;
  if (value.schemaVersion !== 1 || !Array.isArray(value.entities)) {
    throw new Error(`Unsupported or invalid migration snapshot: ${path}`);
  }
  return value;
}

function mergeOverrideSets(base: OverrideSet, next: OverrideSet): OverrideSet {
  const result: OverrideSet = structuredClone(base);
  for (const [type, entries] of Object.entries(next)) {
    result[type] ??= {};
    for (const [id, override] of Object.entries(entries)) result[type]![id] = override;
  }
  return result;
}

async function loadOverrideFile(path: string): Promise<OverrideSet> {
  const extension = extname(path).toLowerCase();
  let value: unknown;
  if (extension === ".json") {
    value = JSON.parse(await readFile(path, "utf8"));
  } else if ([".ts", ".mts", ".js", ".mjs"].includes(extension)) {
    const metadata = await stat(path);
    const module = (await import(`${pathToFileURL(path).href}?mtime=${metadata.mtimeMs}`)) as {
      default?: unknown;
      overrides?: unknown;
    };
    value = module.default ?? module.overrides;
  } else {
    throw new Error(`Unsupported override file: ${path}`);
  }
  if (!isOverrideSet(value)) throw new Error(`Invalid override set: ${path}`);
  return value;
}

export async function loadOverrides(path: string): Promise<OverrideSet> {
  if (!(await exists(path))) return {};
  const metadata = await stat(path);
  if (metadata.isFile()) return loadOverrideFile(path);
  if (!metadata.isDirectory()) throw new Error(`Override path is neither a file nor directory: ${path}`);

  const files = (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && [".json", ".ts", ".mts", ".js", ".mjs"].includes(extname(entry.name)))
    .map((entry) => join(path, entry.name))
    .sort();
  let result: OverrideSet = {};
  for (const file of files) result = mergeOverrideSets(result, await loadOverrideFile(file));
  return result;
}

export async function writeState(
  stateDirectory: string,
  previous: MigrationSnapshot | null,
  current: MigrationSnapshot,
  diff: MigrationDiff,
): Promise<void> {
  await mkdir(stateDirectory, { recursive: true });
  if (previous) {
    await atomicWrite(
      join(stateDirectory, "previous.json"),
      stableStringify(toJsonValue(previous)),
    );
  } else {
    await rm(join(stateDirectory, "previous.json"), { force: true });
  }
  await atomicWrite(join(stateDirectory, "current.json"), stableStringify(toJsonValue(current)));
  await atomicWrite(join(stateDirectory, "changes.json"), stableStringify(toJsonValue(diff)));
}

export async function readDiff(stateDirectory: string): Promise<MigrationDiff | null> {
  const path = join(stateDirectory, "changes.json");
  if (!(await exists(path))) return null;
  return JSON.parse(await readFile(path, "utf8")) as MigrationDiff;
}

export async function writeTextFile(path: string, content: string, force = false): Promise<boolean> {
  if (!force && (await exists(path))) return false;
  await atomicWrite(path, content);
  return true;
}

export async function readStatePrevious(stateDirectory: string): Promise<MigrationSnapshot | null> {
  const path = join(stateDirectory, "previous.json");
  if (!(await exists(path))) return null;
  return JSON.parse(await readFile(path, "utf8")) as MigrationSnapshot;
}
