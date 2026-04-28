import { ResourceType } from "./types";

export interface RawHarEntry {
  startedDateTime?: string;
  time?: number;
  request?: {
    method?: string;
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    queryString?: Array<{ name: string; value: string }>;
    cookies?: Array<{ name: string; value: string }>;
    postData?: { mimeType?: string; text?: string };
    bodySize?: number;
    headersSize?: number;
  };
  response?: {
    status?: number;
    statusText?: string;
    headers?: Array<{ name: string; value: string }>;
    content?: {
      size?: number;
      mimeType?: string;
      text?: string;
      encoding?: string;
    };
    bodySize?: number;
    headersSize?: number;
    _transferSize?: number;
  };
  timings?: Record<string, number>;
  _resourceType?: string;
  _initiator?: unknown;
  _webSocketMessages?: unknown;
}

export interface IndexedEntry {
  id: number;
  url: string;
  host: string;
  method: string;
  status: number | null;
  type: ResourceType;
  size: number;
  durationMs: number;
  startMs: number;
  startedDateTime: string;
  raw: RawHarEntry;
}

export interface HarIndex {
  pageStartMs: number;
  entries: IndexedEntry[];
}

const MIME_TO_TYPE: Array<[RegExp, ResourceType]> = [
  [/^text\/html\b/i, "Doc"],
  [/^text\/css\b/i, "CSS"],
  [/javascript|ecmascript|application\/json/i, "JS"],
  [/^font\/|application\/font|application\/x-font|woff/i, "Font"],
  [/^image\//i, "Img"],
  [/^audio\/|^video\//i, "Media"],
  [/manifest\+json/i, "Manifest"],
  [/wasm/i, "Wasm"],
];

function classifyByExt(url: string): ResourceType | null {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* ignore */
  }
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "html":
    case "htm":
      return "Doc";
    case "css":
      return "CSS";
    case "js":
    case "mjs":
    case "cjs":
    case "json":
      return "JS";
    case "woff":
    case "woff2":
    case "ttf":
    case "otf":
    case "eot":
      return "Font";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
    case "ico":
    case "avif":
      return "Img";
    case "mp3":
    case "mp4":
    case "webm":
    case "ogg":
    case "wav":
    case "m3u8":
    case "ts":
      return "Media";
    case "wasm":
      return "Wasm";
    case "webmanifest":
      return "Manifest";
    default:
      return null;
  }
}

function classify(entry: RawHarEntry): ResourceType {
  const rt = (entry._resourceType ?? "").toLowerCase();
  if (rt) {
    if (rt === "xhr" || rt === "fetch") return "Fetch/XHR";
    if (rt === "document") return "Doc";
    if (rt === "stylesheet") return "CSS";
    if (rt === "script") return "JS";
    if (rt === "font") return "Font";
    if (rt === "image") return "Img";
    if (rt === "media") return "Media";
    if (rt === "manifest") return "Manifest";
    if (rt === "websocket" || rt === "eventsource") return "Socket";
    if (rt === "wasm") return "Wasm";
    if (rt === "other") return "Other";
  }

  if (entry._webSocketMessages) return "Socket";

  const url = entry.request?.url ?? "";
  if (url.startsWith("ws://") || url.startsWith("wss://")) return "Socket";

  const mime = entry.response?.content?.mimeType ?? "";
  for (const [re, type] of MIME_TO_TYPE) {
    if (re.test(mime)) return type;
  }

  const byExt = classifyByExt(url);
  if (byExt) return byExt;

  return "Other";
}

function computeSize(entry: RawHarEntry): number {
  const r = entry.response;
  if (!r) return 0;
  if (typeof r._transferSize === "number" && r._transferSize >= 0) {
    return r._transferSize;
  }
  const headers = r.headersSize && r.headersSize > 0 ? r.headersSize : 0;
  const body = r.bodySize && r.bodySize > 0 ? r.bodySize : (r.content?.size ?? 0);
  return headers + (body || 0);
}

function parseHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function buildIndex(har: unknown): HarIndex {
  const log = (har as { log?: { entries?: RawHarEntry[]; pages?: Array<{ startedDateTime?: string }> } })?.log;
  const rawEntries = log?.entries ?? [];

  let pageStartMs = Number.POSITIVE_INFINITY;
  for (const e of rawEntries) {
    if (e.startedDateTime) {
      const t = Date.parse(e.startedDateTime);
      if (!Number.isNaN(t) && t < pageStartMs) pageStartMs = t;
    }
  }
  if (!Number.isFinite(pageStartMs)) pageStartMs = 0;

  const entries: IndexedEntry[] = rawEntries.map((raw, i) => {
    const url = raw.request?.url ?? "";
    const startedAt = raw.startedDateTime ? Date.parse(raw.startedDateTime) : pageStartMs;
    const startMs = Number.isFinite(startedAt) ? startedAt - pageStartMs : 0;
    return {
      id: i + 1,
      url,
      host: parseHost(url),
      method: raw.request?.method ?? "",
      status: typeof raw.response?.status === "number" ? raw.response.status : null,
      type: classify(raw),
      size: computeSize(raw),
      durationMs: typeof raw.time === "number" ? raw.time : 0,
      startMs,
      startedDateTime: raw.startedDateTime ?? "",
      raw,
    };
  });

  return { pageStartMs, entries };
}
