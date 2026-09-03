import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineMigration } from "./dsl.js";
import type { MigrationConfig } from "./types.js";

const DEFAULT_CONFIGS = [
  "migrate.config.ts",
  "migrate.config.mts",
  "migrate.config.js",
  "migrate.config.mjs",
];

async function existing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function findConfig(cwd = process.cwd(), requested?: string): Promise<string> {
  if (requested) {
    const path = isAbsolute(requested) ? requested : resolve(cwd, requested);
    if (!(await existing(path))) throw new Error(`Migration config not found: ${path}`);
    return path;
  }

  for (const name of DEFAULT_CONFIGS) {
    const path = resolve(cwd, name);
    if (await existing(path)) return path;
  }
  throw new Error(`Migration config not found. Expected one of: ${DEFAULT_CONFIGS.join(", ")}`);
}

export async function loadConfig(
  cwd = process.cwd(),
  requested?: string,
): Promise<{ path: string; config: MigrationConfig }> {
  const path = await findConfig(cwd, requested);
  const metadata = await stat(path);
  const module = (await import(`${pathToFileURL(path).href}?mtime=${metadata.mtimeMs}`)) as {
    default?: unknown;
    config?: unknown;
  };
  const value = module.default ?? module.config;
  if (!value || typeof value !== "object") {
    throw new Error(`Config must export a migration definition: ${path}`);
  }
  return { path, config: defineMigration(value as MigrationConfig) };
}
