import type { CheerioAPI } from "cheerio";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type MaybePromise<T> = T | Promise<T>;

export type MigrationLogLevel = "debug" | "info" | "warn" | "error";

export type MigrationLogger = {
  log(level: MigrationLogLevel, message: string, details?: JsonObject): void;
};

export type SourceDocument = {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  fetchedAt: string;
  hash: string;
  headers: Record<string, string>;
};

export type SourceContext = {
  cwd: string;
  signal?: AbortSignal;
  logger: MigrationLogger;
};

export type SourceAdapter = {
  name: string;
  origin?: string;
  concurrency?: number;
  discover(context: SourceContext): Promise<string[]>;
  fetch(url: string, context: SourceContext): Promise<SourceDocument>;
};

export type RoutePattern = string | RegExp;

export type ExtractionContext = {
  document: SourceDocument;
  url: URL;
  params: Record<string, string>;
  $: CheerioAPI;
};

export type FieldProvenanceDescriptor = {
  kind: "selector" | "attribute" | "parameter" | "url" | "constant" | "computed";
  selector?: string;
  attribute?: string;
  parameter?: string;
  note?: string;
};

export type FieldDefinition<T extends JsonValue = JsonValue> = {
  readonly field: true;
  readonly provenance: FieldProvenanceDescriptor;
  read(context: ExtractionContext): MaybePromise<T>;
};

export type FieldMap = Record<string, FieldDefinition<JsonValue>>;

export type InferFieldMap<TFields extends FieldMap> = {
  [TKey in keyof TFields]: Awaited<ReturnType<TFields[TKey]["read"]>>;
};

export type EntityRoute<TFields extends JsonObject = JsonObject> =
  | string
  | ((context: ExtractionContext, fields: TFields) => MaybePromise<string | null>);

export type EntityId<TFields extends JsonObject = JsonObject> =
  | FieldDefinition<string | null>
  | ((context: ExtractionContext, fields: TFields) => MaybePromise<string>);

export type EntityDefinition<TFields extends JsonObject = JsonObject> = {
  type: string;
  match: RoutePattern;
  fields?: FieldMap;
  extract?: (context: ExtractionContext) => MaybePromise<TFields | null>;
  id: EntityId<TFields>;
  route?: EntityRoute<TFields>;
  assetFields?: string[];
  include?: (context: ExtractionContext, fields: TFields) => MaybePromise<boolean>;
};

export type OutputConfig = {
  root?: string;
  raw?: string;
  generated?: string;
  resolved?: string;
  overrides?: string;
  state?: string;
};

export type CheckConfig = {
  allowEmpty?: boolean;
  requireHttps?: boolean;
  requireMatchedRoutes?: boolean;
  maxRemoved?: number;
  maxRemovedRatio?: number;
  failOnWarnings?: boolean;
};

export type MigrationConfig = {
  name: string;
  source: SourceAdapter;
  entities: EntityDefinition<any>[];
  output?: OutputConfig;
  checks?: CheckConfig;
};

export type FieldProvenance = FieldProvenanceDescriptor & {
  sourceUrl: string;
  fetchedAt: string;
};

export type EntityRecord = {
  type: string;
  id: string;
  sourceUrl: string;
  sourceHash: string;
  route: string | null;
  status: "active" | "archived";
  fields: JsonObject;
  provenance: Record<string, FieldProvenance>;
};

export type RouteRecord = {
  sourcePath: string;
  targetPath: string;
  status: "active" | "archived" | "redirected";
  entity: {
    type: string;
    id: string;
  };
};

export type AssetRecord = {
  url: string;
  sourceUrl: string;
  entity: {
    type: string;
    id: string;
    field: string;
  };
};

export type SnapshotDocument = {
  url: string;
  status: number;
  contentType: string | null;
  hash: string;
  fetchedAt: string;
  matched: boolean;
};

export type MigrationSnapshot = {
  schemaVersion: 1;
  layer: "generated" | "resolved";
  migration: string;
  generatedAt: string;
  fingerprint: string;
  source: {
    adapter: string;
    origin: string | null;
    documentCount: number;
  };
  documents: SnapshotDocument[];
  entities: EntityRecord[];
  routes: RouteRecord[];
  assets: AssetRecord[];
};

export type RawPageRecord = Omit<SourceDocument, "body"> & {
  file: string;
};

export type RawManifest = {
  schemaVersion: 1;
  migration: string;
  createdAt: string;
  source: string;
  pages: RawPageRecord[];
};

export type EntityOverride = {
  fields?: JsonObject;
  route?: string | null;
  status?: "active" | "archived";
  remove?: boolean;
  create?: {
    sourceUrl?: string;
    route?: string | null;
    status?: "active" | "archived";
    fields: JsonObject;
  };
};

export type OverrideSet = Record<string, Record<string, EntityOverride>>;

export type ValueChange = {
  path: string;
  before?: JsonValue;
  after?: JsonValue;
};

export type EntityChange = {
  kind: "added" | "removed" | "changed";
  type: string;
  id: string;
  sourceUrl?: string;
  changes: ValueChange[];
};

export type MigrationDiff = {
  generatedAt: string;
  previousFingerprint: string | null;
  currentFingerprint: string;
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
  entities: EntityChange[];
};

export type CheckSeverity = "error" | "warning";

export type CheckIssue = {
  severity: CheckSeverity;
  code: string;
  message: string;
  entity?: {
    type: string;
    id: string;
  };
  path?: string;
};

export type CheckReport = {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: CheckIssue[];
};

export type ResolvedOutputPaths = {
  root: string;
  raw: string;
  generated: string;
  resolved: string;
  overrides: string;
  state: string;
};

export type PullResult = {
  documents: SourceDocument[];
  rawDirectory: string;
  manifest: RawManifest;
};

export type SyncResult = {
  generated: MigrationSnapshot;
  resolved: MigrationSnapshot;
  previous: MigrationSnapshot | null;
  diff: MigrationDiff;
  checks: CheckReport;
  paths: ResolvedOutputPaths;
  rawDirectory: string;
};
