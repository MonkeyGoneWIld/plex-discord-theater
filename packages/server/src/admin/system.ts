import os from "node:os";

/**
 * The server's load, a minute at a time, for the Theater Dashboard's System
 * page: the machine's CPU and memory, the bot's own share of the CPU and its
 * memory, and the load average (Linux; null on Windows, which reports none).
 */
export interface SystemSample {
  /** All cores together, 0–100. */
  cpuPct: number | null;
  /** This process's CPU time over the minute, as a share of all cores, 0–100. */
  botCpuPct: number | null;
  memPct: number;
  rssMb: number;
  load1: number | null;
}

/** A sampler: each call measures the CPU since the call before; the first has nothing to measure against. */
export function systemSampler(): () => SystemSample {
  let cpuBefore: { idle: number; total: number } | null = null;
  let procBefore: { usage: NodeJS.CpuUsage; at: number } | null = null;
  return () => {
    const cores = os.cpus();
    const idle = cores.reduce((s, c) => s + c.times.idle, 0);
    const total = cores.reduce((s, c) => s + c.times.idle + c.times.user + c.times.sys + c.times.nice + c.times.irq, 0);
    const cpuPct = cpuBefore && total > cpuBefore.total
      ? Math.round((1 - (idle - cpuBefore.idle) / (total - cpuBefore.total)) * 1000) / 10 : null;
    cpuBefore = { idle, total };
    const usage = process.cpuUsage();
    const at = Date.now();
    const botCpuPct = procBefore && at > procBefore.at
      ? Math.round((((usage.user - procBefore.usage.user) + (usage.system - procBefore.usage.system)) / 1000
        / ((at - procBefore.at) * Math.max(1, cores.length))) * 1000) / 10
      : null;
    procBefore = { usage, at };
    const load = os.loadavg()[0];
    return {
      cpuPct,
      botCpuPct,
      memPct: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10,
      rssMb: Math.round(process.memoryUsage().rss / 1e5) / 10,
      load1: process.platform === "win32" ? null : Math.round(load * 100) / 100,
    };
  };
}
