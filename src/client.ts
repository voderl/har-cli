import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { readMessage, writeMessage } from "./protocol";
import { DaemonRequest, DaemonResponse } from "./types";
import {
  computeVersion,
  logPathFor,
  pidPathFor,
  socketPathFor,
} from "./version";

const CONNECT_TIMEOUT_MS = 1000;
const SPAWN_WAIT_TIMEOUT_MS = 15_000;

function connect(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function tryRequest(
  socketPath: string,
  req: DaemonRequest,
): Promise<DaemonResponse> {
  const socket = await connect(socketPath, CONNECT_TIMEOUT_MS);
  try {
    await writeMessage(socket, req);
    const resp = (await readMessage(socket)) as DaemonResponse;
    return resp;
  } finally {
    socket.end();
  }
}

function spawnDaemon(filePath: string, version: ReturnType<typeof computeVersion>) {
  const logPath = logPathFor(version);
  const out = fs.openSync(logPath, "a");
  const err = fs.openSync(logPath, "a");

  const isTsRun = __filename.endsWith(".ts");
  let cmd: string;
  let args: string[];
  if (isTsRun) {
    cmd = process.execPath;
    args = [
      require.resolve("ts-node/dist/bin"),
      path.resolve(__dirname, "cli.ts"),
      "__daemon__",
      filePath,
    ];
  } else {
    cmd = process.execPath;
    args = [path.resolve(__dirname, "cli.js"), "__daemon__", filePath];
  }

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, HAR_CLI_DAEMON: "1" },
  });
  child.unref();
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(socketPath)) {
      try {
        const s = await connect(socketPath, 500);
        s.end();
        return;
      } catch {
        /* keep waiting */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not become ready within ${timeoutMs}ms`);
}

export const DEFAULT_DAEMON_THRESHOLD_BYTES = 16 * 1024 * 1024;

export async function sendRequest(
  filePath: string,
  req: DaemonRequest,
  opts: {
    noDaemon?: boolean;
    forceDaemon?: boolean;
    daemonThresholdBytes?: number;
  } = {},
): Promise<DaemonResponse> {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `file not found: ${filePath}` };
  }
  const version = computeVersion(filePath);
  const socketPath = socketPathFor(version);

  if (opts.noDaemon) {
    return runInline(filePath, req);
  }

  const threshold = opts.daemonThresholdBytes ?? DEFAULT_DAEMON_THRESHOLD_BYTES;
  const daemonAlive = fs.existsSync(socketPath);
  const useDaemon = opts.forceDaemon || daemonAlive || version.size >= threshold;
  if (!useDaemon) {
    return runInline(filePath, req);
  }

  if (fs.existsSync(socketPath)) {
    try {
      return await tryRequest(socketPath, req);
    } catch {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
      try {
        const pidPath = pidPathFor(version);
        if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
      } catch {
        /* ignore */
      }
    }
  }

  spawnDaemon(filePath, version);
  await waitForSocket(socketPath, SPAWN_WAIT_TIMEOUT_MS);
  return await tryRequest(socketPath, req);
}

function notFound(total: number, id: number): string {
  if (total === 0) return `entry id=${id} not found (har file has 0 entries)`;
  return `entry id=${id} not found. valid id range: 1-${total}. Use \`list\` to see available entries.`;
}

async function runInline(filePath: string, req: DaemonRequest): Promise<DaemonResponse> {
  try {
    const { buildIndex } = await import("./har");
    const { listEntries, getEntryById, getHeaders, getResponse } = await import("./filter");
    const { toCurl } = await import("./curl");
    const raw = fs.readFileSync(filePath, "utf8");
    const idx = buildIndex(JSON.parse(raw));
    switch (req.kind) {
      case "ping":
        return { ok: true, data: { alive: false, inline: true } };
      case "list":
        return { ok: true, data: listEntries(idx.entries, req.filter) };
      case "headers": {
        const e = getEntryById(idx.entries, req.id);
        if (!e) return { ok: false, error: notFound(idx.entries.length, req.id) };
        return { ok: true, data: getHeaders(e, { full: req.full, key: req.key }) };
      }
      case "response": {
        const e = getEntryById(idx.entries, req.id);
        if (!e) return { ok: false, error: notFound(idx.entries.length, req.id) };
        return { ok: true, data: getResponse(e) };
      }
      case "curl": {
        const e = getEntryById(idx.entries, req.id);
        if (!e) return { ok: false, error: notFound(idx.entries.length, req.id) };
        return { ok: true, data: toCurl(e) };
      }
      case "shutdown":
        return { ok: true, data: { stopping: false, inline: true } };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface DaemonClearReport {
  found: number;
  stopped: number;
  removed_files: number;
  errors: string[];
}

export async function clearAllDaemons(): Promise<DaemonClearReport> {
  const path = await import("node:path");
  const { daemonRuntimeDir } = await import("./version");
  const dir = daemonRuntimeDir();

  const report: DaemonClearReport = {
    found: 0,
    stopped: 0,
    removed_files: 0,
    errors: [],
  };

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      report.errors.push(`readdir ${dir}: ${(e as Error).message}`);
    }
    return report;
  }

  const sockFiles = entries.filter((n) => n.startsWith("d-") && n.endsWith(".sock"));
  report.found = sockFiles.length;

  for (const name of sockFiles) {
    const sockPath = path.join(dir, name);
    try {
      const socket = await connect(sockPath, CONNECT_TIMEOUT_MS);
      try {
        await writeMessage(socket, { kind: "shutdown" });
        await readMessage(socket).catch(() => null);
        report.stopped++;
      } finally {
        socket.end();
      }
    } catch (e) {
      report.errors.push(`${name}: shutdown failed (${(e as Error).message}); will remove file`);
    }
  }

  await new Promise((r) => setTimeout(r, 100));

  for (const name of entries) {
    if (!name.startsWith("d-")) continue;
    if (!/\.(sock|pid|log)$/.test(name)) continue;
    const p = path.join(dir, name);
    try {
      fs.unlinkSync(p);
      report.removed_files++;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        report.errors.push(`unlink ${name}: ${(e as Error).message}`);
      }
    }
  }

  return report;
}

export { computeVersion, socketPathFor };
