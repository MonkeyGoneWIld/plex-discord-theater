import { useState, useRef, useEffect, useCallback } from "react";
import type { Genre } from "../lib/api";

const SORT_OPTIONS = [
  { value: "titleSort:asc", label: "Title A-Z" },
  { value: "year:desc", label: "Year (Newest)" },
  { value: "year:asc", label: "Year (Oldest)" },
  { value: "addedAt:desc", label: "Recently Added" },
  { value: "audienceRating:desc", label: "Highest Rated" },
] as const;

interface FilterBarProps {
  genres: Genre[];
  selectedGenres: string[];
  onGenresChange: (ids: string[]) => void;
  sort: string;
  onSortChange: (sort: string) => void;
}

export function FilterBar({
  genres,
  selectedGenres,
  onGenresChange,
  sort,
  onSortChange,
}: FilterBarProps) {
  const [genreOpen, setGenreOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const genreRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);

  const hasFilters = selectedGenres.length > 0 || sort !== "titleSort:asc";

  // Close dropdowns on outside click or Escape
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (genreRef.current && !genreRef.current.contains(e.target as Node)) {
        setGenreOpen(false);
      }
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setGenreOpen(false);
        setSortOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  const toggleGenre = useCallback(
    (id: string) => {
      onGenresChange(
        selectedGenres.includes(id)
          ? selectedGenres.filter((g) => g !== id)
          : [...selectedGenres, id],
      );
    },
    [selectedGenres, onGenresChange],
  );

  const handleClear = useCallback(() => {
    onGenresChange([]);
    onSortChange("titleSort:asc");
  }, [onGenresChange, onSortChange]);

  const sortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "Sort";

  return (
    <div style={styles.bar}>
      {/* Genre dropdown */}
      <div ref={genreRef} style={styles.dropdownWrap}>
        <button
          onClick={() => { setGenreOpen((o) => !o); setSortOpen(false); }}
          style={{
            ...styles.dropdownBtn,
            ...(genreOpen || selectedGenres.length > 0 ? styles.dropdownBtnActive : {}),
          }}
        >
          Genre{selectedGenres.length > 0 ? ` (${selectedGenres.length})` : ""}
          <Chevron />
        </button>
        {genreOpen && (
          <div style={styles.panel}>
            <div style={styles.panelScroll}>
              {genres.map((g) => {
                const selected = selectedGenres.includes(g.id);
                return (
                  <label
                    key={g.id}
                    style={{
                      ...styles.checkRow,
                      ...(selected ? styles.checkRowSelected : {}),
                    }}
                  >
                    <span
                      style={{
                        ...styles.checkbox,
                        ...(selected ? styles.checkboxChecked : {}),
                      }}
                    >
                      {selected && (
                        <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                          <path d="M1 4L3.5 6.5L9 1" stroke="#1a1a2e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleGenre(g.id)}
                      style={{ display: "none" }}
                    />
                    <span style={styles.checkLabel}>{g.title}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Sort dropdown */}
      <div ref={sortRef} style={styles.dropdownWrap}>
        <button
          onClick={() => { setSortOpen((o) => !o); setGenreOpen(false); }}
          style={{
            ...styles.dropdownBtn,
            ...(sortOpen || sort !== "titleSort:asc" ? styles.dropdownBtnActive : {}),
          }}
        >
          {sortLabel}
          <Chevron />
        </button>
        {sortOpen && (
          <div style={styles.panel}>
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => { onSortChange(o.value); setSortOpen(false); }}
                style={{
                  ...styles.sortOption,
                  ...(o.value === sort ? styles.sortOptionActive : {}),
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Clear filters */}
      {hasFilters && (
        <button onClick={handleClear} style={styles.clearBtn}>
          Clear
        </button>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ marginLeft: 6, flexShrink: 0 }}>
      <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "0 24px 12px",
    flexWrap: "wrap",
  },
  dropdownWrap: {
    position: "relative",
  },
  dropdownBtn: {
    display: "flex",
    alignItems: "center",
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    color: "#888",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 500,
    fontFamily: "inherit",
    transition: "all 0.2s ease",
    whiteSpace: "nowrap",
  },
  dropdownBtnActive: {
    borderColor: "rgba(229,160,13,0.3)",
    color: "#e5a00d",
    background: "rgba(229,160,13,0.08)",
  },
  panel: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    minWidth: "200px",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(20,20,40,0.95)",
    backdropFilter: "blur(20px)",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    zIndex: 50,
    overflow: "hidden",
    padding: "4px 0",
  },
  panelScroll: {
    maxHeight: "280px",
    overflowY: "auto",
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 14px",
    cursor: "pointer",
    transition: "background 0.15s ease",
    userSelect: "none",
  },
  checkRowSelected: {
    background: "rgba(229,160,13,0.06)",
  },
  checkbox: {
    width: "16px",
    height: "16px",
    borderRadius: "4px",
    border: "1.5px solid rgba(255,255,255,0.2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "all 0.15s ease",
  },
  checkboxChecked: {
    background: "#e5a00d",
    borderColor: "#e5a00d",
  },
  checkLabel: {
    color: "#ccc",
    fontSize: "13px",
  },
  sortOption: {
    display: "block",
    width: "100%",
    padding: "9px 14px",
    border: "none",
    background: "transparent",
    color: "#ccc",
    fontSize: "13px",
    fontFamily: "inherit",
    textAlign: "left",
    cursor: "pointer",
    transition: "background 0.15s ease",
  },
  sortOptionActive: {
    color: "#e5a00d",
    background: "rgba(229,160,13,0.08)",
  },
  clearBtn: {
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.06)",
    background: "transparent",
    color: "#666",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
    fontFamily: "inherit",
    transition: "all 0.2s ease",
  },
};
