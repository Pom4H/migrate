import { describe, expect, test } from "bun:test";
import { checkMigration } from "../src/check.js";
import { diffSnapshots } from "../src/diff.js";
import { defineMigration, entity } from "../src/dsl.js";
import { extractSnapshot } from "../src/extract.js";
import { field } from "../src/field.js";
import { mergeJson, resolveSnapshot } from "../src/merge.js";
import { compilePattern, renderPattern } from "../src/pattern.js";
import type { MigrationLogger, MigrationSnapshot, SourceAdapter, SourceDocument } from "../src/types.js";

const logger: MigrationLogger = { log() {} };

const fixtureSource: SourceAdapter = {
  name: "fixture",
  origin: "https://legacy.example",
  async discover() {
    return ["https://legacy.example/catalog/coffee/sample/"];
  },
  async fetch() {
    throw new Error("not used");
  },
};

const document: SourceDocument = {
  url: "https://legacy.example/catalog/coffee/sample/",
  status: 200,
  contentType: "text/html; charset=utf-8",
  body: `
    <html>
      <head><meta name="description" content="A useful sample" /></head>
      <body>
        <h1>Sample product</h1>
        <span class="price">1 250 ₽</span>
        <img src="/media/sample.jpg" />
      </body>
    </html>
  `,
  fetchedAt: "2026-09-03T00:00:00.000Z",
  hash: "fixture-hash",
  headers: {},
};

const config = defineMigration({
  name: "fixture",
  source: fixtureSource,
  entities: [
    entity("product", {
      match: "/catalog/:category/:slug",
      id: field.param("slug"),
      route: "/products/:slug",
      fields: {
        title: field.text("h1"),
        description: field.attr('meta[name="description"]', "content"),
        price: field.money(".price"),
        images: field.list("img[src]", { attribute: "src", absolute: true }),
      },
      assetFields: ["images"],
    }),
  ],
});

describe("route patterns", () => {
  test("matches and renders typed route parameters", () => {
    expect(compilePattern("/catalog/:category/:slug")("/catalog/coffee/sample/")).toEqual({
      params: { category: "coffee", slug: "sample" },
    });
    expect(renderPattern("/products/:slug", { slug: "hello world" })).toBe("/products/hello%20world");
  });
});

describe("extraction", () => {
  test("normalizes a source page into a typed entity", async () => {
    const snapshot = await extractSnapshot(config, [document], logger);
    expect(snapshot.entities).toHaveLength(1);
    expect(snapshot.entities[0]?.fields).toEqual({
      title: "Sample product",
      description: "A useful sample",
      price: 1250,
      images: ["https://legacy.example/media/sample.jpg"],
    });
    expect(snapshot.entities[0]?.route).toBe("/products/sample");
    expect(snapshot.assets[0]?.url).toBe("https://legacy.example/media/sample.jpg");
  });
});

describe("overrides", () => {
  test("deep-merges durable improvements without mutating generated data", async () => {
    const generated = await extractSnapshot(config, [document], logger);
    const original = structuredClone(generated.entities[0]?.fields);
    const resolved = await resolveSnapshot(generated, {
      product: {
        sample: {
          route: "/shop/sample",
          fields: { title: "Improved title", seo: { featured: true } },
        },
      },
    });

    expect(resolved.entities[0]?.fields).toEqual({
      title: "Improved title",
      description: "A useful sample",
      price: 1250,
      images: ["https://legacy.example/media/sample.jpg"],
      seo: { featured: true },
    });
    expect(resolved.entities[0]?.route).toBe("/shop/sample");
    expect(generated.entities[0]?.fields).toEqual(original);
  });

  test("merges nested JSON deterministically", () => {
    expect(mergeJson({ a: { b: 1, c: 2 } }, { a: { b: 3 } })).toEqual({
      a: { b: 3, c: 2 },
    });
  });
});

describe("semantic diff and checks", () => {
  test("reports field changes instead of raw JSON noise", async () => {
    const previous = await extractSnapshot(config, [document], logger);
    const current = structuredClone(previous) as MigrationSnapshot;
    current.fingerprint = "changed";
    current.entities[0]!.fields["price"] = 1400;

    const diff = diffSnapshots(previous, current);
    expect(diff.summary.changed).toBe(1);
    expect(diff.entities[0]?.changes).toContainEqual({
      path: "fields.price",
      before: 1250,
      after: 1400,
    });
  });

  test("rejects duplicate active target routes", async () => {
    const generated = await extractSnapshot(config, [document], logger);
    const resolved = await resolveSnapshot(generated, {
      product: {
        second: {
          create: { fields: { title: "Second" }, route: "/products/sample" },
        },
      },
    });
    const diff = diffSnapshots(null, generated);
    const report = await checkMigration({
      config,
      generated,
      resolved,
      previous: null,
      diff,
      overrides: {},
    });
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "duplicate-route")).toBe(true);
  });
});
