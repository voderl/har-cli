import * as fs from "node:fs";
import * as net from "node:net";
import { buildIndex, HarIndex } from "./har";
import { getEntryById, getHeaders, getResponse, listEntries } from "./filter";
import { toCurl } from "./curl";
import { readMessage, writeMessage } from "./protocol";
import { DaemonRequest, DaemonResponse } from "./types";
import {
  computeVersion,
  pidPathFor,
  socketPathFor,
  FileVersion,
  logPathFor,
} from "./version";

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function notFoundError(total: number, id: number): string {
  if (total === 0) return `entry id=${id} not found (har file has 0 entries)`;
  return `entry id=${id} not found. valid id range: 1-${total}. Use \`list\` to see available entries.`;
}

interface DaemonState {
  version: FileVersion;
  index: HarIndex;
  lastActivity: number;
  idleTimer: NodeJS.Timeout | null;
  server: net.Server;
}

function loadHar(filePath: string): HarIndex {
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);
  return buildIndex(json);
}

function resetIdleTimer(state: DaemonState) {
  state.lastActivity = Date.now();
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    shutdown(state, "idle-timeout");
  }, IDLE_TIMEOUT_MS);
}

function shutdown(state: DaemonState, reason: string) {
  try {
    state.server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 1000).unref();
  process.stderr.write(`daemon shutting down: ${reason}\n`);
}

function handle(state: DaemonState, req: DaemonRequest): DaemonResponse {
  switch (req.kind) {
    case "ping":
      return { ok: true, data: { alive: true, hash: state.version.hash } };
    case "shutdown":
      setTimeout(() => shutdown(state, "client-requested"), 10).unref();
      return { ok: true, data: { stopping: true } };
    case "list":
      return { ok: true, data: listEntries(state.index.entries, req.filter) };
    case "headers": {
      const e = getEntryById(state.index.entries, req.id);
      if (!e) return { ok: false, error: notFoundError(state.index.entries.length, req.id) };
      return { ok: true, data: getHeaders(e, { full: req.full, key: req.key }) };
    }
    case "response": {
      const e = getEntryById(state.index.entries, req.id);
      if (!e) return { ok: false, error: notFoundError(state.index.entries.length, req.id) };
      return { ok: true, data: getResponse(e) };
    }
    case "curl": {
      const e = getEntryById(state.index.entries, req.id);
      if (!e) return { ok: false, error: notFoundError(state.index.entries.length, req.id) };
      return { ok: true, data: toCurl(e) };
    }
    default:
      return { ok: false, error: `unknown request kind` };
  }
}

export function runDaemon(filePath: string) {
  const version = computeVersion(filePath);
  const sockPath = socketPathFor(version);
  const pidPath = pidPathFor(version);

  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* ignore */
  }

  const index = loadHar(filePath);
  const server = net.createServer();
  const state: DaemonState = {
    version,
    index,
    lastActivity: Date.now(),
    idleTimer: null,
    server,
  };

  server.on("connection", (socket) => {
    socket.on("error", () => socket.destroy());
    (async () => {
      try {
        const reqRaw = (await readMessage(socket)) as DaemonRequest;
        resetIdleTimer(state);
        const resp = handle(state, reqRaw);
        await writeMessage(socket, resp);
      } catch (e) {
        try {
          await writeMessage(socket, { ok: false, error: (e as Error).message });
        } catch {
          /* ignore */
        }
      } finally {
        socket.end();
      }
    })();
  });

  server.listen(sockPath, () => {
    fs.writeFileSync(pidPath, String(process.pid));
    resetIdleTimer(state);
    process.stderr.write(
      `har-cli daemon listening: file=${version.filePath} hash=${version.hash} pid=${process.pid}\n`,
    );
  });

  const cleanup = () => {
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => shutdown(state, "SIGINT"));
  process.on("SIGTERM", () => shutdown(state, "SIGTERM"));
}

export { IDLE_TIMEOUT_MS, logPathFor };
