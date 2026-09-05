import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineMigration, entity } from "../src/dsl.js";
import { extractSnapshot, fingerprintSnapshot } from "../src/extract.js";
import { field } from "../src/field.js";
import { readSnapshotDirectory, writeSnapshotDirectory } from "../src/storage.js";
import type { MigrationLogger, SourceAdapter, SourceDocument } from "../src/types.js";

const logger: MigrationLogger = { log() {} };

const source: SourceAdapter = {
  name: "fixture",
  origin: "https://legacy.example",
  async discover() {
    return ["https://legacy.example/catalog/coffee/sample/"];
  },
  async fetch() {
    throw new Error("not used");
  },
};

const config = defineMigration({
  name: "fixture",
  source,
  entities: [
    entity("product", {
      match: "/catalog/:category/:slug",
      id: field.param("slug"),
      route: "/products/:slug",
      fields: {
        title: field.text("h1"),
        price: field.money(".price"),
      },
    }),
  ],
});

function document(fetchedAt: string, hash: string): SourceDocument {
  return {
    url: "https://legacy.example/catalog/coffee/sample/",
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<h1>Sample product</h1><span class='price'>1 250 ₽</span>",
    fetchedAt,
    hash,
    headers: {},
  };
}

describe("git-native storage", () => {
  test("fetch metadata does not change the domain fingerprint", async () => {
    const first = await extractSnapshot(config, [document("2026-09-05T00:00:00.000Z", "hash-a")], logger);
    const second = await extractSnapshot(config, [document("2026-09-06T00:00:00.000Z", "hash-b")], logger);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(await fingerprintSnapshot({ ...second, fingerprint: undefined } as never)).toBe(second.fingerprint);
  });

  test("writes one stable file per entity without observation timestamps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "migrate-storage-"));
    try {
      const first = await extractSnapshot(config, [document("2026-09-05T00:00:00.000Z", "hash-a")], logger);
      await writeSnapshotDirectory(directory, first);

      expect(await readdir(directory)).toEqual([
        "assets.json",
        "documents.json",
        "entities",
        "manifest.json",
        "routes.json",
      ]);
      const entityFiles = await readdir(join(directory, "entities", "product"));
      expect(entityFiles).toHaveLength(1);
      const entityPath = join(directory, "entities", "product", entityFiles[0]!);
      const before = await readFile(entityPath, "utf8");
      expect(before).not.toContain("fetchedAt");
      expect(before).not.toContain("sourceHash");

      const second = await extractSnapshot(config, [document("2026-09-06T00:00:00.000Z", "hash-b")], logger);
      await writeSnapshotDirectory(directory, second);
      expect(await readFile(entityPath, "utf8")).toBe(before);

      const restored = await readSnapshotDirectory(directory);
      expect(restored?.entities[0]?.fields).toEqual({ price: 1250, title: "Sample product" });
      expect(restored?.fingerprint).toBe(second.fingerprint);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
