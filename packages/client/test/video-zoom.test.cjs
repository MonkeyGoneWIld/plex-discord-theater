const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
// Exercise the hook's native event listeners and preference transitions without
// requiring a Plex stream or Discord authentication.
const saved = new Map();
const storage = { getItem: k => saved.get(k) ?? null, setItem: (k,v) => saved.set(k,v) };
let slots = [], cursor = 0, effects = [];
const react = {
  useRef: initial => { const i = cursor++; return slots[i] ??= {current:initial}; },
  useState: initial => { const i = cursor++; slots[i] ??= initial; return [slots[i], v => slots[i] = typeof v === "function" ? v(slots[i]) : v]; },
  useEffect: fn => { const i = cursor++; if (!slots[i]) { slots[i] = true; effects.push(fn); } }
};
function load(file, imports) {
  const module = {exports:{}};
  const code = ts.transpileModule(fs.readFileSync(file,"utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require:n=>imports[n],localStorage:storage,Date,Math});
  return module.exports;
}
const pref = load("packages/client/src/lib/videoZoom.ts",{});
const hook = load("packages/client/src/lib/useVideoZoom.ts",{"react":react,"./videoZoom":pref});
const listeners = {};
const root = { current: {
  addEventListener:(name,fn)=>listeners[name]=fn, removeEventListener:()=>{},
  querySelector:()=>null, getBoundingClientRect:()=>({width:1000,height:600})
}};
const notices = [];
function render(key) { cursor=0; const v=hook.useVideoZoom(root,key,message=>notices.push(message)); effects.splice(0).forEach(f=>f()); return v; }
const key1=pref.zoomKey({type:"episode",ratingKey:"11",grandparentRatingKey:"1"});
const key2=pref.zoomKey({type:"episode",ratingKey:"12",grandparentRatingKey:"1"});
let value=render(key1); value.setMode("manual"); value=render(key1); value.setZoom(145);
assert.equal(render(key2).zoom,145); assert.equal(notices.length,0);
render("movie:2");
assert.equal(render(key1).zoom,145);
slots=[]; effects=[]; assert.equal(render(key1).zoom,145);
let prevented=false;
const event={target:{matches:()=>true},clientY:200,ctrlKey:true,deltaY:-1,preventDefault:()=>prevented=true,stopPropagation:()=>{}};
listeners.wheel(event); assert.equal(render(key1).zoom,150); assert.ok(prevented); assert.equal(notices.at(-1),"Zoom: 150%");
render(key1).setMode("normal"); prevented=false;
listeners.wheel(event); assert.equal(prevented,false);
function touch(touches) { return {...event,touches}; }
listeners.touchstart(touch([{clientX:100,clientY:200},{clientX:200,clientY:200}]));
listeners.touchmove(touch([{clientX:80,clientY:200},{clientX:220,clientY:200}]));
assert.equal(render(key1).mode,"fill"); assert.equal(notices.at(-1),"Fill Screen");
listeners.touchend(touch([]));
render(key1).setMode("manual");
listeners.touchstart(touch([{clientX:100,clientY:200},{clientX:200,clientY:200}]));
listeners.touchmove(touch([{clientX:90,clientY:200},{clientX:210,clientY:200}]));
assert.equal(render(key1).zoom,120); assert.equal(notices.at(-1),"Zoom: 120%");
listeners.touchend(touch([]));
// Shift the pinch midpoint while zooming to 200%; translation is unsupported.
listeners.touchstart(touch([{clientX:100,clientY:200},{clientX:200,clientY:200}]));
listeners.touchmove(touch([{clientX:250,clientY:400},{clientX:450,clientY:400}]));
assert.equal(render(key1).zoom,200);
assert.equal("x" in render(key1),false);
assert.equal("y" in render(key1),false);
listeners.touchend(touch([]));
// Ignore only the trailing picture click, never a deliberate control click.
prevented=false; listeners.click(event); assert.equal(prevented,true);
prevented=false; listeners.click({...event,target:{matches:()=>false}}); assert.equal(prevented,false);
// One-finger dragging cannot pan, zoom, or swallow the next fresh tap.
const beforeDrag = notices.length;
listeners.touchstart(touch([{clientX:100,clientY:200}]));
prevented=false;
listeners.touchmove(touch([{clientX:140,clientY:220}]));
assert.equal(prevented,false);
assert.equal(render(key1).zoom,200);
assert.equal(notices.length,beforeDrag);
listeners.touchend(touch([]));
prevented=false; listeners.click(event); assert.equal(prevented,false);
render(key1).setZoom(50); assert.equal(render(key1).zoom,50);
slots=[]; effects=[]; assert.equal(render(key1).zoom,50);
const noticeCount = notices.length;
render(key1).setMode("fill"); render(key1).setMode("manual");
assert.equal(notices.length,noticeCount);
assert.equal(render(key1).zoom,100);
render(key1).setZoom(25); assert.equal(render(key1).zoom,50);
render(key1).setZoom(250); assert.equal(render(key1).zoom,200);
saved.set("pdt:videoZoom:v1","null"); assert.equal(pref.loadZoomPreference(key1).mode,"normal");
console.log("Zoom regression checks passed: episode continuity, remount persistence, title isolation, wheel gating, centered pinch and ignored single-finger drags.");
