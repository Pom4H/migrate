import { load } from "cheerio";
import { compilePattern, renderPattern } from "./pattern.js";
import type {
  AssetRecord,
  EntityDefinition,
  EntityRecord,
  ExtractionContext,
  FieldProvenance,
  JsonObject,
  JsonValue,
  MigrationConfig,
  MigrationLogger,
  MigrationSnapshot,
  RouteRecord,
  SourceDocument,
} from "./types.js";
import { normalizePathname, sha256, stableStringify, toJsonObject, toJsonValue } from "./util.js";

const entityKey = (type: string, id: string) => `${type}:${id}`;

function collectAssetUrls(value: JsonValue, base: URL): string[] {
  if (typeof value === "string") {
    try {
      const url = new URL(value, base);
      return [url.href];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectAssetUrls(item, base));
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((item) => collectAssetUrls(item, base));
  }
  return [];
}

async function extractFields(
  definition: EntityDefinition,
  context: ExtractionContext,
): Promise<{ fields: JsonObject; provenance: Record<string, FieldProvenance> } | null> {
  if (definition.extract) {
    const value = await definition.extract(context);
    if (value === null) return null;
    const fields = toJsonObject(value, `${definition.type}.extract`);
    const provenance = Object.fromEntries(
      Object.keys(fields).map((name) => [
        name,
        {
          kind: "computed" as const,
          note: "custom entity extractor",
          sourceUrl: context.document.url,
          fetchedAt: context.document.fetchedAt,
        },
      ]),
    );
    return { fields, provenance };
  }

  const fields: JsonObject = {};
  const provenance: Record<string, FieldProvenance> = {};
  for (const [name, field] of Object.entries(definition.fields ?? {})) {
    const value = await field.read(context);
    fields[name] = toJsonValue(value, `${definition.type}.${name}`);
    provenance[name] = {
      ...field.provenance,
      sourceUrl: context.document.url,
      fetchedAt: context.document.fetchedAt,
    };
  }
  return { fields, provenance };
}

async function extractId(
  definition: EntityDefinition,
  context: ExtractionContext,
  fields: JsonObject,
): Promise<string> {
  const raw =
    typeof definition.id === "function"
      ? await definition.id(context, fields)
      : await definition.id.read(context);
  const id = raw?.trim();
  if (!id) throw new Error(`Entity ${definition.type} produced an empty id at ${context.url.href}`);
  return id;
}

async function extractRoute(
  definition: EntityDefinition,
  context: ExtractionContext,
  fields: JsonObject,
): Promise<string | null> {
  if (!definition.route) return normalizePathname(context.url.pathname);
  const raw =
    typeof definition.route === "function"
      ? await definition.route(context, fields)
      : renderPattern(definition.route, context.params);
  return raw === null ? null : normalizePathname(raw);
}

/**
 * Fingerprints represent normalized domain state, not an HTTP observation.
 * Fetch timestamps, response hashes and provenance timestamps deliberately stay
 * out of the material so dynamic HTML does not manufacture source changes.
 */
export async function fingerprintSnapshot(snapshot: Omit<MigrationSnapshot, "fingerprint">): Promise<string> {
  const material = {
    schemaVersion: snapshot.schemaVersion,
    layer: snapshot.layer,
    migration: snapshot.migration,
    source: {
      adapter: snapshot.source.adapter,
      origin: snapshot.source.origin,
    },
    entities: snapshot.entities.map((entity) => ({
      type: entity.type,
      id: entity.id,
      route: entity.route,
      status: entity.status,
      fields: entity.fields,
    })),
    routes: snapshot.routes,
    assets: snapshot.assets,
  };
  return sha256(stableStringify(toJsonValue(material)));
}

export async function extractSnapshot(
  config: MigrationConfig,
  documents: SourceDocument[],
  logger: MigrationLogger,
): Promise<MigrationSnapshot> {
  const definitions = config.entities.map((definition) => ({
    definition,
    match: compilePattern(definition.match),
  }));
  const entities: EntityRecord[] = [];
  const routes: RouteRecord[] = [];
  const assets: AssetRecord[] = [];
  const matchedUrls = new Set<string>();

  for (const document of documents) {
    if (document.status >= 400 || !document.contentType?.includes("html")) continue;
    const url = new URL(document.url);
    const $ = load(document.body);

    for (const candidate of definitions) {
      const match = candidate.match(url.pathname);
      if (!match) continue;
      const context: ExtractionContext = { document, url, params: match.params, $ };

      try {
        const extracted = await extractFields(candidate.definition, context);
        if (!extracted) continue;
        if (
          candidate.definition.include &&
          !(await candidate.definition.include(context, extracted.fields))
        ) {
          continue;
        }

        const id = await extractId(candidate.definition, context, extracted.fields);
        const route = await extractRoute(candidate.definition, context, extracted.fields);
        const entity: EntityRecord = {
          type: candidate.definition.type,
          id,
          sourceUrl: document.url,
          sourceHash: document.hash,
          route,
          status: "active",
          fields: extracted.fields,
          provenance: extracted.provenance,
        };
        entities.push(entity);
        matchedUrls.add(document.url);

        if (route) {
          routes.push({
            sourcePath: normalizePathname(url.pathname),
            targetPath: route,
            status: "active",
            entity: { type: entity.type, id: entity.id },
          });
        }

        for (const fieldName of candidate.definition.assetFields ?? []) {
          const value = entity.fields[fieldName];
          if (value === undefined) continue;
          for (const assetUrl of collectAssetUrls(value, url)) {
            assets.push({
              url: assetUrl,
              sourceUrl: document.url,
              entity: { type: entity.type, id: entity.id, field: fieldName },
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to extract ${candidate.definition.type} from ${document.url}: ${message}`, {
          cause: error,
        });
      }
    }
  }

  entities.sort((left, right) => entityKey(left.type, left.id).localeCompare(entityKey(right.type, right.id)));
  routes.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  assets.sort((left, right) => `${left.url}:${entityKey(left.entity.type, left.entity.id)}`.localeCompare(
    `${right.url}:${entityKey(right.entity.type, right.entity.id)}`,
  ));

  const withoutFingerprint: Omit<MigrationSnapshot, "fingerprint"> = {
    schemaVersion: 1,
    layer: "generated",
    migration: config.name,
    generatedAt: new Date().toISOString(),
    source: {
      adapter: config.source.name,
      origin: config.source.origin ?? null,
      documentCount: documents.length,
    },
    documents: documents
      .map((document) => ({
        url: document.url,
        status: document.status,
        contentType: document.contentType,
        hash: document.hash,
        fetchedAt: document.fetchedAt,
        matched: matchedUrls.has(document.url),
      }))
      .sort((left, right) => left.url.localeCompare(right.url)),
    entities,
    routes,
    assets,
  };
  const snapshot: MigrationSnapshot = {
    ...withoutFingerprint,
    fingerprint: await fingerprintSnapshot(withoutFingerprint),
  };
  logger.log("info", `Extracted ${snapshot.entities.length} entities`);
  return snapshot;
}
