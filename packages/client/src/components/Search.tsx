import { useState, useCallback, useRef, useEffect } from "react";

interface SearchProps {
  onSearch: (query: string) => void;
  onClear: () => void;
  placeholder?: string;
}

export function Search({ onSearch, onClear, placeholder = "Search your library..." }: SearchProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSearchRef = useRef(onSearch);
  const onClearRef = useRef(onClear);

  useEffect(() => { onSearchRef.current = onSearch; }, [onSearch]);
  useEffect(() => { onClearRef.current = onClear; }, [onClear]);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

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
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={styles.input}
        />
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
    borderColor: "rgba(229,160,13,0.3)",
    boxShadow: "0 0 0 3px rgba(229,160,13,0.08), inset 0 1px 4px rgba(0,0,0,0.2)",
  },
  searchIcon: {
    marginLeft: "14px",
    flexShrink: 0,
  },
  input: {
    width: "100%",
    padding: "12px 14px",
    fontSize: "15px",
    border: "none",
    background: "transparent",
    color: "#f0f0f0",
    outline: "none",
    fontFamily: "inherit",
  },
};
