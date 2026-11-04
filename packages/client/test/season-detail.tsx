// Manual/DOM fixture: npm run dev -w packages/client, then open
// /test/season-detail.html. A season's episode cards: each opens its episode,
// and its watched tick is a control of its own beside it rather than inside
// it. Inside, it was a control nested in a button, which screen readers read
// as part of the button's name and never as a checkbox. The checks run on
// their own and are written above the season. Not part of the production
// entry.
import { createRoot } from "react-dom/client";

const json = (body: unknown, ms = 0) => new Promise<Response>((resolve) => setTimeout(() =>
  resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })), ms));
const episodes = [1, 2].map((n) => ({
  ratingKey: `e${n}`, type: "episode", title: n === 1 ? "Pilot" : "The Second One", index: n, parentIndex: 1,
  summary: "A short summary of what happens.", duration: 1_500_000,
}));
/** The watched-state changes asked for. */
const marked: string[] = [];
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const p = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
  if (p === "/api/plex/children/s1") return json({ items: episodes });
  if (p === "/api/history/progress") return json({ entries: {} });
  if (p === "/api/plex/season-episodes/s1") return json({ episodes: [] });
  if (p.startsWith("/api/plex-account/watched/") && init?.method === "PUT") {
    marked.push(p.split("/").pop()!);
    return json({ watched: true, progress: null, affected: 1 });
  }
  return json({});
}) as typeof fetch;

const { SeasonDetail } = await import("../src/components/SeasonDetail");
const opened: string[] = [];
/** For checking by hand, with the keyboard. */
Object.assign(window, { opened, marked });
const root = document.getElementById("root")!;
createRoot(root).render(
  <SeasonDetail
    season={{ ratingKey: "s1", title: "Season 1", index: 1, type: "season" } as never}
    show={{ ratingKey: "sh", title: "The Show", type: "show" } as never}
    onSelectEpisode={(ep) => opened.push(ep.title)}
    onBack={() => {}}
  />,
);

const results: string[] = [];
const expect = (name: string, ok: boolean) => results.push(`${ok ? "PASS" : "FAIL"}: ${name}`);
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};
await until(() => (root.textContent ?? "").includes("Pilot"));
const ticks = [...root.querySelectorAll<HTMLElement>("[role=checkbox]")]
  .filter((el) => (el.getAttribute("aria-label") ?? "").includes("Pilot"));
expect("no control inside another: nothing focusable inside a button",
  root.querySelectorAll("button button, button a, button input, button [tabindex], button [role=checkbox]").length === 0);
expect("the tick is a checkbox a keyboard reaches, named for its episode",
  ticks.length === 1 && ticks[0].tabIndex === 0 && ticks[0].getAttribute("aria-checked") === "false");
[...root.querySelectorAll<HTMLElement>("span")].find((el) => el.textContent === "Pilot")?.click();
expect("clicking the card's title opens the episode", opened.join() === "Pilot");
ticks[0]?.click();
await until(() => marked.length > 0);
expect("clicking the tick marks it watched, without opening it", marked.join() === "e1" && opened.join() === "Pilot");
expect("the episode is still a button a keyboard reaches, named by its title",
  [...root.querySelectorAll("button")].some((b) => b.getAttribute("role") !== "checkbox" && (b.textContent ?? "").includes("Pilot")));
document.getElementById("verdict")!.textContent = results.join(" · ");
