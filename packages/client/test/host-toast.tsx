// Manual/DOM regression fixture: npm run dev -w packages/client, then open
// /test/host-toast.html and Run. "You are now the host" as App says it
// (lib/usePromotedToast), through what a room's host goes through: opening it,
// being handed it, handing it back within the toast's two seconds — a host
// whose connection dropped coming back in its grace, 1.7 s later on 27 Oct,
// which left the toast up for the rest of the episode — the role not known
// while reconnecting, and being handed it twice. Not part of the production
// entry.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PROMOTED_TOAST_MS, usePromotedToast } from "../src/lib/usePromotedToast";

type Role = boolean | null;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shown = () => document.querySelector("[data-toast]")?.getAttribute("data-toast") === "true";

function Probe({ isHost }: { isHost: Role }) {
  const toast = usePromotedToast(isHost);
  return <p data-toast={String(toast)}>host: {String(isHost)} · {toast ? "You are now the host" : "no toast"}</p>;
}

function Fixture() {
  const [isHost, setIsHost] = useState<Role>(null);
  const [generation, setGeneration] = useState(0);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  async function run() {
    setRunning(true); setResults([]);
    let passed = 0, failed = 0;
    const say = (ok: boolean, text: string) => {
      if (ok) passed++; else failed++;
      setResults((lines) => [...lines, `${ok ? "PASS" : "FAIL"} ${text}`]);
    };
    // A client that has just joined: its role not known yet.
    const joined = async () => { setGeneration((n) => n + 1); setIsHost(null); await pause(50); };
    // Then told it is a viewer, and then the host.
    const handed = async () => { await joined(); setIsHost(false); await pause(50); setIsHost(true); };
    try {
      await joined(); setIsHost(true); await pause(100);
      say(!shown(), "opening the room as its host says nothing");

      await handed(); await pause(100);
      const said = shown();
      await pause(PROMOTED_TOAST_MS);
      say(said && !shown(), `handed the room: said, and gone ${PROMOTED_TOAST_MS / 1000} s later`);

      await handed(); await pause(1700); setIsHost(false); await pause(100);
      const back = !shown();
      await pause(PROMOTED_TOAST_MS + 500);
      say(back && !shown(), "handed back 1.7 s later: gone then, and stays gone");

      await handed(); await pause(500); setIsHost(null); await pause(100);
      const unknown = !shown();
      await pause(PROMOTED_TOAST_MS);
      say(unknown && !shown(), "reconnecting, the role not known: gone then, and stays gone");

      await handed(); await pause(1000); setIsHost(false); await pause(500); setIsHost(true);
      await pause(PROMOTED_TOAST_MS - 500);
      const again = shown();
      await pause(800);
      say(again && !shown(), `handed it twice: said again, for ${PROMOTED_TOAST_MS / 1000} s from the second`);
    } catch (error) {
      say(false, String(error));
    } finally {
      setResults((lines) => [...lines, `${passed} passed, ${failed} failed`]);
      setRunning(false);
    }
  }
  return (
    <main>
      <h1>Host toast checks</h1>
      <div className="tools">
        <button disabled={running} onClick={run}>{running ? "Checking…" : "Run host toast checks"}</button>
      </div>
      <Probe key={generation} isHost={isHost} />
      <pre aria-live="polite">{results.join("\n")}</pre>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
