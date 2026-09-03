export { defineMigration, defineOverrides, entity } from "./dsl.js";
export { field } from "./field.js";
export { website } from "./source/web.js";
export type { DiscoveryMode, UrlRule, WebsiteOptions } from "./source/web.js";
export {
  checkCurrentMigration,
  consoleLogger,
  pullMigration,
  syncMigration,
} from "./engine.js";
export type { EngineOptions, SyncOptions } from "./engine.js";
export { checkMigration, formatCheckReport } from "./check.js";
export type { CheckInput } from "./check.js";
export { diffSnapshots, diffValues, formatDiff } from "./diff.js";
export { extractSnapshot, fingerprintSnapshot } from "./extract.js";
export { findOrphanOverrides, mergeJson, resolveSnapshot } from "./merge.js";
export { compilePattern, renderPattern } from "./pattern.js";
export {
  loadOverrides,
  readDiff,
  readSnapshotDirectory,
  resolveOutputPaths,
  writeRawSnapshot,
  writeSnapshotDirectory,
} from "./storage.js";
export { VERSION } from "./version.js";
export type {
  AssetRecord,
  CheckConfig,
  CheckIssue,
  CheckReport,
  CheckSeverity,
  EntityChange,
  EntityDefinition,
  EntityId,
  EntityOverride,
  EntityRecord,
  EntityRoute,
  ExtractionContext,
  FieldDefinition,
  FieldMap,
  FieldProvenance,
  FieldProvenanceDescriptor,
  InferFieldMap,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MaybePromise,
  MigrationConfig,
  MigrationDiff,
  MigrationLogger,
  MigrationSnapshot,
  OutputConfig,
  OverrideSet,
  PullResult,
  RawManifest,
  RawPageRecord,
  ResolvedOutputPaths,
  RoutePattern,
  RouteRecord,
  SnapshotDocument,
  SourceAdapter,
  SourceContext,
  SourceDocument,
  SyncResult,
  ValueChange,
} from "./types.js";
