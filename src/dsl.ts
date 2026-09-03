import type {
  EntityDefinition,
  EntityId,
  EntityRoute,
  ExtractionContext,
  FieldMap,
  InferFieldMap,
  JsonObject,
  MaybePromise,
  MigrationConfig,
  OverrideSet,
  RoutePattern,
} from "./types.js";

export function defineMigration<const TConfig extends MigrationConfig>(config: TConfig): TConfig {
  if (!config.name.trim()) throw new Error("Migration name cannot be empty");
  if (config.entities.length === 0) throw new Error("At least one entity definition is required");

  const names = new Set<string>();
  for (const definition of config.entities) {
    if (!definition.type.trim()) throw new Error("Entity type cannot be empty");
    if (names.has(definition.type)) {
      throw new Error(`Entity type is defined more than once: ${definition.type}`);
    }
    names.add(definition.type);
  }

  return config;
}

type FieldsResult<TFields extends FieldMap> = InferFieldMap<TFields> & JsonObject;

type FieldEntityOptions<TFields extends FieldMap> = {
  match: RoutePattern;
  fields: TFields;
  id: EntityId<FieldsResult<TFields>>;
  route?: EntityRoute<FieldsResult<TFields>>;
  assetFields?: (keyof TFields & string)[];
  include?: (
    context: ExtractionContext,
    fields: FieldsResult<TFields>,
  ) => MaybePromise<boolean>;
};

type CustomEntityOptions<TFields extends JsonObject> = {
  match: RoutePattern;
  extract: (context: ExtractionContext) => MaybePromise<TFields | null>;
  id: EntityId<TFields>;
  route?: EntityRoute<TFields>;
  assetFields?: (keyof TFields & string)[];
  include?: (context: ExtractionContext, fields: TFields) => MaybePromise<boolean>;
};

export function entity<const TFields extends FieldMap>(
  type: string,
  options: FieldEntityOptions<TFields>,
): EntityDefinition<FieldsResult<TFields>>;
export function entity<const TFields extends JsonObject>(
  type: string,
  options: CustomEntityOptions<TFields>,
): EntityDefinition<TFields>;
export function entity(
  type: string,
  options: FieldEntityOptions<FieldMap> | CustomEntityOptions<JsonObject>,
): EntityDefinition {
  if (!type.trim()) throw new Error("Entity type cannot be empty");
  if (!("fields" in options) && !("extract" in options)) {
    throw new Error(`Entity ${type} needs either fields or extract`);
  }
  return { type, ...options } as EntityDefinition;
}

export function defineOverrides<const TOverrides extends OverrideSet>(
  overrides: TOverrides,
): TOverrides {
  return overrides;
}
