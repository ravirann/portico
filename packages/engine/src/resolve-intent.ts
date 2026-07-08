/**
 * Fuzzy intent resolution against a set of canonical candidates.
 *
 * Portal automation runs against messy, task-supplied intent strings
 * ("Southview", "  primary   CARE ", ...) that need to be mapped onto the
 * exact clinic/provider/reason strings a given portal actually exposes.
 * Picking the wrong candidate silently is unacceptable at scale — a fuzzy
 * match that's actually ambiguous (e.g. two clinics both starting with
 * "Southview") must never be resolved by guesswork.
 *
 * This module is the safety layer for that decision: it is pure and
 * dependency-free so it can be unit-tested exhaustively and reasoned about
 * in isolation from any browser/model/network concern. It fails loud —
 * callers MUST treat "ambiguous" and "none" as a signal to refuse the task
 * or escalate to a human, never as "pick the first one and move on."
 */

export type IntentMatch =
  | { status: "resolved"; value: string; matchedBy: "exact" | "startsWith" | "contains" }
  | { status: "ambiguous"; matches: string[] }
  | { status: "none" };

export interface ResolveIntentOptions {
  /** Reserved for future policies; only "unique" is implemented (the default). */
  policy?: "unique";
}

/** Trim, collapse internal whitespace, and lowercase for comparison purposes only. */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Resolve a fuzzy `input` string against a list of canonical `candidates`.
 *
 * Matching is tiered from most to least specific — exact, then startsWith,
 * then contains — and the FIRST tier that produces any match wins; later
 * (looser) tiers are never consulted once an earlier tier has a hit. This is
 * what lets an exact match win even when the same input is also a substring
 * of other candidates (see module tests for a worked example).
 *
 * Within the winning tier, candidates are deduplicated by their normalized
 * form (so case/whitespace variants of the same underlying string collapse
 * to a single logical match, keeping the first original occurrence). If
 * that leaves exactly one distinct value, it resolves; if more than one
 * remains, the result is ambiguous and the caller must not guess.
 */
export function resolveIntent(
  input: string,
  candidates: string[],
  _opts?: ResolveIntentOptions,
): IntentMatch {
  const normalizedInput = normalize(input);
  if (normalizedInput === "" || candidates.length === 0) {
    return { status: "none" };
  }

  const tiers: Array<{ matchedBy: "exact" | "startsWith" | "contains"; test: (c: string) => boolean }> = [
    { matchedBy: "exact", test: (c) => c === normalizedInput },
    { matchedBy: "startsWith", test: (c) => c.startsWith(normalizedInput) },
    { matchedBy: "contains", test: (c) => c.includes(normalizedInput) },
  ];

  for (const tier of tiers) {
    // Collect originals matching this tier, deduped by normalized form,
    // preserving the first original occurrence and original order.
    const seen = new Set<string>();
    const originals: string[] = [];
    for (const candidate of candidates) {
      const normalizedCandidate = normalize(candidate);
      if (!tier.test(normalizedCandidate)) continue;
      if (seen.has(normalizedCandidate)) continue;
      seen.add(normalizedCandidate);
      originals.push(candidate);
    }

    if (originals.length === 0) continue; // no match at this tier — try the next, looser tier

    if (originals.length === 1) {
      return { status: "resolved", value: originals[0], matchedBy: tier.matchedBy };
    }
    return { status: "ambiguous", matches: originals };
  }

  return { status: "none" };
}
