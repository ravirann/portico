/**
 * Two-source authoring: reconcile the Stagehand agent's OWN action stream against
 * the DOM click-hook stream, and compile from the merge instead of raw clicks.
 *
 * Why this exists: the agent navigates correctly (live per-step reasoning), but
 * the YAML was compiled only from raw DOM clicks — a lossy reconstruction that
 * froze noise (dashboard cards, notification blobs) and mis-identified elements.
 * The agent already knows, per action, its INTENT ("click the New Patient Adult
 * Visit option") and the element it resolved (`playwrightArguments.selector`, an
 * `xpath=…`). That is strictly richer than a scraped click. So we use:
 *
 *   • the agent stream  → the authority on INTENT + SEQUENCE (which interactions
 *                         were deliberate — drops the noise the agent never did),
 *   • the DOM-hook stream → the authority on ELEMENT IDENTITY (role / accessible
 *                         name / testid, captured at click time) for a resilient
 *                         `getByRole(name)` replay locator.
 *
 * Neither alone is complete (the agent gives xpath + intent but not role/name;
 * the hook gives identity but no intent and includes noise), so we join them.
 *
 * Ground truth for the shapes below (verified against @browserbasehq/stagehand
 * 3.6.0): our Claude model resolves the agent to hybrid/dom mode (never CUA), so
 * `AgentResult.actions` carries, per `act` tool call, `{ type:"act", action,
 * reasoning, playwrightArguments?: { selector:"xpath=…", description, method,
 * arguments } }`. `AgentAction` is loosely typed (`[key:string]: unknown`), so we
 * parse defensively rather than trusting a declared shape.
 */
import type { ClickEvent } from "@portico/flow-spec";

/** One deliberate interaction distilled from the agent's action stream. */
export interface AgentActionRecord {
  /** Position in the raw actions array (preserves order). */
  index: number;
  /** Raw Stagehand tool type ("act", "click", "type", …). */
  type: string;
  /** Coarse interaction kind we care about for replay. */
  kind: "click" | "fill" | "press" | "other";
  /** Best concise human label: element description → action instruction → reasoning. */
  label: string;
  /** Resolved selector with the `xpath=` prefix stripped, when the tool resolved one. */
  xpath?: string;
  /** Playwright method the agent used ("click", "fill", "press", …). */
  method?: string;
  /** Typed text for a fill/type action. */
  value?: string;
}

/** Provenance + confidence for one reconciled step (for logging + tier hints). */
export interface ReconcileMeta {
  source: "both" | "agent-only";
  confidence: "high" | "medium" | "low";
  label: string;
}

export interface ReconcileResult {
  /** The reconciled, ordered replay steps (a ClickEvent[] the compiler consumes). */
  steps: ClickEvent[];
  meta: ReconcileMeta[];
  /** False ⇒ the agent stream was thin / didn't correlate; caller uses the DOM-hook path. */
  usedAgentStream: boolean;
  /** Hook clicks the agent never corroborated (dropped as noise) — approximate. */
  droppedNoise: number;
}

