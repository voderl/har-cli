import {
  ExtraInfoField,
  HeadersResponse,
  HeaderEntry,
  ListResponse,
  ResponseDetailResponse,
} from "./types";

function pad(s: string, w: number): string {
  if (s.length >= w) return s;
  return s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  if (s.length >= w) return s;
  return " ".repeat(w - s.length) + s;
}

export function renderList(
  d: ListResponse,
  filterSummary: string,
  extraInfo: ExtraInfoField[] = [],
): string {
  const lines: string[] = [];

  const header = `${d.total_matched} matched · showing ${d.shown === 0 ? 0 : (d.page - 1) * d.page_size + 1}-${(d.page - 1) * d.page_size + d.shown} · ${d.hidden} hidden (page=${d.page} of ${Math.max(1, Math.ceil(d.total_matched / d.page_size))})`;
  lines.push(header);
  if (filterSummary) lines.push(`filters: ${filterSummary}`);
  lines.push("");

  if (d.rows.length === 0) {
    lines.push("(no entries)");
    if (d.hint) {
      lines.push("");
      lines.push(d.hint);
    }
    return lines.join("\n");
  }

  const showHit = d.rows.some((r) => r.hit_reason && r.hit_reason.length > 0);

  const baseCols = ["ID", "METHOD", "STATUS"];
  const extraColMap: Record<ExtraInfoField, string> = {
    type: "TYPE",
    content_type: "CONTENT_TYPE",
    size: "SIZE",
    start_time: "START_TIME",
    duration: "DURATION",
    timings: "TIMINGS(b/w/r ms)",
  };
  const extraCols = extraInfo.map((f) => extraColMap[f]);
  const cols = [...baseCols, ...extraCols];
  if (showHit) cols.push("HIT");
  cols.push("URL");

  const widths: Record<string, number> = {};
  for (const c of cols) widths[c] = c.length;

  const rowsAsCells = d.rows.map((r) => {
    const cells: Record<string, string> = {
      ID: String(r.id),
      METHOD: r.method || "-",
      URL: r.url,
      STATUS: r.status === null ? "-" : String(r.status),
      TYPE: r.type,
      CONTENT_TYPE: r.content_type || "-",
      SIZE: r.size,
      DURATION: r.duration,
      START_TIME: r.start_time,
      "TIMINGS(b/w/r ms)": r.timings,
    };
    if (showHit) cells.HIT = (r.hit_reason ?? []).join(",") || "-";
    for (const k of cols) {
      if (cells[k].length > widths[k]) widths[k] = cells[k].length;
    }
    return cells;
  });

  const rightAligned = new Set([
    "ID",
    "STATUS",
    "SIZE",
    "START_TIME",
    "DURATION",
    "TIMINGS(b/w/r ms)",
  ]);

  const renderRow = (cells: Record<string, string>) => {
    const parts: string[] = [];
    for (const c of cols) {
      if (c === "URL") continue;
      const v = cells[c];
      parts.push(rightAligned.has(c) ? padLeft(v, widths[c]) : pad(v, widths[c]));
    }
    parts.push(cells.URL);
    return parts.join("  ");
  };

  const headerCells: Record<string, string> = Object.fromEntries(
    cols.map((c) => [c, c]),
  );
  lines.push(renderRow(headerCells));
  for (const cells of rowsAsCells) lines.push(renderRow(cells));

  if (d.hint) {
    lines.push("");
    lines.push(d.hint);
  }

  return lines.join("\n");
}

export function renderHeaderKey(
  d: HeadersResponse,
  key: string,
): { text: string; found: boolean } {
  const reqVal = typeof d.request_headers === "string" ? d.request_headers : null;
  const resVal = typeof d.response_headers === "string" ? d.response_headers : null;
  if (reqVal !== null && resVal !== null) {
    return { text: `request:  ${reqVal}\nresponse: ${resVal}`, found: true };
  }
  if (reqVal !== null) return { text: reqVal, found: true };
  if (resVal !== null) return { text: resVal, found: true };
  return {
    text: `(header "${key}" not found in request or response of entry #${d.id})`,
    found: false,
  };
}

