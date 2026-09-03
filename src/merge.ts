import { fingerprintSnapshot } from "./extract.js";
import type {
  EntityOverride,
  EntityRecord,
  JsonObject,
  JsonValue,
  MigrationSnapshot,
  OverrideSet,
  RouteRecord,
} from "./types.js";
import { deepClone, isPlainObject, normalizePathname, toJsonObject } from "./util.js";

const keyOf = (type: string, id: string) => `${type}:${id}`;

export function mergeJson(base: JsonObject, patch: JsonObject): JsonObject {
  const result = deepClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (
      value !== null &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      current !== null &&
      !Array.isArray(current) &&
      typeof current === "object"
    ) {
      result[key] = mergeJson(current, value);
    } else {
      result[key] = deepClone(value);
    }
  }
  return result;
}

function applyOverride(entity: EntityRecord, override: EntityOverride, generatedAt: string): EntityRecord {
  const fields = override.fields ? mergeJson(entity.fields, toJsonObject(override.fields)) : entity.fields;
  const provenance = { ...entity.provenance };
  for (const name of Object.keys(override.fields ?? {})) {
    provenance[name] = {
      kind: "computed",
      note: "override",
      sourceUrl: `override://${entity.type}/${entity.id}`,
      fetchedAt: generatedAt,
    };
  }
  return {
    ...entity,
    fields,
    route: override.route === undefined ? entity.route : override.route,
    status: override.status ?? entity.status,
    provenance,
  };
}

function createEntity(type: string, id: string, override: EntityOverride, generatedAt: string): EntityRecord | null {
  if (!override.create) return null;
  const fields = toJsonObject(override.create.fields, `${type}.${id}.create.fields`);
  return {
    type,
    id,
    sourceUrl: override.create.sourceUrl ?? `override://${type}/${id}`,
    sourceHash: "override",
    route: override.route ?? override.create.route ?? null,
    status: override.status ?? override.create.status ?? "active",
    fields,
    provenance: Object.fromEntries(
      Object.keys(fields).map((name) => [
        name,
        {
          kind: "computed" as const,
          note: "override-created entity",
          sourceUrl: `override://${type}/${id}`,
          fetchedAt: generatedAt,
        },
      ]),
    ),
  };
}

function rebuildRoutes(generated: MigrationSnapshot, entities: EntityRecord[]): RouteRecord[] {
  const generatedByEntity = new Map(
    generated.routes.map((route) => [keyOf(route.entity.type, route.entity.id), route]),
  );
  const routes: RouteRecord[] = [];

  for (const entity of entities) {
    if (!entity.route) continue;
    const original = generatedByEntity.get(keyOf(entity.type, entity.id));
    routes.push({
      sourcePath: original?.sourcePath ?? normalizePathname(new URL(entity.sourceUrl, "https://override.invalid").pathname),
      targetPath: normalizePathname(entity.route),
      status: entity.status,
      entity: { type: entity.type, id: entity.id },
    });
  }
  return routes.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
}

export function findOrphanOverrides(snapshot: MigrationSnapshot, overrides: OverrideSet): string[] {
  const known = new Set(snapshot.entities.map((entity) => keyOf(entity.type, entity.id)));
  const orphans: string[] = [];
  for (const [type, entries] of Object.entries(overrides)) {
    for (const [id, override] of Object.entries(entries)) {
      if (!known.has(keyOf(type, id)) && !override.create) orphans.push(keyOf(type, id));
    }
  }
  return orphans.sort();
}

export async function resolveSnapshot(
  generated: MigrationSnapshot,
  overrides: OverrideSet,
): Promise<MigrationSnapshot> {
  const entities: EntityRecord[] = [];
  const visited = new Set<string>();

  for (const entity of generated.entities) {
    const key = keyOf(entity.type, entity.id);
    visited.add(key);
    const override = overrides[entity.type]?.[entity.id];
    if (override?.remove) continue;
    entities.push(override ? applyOverride(entity, override, generated.generatedAt) : deepClone(entity));
  }

  for (const [type, entries] of Object.entries(overrides)) {
    for (const [id, override] of Object.entries(entries)) {
      if (visited.has(keyOf(type, id)) || override.remove) continue;
      const created = createEntity(type, id, override, generated.generatedAt);
      if (created) entities.push(created);
    }
  }

  entities.sort((left, right) => keyOf(left.type, left.id).localeCompare(keyOf(right.type, right.id)));
  const withoutFingerprint: Omit<MigrationSnapshot, "fingerprint"> = {
    ...generated,
    layer: "resolved",
    entities,
    routes: rebuildRoutes(generated, entities),
  };

  return {
    ...withoutFingerprint,
    fingerprint: await fingerprintSnapshot(withoutFingerprint),
  };
}

export function isOverrideSet(value: unknown): value is OverrideSet {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(
    (entries) =>
      isPlainObject(entries) &&
      Object.values(entries).every((entry) => isPlainObject(entry)),
  );
}

export function overlayValue(base: JsonValue, patch: JsonValue): JsonValue {
  if (
    base !== null &&
    patch !== null &&
    isPlainObject(base) &&
    isPlainObject(patch)
  ) {
    return mergeJson(base as JsonObject, patch as JsonObject);
  }
  return deepClone(patch);
}
