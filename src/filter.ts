import { formatSize, formatDurationSec, formatStartTimeSec, formatTimings } from "./format";
import { IndexedEntry } from "./har";
import {
  ALL_RESOURCE_TYPES,
  FilterOptions,
  HeaderEntry,
  HeadersResponse,
  ListResponse,
  ListRow,
  ResourceType,
  ResponseDetailResponse,
  SearchType,
} from "./types";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_SEARCH_TYPES: SearchType[] = ["url", "header", "response"];

function matchDomain(entry: IndexedEntry, domain: string): boolean {
  if (!domain) return true;
  const d = domain.toLowerCase();
  return entry.host.toLowerCase().includes(d);
}

function matchType(entry: IndexedEntry, types: ResourceType[] | "all" | undefined): boolean {
  if (!types) return entry.type === "Fetch/XHR";
  if (types === "all") return true;
  return types.includes(entry.type);
}

function matchTimeRange(
  entry: IndexedEntry,
  range: FilterOptions["timeRange"],
): boolean {
  if (!range) return true;
  const startSec = entry.startMs / 1000;
  if (range.startSec !== undefined && startSec < range.startSec) return false;
  if (range.endSec !== undefined && startSec > range.endSec) return false;
  return true;
}

function matchStatus(entry: IndexedEntry, code?: string): boolean {
  if (!code) return true;
  if (entry.status === null) return false;
  const s = String(entry.status);
  if (code.endsWith("xx") && code.length === 3) {
    return s.startsWith(code[0]);
  }
  if (code.includes(",")) {
    return code.split(",").map((x) => x.trim()).includes(s);
  }
  if (code.includes("-")) {
    const [lo, hi] = code.split("-").map((x) => parseInt(x.trim(), 10));
    return entry.status >= lo && entry.status <= hi;
  }
  return s === code;
}

type KeywordMatcher = (text: string | null | undefined) => boolean;

function buildMatcher(keyword: string, regex: boolean): KeywordMatcher {
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(keyword, "i");
    } catch (e) {
      throw new Error(
        `invalid --regex pattern "${keyword}": ${(e as Error).message}`,
      );
    }
    return (s) => (s ? re.test(s) : false);
  }
  const terms = keyword
    .split("|")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (terms.length === 0) {
    return () => false;
  }
  return (s) => {
    if (!s) return false;
    const lower = s.toLowerCase();
    for (const t of terms) if (lower.includes(t)) return true;
    return false;
  };
}

function searchInUrl(entry: IndexedEntry, match: KeywordMatcher): boolean {
  return match(entry.url);
}

function searchInHeaders(entry: IndexedEntry, match: KeywordMatcher): boolean {
  const reqH = entry.raw.request?.headers ?? [];
  const resH = entry.raw.response?.headers ?? [];
  for (const h of reqH) {
    if (match(h.name) || match(h.value)) return true;
  }
  for (const h of resH) {
    if (match(h.name) || match(h.value)) return true;
  }
  return false;
}

function searchInResponse(entry: IndexedEntry, match: KeywordMatcher): boolean {
  return match(entry.raw.response?.content?.text);
}

function applyKeyword(
  entry: IndexedEntry,
  match: KeywordMatcher,
  searchTypes: SearchType[],
): { match: boolean; hits: SearchType[] } {
  const hits: SearchType[] = [];
  if (searchTypes.includes("url") && searchInUrl(entry, match)) hits.push("url");
  if (searchTypes.includes("header") && searchInHeaders(entry, match)) hits.push("header");
  if (searchTypes.includes("response") && searchInResponse(entry, match)) hits.push("response");
  return { match: hits.length > 0, hits };
}

function toRow(
  entry: IndexedEntry,
  hit?: SearchType[],
  showHitReason?: boolean,
): ListRow {
  const rawMime = entry.raw.response?.content?.mimeType ?? "";
  const contentType = rawMime ? rawMime.split(";")[0].trim() : "-";

  const row: ListRow = {
    id: entry.id,
    method: entry.method || "-",
    url: entry.url,
    type: entry.type,
    content_type: contentType || "-",
    status: entry.status,
    size: formatSize(entry.size),
    duration: formatDurationSec(entry.durationMs),
    start_time: formatStartTimeSec(entry.startMs),
    timings: formatTimings(entry.raw.timings),
  };
  if (showHitReason && hit && hit.length > 0) {
    row.hit_reason = hit;
  }
  return row;
}

