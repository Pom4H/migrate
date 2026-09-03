# Catalog example

This example keeps a replacement catalog synchronized with a hypothetical legacy source.

Copy `migrate.config.ts` to a project root, copy `overrides.ts` to `content/overrides.ts`, then run:

```bash
bunx @pom4h/migrate sync --check
```

The source domain is intentionally non-routable example data. Replace selectors and the origin with a source you are authorized to migrate.