// Tool types that represent a replayable DOM interaction (beyond the ones that
// carry playwrightArguments, which are always treated as interactions).
const INTERACTION_TYPES = new Set(["act", "click", "type", "tap", "fill", "press"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

function kindOf(method: string | undefined, type: string): AgentActionRecord["kind"] {
  const m = (method ?? "").toLowerCase();
  if (m.includes("fill") || m.includes("type") || type === "type" || type === "fill") return "fill";
  if (m.includes("press") || m.includes("key") || type === "press") return "press";
  if (m.includes("click") || m.includes("tap") || type === "act" || type === "click" || type === "tap") return "click";
  return "other";
}

/**
 * Distill `AgentResult.actions` (loose, tool-shaped objects) into ordered
 * interaction records. Only entries that resolved a DOM action (have
 * `playwrightArguments`) or are an interaction tool type are kept; navigation /
 * scroll / screenshot / think / done are ignored.
 */
export function extractAgentActions(raw: readonly unknown[] | undefined): AgentActionRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentActionRecord[] = [];
  raw.forEach((r, i) => {
    if (!r || typeof r !== "object") return;
    const a = r as Record<string, unknown>;
    const type = str(a.type) ?? "";
    const pw =
      a.playwrightArguments && typeof a.playwrightArguments === "object"
        ? (a.playwrightArguments as Record<string, unknown>)
        : undefined;
    if (!pw && !INTERACTION_TYPES.has(type)) return;

    const method = str(pw?.method);
    const selector = str(pw?.selector);
    const xpath = selector ? selector.replace(/^xpath=/, "").replace(/\/+$/, "").trim() : undefined;
    const args = Array.isArray(pw?.arguments) ? (pw!.arguments as unknown[]) : [];
    const value = str(args[0]);
    // Prefer the element description (what it IS) over the imperative instruction.
    const label = str(pw?.description) ?? str(a.action) ?? str(a.instruction) ?? str(a.reasoning) ?? "";
    if (!label && !xpath) return;

    out.push({ index: i, type, kind: kindOf(method, type), label, xpath: xpath || undefined, method, value });
  });
  return out;
}

// ── matching helpers ────────────────────────────────────────────────────────

const STOP = new Set([
  "the", "a", "an", "to", "of", "on", "in", "and", "or", "for", "with", "your", "this", "that",
  "click", "select", "choose", "press", "tap", "open", "go", "button", "link", "option", "tab", "menu", "item", "page",
]);

function tokens(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function labelMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  // Substring only when BOTH are reasonably long, so a 2–3 char token can't
  // anchor a match ("ok" ⊂ "book now").
  if (Math.min(na.length, nb.length) >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  // BIDIRECTIONAL coverage: the agent label's tokens must be mostly present AND
  // the hook label must not be a much larger blob the agent tokens merely sit
  // inside. A short agent label being a subset of a long noise container (which
  // a one-directional min-denominator ratio would score 1.0) is exactly the
  // false match that would drop the real control — reject it here.
  return inter / ta.size >= 0.6 && inter / tb.size >= 0.5;
}

function xpathNorm(x: string | null | undefined): string {
  return (x ?? "").replace(/^xpath=/, "").replace(/\/+$/, "").trim();
}

/** Equal, or one path is an ancestor of the other (hook `closest()` may resolve
 *  to the actionable ancestor of the exact node the agent targeted). */
function xpathMatch(a: string | undefined, b: string | null | undefined): boolean {
  const na = xpathNorm(a);
  const nb = xpathNorm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return long.startsWith(short + "/");
}

export function labelOfClick(c: ClickEvent): string {
  return (c.ariaLabel ?? c.text ?? c.name ?? c.testid ?? "").toString().trim();
}

/**
 * Turn an agent instruction/description into a clean element NAME — a substring
 * of the element's real visible text, which the engine's getByText/getByRole
 * cascade can match. The Stagehand `description` is an LLM sentence that wraps
 * the real label in scaffolding ("button: Southview…", "Primary Care button,
 * includes…", "Button for scheduling a New Patient Visit", "Continue button at
 * the bottom of the locations step"). We peel that scaffolding off so what
 * remains is the label the page actually renders.
 */
export function conciseLabel(s: string): string {
  let out = (s || "").replace(/\s+/g, " ").trim();
  // Leading element-type qualifier the model prepends: "button:", "link - ", "the icon —".
  out = out.replace(/^(the\s+)?(button|link|icon|field|tab|option|menu\s*item|checkbox|radio|element|control)\s*[:\-–—]\s*/i, "");
  // Leading imperative verb + article: "click the", "select", "choose the".
  out = out.replace(/^(please\s+)?(click|select|choose|press|tap|open|go\s+to|navigate\s+to|expand|toggle)\s+(on\s+)?(the\s+)?/i, "");
  // Leading "button/link for <verb>ing a/an/the …" description wrapper.
  out = out.replace(/^(the\s+)?(button|link|control|option)\s+(for|to)\s+[a-z]+ing\s+(a|an|the)?\s*/i, "");
  // Trailing positional/type descriptor: "… button at the bottom of the locations step".
  out = out.replace(/\s+(button|link|icon|tab|option|control)\s+(at|in|on|near|of)\s+the\s+.+$/i, "");
  // A lone leading or trailing element-type noun.
  out = out.replace(/^(button|link|icon|tab|option|checkbox|radio)\s+/i, "");
  out = out.replace(/[\s,]+(button|link|icon|tab|option|menu\s*item|checkbox|radio)\s*$/i, "");
  // A mid-phrase ", button," splitting a real label ("Primary Care button, includes…").
  out = out.replace(/[,\s]+button[,\s]+/i, " ");
  return out.replace(/\s+/g, " ").trim().slice(0, 72).trim();
}

/** Earliest hook click at/after `cursor` matching this agent action; xpath
 *  identity is a strong match and wins over a mere label overlap. */
function bestMatch(
  act: AgentActionRecord,
  clicks: ClickEvent[],
  cursor: number,
): { index: number; strong: boolean } {
  let labelHit = -1;
  for (let i = cursor; i < clicks.length; i++) {
    const c = clicks[i];
    if (!c) continue;
    if (act.xpath && xpathMatch(act.xpath, c.xpath)) return { index: i, strong: true };
    if (labelHit < 0 && labelMatch(act.label, labelOfClick(c))) labelHit = i;
  }
  return { index: labelHit, strong: false };
}

/** Hook click is the identity base; fill a missing/oversized label from the
 *  agent's intent. Carry the agent's xpath forward if the hook lacked one. */
function mergeClick(hook: ClickEvent, act: AgentActionRecord): ClickEvent {
  const hookLabel = labelOfClick(hook);
  const usable = !!hookLabel && hookLabel.length <= 72;
  const merged: ClickEvent = usable ? { ...hook } : { ...hook, ariaLabel: null, text: conciseLabel(act.label) };
  if (!merged.xpath && act.xpath) merged.xpath = "xpath=" + act.xpath;
  return merged;
}

/** An interaction the agent did but the DOM hook missed → a semantic-only step
 *  (no cached selector) that the engine heals by role+name+intent at run time. */
function synthClick(act: AgentActionRecord): ClickEvent | null {
  if (act.kind !== "click") return null; // only clicks replay today; fills/press are agent-only-not-yet
  const label = conciseLabel(act.label);
  if (!label || label.length > 72) return null;
  // No role: we don't know the element's tag (the hook missed it), so let the
  // engine's role-agnostic locator cascade heal by name across button/link/tab/…
  // rather than freezing a guessed role that getByRole would then fail to match.
  return { text: label, xpath: act.xpath ? "xpath=" + act.xpath : undefined };
}

/**
 * Reconcile the two capture streams into the ordered replay steps.
 *
 * The agent's deliberate CLICK actions drive the sequence; each is aligned
 * (monotonically) to its hook click by xpath identity or label similarity. Hook
 * clicks no agent action corroborates are dropped as noise. Agent clicks the hook
 * missed become heal-only steps. Conservative fallbacks (return the raw hook
 * clicks, `usedAgentStream:false`) when the agent stream is too thin (<2 clicks)
 * or fails to correlate with a populated hook stream — so nothing regresses.
 */
export function reconcileClicks(clicks: ClickEvent[], agentActs: AgentActionRecord[]): ReconcileResult {
  const clickActs = agentActs.filter((a) => a.kind === "click");
  if (clickActs.length < 2) {
    return { steps: clicks, meta: [], usedAgentStream: false, droppedNoise: 0 };
  }

  const steps: ClickEvent[] = [];
  const meta: ReconcileMeta[] = [];
  let cursor = 0;
  let matched = 0;

  for (const act of clickActs) {
    const m = bestMatch(act, clicks, cursor);
    const hook = m.index >= 0 ? clicks[m.index] : undefined;
    if (hook) {
      steps.push(mergeClick(hook, act));
      meta.push({
        source: "both",
        confidence: m.strong ? "high" : "medium",
        label: labelOfClick(hook) || conciseLabel(act.label),
      });
      cursor = m.index + 1;
      matched++;
    } else {
      const s = synthClick(act);
      if (s) {
        steps.push(s);
        meta.push({ source: "agent-only", confidence: "low", label: conciseLabel(act.label) });
      }
    }
  }

  // If the agent stream didn't correlate with a NON-empty hook stream, the join
  // is untrustworthy — defer to the hook path rather than emit a flow built
  // mostly from heal-only guesses. Zero matches is always too weak; a single
  // match amid a noisy hook stream (≥3 clicks) is too, so require ≥2 there.
  // (When the hook captured nothing, agent-only steps are all we have — keep them.)
  const tooWeak = matched === 0 || (clicks.length >= 3 && matched < 2);
  if (clicks.length > 0 && tooWeak) {
    return { steps: clicks, meta: [], usedAgentStream: false, droppedNoise: 0 };
  }

  const droppedNoise = Math.max(0, clicks.length - matched);
  return { steps, meta, usedAgentStream: true, droppedNoise };
}