export function listEntries(
  entries: IndexedEntry[],
  opts: FilterOptions,
): ListResponse {
  const page = opts.page && opts.page > 0 ? opts.page : 1;
  const pageSize = opts.pageSize && opts.pageSize > 0 ? opts.pageSize : DEFAULT_PAGE_SIZE;
  const searchTypes =
    opts.keyword && opts.searchTypes && opts.searchTypes.length > 0
      ? opts.searchTypes
      : DEFAULT_SEARCH_TYPES;
  const showHitReason = !!opts.keyword && searchTypes.length > 1;

  const matcher = opts.keyword
    ? buildMatcher(opts.keyword, !!opts.keywordRegex)
    : null;

  const idSet = opts.ids && opts.ids.length > 0 ? new Set(opts.ids) : null;

  const matched: Array<{ entry: IndexedEntry; hits: SearchType[] }> = [];
  for (const entry of entries) {
    if (idSet && !idSet.has(entry.id)) continue;
    if (!matchDomain(entry, opts.domain ?? "")) continue;
    if (!matchType(entry, opts.types)) continue;
    if (!matchTimeRange(entry, opts.timeRange)) continue;
    if (!matchStatus(entry, opts.statusCode)) continue;
    let hits: SearchType[] = [];
    if (matcher) {
      const r = applyKeyword(entry, matcher, searchTypes);
      if (!r.match) continue;
      hits = r.hits;
    }
    matched.push({ entry, hits });
  }

  const total = matched.length;
  const startIdx = (page - 1) * pageSize;
  const endIdx = startIdx + pageSize;
  const slice = matched.slice(startIdx, endIdx);
  const rows = slice.map((m) => toRow(m.entry, m.hits, showHitReason));
  const shown = rows.length;
  const hidden = Math.max(0, total - endIdx) + Math.max(0, startIdx);

  const result: ListResponse = {
    total_matched: total,
    page,
    page_size: pageSize,
    shown,
    hidden,
    rows,
  };

  if (hidden > 0) {
    const totalPages = Math.ceil(total / pageSize);
    const remainingAfter = Math.max(0, total - endIdx);
    const parts: string[] = [];
    if (remainingAfter > 0) {
      parts.push(
        `${remainingAfter} more entries hidden. Use page=${page + 1} (of ${totalPages}) to fetch the next page, or apply tighter filters (domain/type/status/time-range/keyword).`,
      );
    } else if (startIdx > 0) {
      parts.push(`Showing page ${page} of ${totalPages}.`);
    }
    result.hint = parts.join(" ");
  }
  return result;
}

export function getEntryById(
  entries: IndexedEntry[],
  id: number,
): IndexedEntry | undefined {
  return entries.find((e) => e.id === id);
}

function normalizeHeaderEntries(
  headers: Array<{ name: string; value: string }> | undefined,
): HeaderEntry[] {
  if (!headers) return [];
  return headers.map((h) => ({ name: h.name, value: h.value }));
}

export function getHeaders(
  entry: IndexedEntry,
  opts: { full?: boolean; key?: string },
): HeadersResponse {
  const reqHeaders = normalizeHeaderEntries(entry.raw.request?.headers);
  const resHeaders = normalizeHeaderEntries(entry.raw.response?.headers);

  const base: HeadersResponse = {
    id: entry.id,
    url: entry.url,
    method: entry.method,
    status: entry.status,
    request_headers: reqHeaders,
    response_headers: resHeaders,
  };

  if (opts.key) {
    const key = opts.key.toLowerCase();
    const findVal = (list: HeaderEntry[]): string | null => {
      const found = list.find((h) => h.name.toLowerCase() === key);
      return found ? found.value : null;
    };
    base.request_headers = findVal(reqHeaders);
    base.response_headers = findVal(resHeaders);
    return base;
  }

  if (opts.full) {
    return base;
  }

  base.request_headers = reqHeaders.map((h) => h.name);
  base.response_headers = resHeaders.map((h) => h.name);
  return base;
}

export function getResponse(entry: IndexedEntry): ResponseDetailResponse {
  const content = entry.raw.response?.content ?? {};
  const text = content.text ?? null;
  const encoding = content.encoding ?? null;

  let parsedJson: unknown = undefined;
  if (text && content.mimeType && /json/i.test(content.mimeType)) {
    try {
      parsedJson = JSON.parse(text);
    } catch {
      parsedJson = undefined;
    }
  }

  return {
    id: entry.id,
    url: entry.url,
    method: entry.method,
    status: entry.status,
    status_text: entry.raw.response?.statusText ?? null,
    mime_type: content.mimeType ?? null,
    size_bytes: typeof content.size === "number" ? content.size : 0,
    encoding,
    text,
    json: parsedJson,
  };
}

export { ALL_RESOURCE_TYPES, DEFAULT_PAGE_SIZE, DEFAULT_SEARCH_TYPES };
