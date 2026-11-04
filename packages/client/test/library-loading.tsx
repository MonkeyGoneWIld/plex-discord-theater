// Manual/DOM fixture: npm run dev -w packages/client, then open
// /test/library-loading.html. A library opened while the list of libraries is
// still loading, as it is after a reload, and then another library: each shows
// its skeleton until its titles come, and "This library is empty" never. It
// flashed when the list of libraries answered, or the search box was reset
// (as it is whenever the library changes), and either cleared the loading
// flag the titles still needed. The verdicts are written above the library.
// Not part of the production entry.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const json = (body: unknown, ms = 0) => new Promise<Response>((resolve) => setTimeout(() =>
  resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })), ms));
const titles: Record<string, string> = { "1": "Heat", "2": "Ronin" };
window.fetch = ((input: RequestInfo | URL) => {
  const p = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
  if (p === "/api/plex/sections") {
    return json({ sections: [{ id: "1", title: "Movies", type: "movie" }, { id: "2", title: "More Movies", type: "movie" }] }, 50);
  }
  const all = p.match(/^\/api\/plex\/sections\/(\d)\/all$/);
  if (all) {
    return json({ items: [{ ratingKey: `${all[1]}0`, title: titles[all[1]], type: "movie", year: 1998 }], totalSize: 1, start: 0, size: 1 }, 1000);
  }
  if (/^\/api\/plex\/sections\/\d\/genres$/.test(p)) return json({ genres: [] });
  if (p === "/api/plex/home") return json({ hubs: [] });
  if (p === "/api/history/settings") return json({ saveMode: "all" });
  if (p.startsWith("/api/history")) return json({ items: [], total: 0 });
  if (p === "/api/plex-account/status") return json({ linked: false });
  if (p === "/api/plex-account/watchlist") return json({ items: [] });
  return json({});
}) as typeof fetch;

const { Library } = await import("../src/components/Library");

const verdict = document.getElementById("verdict")!;
const library = document.getElementById("root")!;
const said: string[] = [];
/** Watches one library's load: whether the empty state showed before its titles. */
function watch(section: string, then?: () => void) {
  const startedAt = performance.now();
  let emptyAt: number | null = null;
  const seen = new MutationObserver(() => {
    const text = library.textContent ?? "";
    if (emptyAt === null && text.includes("This library is empty")) emptyAt = Math.round(performance.now() - startedAt);
    if (!text.includes(titles[section])) return;
    seen.disconnect();
    said.push(emptyAt === null
      ? `PASS: library ${section}, the skeleton until its titles came`
      : `FAIL: library ${section}, “This library is empty” at ${emptyAt} ms, before its titles`);
    verdict.textContent = said.join(" · ");
    then?.();
  });
  seen.observe(library, { childList: true, subtree: true, characterData: true });
}

let switchTo: (section: string) => void = () => {};
function Harness() {
  const [section, setSection] = useState("1");
  useEffect(() => { switchTo = setSection; }, []);
  return <Library isHost onSelect={() => {}} activeSection={section} onActiveSectionChange={setSection} />;
}
watch("1", () => setTimeout(() => {
  watch("2");
  switchTo("2");
}, 200));
createRoot(library).render(<Harness />);
