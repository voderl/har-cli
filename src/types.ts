export type ResourceType =
  | "Fetch/XHR"
  | "Doc"
  | "CSS"
  | "JS"
  | "Font"
  | "Img"
  | "Media"
  | "Manifest"
  | "Socket"
  | "Wasm"
  | "Other";

export const ALL_RESOURCE_TYPES: ResourceType[] = [
  "Fetch/XHR",
  "Doc",
  "CSS",
  "JS",
  "Font",
  "Img",
  "Media",
  "Manifest",
  "Socket",
  "Wasm",
  "Other",
];

export type SearchType = "url" | "header" | "response";

export interface FilterOptions {
  ids?: number[];
  domain?: string;
  types?: ResourceType[] | "all";
  timeRange?: { startSec?: number; endSec?: number };
  statusCode?: string;
  keyword?: string;
  keywordRegex?: boolean;
  searchTypes?: SearchType[];
  page?: number;
  pageSize?: number;
}

export type ExtraInfoField =
  | "size"
  | "start_time"
  | "duration"
  | "type"
  | "content_type"
  | "timings";

export const ALL_EXTRA_INFO_FIELDS: ExtraInfoField[] = [
  "size",
  "start_time",
  "duration",
  "type",
  "content_type",
  "timings",
];

export interface ListRow {
  id: number;
  method: string;
  url: string;
  type: ResourceType;
  content_type: string;
  status: number | null;
  size: string;
  duration: string;
  start_time: string;
  timings: string;
  hit_reason?: SearchType[];
}

export interface ListResponse {
  total_matched: number;
  page: number;
  page_size: number;
  shown: number;
  hidden: number;
  rows: ListRow[];
  hint?: string;
}

export interface HeaderEntry {
  name: string;
  value: string;
}

export interface HeadersResponse {
  id: number;
  url: string;
  method: string;
  status: number | null;
  request_headers: HeaderEntry[] | string[] | string | null;
  response_headers: HeaderEntry[] | string[] | string | null;
}

export interface ResponseDetailResponse {
  id: number;
  url: string;
  method: string;
  status: number | null;
  status_text: string | null;
  mime_type: string | null;
  size_bytes: number;
  encoding: string | null;
  text: string | null;
  json: unknown;
  truncated?: boolean;
}

export type DaemonRequest =
  | { kind: "ping" }
  | { kind: "shutdown" }
  | { kind: "list"; filter: FilterOptions }
  | { kind: "headers"; id: number; full?: boolean; key?: string }
  | { kind: "response"; id: number; full?: boolean }
  | { kind: "curl"; id: number };

export interface CurlResponse {
  id: number;
  url: string;
  method: string;
  curl: string;
}

export type DaemonResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };
