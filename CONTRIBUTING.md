# Contributing

Migrate is built with Bun 1.4 and TypeScript 7.

```bash
bun install
bun run verify
```

Keep changes aligned with the project invariants:

- source snapshots are immutable;
- generated data is deterministic;
- overrides are never rewritten;
- entity identity is explicit;
- core synchronization does not depend on an LLM;
- adapters stay separate from the migration engine.

Add tests for behavior changes. Do not add examples containing private systems, credentials, customer data, or websites you are not authorized to migrate.
