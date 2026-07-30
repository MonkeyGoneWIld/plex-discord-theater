import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { useMediaQuery } from "../lib/useMediaQuery";

// "Desktop" here means a device with a precise, hover-capable pointer — a mouse.
// Discord on a phone/tablet reports `hover: none` / `pointer: coarse`, so it
// falls through to the plain native-scroll row below: the hover-reveal chevrons
// would be dead weight there, and finger-swiping the shelf is what's expected.
const DESKTOP_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

interface ScrollShelfProps {
  children: ReactNode;
  /** Inline style for the scroller itself (the flex row) — shared with the
   *  mobile branch so both look identical apart from the added controls. */
  rowStyle: CSSProperties;
}

/**
 * A horizontally-scrolling poster row. On touch it's exactly the plain row it
 * always was. On a mouse-driven desktop it gains: edge-fade chevrons (click to
 * page, hold to glide) that hide at each end, click-and-drag to pan, and a
 * custom thin scrollbar that only appears on hover. The mouse wheel is left
 * alone — it always scrolls the page vertically.
 *
 * The scrollbar is a drawn element rather than the browser's: the app sets an
 * inherited `scrollbar-color` on <html>, and once that's inherited Chromium
 * renders the standard scrollbar (with end-arrow buttons) and ignores every
 * `::-webkit-scrollbar` rule — so a native bar can't be made arrow-less here.
 */
export function ScrollShelf({ children, rowStyle }: ScrollShelfProps) {
  const isDesktop = useMediaQuery(DESKTOP_POINTER_QUERY);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ down: false, startX: 0, startLeft: 0, moved: false });
  const holdRef = useRef<{ raf: number; hold: boolean; timer: number } | null>(null);

  // Reconcile the chevrons and the custom scrollbar with the current scroll
  // position: hide each chevron at its end, size/place the thumb, keep the
  // chevrons centered on the poster art (a fixed 2:3 image, so its height is the
  // card width x 1.5 — measured from the first card so it tracks the layout).
  const sync = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const max = sc.scrollWidth - sc.clientWidth;
    leftRef.current?.classList.toggle("shelf-chev-dis", sc.scrollLeft <= 1);
    rightRef.current?.classList.toggle("shelf-chev-dis", sc.scrollLeft >= max - 1);

    const first = sc.firstElementChild as HTMLElement | null;
    if (first) {
      const posterH = `${first.getBoundingClientRect().width * 1.5}px`;
      if (leftRef.current) leftRef.current.style.height = posterH;
      if (rightRef.current) rightRef.current.style.height = posterH;
    }

    const bar = barRef.current;
    const thumb = thumbRef.current;
    if (bar && thumb) {
      if (max <= 0) {
        bar.style.visibility = "hidden";
      } else {
        bar.style.visibility = "";
        const tw = Math.max(36, (sc.clientWidth / sc.scrollWidth) * bar.clientWidth);
        thumb.style.width = `${tw}px`;
        thumb.style.left = `${(sc.scrollLeft / max) * (bar.clientWidth - tw)}px`;
      }
    }
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    const sc = scrollerRef.current;
    if (!sc) return;
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [isDesktop, sync, children]);

  // Click-and-drag to pan. A small threshold distinguishes a pan from a click,
  // and onClickCapture swallows the trailing click so a drag never opens a card.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const sc = scrollerRef.current;
    if (!sc) return;
    const st = dragRef.current;
    st.down = true; st.startX = e.clientX; st.startLeft = sc.scrollLeft; st.moved = false;
    const move = (ev: PointerEvent) => {
      if (!st.down) return;
      const dx = ev.clientX - st.startX;
      if (Math.abs(dx) > 6) st.moved = true;
      sc.scrollLeft = st.startLeft - dx;
    };
    const up = () => {
      st.down = false;
      sc.style.removeProperty("cursor");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    sc.style.cursor = "grabbing";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (dragRef.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current.moved = false;
    }
  }, []);

  // Chevron: nudge ~a screen on press, then glide continuously while held.
  const press = useCallback((dir: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const sc = scrollerRef.current;
    if (!sc) return;
    sc.scrollBy({ left: dir * sc.clientWidth * 0.8, behavior: "smooth" });
    const h = { raf: 0, hold: false, timer: 0 };
    holdRef.current = h;
    h.timer = window.setTimeout(() => {
      h.hold = true;
      const glide = () => { if (!h.hold) return; sc.scrollLeft += dir * 12; h.raf = requestAnimationFrame(glide); };
      glide();
    }, 300);
  }, []);

  const release = useCallback(() => {
    const h = holdRef.current;
    if (!h) return;
    clearTimeout(h.timer); h.hold = false; cancelAnimationFrame(h.raf);
  }, []);

  // Drag the custom scrollbar thumb to scroll.
  const onThumbDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const sc = scrollerRef.current, bar = barRef.current, thumb = thumbRef.current;
    if (!sc || !bar || !thumb) return;
    const startX = e.clientX, startLeft = sc.scrollLeft, tw = thumb.offsetWidth;
    const trackable = bar.clientWidth - tw, max = sc.scrollWidth - sc.clientWidth;
    thumb.style.cursor = "grabbing";
    const move = (ev: PointerEvent) => {
      if (trackable <= 0) return;
      sc.scrollLeft = startLeft + ((ev.clientX - startX) / trackable) * max;
    };
    const up = () => {
      thumb.style.removeProperty("cursor");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  if (!isDesktop) {
    return <div style={rowStyle} className="scroll-row">{children}</div>;
  }

  return (
    <div className="shelf">
      <div
        ref={leftRef}
        className="shelf-chev shelf-chev-l shelf-chev-dis"
        role="button"
        tabIndex={-1}
        aria-label="Scroll left"
        onPointerDown={press(-1)}
        onPointerUp={release}
        onPointerLeave={release}
      >
        <span>&lsaquo;</span>
      </div>
      <div
        ref={scrollerRef}
        className="shelf-scroller"
        style={rowStyle}
        onScroll={sync}
        onPointerDown={onPointerDown}
        onClickCapture={onClickCapture}
      >
        {children}
      </div>
      <div
        ref={rightRef}
        className="shelf-chev shelf-chev-r shelf-chev-dis"
        role="button"
        tabIndex={-1}
        aria-label="Scroll right"
        onPointerDown={press(1)}
        onPointerUp={release}
        onPointerLeave={release}
      >
        <span>&rsaquo;</span>
      </div>
      <div className="shelf-bar" ref={barRef}>
        <div className="shelf-thumb" ref={thumbRef} onPointerDown={onThumbDown} />
      </div>
    </div>
  );
}
