// Manual/DOM regression fixture: npm run dev -w packages/client, then open
// /test/host-request-panel.html and Run. Asking the host for the role, as the
// People panel and the card over the page show it (11 November):
//  - nothing the host does in the activity answers for them: only Decline;
//  - the People panel carries the host's Accept and Decline, since the card
//    stands aside while it is open;
//  - Request host sits at the foot of the panel, above the Discord preference;
//  - a declined request is said the way "You are now the host" is: top centre.
// Not part of the production entry.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HostRequestOverlay } from "../src/components/HostRequestOverlay";
import { PeoplePanel } from "../src/components/PeoplePanel";
import type { HostRequestView } from "../src/lib/hostRequest";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const people = [
  { userId: "1", username: "host", isHost: true, isCoHost: false },
  { userId: "2", username: "viewer", isHost: false, isCoHost: false },
];
const view = (o: Partial<HostRequestView>): HostRequestView =>
  ({ on: true, now: Date.now(), active: null, blocked: null, reclaimUntil: null, offset: 0, ...o });
const asked = () => view({ active: { requesterId: "2", requesterName: "viewer", endsAt: Date.now() + 240_000 }, blocked: { why: "host" } as never });

function Fixture() {
  const [as, setAs] = useState<"host" | "viewer">("host");
  const [request, setRequest] = useState<HostRequestView>(view({}));
  const [panel, setPanel] = useState(false);
  const [answers, setAnswers] = useState<boolean[]>([]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const isHost = as === "host";

  async function run() {
    setRunning(true); setResults([]);
    let passed = 0, failed = 0;
    const say = (ok: boolean, text: string) => {
      if (ok) passed++; else failed++;
      setResults((lines) => [...lines, `${ok ? "PASS" : "FAIL"} ${text}`]);
    };
    const q = <T extends Element>(s: string) => document.querySelector<T>(s);
    const text = (s: string) => q(s)?.textContent ?? "";
    let got: boolean[] = [];
    const track = (a: boolean) => { got = [...got, a]; setAnswers(got); };
    (window as unknown as { __answer: (a: boolean) => void }).__answer = track;
    try {
      // The host, asked.
      setAs("host"); setPanel(false); setRequest(asked()); got = []; setAnswers([]);
      await pause(1700);
      say(text("[data-host-request]").includes("Host requested by viewer"), "the host sees who asked, with Accept and Decline");
      say(!text("[data-host-request]").includes("declines"), "  and isn't told that using the Activity declines");
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
      await pause(100);
      say(got.length === 0, "the host clicking or typing anywhere answers nothing");
      setPanel(true);
      await pause(100);
      say(got.length === 0 && !q("[data-host-request]"), "opening the People panel answers nothing; the card stands aside");
      const rows = [...document.querySelectorAll<HTMLElement>("[data-people-panel] button")];
      const accept = rows.find((b) => b.textContent === "Accept");
      const decline = rows.find((b) => b.textContent === "Decline");
      say(!!accept && !!decline && text("[data-people-panel]").includes("Host requested by"), "the panel has the request, with Accept and Decline");
      decline?.click();
      await pause(50);
      say(got.length === 1 && got[0] === false, "only Decline declines");

      // A viewer: where the button sits.
      setAs("viewer"); setRequest(view({})); setPanel(true);
      await pause(100);
      const ask = [...document.querySelectorAll<HTMLElement>("[data-people-panel] button")].find((b) => b.textContent === "Request host");
      const pref = [...document.querySelectorAll<HTMLElement>("[data-people-panel] label")].find((l) => l.textContent?.includes("Show media details on Discord"));
      const list = q<HTMLElement>("[data-people-list]");
      say(!!ask && !!pref && !!list
        && ask.getBoundingClientRect().top > list.getBoundingClientRect().bottom - 1
        && ask.getBoundingClientRect().bottom <= pref.getBoundingClientRect().top + 1,
        "Request host is below the roster and above Show media details on Discord");

      // A viewer whose request the host declined.
      setPanel(false);
      setRequest(view({ active: { requesterId: "2", requesterName: "viewer", endsAt: Date.now() + 60_000 }, blocked: { why: "asked" } as never }));
      await pause(100);
      setRequest(view({ blocked: { why: "you-declined", until: Date.now() + 7_200_000 } as never }));
      await pause(150);
      const note = q<HTMLElement>("[data-host-request-note]");
      const box = note?.getBoundingClientRect();
      say(!!note && !!box && Math.abs(box.left + box.width / 2 - window.innerWidth / 2) < 2 && box.top < 40,
        "a declined request is said at the top centre, as You are now the host is");
      say(!!note && getComputedStyle(note).fontSize === "14px" && getComputedStyle(note).fontWeight === "600", "  in the same type");
      await pause(3200);
      say(!q("[data-host-request-note]"), "  and for about three seconds");
    } finally {
      setResults((lines) => [...lines, `${passed} passed, ${failed} failed`]);
      setRunning(false);
    }
  }

  const answer = (a: boolean) => (window as unknown as { __answer?: (a: boolean) => void }).__answer?.(a);
  return (
    <main>
      <div className="tools">
        <button onClick={run} disabled={running}>{running ? "Running…" : "Run"}</button>
        <button onClick={() => { setAs("host"); setRequest(asked()); setPanel(false); }}>Host, asked</button>
        <button onClick={() => { setAs("host"); setRequest(asked()); setPanel(true); }}>Host, panel open</button>
        <button onClick={() => { setAs("viewer"); setRequest(view({})); setPanel(true); }}>Viewer, panel open</button>
      </div>
      <pre data-results>{results.join("\n")}</pre>
      <p>answers: {JSON.stringify(answers)}</p>
      {panel && (
        <div data-people-panel>
          <PeoplePanel participants={people as never} selfUserId={isHost ? "1" : "2"} isHost={isHost}
            onPromoteHost={() => {}} onSetCoHost={() => {}} onClose={() => setPanel(false)}
            sharePresenceDetails onSharePresenceDetails={() => {}}
            hostRequest={request} onRequestHost={() => {}} onAnswerHostRequest={answer} onReclaimHost={() => {}} />
        </div>
      )}
      <HostRequestOverlay view={request} selfUserId={isHost ? "1" : "2"} isHost={isHost} hostName="host"
        onAnswer={answer} onReclaim={() => {}} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
