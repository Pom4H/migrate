# Migrate

**Migration-as-code for replacing live legacy web products without freezing the source.**

Migrate turns a live website into typed, reviewable data, applies durable improvements, and keeps a modern replacement synchronized until cutover.

```text
legacy source
    ↓ pull
immutable raw snapshots
    ↓ extract
normalized generated data
    ↓ overlay
human-owned overrides
    ↓ check
resolved content + semantic diff
```

## Why

A conventional rebuild starts drifting as soon as the old system changes. A product is added, a price changes, an article is corrected, and the replacement becomes stale before it launches.

Migrate treats the transition as a repeatable program:

- the source remains operational;
- every synchronization is deterministic and reviewable;
- generated data and human improvements stay separate;
- changes are reported as entities and fields, not multi-megabyte JSON diffs;
- CI can reject broken routes, duplicate identities, orphaned overrides, and suspicious mass removals.

Migrate is not a visual website copier. It is the synchronization and verification layer between an existing system and its replacement.

## Requirements

- Bun 1.4 or newer
- TypeScript 7 for development

## Install

```bash
bun add -d @pom4h/migrate
```

The npm package is scoped because the unscoped `migrate` name is already used by unrelated migration tools. The executable is still named `migrate` inside an installed project.

## Start a migration

```bash
bunx @pom4h/migrate init https://legacy.example.com
bunx @pom4h/migrate sync --check
```

`init` creates:

```text
migrate.config.ts
content/overrides.ts
.github/workflows/migrate.yml
```

## Configuration

Configuration is ordinary TypeScript. The DSL remains small, while custom extractors provide an escape hatch for unusual systems.

```ts
import {
  defineMigration,
  entity,
  field,
  website,
} from "@pom4h/migrate";

export default defineMigration({
  name: "example-catalog",

  source: website("https://legacy.example.com", {
    discover: ["sitemap", "links"],
    include: ["/catalog/**"],
    concurrency: 8,
    maxPages: 2_000,
  }),

  entities: [
    entity("product", {
      match: "/catalog/:category/:slug",
      id: field.param("slug"),
      route: "/products/:slug",

      fields: {
        title: field.text("h1"),
        description: field.text(".product-description", {
          required: false,
        }),
        price: field.money(".price"),
        images: field.list(".gallery img[src]", {
          attribute: "src",
          absolute: true,
        }),
      },

      assetFields: ["images"],
    }),
  ],

  output: {
    generated: "content/generated",
    resolved: "content/resolved",
    overrides: "content/overrides.ts",
  },

  checks: {
    allowEmpty: false,
    requireHttps: true,
    maxRemovedRatio: 0.05,
  },
});
```

### Custom extraction

Selectors are deliberately not a prison. Use a typed extractor when data is embedded in scripts, assembled from several blocks, or requires domain logic.

```ts
entity("article", {
  match: "/journal/:slug",
  id: field.param("slug"),

  extract: ({ $, url }) => ({
    title: $("h1").text().trim(),
    canonical: url.href,
    sections: $("article section")
      .map((_, section) => $(section).text().trim())
      .get(),
  }),
});
```

## Durable overrides

Generated files are disposable. Overrides are source-controlled product decisions and are never rewritten by synchronization.

```ts
import { defineOverrides } from "@pom4h/migrate";

export default defineOverrides({
  product: {
    "sample-product": {
      fields: {
        title: "A clearer product name",
        seo: {
          title: "A clearer product name — Example",
          featured: true,
        },
      },
      route: "/products/sample-product",
    },
  },
});
```

Overrides can also archive, remove, or explicitly create an entity:

```ts
export default defineOverrides({
  page: {
    obsolete: { remove: true },
    campaign: {
      create: {
        route: "/campaign",
        fields: { title: "Campaign" },
      },
    },
  },
});
```

## Data layers

A synchronization produces three independent layers:

```text
.migrate/raw/<timestamp>/     exact fetched responses and metadata
content/generated/            normalized source truth
content/overrides.ts          human-owned patches
content/resolved/             generated data with patches applied
```

Each generated and resolved directory uses a Git-native representation:

