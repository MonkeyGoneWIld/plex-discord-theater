/**
 * How much of the GPU an ffmpeg used, by the kernel's own count rather than
 * intel_gpu_top's: every DRM file a process has open reports its engines' busy
 * time in /proc/<pid>/fdinfo/<fd> — i915 as drm-engine-<engine> in ns, xe as
 * drm-cycles-<class> against drm-total-cycles-<class>. On 18 October
 * intel_gpu_top on the host showed every engine idle through re-encodes the
 * log said were on QSV; this says, per run, which it was.
 */
import fs from "node:fs";

/** One engine's count: busy ns (i915), or busy cycles and the GPU's cycles meanwhile (xe). */
interface EngineCount {
  busy: number;
  total: number | null;
  capacity: number;
}

export interface GpuSample {
  at: number;
  /** CPU seconds it has used, user and system — the other side of the same question. */
  cpuS: number | null;
  /** Bytes it has read, the film from the NAS included (/proc/<pid>/io rchar). */
  readBytes: number | null;
  /** The DRM devices it has open, and their driver — none, it isn't using a GPU. */
  devices: string[];
  driver: string | null;
  engines: Record<string, EngineCount>;
}

/** xe's engine classes, by the names i915 and intel_gpu_top use. */
const XE_CLASSES: Record<string, string> = { rcs: "render", bcs: "copy", vcs: "video", vecs: "video-enhance", ccs: "compute" };

/**
 * One DRM file's fdinfo: its client (two files can be one client), driver and
 * engine counts. Null for a file that isn't a DRM client.
 */
export function parseFdinfo(text: string): { client: string; driver: string | null; engines: Record<string, EngineCount> } | null {
  const client = text.match(/^drm-client-id:\s*(\d+)/m)?.[1];
  if (!client) return null;
  const driver = text.match(/^drm-driver:\s*(\S+)/m)?.[1] ?? null;
  const engines: Record<string, EngineCount> = {};
  const capacity = (name: string) => {
    const c = Number(text.match(new RegExp(`^drm-engine-capacity-${name}:\\s*(\\d+)`, "m"))?.[1]);
    return c > 0 ? c : 1;
  };
  for (const [, name, ns] of text.matchAll(/^drm-engine-(?!capacity-)([\w-]+):\s*(\d+) ns/gm)) {
    engines[name] = { busy: Number(ns), total: null, capacity: capacity(name) };
  }
  for (const [, cls, cycles] of text.matchAll(/^drm-cycles-(\w+):\s*(\d+)/gm)) {
    const total = Number(text.match(new RegExp(`^drm-total-cycles-${cls}:\\s*(\\d+)`, "m"))?.[1]);
    engines[XE_CLASSES[cls] ?? cls] = { busy: Number(cycles), total: Number.isFinite(total) ? total : null, capacity: capacity(cls) };
  }
  return { client, driver, engines };
}

/** What process `pid` has open of the GPU now; null if /proc can't say (not Linux, or it's gone). */
export function sampleGpu(pid: number): GpuSample | null {
  let fds: string[];
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return null;
  }
  const sample: GpuSample = { at: Date.now(), cpuS: cpuSeconds(pid), readBytes: bytesRead(pid), devices: [], driver: null, engines: {} };
  const clients = new Set<string>();
  for (const fd of fds) {
    let target: string;
    let info: ReturnType<typeof parseFdinfo>;
    try {
      target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (!target.startsWith("/dev/dri/")) continue;
      info = parseFdinfo(fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8"));
    } catch {
      continue;
    }
    if (!sample.devices.includes(target)) sample.devices.push(target);
    if (!info || clients.has(info.client)) continue;
    clients.add(info.client);
    sample.driver ??= info.driver;
    for (const [name, c] of Object.entries(info.engines)) {
      const had = sample.engines[name];
      // xe's total is the GPU's clock, the same for every client: not added up.
      sample.engines[name] = had ? { busy: had.busy + c.busy, total: c.total, capacity: c.capacity } : { ...c };
    }
  }
  return sample;
}

/** /proc/<pid>/stat's utime and stime, in seconds (USER_HZ is 100 on Linux). */
function cpuSeconds(pid: number): number | null {
  try {
    // Fields after the command's closing parenthesis: utime and stime are the 12th and 13th.
    const rest = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ");
    return (Number(rest[11]) + Number(rest[12])) / 100;
  } catch {
    return null;
  }
}

function bytesRead(pid: number): number | null {
  try {
    const n = Number(fs.readFileSync(`/proc/${pid}/io`, "utf8").match(/^rchar:\s*(\d+)/m)?.[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** How fast it read from `from` to `to`, Mbps. */
export function readUse(from: GpuSample | null, to: GpuSample | null): string {
  if (!from || !to || from.readBytes === null || to.readBytes === null || to.at <= from.at) return "unknown";
  return `${Math.round(((to.readBytes - from.readBytes) * 8) / ((to.at - from.at) / 1000) / 1e6)} Mbps`;
}

/** How many CPU cores' worth it used from `from` to `to`. */
export function cpuUse(from: GpuSample | null, to: GpuSample | null): string {
  if (!from || !to || from.cpuS === null || to.cpuS === null || to.at <= from.at) return "unknown";
  return `${Math.round(((to.cpuS - from.cpuS) / ((to.at - from.at) / 1000)) * 10) / 10} cores`;
}

/** Each engine's share of the time from `from` to `to`, busiest first — for the log. */
export function gpuUse(from: GpuSample | null, to: GpuSample | null): string {
  if (!to) return "unknown (no /proc)";
  if (to.devices.length === 0) return "none: ffmpeg had no GPU open, so the CPU did the work";
  const wallMs = to.at - (from?.at ?? to.at);
  const shares: Array<[string, number]> = [];
  for (const [name, c] of Object.entries(to.engines)) {
    const was = from?.engines[name];
    const busy = c.busy - (was?.busy ?? 0);
    const share = c.total !== null
      ? (was?.total != null && c.total > was.total ? busy / (c.total - was.total) : null)
      : wallMs > 0 ? busy / (wallMs * 1e6) : null;
    if (share !== null) shares.push([name, Math.max(0, share / c.capacity)]);
  }
  const where = `${to.driver ?? "unknown driver"}, ${to.devices.join(" ")}`;
  if (shares.length === 0) return `the GPU was open (${where}), but the kernel gave no busy time for it`;
  shares.sort((a, b) => b[1] - a[1]);
  return `${shares.map(([name, s]) => `${name} ${Math.round(s * 100)}%`).join(", ")} over ${Math.round(wallMs / 100) / 10} s (${where})`;
}
