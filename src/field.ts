import type {
  ExtractionContext,
  FieldDefinition,
  FieldProvenanceDescriptor,
  JsonValue,
  MaybePromise,
} from "./types.js";
import { toJsonValue } from "./util.js";

const cleanText = (value: string) => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

function definition<T extends JsonValue>(
  provenance: FieldProvenanceDescriptor,
  read: (context: ExtractionContext) => MaybePromise<T>,
): FieldDefinition<T> {
  return { field: true, provenance, read };
}

function requiredValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined || value === "") {
    throw new Error(`Required field is missing: ${label}`);
  }
  return value;
}

function absoluteUrl(value: string, base: URL): string {
  return new URL(value, base).href;
}

function parseNumber(value: string): number | null {
  const compact = value.replace(/\u00a0/g, " ").replace(/\s+/g, "").replace(/[^0-9,.-]/g, "");
  if (!compact) return null;

  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  const separator = Math.max(comma, dot);
  let normalized = compact;

  if (separator >= 0) {
    const decimals = compact.length - separator - 1;
    if (decimals > 0 && decimals <= 2) {
      normalized = `${compact.slice(0, separator).replace(/[.,]/g, "")}.${compact.slice(separator + 1)}`;
    } else {
      normalized = compact.replace(/[.,]/g, "");
    }
  }

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export type TextFieldOptions = {
  required?: boolean;
  preserveWhitespace?: boolean;
};

export type AttributeFieldOptions = {
  required?: boolean;
  absolute?: boolean;
};

export const field = {
  text(selector: string, options: TextFieldOptions = {}): FieldDefinition<string | null> {
    return definition({ kind: "selector", selector }, ({ $ }) => {
      const node = $(selector).first();
      const raw = node.length ? node.text() : null;
      const value = raw === null ? null : options.preserveWhitespace ? raw.trim() : cleanText(raw);
      return options.required === false ? value || null : requiredValue(value, selector);
    });
  },

  html(selector: string, options: { required?: boolean } = {}): FieldDefinition<string | null> {
    return definition({ kind: "selector", selector, note: "innerHTML" }, ({ $ }) => {
      const node = $(selector).first();
      const value = node.length ? node.html()?.trim() || null : null;
      return options.required === false ? value : requiredValue(value, selector);
    });
  },

  attr(
    selector: string,
    attribute: string,
    options: AttributeFieldOptions = {},
  ): FieldDefinition<string | null> {
    return definition({ kind: "attribute", selector, attribute }, (context) => {
      const value = context.$(selector).first().attr(attribute)?.trim() || null;
      const resolved = value && options.absolute ? absoluteUrl(value, context.url) : value;
      return options.required === false
        ? resolved
        : requiredValue(resolved, `${selector}[${attribute}]`);
    });
  },

  url(
    selector: string,
    attribute = "href",
    options: { required?: boolean } = {},
  ): FieldDefinition<string | null> {
    return field.attr(selector, attribute, { ...options, absolute: true });
  },

  image(selector: string, options: { required?: boolean } = {}): FieldDefinition<string | null> {
    return field.attr(selector, "src", { ...options, absolute: true });
  },

  list(
    selector: string,
    options: { attribute?: string; absolute?: boolean; unique?: boolean } = {},
  ): FieldDefinition<string[]> {
    const provenance: FieldProvenanceDescriptor = options.attribute
      ? { kind: "attribute", selector, attribute: options.attribute }
      : { kind: "selector", selector };

    return definition(provenance, (context) => {
      const values = context
        .$(selector)
        .map((_, element) => {
          const node = context.$(element);
          const raw = options.attribute ? node.attr(options.attribute) : node.text();
          const value = cleanText(raw ?? "");
          if (!value) return null;
          return options.absolute ? absoluteUrl(value, context.url) : value;
        })
        .get()
        .filter((value): value is string => Boolean(value));
      return options.unique === false ? values : [...new Set(values)];
    });
  },

  number(selector: string, options: { required?: boolean } = {}): FieldDefinition<number | null> {
    return definition({ kind: "selector", selector, note: "number" }, ({ $ }) => {
      const value = parseNumber(cleanText($(selector).first().text()));
      return options.required === false ? value : requiredValue(value, selector);
    });
  },

  money(selector: string, options: { required?: boolean } = {}): FieldDefinition<number | null> {
    return definition({ kind: "selector", selector, note: "money" }, ({ $ }) => {
      const value = parseNumber(cleanText($(selector).first().text()));
      return options.required === false ? value : requiredValue(value, selector);
    });
  },

  param(name: string, options: { required?: boolean } = {}): FieldDefinition<string | null> {
    return definition({ kind: "parameter", parameter: name }, ({ params }) => {
      const value = params[name] ?? null;
      return options.required === false ? value : requiredValue(value, `:${name}`);
    });
  },

  pathname(): FieldDefinition<string> {
    return definition({ kind: "url", note: "pathname" }, ({ url }) => url.pathname);
  },

  sourceUrl(): FieldDefinition<string> {
    return definition({ kind: "url", note: "source URL" }, ({ url }) => url.href);
  },

  constant<T extends JsonValue>(value: T): FieldDefinition<T> {
    return definition({ kind: "constant" }, () => value);
  },

  custom<T extends JsonValue>(
    read: (context: ExtractionContext) => MaybePromise<T>,
    note = "custom extractor",
  ): FieldDefinition<T> {
    return definition({ kind: "computed", note }, read);
  },

  map<T extends JsonValue, TResult extends JsonValue>(
    source: FieldDefinition<T>,
    transform: (value: T, context: ExtractionContext) => MaybePromise<TResult>,
    note = "mapped field",
  ): FieldDefinition<TResult> {
    return definition({ kind: "computed", note }, async (context) => {
      const value = await source.read(context);
      return transform(value, context);
    });
  },

  optional<T extends JsonValue>(source: FieldDefinition<T>): FieldDefinition<T | null> {
    return definition(source.provenance, async (context) => {
      try {
        const value = await source.read(context);
        return value ?? null;
      } catch {
        return null;
      }
    });
  },

  json<T extends JsonValue>(
    selector = 'script[type="application/ld+json"]',
    options: { required?: boolean } = {},
  ): FieldDefinition<T | null> {
    return definition({ kind: "selector", selector, note: "JSON" }, ({ $ }) => {
      const raw = $(selector).first().text().trim();
      if (!raw) return options.required === false ? null : requiredValue<T>(null, selector);
      return toJsonValue(JSON.parse(raw), selector) as T;
    });
  },
};

export type Field = typeof field;
