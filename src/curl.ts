import { IndexedEntry } from "./har";
import { CurlResponse } from "./types";

const SKIP_HEADERS = new Set([
  ":authority",
  ":method",
  ":path",
  ":scheme",
  "content-length",
  "host",
  "cookie",
]);

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function toCurl(entry: IndexedEntry): CurlResponse {
  const req = entry.raw.request ?? {};
  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? entry.url;
  const headers = req.headers ?? [];

  const lines: string[] = [];
  lines.push(`curl ${shellSingleQuote(url)}`);

  if (method !== "GET" && method !== "POST") {
    lines.push(`-X ${method}`);
  }

  let cookieValue: string | null = null;

  const seenLowerNames = new Set<string>();
  for (const h of headers) {
    if (!h.name) continue;
    const ln = h.name.toLowerCase();
    if (SKIP_HEADERS.has(ln)) {
      if (ln === "cookie" && cookieValue === null) cookieValue = h.value ?? "";
      continue;
    }
    if (seenLowerNames.has(ln)) continue;
    seenLowerNames.add(ln);
    lines.push(`-H ${shellSingleQuote(`${h.name}: ${h.value ?? ""}`)}`);
  }

  if (cookieValue === null && Array.isArray(req.cookies) && req.cookies.length > 0) {
    cookieValue = req.cookies
      .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
      .join("; ");
  }
  if (cookieValue) {
    lines.push(`-b ${shellSingleQuote(cookieValue)}`);
  }

  const body = req.postData?.text;
  if (body) {
    lines.push(`--data-raw ${shellSingleQuote(body)}`);
  } else if (method !== "GET" && method !== "HEAD") {
    if (body === "") lines.push(`--data-raw ''`);
  }

  return {
    id: entry.id,
    url,
    method,
    curl: lines.join(" \\\n  "),
  };
}
