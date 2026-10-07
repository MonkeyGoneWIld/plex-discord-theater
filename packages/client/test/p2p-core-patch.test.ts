/**
 * The change made to the P2P engine as it is bundled (p2pCorePatch.ts) fits
 * the engine installed, once, and leaves it valid JavaScript. What it does is
 * checked in the browser, with real peers: sync-room.tsx, "Host's downloads
 * crawl".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { patchHybridLoader } from "../p2pCorePatch";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// The engine as the bundler finds it: its "import" entry, lib/index.js.
const file = fileURLToPath(new URL("./hybrid-loader.js", import.meta.resolve("p2p-media-loader-core")));
const source = readFileSync(file, "utf8");

console.log("\n— the engine as installed —");
const patched = patchHybridLoader(source);
check("all three changes are made", patched.split("plex-discord-theater: p2pCorePatch").length - 1, 4);
check("it is still JavaScript", (() => { try { transformSync(patched, { loader: "js", format: "esm" }); return true; } catch { return false; } })(), true);
check("a segment loading from a peer is asked about before being moved to the bot",
  /request\.downloadSource === "p2p" && !this\.pdtKeepOnPeer\(request\) &&/.test(patched), true);
check("the segment playback waits on is looked at before anything else in the queue",
  /if \(this\.pdtTakeFromPeer\(request, segment\)\) continue;/.test(patched), true);
check("applying it twice changes nothing", patchHybridLoader(patched), patched);

console.log("\n— an engine it wasn't written for —");
let refused: unknown = null;
try { patchHybridLoader(source.replace("// High-demand request is loading", "// moved")); } catch (err) { refused = err; }
check("the build stops, rather than going without", refused instanceof Error, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
