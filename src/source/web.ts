import { load } from "cheerio";
import type { SourceAdapter, SourceContext, SourceDocument } from "../types.js";
import { normalizePathname, sha256, uniqueSorted } from "../util.js";

export type DiscoveryMode = "sitemap" | "links";
export type UrlRule = string | RegExp | ((url: URL) => boolean);

export type WebsiteOptions = {
  discover?: DiscoveryMode[];
  routes?: string[];
  sitemapPaths?: string[];
  include?: UrlRule[];
  exclude?: UrlRule[];
  maxPages?: number;
  concurrency?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  userAgent?: string;
};

const DEFAULT_USER_AGENT = "Migrate/0.1 (+https://github.com/Pom4H/migrate)";

const decodeXml = (value: string) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const extractLocations = (xml: string): string[] =>
  [...xml.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeXml(match[1]?.trim() ?? ""))
    .filter(Boolean);

const globExpression = (pattern: string) => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${source}$`);
};

function matchesRule(url: URL, rule: UrlRule): boolean {
  if (typeof rule === "function") return rule(url);
  if (rule instanceof RegExp) {
    const expression = new RegExp(rule.source, rule.flags.replace(/[gy]/g, ""));
    return expression.test(url.pathname);
  }
  return globExpression(rule).test(normalizePathname(url.pathname));
}

function isAllowed(url: URL, origin: URL, options: WebsiteOptions): boolean {
  if (url.origin !== origin.origin) return false;
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (options.exclude?.some((rule) => matchesRule(url, rule))) return false;
  if (options.include?.length && !options.include.some((rule) => matchesRule(url, rule))) return false;
  return true;
}

function canonical(value: string | URL, origin: URL): string | null {
  try {
    const url = new URL(value, origin);
    url.hash = "";
    if (url.origin !== origin.origin) return null;
    url.pathname = normalizePathname(url.pathname);
    if (url.pathname !== "/" && !/\.[A-Za-z0-9]+$/.test(url.pathname)) url.pathname += "/";
    return url.href;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  url: string,
  context: SourceContext,
  options: WebsiteOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out: ${url}`)), options.timeoutMs ?? 20_000);
  const abort = () => controller.abort(context.signal?.reason);
  context.signal?.addEventListener("abort", abort, { once: true });

  try {
    return await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...options.headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener("abort", abort);
  }
}

export function website(originValue: string, options: WebsiteOptions = {}): SourceAdapter {
  const origin = new URL(originValue);
  if (!["http:", "https:"].includes(origin.protocol)) {
    throw new Error(`Website source must use HTTP or HTTPS: ${originValue}`);
  }
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";

  const cache = new Map<string, SourceDocument>();

  const read = async (url: string, context: SourceContext): Promise<SourceDocument> => {
    const known = cache.get(url);
    if (known) return known;

    context.logger.log("debug", `GET ${url}`);
    const response = await fetchWithTimeout(url, context, options);
    const body = await response.text();
    const headers = Object.fromEntries(response.headers.entries());
    const document: SourceDocument = {
      url: response.url || url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      body,
      fetchedAt: new Date().toISOString(),
      hash: await sha256(body),
      headers,
    };
    cache.set(url, document);
    if (document.url !== url) cache.set(document.url, document);
    return document;
  };

  const discoverSitemap = async (context: SourceContext): Promise<string[]> => {
    const sitemapQueue: string[] = [];
    const configured = options.sitemapPaths ?? [];
    for (const path of configured) {
      const url = canonical(path, origin);
      if (url) sitemapQueue.push(url);
    }

    try {
      const robotsUrl = new URL("/robots.txt", origin).href;
      const robots = await read(robotsUrl, context);
      for (const match of robots.body.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)) {
        const url = canonical(match[1]!, origin);
        if (url) sitemapQueue.push(url);
      }
    } catch (error) {
      context.logger.log("debug", "robots.txt discovery failed", { error: String(error) });
    }

    if (sitemapQueue.length === 0) sitemapQueue.push(new URL("/sitemap.xml", origin).href);

    const pages = new Set<string>();
    const visited = new Set<string>();
    while (sitemapQueue.length && visited.size < 100) {
      const sitemapUrl = sitemapQueue.shift()!;
      if (visited.has(sitemapUrl)) continue;
      visited.add(sitemapUrl);

      let document: SourceDocument;
      try {
        document = await read(sitemapUrl, context);
      } catch (error) {
        context.logger.log("warn", `Could not read sitemap ${sitemapUrl}`, { error: String(error) });
        continue;
      }
      if (document.status >= 400) continue;

      const isIndex = /<sitemapindex[\s>]/i.test(document.body);
      for (const location of extractLocations(document.body)) {
        const url = canonical(location, origin);
        if (!url) continue;
        if (isIndex || /\.xml\/?(?:\?|$)/i.test(new URL(url).pathname)) sitemapQueue.push(url);
        else if (isAllowed(new URL(url), origin, options)) pages.add(url);
      }
    }
    return [...pages];
  };

  const discoverLinks = async (context: SourceContext, seeds: string[]): Promise<string[]> => {
    const maxPages = options.maxPages ?? 5_000;
    const queue = uniqueSorted([origin.href, ...seeds]);
    const visited = new Set<string>();
    const pages = new Set<string>();

    while (queue.length && visited.size < maxPages) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      let document: SourceDocument;
      try {
        document = await read(url, context);
      } catch (error) {
        context.logger.log("warn", `Could not crawl ${url}`, { error: String(error) });
        continue;
      }
      if (document.status >= 400 || !document.contentType?.includes("html")) continue;
      if (isAllowed(new URL(url), origin, options)) pages.add(url);

      const $ = load(document.body);
      const crawlOptions: WebsiteOptions = { ...options };
      delete crawlOptions.include;
      $("a[href]").each((_, element) => {
        const href = $(element).attr("href");
        if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) return;
        const next = canonical(href, origin);
        if (!next) return;
        const parsed = new URL(next);
        if (!isAllowed(parsed, origin, crawlOptions)) return;
        if (!visited.has(next) && !queue.includes(next)) queue.push(next);
      });
    }
    return [...pages];
  };

  return {
    name: "website",
    origin: origin.origin,
    concurrency: options.concurrency ?? 6,

    async discover(context) {
      const explicit = (options.routes ?? [])
        .map((route) => canonical(route, origin))
        .filter((value): value is string => Boolean(value))
        .filter((url) => isAllowed(new URL(url), origin, options));
      const modes = options.discover ?? ["sitemap"];
      const found = new Set(explicit);

      if (modes.includes("sitemap")) {
        for (const url of await discoverSitemap(context)) found.add(url);
      }
      if (modes.includes("links")) {
        for (const url of await discoverLinks(context, [...found])) found.add(url);
      }
      if (found.size === 0 && isAllowed(origin, origin, options)) found.add(origin.href);

      const urls = uniqueSorted(found);
      if (urls.length > (options.maxPages ?? 5_000)) {
        throw new Error(`Discovery exceeded maxPages (${options.maxPages ?? 5_000})`);
      }
      context.logger.log("info", `Discovered ${urls.length} source routes`);
      return urls;
    },

    fetch: read,
  };
}
