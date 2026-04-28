import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FileVersion {
  filePath: string;
  size: number;
  mtimeMs: number;
  hash: string;
}

export function computeVersion(filePath: string): FileVersion {
  const abs = path.resolve(filePath);
  const st = fs.statSync(abs);
  const h = crypto.createHash("sha1");
  h.update(abs);
  h.update("\0");
  h.update(String(st.size));
  h.update("\0");
  h.update(String(Math.floor(st.mtimeMs)));
  return {
    filePath: abs,
    size: st.size,
    mtimeMs: st.mtimeMs,
    hash: h.digest("hex").slice(0, 16),
  };
}

export function daemonRuntimeDir(): string {
  const dir = path.join(os.tmpdir(), "har-cli", String(process.getuid?.() ?? "x"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function socketPathFor(version: FileVersion): string {
  return path.join(daemonRuntimeDir(), `d-${version.hash}.sock`);
}

export function pidPathFor(version: FileVersion): string {
  return path.join(daemonRuntimeDir(), `d-${version.hash}.pid`);
}

export function logPathFor(version: FileVersion): string {
  return path.join(daemonRuntimeDir(), `d-${version.hash}.log`);
}
