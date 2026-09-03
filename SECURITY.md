# Security

Migrate fetches and stores source responses. Treat raw snapshots as potentially sensitive data even when the source is publicly accessible.

- Never put credentials directly in `migrate.config.ts`.
- Load authorization values from CI secrets or environment variables.
- Keep `.migrate/raw/` out of Git unless the captured data is safe to publish.
- Review custom extractors and override modules as executable code.
- Run migrations only against systems you are authorized to access.

Report vulnerabilities privately through GitHub Security Advisories for this repository.
