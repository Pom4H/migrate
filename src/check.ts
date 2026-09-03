import { fingerprintSnapshot } from "./extract.js";
import { findOrphanOverrides } from "./merge.js";
import type {
  CheckIssue,
  CheckReport,
  MigrationConfig,
  MigrationDiff,
  MigrationSnapshot,
  OverrideSet,
} from "./types.js";

const entityKey = (type: string, id: string) => `${type}:${id}`;

export type CheckInput = {
  config: MigrationConfig;
  generated: MigrationSnapshot;
  resolved: MigrationSnapshot;
  previous: MigrationSnapshot | null;
  diff: MigrationDiff;
  overrides: OverrideSet;
};

export async function checkMigration(input: CheckInput): Promise<CheckReport> {
  const issues: CheckIssue[] = [];
  const add = (issue: CheckIssue) => issues.push(issue);
  const checks = input.config.checks ?? {};

  if (!checks.allowEmpty && input.generated.entities.length === 0) {
    add({ severity: "error", code: "empty-migration", message: "No entities were extracted" });
  }

  const identities = new Set<string>();
  for (const entity of input.generated.entities) {
    const key = entityKey(entity.type, entity.id);
    if (identities.has(key)) {
      add({
        severity: "error",
        code: "duplicate-entity",
        message: `Duplicate entity identity: ${key}`,
        entity: { type: entity.type, id: entity.id },
      });
    }
    identities.add(key);
    if (!entity.type.trim() || !entity.id.trim()) {
      add({
        severity: "error",
        code: "invalid-identity",
        message: "Entity type and id must be non-empty",
        entity: { type: entity.type, id: entity.id },
      });
    }
    if (checks.requireHttps && /^http:/.test(entity.sourceUrl)) {
      add({
        severity: "warning",
        code: "insecure-source-url",
        message: `Source URL is not HTTPS: ${entity.sourceUrl}`,
        entity: { type: entity.type, id: entity.id },
      });
    }
  }

  const routes = new Map<string, string>();
  for (const route of input.resolved.routes.filter((item) => item.status === "active")) {
    const owner = entityKey(route.entity.type, route.entity.id);
    const existing = routes.get(route.targetPath);
    if (existing && existing !== owner) {
      add({
        severity: "error",
        code: "duplicate-route",
        message: `Target route ${route.targetPath} belongs to both ${existing} and ${owner}`,
        entity: route.entity,
        path: route.targetPath,
      });
    }
    routes.set(route.targetPath, owner);
  }

  const assets = new Set<string>();
  for (const asset of input.resolved.assets) {
    const key = `${asset.url}:${entityKey(asset.entity.type, asset.entity.id)}:${asset.entity.field}`;
    if (assets.has(key)) {
      add({
        severity: "warning",
        code: "duplicate-asset",
        message: `Asset is listed more than once: ${asset.url}`,
        entity: { type: asset.entity.type, id: asset.entity.id },
      });
    }
    assets.add(key);
    try {
      const url = new URL(asset.url);
      if (checks.requireHttps && url.protocol !== "https:") {
        add({
          severity: "warning",
          code: "insecure-asset-url",
          message: `Asset URL is not HTTPS: ${asset.url}`,
          entity: { type: asset.entity.type, id: asset.entity.id },
        });
      }
    } catch {
      add({
        severity: "error",
        code: "invalid-asset-url",
        message: `Invalid asset URL: ${asset.url}`,
        entity: { type: asset.entity.type, id: asset.entity.id },
      });
    }
  }

  if (checks.requireMatchedRoutes) {
    for (const document of input.generated.documents) {
      if (document.status < 400 && document.contentType?.includes("html") && !document.matched) {
        add({
          severity: "warning",
          code: "unmatched-source-route",
          message: `No entity matched ${document.url}`,
        });
      }
    }
  }

  for (const orphan of findOrphanOverrides(input.generated, input.overrides)) {
    const [type = "unknown", id = "unknown"] = orphan.split(":", 2);
    add({
      severity: "warning",
      code: "orphan-override",
      message: `Override no longer matches a generated entity: ${orphan}`,
      entity: { type, id },
    });
  }

  const removed = input.diff.summary.removed;
  if (checks.maxRemoved !== undefined && removed > checks.maxRemoved) {
    add({
      severity: "error",
      code: "removal-limit",
      message: `${removed} entities were removed; allowed maximum is ${checks.maxRemoved}`,
    });
  }
  if (checks.maxRemovedRatio !== undefined && input.previous?.entities.length) {
    const ratio = removed / input.previous.entities.length;
    if (ratio > checks.maxRemovedRatio) {
      add({
        severity: "error",
        code: "removal-ratio",
        message: `${(ratio * 100).toFixed(1)}% of entities were removed; allowed maximum is ${(checks.maxRemovedRatio * 100).toFixed(1)}%`,
      });
    }
  }

  for (const snapshot of [input.generated, input.resolved]) {
    const { fingerprint: _fingerprint, ...material } = snapshot;
    const fingerprint = await fingerprintSnapshot(material);
    if (fingerprint !== snapshot.fingerprint) {
      add({
        severity: "error",
        code: "fingerprint-mismatch",
        message: `${snapshot.layer} snapshot fingerprint does not match its contents`,
      });
    }
  }

  issues.sort((left, right) => {
    const severity = left.severity === right.severity ? 0 : left.severity === "error" ? -1 : 1;
    return severity || left.code.localeCompare(right.code) || left.message.localeCompare(right.message);
  });
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  return {
    ok: errors === 0 && (!checks.failOnWarnings || warnings === 0),
    errors,
    warnings,
    issues,
  };
}

export function formatCheckReport(report: CheckReport): string {
  if (report.issues.length === 0) return "Checks passed: no issues";
  const lines = [`Checks: ${report.errors} errors, ${report.warnings} warnings`];
  for (const issue of report.issues) {
    const symbol = issue.severity === "error" ? "✗" : "!";
    lines.push(`${symbol} [${issue.code}] ${issue.message}`);
  }
  return lines.join("\n");
}
