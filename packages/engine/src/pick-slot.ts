/**
 * Slot-selection policy: turns a `slot_preference` input into one concrete
 * slot, deterministically.
 *
 * Portal availability responses come back as a list of candidate slots
 * (appointment times, provider openings, etc.). A task specifies how it
 * wants one picked — "first", "earliest", "latest", a specific index, or
 * "on or after" some date — and this module is the single place that
 * implements that policy.
 *
 * It is pure and dependency-free: no browser, no network, no clock reads
 * beyond parsing dates supplied in the data itself. That makes it fully
 * unit-testable and safe to reason about in isolation. Callers MUST treat a
 * `null` result as "no slot matched the policy" and handle that explicitly
 * (e.g. escalate or fail the task) rather than assuming a slot was found.
 */

export type PickPolicy =
  | "first"
  | "earliest"
  | "latest"
  | `index:${number}`
  | `on-or-after:${string}`; // ISO date/datetime, e.g. "on-or-after:2026-10-01"

export interface PickOptions {
  /** Field on each item to order/compare by (e.g. "DisplayDateTimeUtc"). Required for earliest/latest/on-or-after. */
  by?: string;
  /** How to interpret the `by` field when ordering. Default "date". */
  compare?: "date" | "number" | "string";
}

export interface PickResult {
  index: number; // index in the ORIGINAL array
  item: Record<string, unknown>;
}

interface Orderable {
  index: number;
  item: Record<string, unknown>;
  value: number | string;
}

/**
 * Compute the comparison value for an item per `opts.compare`. Returns
 * `undefined` when the value is missing/unparseable and therefore cannot
 * participate in ordering (date/number NaN cases).
 */
function comparableValue(
  item: Record<string, unknown>,
  by: string,
  compare: "date" | "number" | "string",
): number | string | undefined {
  const raw = item[by];
  if (raw === undefined || raw === null) return undefined;

  if (compare === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? undefined : n;
  }
  if (compare === "string") {
    return String(raw);
  }
  // "date"
  const t = new Date(String(raw)).getTime();
  return Number.isNaN(t) ? undefined : t;
}

function orderableItems(
  items: Array<Record<string, unknown>>,
  by: string | undefined,
  compare: "date" | "number" | "string",
): Orderable[] {
  if (!by) return [];
  const out: Orderable[] = [];
  items.forEach((item, index) => {
    const value = comparableValue(item, by, compare);
    if (value !== undefined) out.push({ index, item, value });
  });
  return out;
}

/** Stable min: earliest value, ties broken by lowest original index. */
function pickMin(candidates: Orderable[]): Orderable | undefined {
  let best: Orderable | undefined;
  for (const c of candidates) {
    if (!best || c.value < best.value || (c.value === best.value && c.index < best.index)) {
      best = c;
    }
  }
  return best;
}

/** Stable max: largest value, ties broken by lowest original index. */
function pickMax(candidates: Orderable[]): Orderable | undefined {
  let best: Orderable | undefined;
  for (const c of candidates) {
    if (!best || c.value > best.value || (c.value === best.value && c.index < best.index)) {
      best = c;
    }
  }
  return best;
}

export function pickByPolicy(
  items: Array<Record<string, unknown>>,
  policy: PickPolicy,
  opts?: PickOptions,
): PickResult | null {
  if (!Array.isArray(items) || items.length === 0) return null;

  const compare = opts?.compare ?? "date";

  if (policy === "first") {
    return { index: 0, item: items[0] };
  }

  if (policy === "earliest" || policy === "latest") {
    const candidates = orderableItems(items, opts?.by, compare);
    if (candidates.length === 0) return null;
    const winner = policy === "earliest" ? pickMin(candidates) : pickMax(candidates);
    if (!winner) return null;
    return { index: winner.index, item: winner.item };
  }

  const indexMatch = /^index:(-?\d+)$/.exec(policy);
  if (indexMatch) {
    const n = Number(indexMatch[1]);
    if (!Number.isInteger(n) || n < 0 || n >= items.length) return null;
    return { index: n, item: items[n] };
  }

  const onOrAfterMatch = /^on-or-after:(.+)$/.exec(policy);
  if (onOrAfterMatch) {
    const thresholdRaw = onOrAfterMatch[1];
    const threshold = new Date(thresholdRaw).getTime();
    if (Number.isNaN(threshold)) return null;

    const candidates = orderableItems(items, opts?.by, compare);
    const qualifying = candidates.filter((c) => c.value >= threshold);
    const winner = pickMin(qualifying);
    if (!winner) return null;
    return { index: winner.index, item: winner.item };
  }

  // Unrecognized policy string — fail closed, never throw.
  return null;
}
