/**
 * Playlists go gzipped to a player that takes it, as they are to one that
 * doesn't, and small ones always as they are.
 */
import http from "node:http";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import express from "express";
import { sendPlaylist } from "../src/services/send-playlist.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

// Two hours of a re-encode cut every 3 s, as the server lists it.
const long = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-TARGETDURATION:6"];
for (let i = 0; i < 2400; i++) {
  long.push(`#EXTINF:3.000,`, `/api/plex/hls/seg?p=%2Fvideo%2F%3A%2Ftranscode%2Funiversal%2Fsession%2Fabc%2Fbase%2F${String(i).padStart(5, "0")}.ts&token=0123456789abcdef&n=${1_200_000 + i}`);
}
const longText = long.join("\n") + "\n";
const shortText = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nindex.m3u8\n";

const app = express();
app.get("/long", (req, res) => { void sendPlaylist(req, res, longText); });
app.get("/short", (req, res) => { void sendPlaylist(req, res, shortText); });
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;

function get(path: string, encoding?: string): Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get({ port, path, headers: encoding ? { "Accept-Encoding": encoding } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

try {
  const zipped = await get("/long", "gzip, deflate, br");
  check("a long playlist goes gzipped to a player that takes it", zipped.headers["content-encoding"], "gzip");
  check("and unzips to the playlist", gunzipSync(zipped.body).toString("utf8") === longText, true);
  check("at least ten times smaller", zipped.body.length * 10 < Buffer.byteLength(longText), true);
  check("it is an HLS playlist", zipped.headers["content-type"]?.startsWith("application/vnd.apple.mpegurl"), true);
  check("caches are told it varies by encoding", /accept-encoding/i.test(String(zipped.headers.vary)), true);
  console.log(`    (${Buffer.byteLength(longText)} bytes plain, ${zipped.body.length} gzipped)`);

  const plain = await get("/long");
  check("as it is to one that doesn't say", [plain.headers["content-encoding"], plain.body.toString("utf8") === longText], [undefined, true]);

  const short = await get("/short", "gzip");
  check("a short one goes as it is", [short.headers["content-encoding"], short.body.toString("utf8")], [undefined, shortText]);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
