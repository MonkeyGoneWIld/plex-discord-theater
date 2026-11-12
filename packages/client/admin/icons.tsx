/** The dashboard's icons: 24-unit outlines, drawn in the colour of the text around them. */
const PATHS: Record<string, string[]> = {
  now: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M10 8.5v7l6-3.5-6-3.5Z"],
  history: ["M3 12a9 9 0 1 0 3-6.7", "M3 4v4h4", "M12 7v5l3 2"],
  graphs: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"],
  people: ["M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M2.5 20a6.5 6.5 0 0 1 13 0", "M16 4.5a3.5 3.5 0 0 1 0 6.5", "M18 14.5a6 6 0 0 1 3.5 5.5"],
  places: ["M9 4 7 20", "M17 4l-2 16", "M4 9h17", "M3 15h17"],
  requests: ["M4 13h4l1.5 3h5L16 13h4", "M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2.5-8Z"],
  caches: ["M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z", "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
  logs: ["M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z", "m8 9 3 3-3 3", "M13 15h3"],
  settings: ["M4 7h10", "M18 7h2", "M4 17h2", "M10 17h10", "M16 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z", "M8 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"],
  film: ["M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z", "M7 4v16", "M17 4v16", "M3 9h4", "M3 15h4", "M17 9h4", "M17 15h4"],
  upload: ["M12 16V4", "m7 9 5-5 5 5", "M4 20h16"],
  users: ["M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M5 20a7 7 0 0 1 14 0"],
  stream: ["M3 7h18", "M3 12h18", "M3 17h12"],
  split: ["M12 3v18", "M4 8l8-5 8 5", "M4 16l8 5 8-5"],
  pulse: ["M3 12h4l2.5-6 4 12L16 12h5"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 2"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  alert: ["M12 4 2.5 20h19L12 4Z", "M12 10v4", "M12 17v.5"],
  download: ["M12 4v12", "m7 11 5 5 5-5", "M4 20h16"],
  signout: ["M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5", "M10 12H3", "m6 8-4 4 4 4"],
  chevron: ["m9 6 6 6-6 6"],
  back: ["M15 6 9 12l6 6"],
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths = PATHS[name] ?? PATHS.film;
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** The dashboard's mark: a play button on the app's amber, plain enough to read in a browser tab. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#e5a00d" />
      <path d="M10 8.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72l-12.5-7.5A1 1 0 0 0 10 8.5Z" fill="#14161b" />
    </svg>
  );
}
