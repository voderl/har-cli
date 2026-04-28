#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearAllDaemons, sendRequest } from "./client";
import { runDaemon } from "./daemon";
import { renderHeaderKey, renderHeaders, renderList, renderResponse } from "./text";
import {
  ALL_EXTRA_INFO_FIELDS,
  ALL_RESOURCE_TYPES,
  CurlResponse,
  ExtraInfoField,
  FilterOptions,
  HeadersResponse,
  ListResponse,
  ResourceType,
  ResponseDetailResponse,
  SearchType,
} from "./types";

type Format = "text" | "json";

function parseFormat(input: string | undefined): Format {
  if (!input) return "text";
  const v = input.toLowerCase();
  if (v === "text" || v === "json") return v;
  throw new Error(`unknown --format: "${input}". Allowed: text, json`);
}

function parseTypes(input: string | undefined): ResourceType[] | "all" | undefined {
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === "all") return "all";
  const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  const norm: ResourceType[] = [];
  const lookup = new Map<string, ResourceType>();
  for (const t of ALL_RESOURCE_TYPES) lookup.set(t.toLowerCase(), t);
  lookup.set("xhr", "Fetch/XHR");
  lookup.set("fetch", "Fetch/XHR");
  lookup.set("fetch/xhr", "Fetch/XHR");
  for (const p of parts) {
    const t = lookup.get(p.toLowerCase());
    if (!t) {
      throw new Error(
        `unknown type: "${p}". Allowed: all, ${ALL_RESOURCE_TYPES.join(", ")}`,
      );
    }
    if (!norm.includes(t)) norm.push(t);
  }
  return norm;
}

function parseTimeRange(input: string | undefined): FilterOptions["timeRange"] {
  if (!input) return undefined;
  const m = input.match(/^\s*(-?\d+(?:\.\d+)?)?\s*-\s*(-?\d+(?:\.\d+)?)?\s*$/);
  if (!m) {
    const single = parseFloat(input);
    if (!Number.isNaN(single)) return { startSec: single };
    throw new Error(`invalid time-range: "${input}". Use formats like "1.0-3.5", "2-", "-5"`);
  }
  return {
    startSec: m[1] !== undefined ? parseFloat(m[1]) : undefined,
    endSec: m[2] !== undefined ? parseFloat(m[2]) : undefined,
  };
}

function parseIds(input: string | undefined): number[] | undefined {
  if (!input) return undefined;
  const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (Number.isNaN(n) || n <= 0) {
      throw new Error(`invalid --id "${p}". ids must be positive integers, comma-separated (e.g. --id 12,24,42)`);
    }
    if (!out.includes(n)) out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

function parseExtraInfo(input: string | undefined): ExtraInfoField[] {
  if (!input) return [];
  const parts = input.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: ExtraInfoField[] = [];
  for (const p of parts) {
    if (!ALL_EXTRA_INFO_FIELDS.includes(p as ExtraInfoField)) {
      throw new Error(
        `unknown --extra-info field: "${p}". Allowed: ${ALL_EXTRA_INFO_FIELDS.join(", ")}`,
      );
    }
    if (!out.includes(p as ExtraInfoField)) out.push(p as ExtraInfoField);
  }
  return out;
}

function parseSearchTypes(input: string | undefined): SearchType[] | undefined {
  if (!input) return undefined;
  const allowed: SearchType[] = ["url", "header", "response"];
  const parts = input.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: SearchType[] = [];
  for (const p of parts) {
    if (!allowed.includes(p as SearchType)) {
      throw new Error(`unknown search-type: "${p}". Allowed: ${allowed.join(", ")}`);
    }
    if (!out.includes(p as SearchType)) out.push(p as SearchType);
  }
  return out;
}

function printJson(resp: { ok: boolean; data?: unknown; error?: string }) {
  if (resp.ok) {
    process.stdout.write(JSON.stringify(resp.data, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ error: resp.error }, null, 2) + "\n");
    process.exitCode = 1;
  }
}

function printText(text: string) {
  process.stdout.write(text + "\n");
}

function printError(format: Format, msg: string) {
  if (format === "json") {
    process.stdout.write(JSON.stringify({ error: msg }, null, 2) + "\n");
  } else {
    process.stderr.write(`error: ${msg}\n`);
  }
  process.exitCode = 1;
}