```text
manifest.json
documents.json
routes.json
assets.json
entities/
  product/
    sample-product-3e41c32c802a.json
    another-product-ef86f763d83f.json
  article/
    migration-notes-7c52a6710b9d.json
```

Each entity owns one file. Adding a product adds a file; changing one price changes a few lines in one file. This avoids rewriting a giant entity array and also reduces merge conflicts between independent changes.

Fetch timestamps, raw response hashes and per-field observation timestamps are intentionally omitted from this Git-facing representation. They remain available in the immutable raw/state layers, while semantic fingerprints are calculated from normalized entities, routes and assets. Dynamic HTML that does not change the extracted domain therefore produces no generated-content diff.

All JSON is written with stable key ordering. Entity identity is `(type, id)`, so formatting changes and crawl order do not create noise. Existing `0.1` directories containing `snapshot.json` remain readable and are rewritten to the Git-native layout by the next synchronization.

## Semantic diffs

```bash
bunx @pom4h/migrate diff
```

Example output:

```diff
Source diff: +2 ~1 -0 (48 unchanged)
+ product new-product
+ article migration-notes
~ product sample-product
    fields.price: 1250 → 1400
```

The machine-readable form is available for CI and agents:

```bash
bunx @pom4h/migrate diff --json
```

## Checks

```bash
bunx @pom4h/migrate check
```

The first release checks:

- empty extraction results;
- duplicate `(type, id)` identities;
- duplicate active target routes;
- malformed and insecure asset URLs;
- source routes not represented by an entity;
- overrides whose source entity disappeared;
- absolute and proportional removal limits;
- snapshot fingerprint integrity.

Use `sync --check` to make a failed check return a non-zero exit code.

## Commands

| Command | Purpose |
| --- | --- |
| `migrate init <origin>` | Create a config, overrides file, and synchronization workflow |
| `migrate pull` | Save an immutable raw source snapshot |
| `migrate sync` | Pull, extract, normalize, overlay, diff, check, and write outputs |
| `migrate sync --dry-run` | Perform the pipeline without writing files |
| `migrate diff` | Print the latest entity-level source diff |
| `migrate check` | Validate the current generated and resolved snapshots |
| `migrate ci` | Generate a scheduled GitHub Actions workflow |

All commands accept `--cwd`, `--config`, and `--verbose`.

## CI synchronization

`migrate init` and `migrate ci` generate a workflow that:

1. installs Bun 1.4;
2. synchronizes the source;
3. runs migration checks;
4. runs the replacement build when a build script exists;
5. opens a pull request containing the source diff.

Raw responses and transient state are ignored by default. Normalized generated content remains reviewable in Git.

## Source adapters

`website()` is the built-in HTTP adapter. It supports explicit routes, sitemap discovery, same-origin link crawling, include/exclude rules, request headers, timeouts, bounded concurrency, and an in-memory response cache.

Any other source can implement the small `SourceAdapter` contract:

```ts
import type { SourceAdapter } from "@pom4h/migrate";

const source: SourceAdapter = {
  name: "internal-api",
  origin: "https://api.example.com",

  async discover() {
    return ["https://api.example.com/items"];
  },

  async fetch(url) {
    // Return a SourceDocument from an API, export, filesystem, or browser adapter.
    throw new Error(`Implement ${url}`);
  },
};
```

Browser automation and hosted crawling services belong in optional adapters rather than the core package.

## Design invariants

- **Source data is immutable.** Raw snapshots are evidence, not working files.
- **Generated data is disposable.** Re-running the same source and config must recreate it.
- **Overrides survive regeneration.** Human decisions never live inside generated JSON.
- **Identity is explicit.** URLs and array positions are not durable entity identities.
- **CI is deterministic.** AI may help author configuration, but synchronization does not require an LLM.
- **Cutover is gradual.** Source and replacement can run in parallel until route coverage is complete.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

The project pins Bun 1.4 and TypeScript 7.0.2. Source code uses erasable TypeScript syntax so it remains compatible with modern native TypeScript execution paths.

## Status

`0.1.x` is an intentionally small foundation. The stable concepts are typed entities, raw snapshots, generated/resolved layers, durable overrides, semantic diffs, checks, and CI generation. Storage formats may still evolve before `1.0`.

## License

MIT
