import { useState, useCallback, useRef, useEffect } from "react";

interface SearchProps {
  onSearch: (query: string) => void;
  onClear: () => void;
  placeholder?: string;
  // Bumped by the parent (e.g. its Back button) to clear the field from outside.
  clearSignal?: number;
}

export function Search({ onSearch, onClear, placeholder = "Search your library...", clearSignal = 0 }: SearchProps) {
  const [value, setValue] = useState("");
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
    setValue("");
  }, [clearSignal]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const q = e.target.value;
      setValue(q);

      clearTimeout(debounceRef.current);
      if (q.trim().length === 0) {
        onClearRef.current();
        return;
      }
      debounceRef.current = setTimeout(() => onSearchRef.current(q.trim()), 400);
    },
    [],
  );

  // Clear the box and keep the cursor in the field, so the user can keep typing.
  const clearInput = useCallback(() => {
    clearTimeout(debounceRef.current);
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
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={styles.searchIcon}>
          <circle cx="7.5" cy="7.5" r="5.5" stroke="#666" strokeWidth="1.5"/>
          <path d="M12 12L16 16" stroke="#666" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
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
  searchIcon: {
    marginLeft: "14px",
    flexShrink: 0,
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
