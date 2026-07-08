/* Hairline icons, 16px grid, 1.6 stroke. */
type P = { className?: string };
const base = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const IconDash = (p: P) => (
  <svg {...base} className={p.className}><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>
);
export const IconRuns = (p: P) => (
  <svg {...base} className={p.className}><path d="M2 4h12M2 8h12M2 12h7" /></svg>
);
export const IconConnectors = (p: P) => (
  <svg {...base} className={p.className}><circle cx="4" cy="4" r="2" /><circle cx="12" cy="12" r="2" /><path d="M4 6v3a3 3 0 0 0 3 3h3" /></svg>
);
export const IconFlows = (p: P) => (
  <svg {...base} className={p.className}><rect x="2" y="2.5" width="9" height="11" rx="1.5" /><path d="M13.5 5v8a1.5 1.5 0 0 1-1.5 1.5H5" opacity="0.55" /><path d="M4.5 6h4M4.5 8.5h4M4.5 11h2.5" /></svg>
);
export const IconShield = (p: P) => (
  <svg {...base} className={p.className}><path d="M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4l5-2z" /></svg>
);
export const IconPlay = (p: P) => (
  <svg {...base} className={p.className}><path d="M5 3.5l7 4.5-7 4.5v-9z" fill="currentColor" stroke="none" /></svg>
);
export const IconArrow = (p: P) => (
  <svg {...base} className={p.className}><path d="M4 8h8M8.5 4.5L12 8l-3.5 3.5" /></svg>
);
export const IconBolt = (p: P) => (
  <svg {...base} className={p.className}><path d="M9 2L4 9h3.5L7 14l5-7H8.5L9 2z" /></svg>
);