function buildFilterSummary(filter: FilterOptions): string {
  const parts: string[] = [];
  if (filter.ids && filter.ids.length > 0) parts.push(`id=${filter.ids.join(",")}`);
  if (filter.types === "all") parts.push("type=all");
  else if (filter.types && filter.types.length > 0)
    parts.push(`type=${filter.types.join(",")}`);
  else parts.push("type=Fetch/XHR");
  if (filter.domain) parts.push(`domain=${filter.domain}`);
  if (filter.statusCode) parts.push(`status=${filter.statusCode}`);
  if (filter.timeRange) {
    const a = filter.timeRange.startSec ?? "";
    const b = filter.timeRange.endSec ?? "";
    parts.push(`time=${a}-${b}s`);
  }
  if (filter.keyword) {
    const types = filter.searchTypes && filter.searchTypes.length > 0
      ? filter.searchTypes.join(",")
      : "url,header,response";
    const mode = filter.keywordRegex
      ? " (regex)"
      : filter.keyword.includes("|")
      ? " (OR)"
      : "";
    parts.push(`keyword="${filter.keyword}"${mode} in ${types}`);
  }
  return parts.join("  ");
}

interface RootOpts {
  file?: string;
  daemon?: boolean;
  forceDaemon?: boolean;
  daemonThreshold?: number;
  format?: string;
}

function buildClientOpts(root: RootOpts): {
  noDaemon?: boolean;
  forceDaemon?: boolean;
  daemonThresholdBytes?: number;
} {
  const out: {
    noDaemon?: boolean;
    forceDaemon?: boolean;
    daemonThresholdBytes?: number;
  } = {};
  if (root.daemon === false) out.noDaemon = true;
  if (root.forceDaemon) out.forceDaemon = true;
  if (typeof root.daemonThreshold === "number" && !Number.isNaN(root.daemonThreshold)) {
    out.daemonThresholdBytes = root.daemonThreshold * 1024 * 1024;
  }
  return out;
}

function requireFile(file: string | undefined): string {
  if (!file) {
    throw new Error(
      "missing --file <path>. Usage: har-cli -f <file.har> [list|headers <id>|response <id>]",
    );
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new Error(`file not found: ${abs}`);
  }
  return abs;
}

function addFilterOptions(cmd: Command): Command {
  return cmd
    .option(
      "--id <ids>",
      "filter by entry id, comma-separated (e.g. 12,24,42)",
    )
    .option(
      "--extra-info <fields>",
      `extra columns to include, comma-separated. allowed: ${ALL_EXTRA_INFO_FIELDS.join(", ")}. timings is shown as 'b/w/r ms' = blocked / wait (TTFB) / receive`,
    )
    .option("-d, --domain <domain>", "filter by host substring")
    .option(
      "-t, --type <types>",
      `filter resource types (comma-separated). default: Fetch/XHR. allowed: all, ${ALL_RESOURCE_TYPES.join(", ")}`,
    )
    .option(
      "--time-range <range>",
      "filter by start time in seconds, e.g. '1.0-3.5', '2-', '-5'",
    )
    .option("-s, --status <code>", "status filter: '200', '2xx', '200,302', '200-299'")
    .option(
      "-k, --keyword <kw>",
      "search keyword, case-insensitive. use '|' to OR multiple terms (e.g. 'agent|user|login')",
    )
    .option(
      "--regex <pattern>",
      "search with a JavaScript regex (case-insensitive); takes precedence over --keyword",
    )
    .option(
      "--search-type <types>",
      "comma-separated subset of url,header,response (default all when --keyword is set)",
    )
    .option("-p, --page <n>", "page number (default 1)", (v) => parseInt(v, 10))
    .option("--page-size <n>", "page size (default 50)", (v) => parseInt(v, 10));
}

