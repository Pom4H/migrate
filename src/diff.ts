import type {
  EntityChange,
  EntityRecord,
  JsonObject,
  JsonValue,
  MigrationDiff,
  MigrationSnapshot,
  ValueChange,
} from "./types.js";
import { stableStringify, toJsonValue } from "./util.js";

const keyOf = (entity: Pick<EntityRecord, "type" | "id">) => `${entity.type}:${entity.id}`;

function equal(left: JsonValue, right: JsonValue): boolean {
  return stableStringify(left, 0) === stableStringify(right, 0);
}

function entityValue(entity: EntityRecord): JsonObject {
  return {
    route: entity.route,
    status: entity.status,
    fields: entity.fields,
  };
}

function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

export function diffValues(before: JsonValue, after: JsonValue, path = ""): ValueChange[] {
  if (equal(before, after)) return [];

  const beforeObject = before !== null && !Array.isArray(before) && typeof before === "object";
  const afterObject = after !== null && !Array.isArray(after) && typeof after === "object";
  if (!beforeObject || !afterObject) return [{ path, before, after }];

  const changes: ValueChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const hasBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    const nextPath = joinPath(path, key);
    if (!hasBefore) {
      changes.push({ path: nextPath, after: after[key]! });
    } else if (!hasAfter) {
      changes.push({ path: nextPath, before: before[key]! });
    } else {
      changes.push(...diffValues(before[key]!, after[key]!, nextPath));
    }
  }
  return changes;
}

export function diffSnapshots(
  previous: MigrationSnapshot | null,
  current: MigrationSnapshot,
): MigrationDiff {
  const previousMap = new Map((previous?.entities ?? []).map((entity) => [keyOf(entity), entity]));
  const currentMap = new Map(current.entities.map((entity) => [keyOf(entity), entity]));
  const changes: EntityChange[] = [];
  let unchanged = 0;

  for (const entity of current.entities) {
    const key = keyOf(entity);
    const before = previousMap.get(key);
    if (!before) {
      changes.push({
        kind: "added",
        type: entity.type,
        id: entity.id,
        sourceUrl: entity.sourceUrl,
        changes: [{ path: "", after: entityValue(entity) }],
      });
      continue;
    }

    const fieldChanges = diffValues(entityValue(before), entityValue(entity));
    if (fieldChanges.length === 0) unchanged++;
    else {
      changes.push({
        kind: "changed",
        type: entity.type,
        id: entity.id,
        sourceUrl: entity.sourceUrl,
        changes: fieldChanges,
      });
    }
  }

  for (const entity of previous?.entities ?? []) {
    if (currentMap.has(keyOf(entity))) continue;
    changes.push({
      kind: "removed",
      type: entity.type,
      id: entity.id,
      sourceUrl: entity.sourceUrl,
      changes: [{ path: "", before: entityValue(entity) }],
    });
  }

  const order = { added: 0, changed: 1, removed: 2 } as const;
  changes.sort((left, right) => {
    const kind = order[left.kind] - order[right.kind];
    return kind || `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`);
  });

  return {
    generatedAt: new Date().toISOString(),
    previousFingerprint: previous?.fingerprint ?? null,
    currentFingerprint: current.fingerprint,
    summary: {
      added: changes.filter((change) => change.kind === "added").length,
      removed: changes.filter((change) => change.kind === "removed").length,
      changed: changes.filter((change) => change.kind === "changed").length,
      unchanged,
    },
    entities: changes,
  };
}

function inline(value: JsonValue | undefined): string {
  if (value === undefined) return "∅";
  const text = JSON.stringify(toJsonValue(value));
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

export function formatDiff(diff: MigrationDiff): string {
  const { added, changed, removed, unchanged } = diff.summary;
  const lines = [
    `Source diff: +${added} ~${changed} -${removed} (${unchanged} unchanged)`,
  ];

  for (const entity of diff.entities) {
    const symbol = entity.kind === "added" ? "+" : entity.kind === "removed" ? "-" : "~";
    lines.push(`${symbol} ${entity.type} ${entity.id}`);
    if (entity.kind !== "changed") continue;
    for (const change of entity.changes) {
      lines.push(`    ${change.path}: ${inline(change.before)} → ${inline(change.after)}`);
    }
  }
  return lines.join("\n");
}
