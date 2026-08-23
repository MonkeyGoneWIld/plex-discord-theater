/**
 * Turning the volume past what the element can do.
 *
 * There is no Web Audio in here, which is the point: this is the path every
 * browser takes before the graph is up, and the one it stays on for good if the
 * graph can't be built. Getting it wrong doesn't make the boost not work, it
 * makes the volume not work — so what is pinned down below is that the ordinary
 * 0–100% behaviour is exactly what it was, and that asking for more than can be
 * delivered reports back what actually happened rather than what was asked for.
 */
import { setLevel, getLevel, boostAvailable, MAX_LEVEL } from "../src/lib/audioBoost";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`); }
}

/**
 * Just enough of a media element: a volume that announces its own changes, the
 * way the real one does, and does not announce a no-op — which is exactly why
 * the module sends an event by hand when only the gain moved.
 */
class FakeMedia extends EventTarget {
  #volume = 1;
  get volume(): number { return this.#volume; }
  set volume(v: number) {
    if (v === this.#volume) return;
    this.#volume = v;
    this.dispatchEvent(new Event("volumechange"));
  }
}
const media = () => new FakeMedia() as unknown as HTMLMediaElement;

/** Let the graph attempt settle — it is a promise chain either way. */
const settle = () => new Promise((r) => setTimeout(r, 0));

console.log("\n— the range the element can do itself —");
{
  const v = media();
  setLevel(v, 0.5);
  check("half", [v.volume, getLevel(v)], [0.5, 0.5]);
  setLevel(v, 0);
  check("silent", [v.volume, getLevel(v)], [0, 0]);
  setLevel(v, 1);
  check("full", [v.volume, getLevel(v)], [1, 1]);
  setLevel(v, -3);
  check("below the floor clamps", getLevel(v), 0);
}

console.log("\n— every change is announced —");
{
  // The player persists the level and the control bar mirrors it, both off this
  // one event. A change nobody hears about is a slider that goes stale.
  const v = media();
  let heard = 0;
  v.addEventListener("volumechange", () => { heard++; });
  setLevel(v, 0.4);
  check("a change to the element fires one", heard, 1);
  setLevel(v, 0.4);
  // Assigning the same number to video.volume fires nothing natively, so this
  // is the case that needs the event sent by hand.
  check("setting the same level still fires one", heard, 2);
}

console.log("\n— asking for more than can be delivered —");
{
  const v = media();
  setLevel(v, 1.5);
  await settle();
  // No Web Audio here, so there is no boost to be had. The level has to come
  // back as 100%: a slider left sitting at 150% would be claiming loudness
  // nobody can hear, and the remembered level would carry the lie into the
  // next session.
  check("clamps to what the element can do", getLevel(v), 1);
  check("and the element is at its own maximum", v.volume, 1);
  check("boost reports itself unavailable afterwards", boostAvailable(), false);
}

console.log("\n— something else writes the element —");
{
  const v = media();
  setLevel(v, 1);
  // A code path that sets video.volume directly is the more recent answer, and
  // below 100% the two numbers are the same one anyway.
  v.volume = 0.25;
  check("the element wins", getLevel(v), 0.25);
}

console.log("\n— the ceiling —");
{
  const v = media();
  setLevel(v, 99);
  await settle();
  check("nothing goes past MAX_LEVEL", getLevel(v) <= MAX_LEVEL, true);
  check("MAX_LEVEL is 200%", MAX_LEVEL, 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
