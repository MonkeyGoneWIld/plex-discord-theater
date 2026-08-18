import { useState, useCallback, useRef, useEffect } from "react";

interface SearchProps {
  onSearch: (query: string) => void;
  onClear: () => void;
  placeholder?: string;
  // Bumped by the parent (e.g. its Back button) to clear the field from outside.
  clearSignal?: number;
  /**
   * Whether the parent's search request is still in flight.
   *
   * Combined with this component's own debounce window, which is the other half
   * of the wait — and the half the parent can't see. Between them they cover
   * the whole gap between the last keystroke and results appearing, which is
   * otherwise a second or more of the screen doing nothing.
   */
  busy?: boolean;
}

export function Search({ onSearch, onClear, placeholder = "Search your library...", clearSignal = 0, busy = false }: SearchProps) {
  const [value, setValue] = useState("");
  // A keystroke has landed and the debounce hasn't fired yet. Tracked here
  // because the timer lives here — the parent has no way to know about it.
  const [pending, setPending] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSearchRef = useRef(onSearch);
  const onClearRef = useRef(onClear);

  useEffect(() => { onSearchRef.current = onSearch; }, [onSearch]);
  useEffect(() => { onClearRef.current = onClear; }, [onClear]);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  // External clear (parent bumped clearSignal). Skip the initial value so we
  // don't blow away a query on first mount.
  const firstSignal = useRef(clearSignal);
  useEffect(() => {
    if (clearSignal === firstSignal.current) return;
    clearTimeout(debounceRef.current);
    setPending(false);
    setValue("");
  }, [clearSignal]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const q = e.target.value;
      setValue(q);

      clearTimeout(debounceRef.current);
      if (q.trim().length === 0) {
        setPending(false);
        onClearRef.current();
        return;
      }
      // One character is not a search: each one costs a Plex /hubs/search, a
      // Discover cloud search and up to 15 parallel ownership lookups, so
      // typing "the" fired three of those before this floor.
      if (q.trim().length < 2) {
        setPending(false);
        return;
      }
      setPending(true);
      debounceRef.current = setTimeout(() => {
        setPending(false);
        onSearchRef.current(q.trim());
      }, 400);
    },
    [],
  );

  // Clear the box and keep the cursor in the field, so the user can keep typing.
  const clearInput = useCallback(() => {
    clearTimeout(debounceRef.current);
    setPending(false);
    setValue("");
    onClearRef.current();
    inputRef.current?.focus();
  }, []);

  return (
    <div style={styles.container}>
      <div style={{
        ...styles.inputWrap,
        ...(focused ? styles.inputWrapFocused : {}),
      }}>
        {/* The magnifier becomes a spinner while a search is on its way. Same
            place, same size, so nothing shifts — and it is in the one part of
            the screen the user is already looking at, which matters because the
            results area behind it may still be showing the previous view. */}
        {pending || busy ? (
          // Wrapped in a box with the icon's exact footprint and margin rather
          // than styled to match it: the spinner is smaller than the magnifier,
          // so sharing the layout box is what keeps the two centred on the same
          // point instead of one sitting flush against the edge.
          <span style={styles.searchIconSlot} role="status" aria-label="Searching">
            <span style={styles.searchSpinner} />
          </span>
        ) : (
          <span style={styles.searchIconSlot}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="7.5" cy="7.5" r="5.5" stroke="#666" strokeWidth="1.5"/>
              <path d="M12 12L16 16" stroke="#666" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={styles.input}
        />
        {value.length > 0 && (
          <button
            type="button"
            onClick={clearInput}
            style={styles.clearBtn}
            aria-label="Clear search"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // The one slot both the magnifier and the spinner sit in, so swapping them
  // moves nothing. Carries the margin the icon used to hold itself.
  searchIconSlot: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    marginLeft: "14px",
    flexShrink: 0,
  },
  searchSpinner: {
    width: "15px",
    height: "15px",
    border: "2px solid rgba(229,160,13,0.25)",
    borderTopColor: "#e5a00d",
    borderRadius: "50%",
    animation: "spin 0.7s linear infinite",
  },
  container: {
    padding: "16px 24px",
  },
  inputWrap: {
    display: "flex",
    alignItems: "center",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    transition: "all 0.2s ease",
    overflow: "hidden",
  },
  inputWrapFocused: {
    // Full shorthand — see the note in SeasonDetail's episodeCard. A
    // borderColor-only override leaves the box white-bordered after blur.
    border: "1px solid rgba(229,160,13,0.3)",
    boxShadow: "0 0 0 3px rgba(229,160,13,0.08), inset 0 1px 4px rgba(0,0,0,0.2)",
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: "12px 14px",
    fontSize: "15px",
    border: "none",
    background: "transparent",
    color: "#f0f0f0",
    outline: "none",
    fontFamily: "inherit",
  },
  clearBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "28px",
    height: "28px",
    marginRight: "10px",
    padding: 0,
    borderRadius: "50%",
    border: "none",
    background: "rgba(255,255,255,0.08)",
    color: "#bbb",
    cursor: "pointer",
  },
};
