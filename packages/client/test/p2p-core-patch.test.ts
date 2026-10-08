/**
 * The change made to the P2P engine as it is bundled (p2pCorePatch.ts) fits
 * the engine installed, once, and leaves it valid JavaScript. What it does is
 * checked in the browser, with real peers: sync-room.tsx, "Host's downloads
 * crawl".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { patchHybridLoader, patchSegmentStorage } from "../p2pCorePatch";

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
check("all its changes are made", patched.split("plex-discord-theater: p2pCorePatch").length - 1, 7);
check("it is still JavaScript", (() => { try { transformSync(patched, { loader: "js", format: "esm" }); return true; } catch { return false; } })(), true);
check("a segment loading from a peer is asked about before being moved to the bot",
  /request\.downloadSource === "p2p" && !this\.pdtKeepOnPeer\(request, segment\) &&/.test(patched), true);
check("one playback asks for is offered to another player before the bot is asked",
  /if \(this\.pdtShareFromPeer\(request, segment\)\) \{[^}]*\}\s+else if \(canLoadThroughHttp\) \{\s+this\.loadThroughHttp\(segment\);/.test(patched), true);
check("one not loading yet is offered to another player before the bot",
  /\/\/ High-demand request is not loading\s+\/\/ plex-discord-theater: p2pCorePatch\s+if \(this\.pdtShareFromPeer\(request, segment\)\) continue;\s+const shouldLoadThroughHttp/.test(patched), true);
check("the segment playback waits on is looked at before anything else in the queue",
  /if \(this\.pdtTakeFromPeer\(request, segment\)\) continue;/.test(patched), true);
check("applying it twice changes nothing", patchHybridLoader(patched), patched);

console.log("\n— its memory —");
const storageFile = fileURLToPath(new URL("./segment-storage/segment-memory-storage.js", import.meta.resolve("p2p-media-loader-core")));
const storage = patchSegmentStorage(readFileSync(storageFile, "utf8"));
check("what has been watched is kept until the memory is full, a copy's growing playlist too",
  /clear\(_isLiveStream, newSegmentSize\) \{\s+const isLiveStream = false;/.test(storage), true);
check("and it is still JavaScript", (() => { try { transformSync(storage, { loader: "js", format: "esm" }); return true; } catch { return false; } })(), true);

console.log("\n— an engine it wasn't written for —");
let refused: unknown = null;
try { patchHybridLoader(source.replace("// High-demand request is loading", "// moved")); } catch (err) { refused = err; }
check("the build stops, rather than going without", refused instanceof Error, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
