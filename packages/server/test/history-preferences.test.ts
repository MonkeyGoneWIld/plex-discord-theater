import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-preferences-"));
process.env.THUMB_CACHE_DIR = dataDir;

const {
  closeHistoryDb,
  getHistorySaveMode,
  setHistorySaveMode,
  shouldRecordHistory,
} = await import("../src/services/watch-history.js");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${name}\n         expected ${String(expected)}\n         actual   ${String(actual)}`);
}

check("new users keep all-party history by default", getHistorySaveMode("viewer"), "all");
check("default records a viewer", shouldRecordHistory("viewer", false), true);

setHistorySaveMode("viewer", "host_only");
check("preference is stored per user", getHistorySaveMode("viewer"), "host_only");
check("host-only skips viewer history", shouldRecordHistory("viewer", false), false);
check("host-only still records the host", shouldRecordHistory("viewer", true), true);
check("another user's default is unchanged", getHistorySaveMode("other"), "all");

setHistorySaveMode("viewer", "all");
check("preference can be changed back", shouldRecordHistory("viewer", false), true);

closeHistoryDb();
fs.rmSync(dataDir, { recursive: true, force: true });

if (failures > 0) process.exit(1);
console.log("history preferences tests passed");