export function renderHeaders(d: HeadersResponse): string {
  const lines: string[] = [];
  lines.push(`#${d.id}  ${d.method} ${d.status ?? "-"}  ${d.url}`);
  lines.push("");

  const renderSection = (
    title: string,
    body: HeaderEntry[] | string[] | string | null,
  ) => {
    lines.push(`[${title}]`);
    if (body === null) {
      lines.push("(not present)");
    } else if (typeof body === "string") {
      lines.push(body);
    } else if (Array.isArray(body) && body.length === 0) {
      lines.push("(none)");
    } else if (Array.isArray(body) && typeof body[0] === "string") {
      lines.push((body as string[]).join(", "));
    } else {
      const arr = body as HeaderEntry[];
      const w = Math.min(40, arr.reduce((m, h) => Math.max(m, h.name.length), 0));
      for (const h of arr) lines.push(`${pad(h.name, w)}  ${h.value}`);
    }
    lines.push("");
  };

  renderSection("request headers", d.request_headers);
  renderSection("response headers", d.response_headers);
  return lines.join("\n").trimEnd();
}

const RESPONSE_TRUNCATE_BYTES = 2 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}kB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}Mb`;
}

/**
 * Build a diagnostic message for the common case where `response.content.text`
 * is missing in the HAR. The most frequent root cause (in our experience) is
 * Chrome DevTools failing to buffer the response body for any request that
 * was already in flight when HAR recording started — header metadata
 * (size/mime/encoding) is captured but the body stream is gone. Status code
 * and method don't matter; what matters is the relative timing between the
 * request and DevTools opening / "Preserve log" turning on.
 *
 * We surface what we *do* know (size, mime, encoding) so the user can tell
 * whether the body would have been useful, and point to the fix.
 */
function renderMissingBodyHint(d: ResponseDetailResponse): string {
  const parts = ["(no body — response.content.text missing in HAR"];
  const meta: string[] = [];
  if (d.size_bytes && d.size_bytes > 0) meta.push(`size=${formatBytes(d.size_bytes)}`);
  if (d.mime_type) meta.push(`mime=${d.mime_type}`);
  if (d.encoding) meta.push(`encoding=${d.encoding}`);
  if (meta.length > 0) parts.push(`; ${meta.join(", ")}`);
  parts.push(")");
  const head = parts.join("");
  const advice =
    "Likely cause: the request was already in flight when DevTools/HAR " +
    "recording started, so Chrome captured headers but not the body. " +
    "Re-record with DevTools Network → enable \"Preserve log\" and " +
    "\"Disable cache\", then reload the page (or trigger the request again).";
  return `${head}\n${advice}`;
}

function prettyIfJson(text: string, mime: string | null): string {
  if (!mime || !/json/i.test(mime)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function renderResponse(
  d: ResponseDetailResponse,
  opts: { full?: boolean } = {},
): string {
  const url = d.url ?? "";
  const status = d.status ?? "-";
  const mime = d.mime_type ?? "-";
  const sizeStr = formatBytes(d.size_bytes ?? 0);
  const headerLines = [
    `url: ${url}`,
    `status: ${status}`,
    `size: ${sizeStr}`,
    `content_type: ${mime}`,
  ];

  if (d.text === null || d.text === undefined) {
    headerLines.push("");
    headerLines.push(renderMissingBodyHint(d));
    return headerLines.join("\n");
  }

  const pretty = prettyIfJson(d.text, d.mime_type ?? null);
  const buf = Buffer.from(pretty, "utf8");

  if (opts.full || buf.byteLength <= RESPONSE_TRUNCATE_BYTES) {
    headerLines.push("");
    headerLines.push(pretty);
    return headerLines.join("\n");
  }

  const slice = buf.subarray(0, RESPONSE_TRUNCATE_BYTES).toString("utf8");
  const totalStr = formatBytes(buf.byteLength);
  headerLines.push("");
  headerLines.push(slice);
  headerLines.push(
    `\n--- truncated: showing ${formatBytes(RESPONSE_TRUNCATE_BYTES)} of ${totalStr}${
      buf.byteLength !== d.size_bytes ? ` (${sizeStr} raw)` : ""
    }; use \`response ${d.id} --full\` for the entire body ---`,
  );
  return headerLines.join("\n");
}