async function main() {
  const program = new Command();
  program
    .name("har-cli")
    .description("Agent-friendly CLI for parsing/querying HAR files with daemon caching.")
    .version("0.1.0")
    .option("-f, --file <path>", "HAR file path")
    .option(
      "--no-daemon",
      "force inline parse (no daemon, no caching)",
    )
    .option(
      "--force-daemon",
      "force daemon mode regardless of file size",
    )
    .option(
      "--daemon-threshold <mb>",
      "use daemon only when file is at least N MB (default 16)",
      (v) => parseFloat(v),
    )
    .option(
      "--format <fmt>",
      "output format: text (default) or json",
      "text",
    );

  const listCmd = addFilterOptions(
    program
      .command("list", { isDefault: true })
      .description("list entries (default command)"),
  );
  listCmd.action(async (opts, command: Command) => {
    const root = command.parent!.opts<RootOpts>();
    const format = parseFormat(root.format);
    const file = requireFile(root.file);
    const useRegex = typeof opts.regex === "string" && opts.regex.length > 0;
    const extraInfo = parseExtraInfo(opts.extraInfo);
    const filter: FilterOptions = {
      ids: parseIds(opts.id),
      domain: opts.domain,
      types: parseTypes(opts.type),
      timeRange: parseTimeRange(opts.timeRange),
      statusCode: opts.status,
      keyword: useRegex ? opts.regex : opts.keyword,
      keywordRegex: useRegex,
      searchTypes: parseSearchTypes(opts.searchType),
      page: opts.page,
      pageSize: opts.pageSize,
    };
    const resp = await sendRequest(
      file,
      { kind: "list", filter },
      buildClientOpts(root),
    );
    if (!resp.ok) {
      printError(format, resp.error);
      return;
    }
    if (format === "json") {
      printJson(resp);
    } else {
      printText(renderList(resp.data as ListResponse, buildFilterSummary(filter), extraInfo));
    }
  });

  program
    .command("headers <id>")
    .description("get headers for an entry by id (default: header names only)")
    .option("--full", "return full header name+value pairs")
    .option("--key <name>", "return the value of a specific header")
    .action(async (idStr: string, opts, command: Command) => {
      const root = command.parent!.opts<{
        file?: string;
        daemon?: boolean;
        format?: string;
      }>();
      const format = parseFormat(root.format);
      const file = requireFile(root.file);
      const id = parseInt(idStr, 10);
      if (Number.isNaN(id) || id <= 0) {
        printError(format, `invalid id: "${idStr}". id must be a positive integer; use \`list\` to see available ids.`);
        return;
      }
      const resp = await sendRequest(
        file,
        { kind: "headers", id, full: !!opts.full, key: opts.key },
        buildClientOpts(root),
      );
      if (!resp.ok) {
        printError(format, resp.error);
        return;
      }
      if (format === "json") {
        printJson(resp);
      } else if (opts.key) {
        const r = renderHeaderKey(resp.data as HeadersResponse, opts.key);
        if (!r.found) {
          process.stderr.write(r.text + "\n");
          process.exitCode = 1;
        } else {
          printText(r.text);
        }
      } else {
        printText(renderHeaders(resp.data as HeadersResponse));
      }
    });

  program
    .command("response <id>")
    .description(
      "get response body. default: header summary + body truncated to 2kB (JSON pretty-printed). --full restores the entire body.",
    )
    .option("--full", "return the entire raw body (may be very large)")
    .action(async (idStr: string, opts, command: Command) => {
      const root = command.parent!.opts<RootOpts>();
      const format = parseFormat(root.format);
      const file = requireFile(root.file);
      const id = parseInt(idStr, 10);
      if (Number.isNaN(id) || id <= 0) {
        printError(format, `invalid id: "${idStr}". id must be a positive integer; use \`list\` to see available ids.`);
        return;
      }
      const resp = await sendRequest(
        file,
        { kind: "response", id, full: !!opts.full },
        buildClientOpts(root),
      );
      if (!resp.ok) {
        printError(format, resp.error);
        return;
      }
      if (format === "json") {
        printJson(resp);
      } else {
        printText(
          renderResponse(resp.data as ResponseDetailResponse, { full: !!opts.full }),
        );
      }
    });

  program
    .command("to-curl-command <id>")
    .description("convert an entry into a copy-pasteable curl command")
    .action(async (idStr: string, _opts, command: Command) => {
      const root = command.parent!.opts<RootOpts>();
      const format = parseFormat(root.format);
      const file = requireFile(root.file);
      const id = parseInt(idStr, 10);
      if (Number.isNaN(id) || id <= 0) {
        printError(format, `invalid id: "${idStr}". id must be a positive integer; use \`list\` to see available ids.`);
        return;
      }
      const resp = await sendRequest(
        file,
        { kind: "curl", id },
        buildClientOpts(root),
      );
      if (!resp.ok) {
        printError(format, resp.error);
        return;
      }
      if (format === "json") {
        printJson(resp);
      } else {
        printText((resp.data as CurlResponse).curl);
      }
    });

  program
    .command("daemon-clear")
    .description("stop all running daemons and clear cached socket/pid/log files")
    .action(async (_opts, command: Command) => {
      const root = command.parent!.opts<RootOpts>();
      const format = parseFormat(root.format);
      const report = await clearAllDaemons();
      if (format === "json") {
        printJson({ ok: true, data: report });
      } else {
        printText(
          `found ${report.found} daemon(s) · stopped ${report.stopped} · removed ${report.removed_files} file(s)` +
            (report.errors.length > 0 ? "\n\nerrors:\n  " + report.errors.join("\n  ") : ""),
        );
      }
    });

  if (process.argv[2] === "__daemon__") {
    const file = process.argv[3];
    if (!file) {
      process.stderr.write("daemon: missing file path\n");
      process.exit(1);
    }
    runDaemon(file);
    return;
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`har-cli error: ${err.message ?? err}\n`);
  process.exit(1);
});
