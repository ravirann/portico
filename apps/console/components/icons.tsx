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
export const IconSessions = (p: P) => (
  <svg {...base} className={p.className}><rect x="2" y="3" width="12" height="9" rx="1.5" /><path d="M2 6h12" /><circle cx="4" cy="4.5" r="0.4" fill="currentColor" stroke="none" /><path d="M6 14h4" opacity="0.55" /></svg>
);
export const IconSettings = (p: P) => (
  <svg {...base} className={p.className}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v1.6M8 12.9v1.6M2.4 8H1M15 8h-1.4M4 4l1 1M11 11l1 1M12 4l-1 1M5 11l-1 1" /></svg>
);
export const IconPlus = (p: P) => (
  <svg {...base} className={p.className}><path d="M8 3.5v9M3.5 8h9" /></svg>
);
export const IconTrash = (p: P) => (
  <svg {...base} className={p.className}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" /></svg>
);
export const IconEdit = (p: P) => (
  <svg {...base} className={p.className}><path d="M11 2.5l2.5 2.5M2.5 11L10 3.5 12.5 6 5 13.5H2.5V11z" /></svg>
);
export const IconHelp = (p: P) => (
  <svg {...base} className={p.className}><circle cx="8" cy="8" r="6" /><path d="M6.1 6.1a1.9 1.9 0 0 1 3.7.6c0 1.3-1.9 1.7-1.9 3" /><path d="M8 11.5v.01" /></svg>
);
export const IconLayers = (p: P) => (
  <svg {...base} className={p.className}><path d="M8 2 2 5l6 3 6-3-6-3z" /><path d="M2 8l6 3 6-3" opacity="0.55" /><path d="M2 11l6 3 6-3" opacity="0.35" /></svg>
);
export const IconAudit = (p: P) => (
  <svg {...base} className={p.className}><rect x="3" y="2" width="8.5" height="12" rx="1.2" /><path d="M5.2 5.2h4.1M5.2 7.6h4.1M5.2 10h2.3" /><path d="M10.5 11.5l1.3 1.3 2.5-2.8" /></svg>
);
