export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}kB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}Mb`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)}Gb`;
}

export function formatDurationSec(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatStartTimeSec(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtMs(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "-";
  return `${Math.round(n)}`;
}

export function formatTimings(timings: Record<string, number> | undefined): string {
  if (!timings) return "-";
  return `${fmtMs(timings.blocked)}/${fmtMs(timings.wait)}/${fmtMs(timings.receive)}`;
}
