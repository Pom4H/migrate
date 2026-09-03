import type { RoutePattern } from "./types.js";
import { normalizePathname } from "./util.js";

export type RouteMatch = {
  params: Record<string, string>;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function compilePattern(pattern: RoutePattern): (pathname: string) => RouteMatch | null {
  if (pattern instanceof RegExp) {
    const flags = pattern.flags.replace(/[gy]/g, "");
    const expression = new RegExp(pattern.source, flags);
    return (pathname) => {
      const match = expression.exec(normalizePathname(pathname));
      if (!match) return null;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(match.groups ?? {})) {
        if (value !== undefined) params[key] = decode(value);
      }
      return { params };
    };
  }

  const normalized = normalizePathname(pattern);
  const names: string[] = [];
  const segments = normalized.split("/").map((segment) => {
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!name) throw new Error(`Invalid route pattern: ${pattern}`);
      names.push(name);
      return "([^/]+)";
    }
    if (segment.startsWith("*")) {
      const name = segment.slice(1) || "wildcard";
      names.push(name);
      return "(.+)";
    }
    return escapeRegExp(segment);
  });
  const expression = new RegExp(`^${segments.join("\\/")}\\/?$`);

  return (pathname) => {
    const match = expression.exec(normalizePathname(pathname));
    if (!match) return null;
    const params: Record<string, string> = {};
    for (let index = 0; index < names.length; index++) {
      const value = match[index + 1];
      if (value !== undefined) params[names[index]!] = decode(value);
    }
    return { params };
  };
}

export function renderPattern(pattern: string, params: Record<string, string>): string {
  const rendered = pattern.replace(/([:*])([A-Za-z0-9_]+)/g, (_, prefix: string, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing route parameter \"${name}\" for ${pattern}`);
    return prefix === "*"
      ? value.split("/").map(encodeURIComponent).join("/")
      : encodeURIComponent(value);
  });
  return normalizePathname(rendered);
}
