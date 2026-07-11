/**
 * Query-rewriter agent (author tier).
 *
 * The reliability of agent-authoring hinges on the browser agent COMPLETING an
 * ambiguous natural-language goal. A one-line user goal ("update the LOP to
 * English for 9717352594") is under-specified: the agent has to guess the entity,
 * the steps, and what "done" means — and often stalls. This module runs a small
 * planning pass FIRST, turning the raw goal into:
 *
 *   - `refinedGoal`  — an explicit, numbered instruction the browser agent
 *                      follows far more reliably (search → open → edit → SAVE).
 *   - `intent`       — read | search | extract | update, so the compiler knows
 *                      whether to expect a mutation.
 *   - `parameters`   — the per-run values (phone, name, id) that must become
 *                      flow inputs — this is the signal the compiler uses to
 *                      parameterize, instead of guessing from digit-runs alone.
 *   - `expectedOutputs` — the data the flow should end up with (for validation).
 *
 * It is author-tier only (never on the replay hot path) and degrades to a
 * pass-through when no model is configured or the call fails — authoring must
 * never break because planning did. Uses a direct OpenAI-compatible chat call to
 * avoid AI-SDK version conflicts between this package (Stagehand's ai@5) and the
 * engine (ai@6).
 */

export interface GoalParameter {
  /** snake_case input name, e.g. "phone_number". */
  name: string;
  /** The concrete value seen in the goal, e.g. "9717352594". */
  value: string;
  /** One-line human description for the Run form. */
  description: string;
}

export interface GoalPlan {
  refinedGoal: string;
  intent: "read" | "search" | "extract" | "update" | "navigate";
  entities: string[];
  parameters: GoalParameter[];
  expectedOutputs: string[];
  /** The raw goal, unchanged, for traceability. */
  rawGoal: string;
}

/** Bump whenever SYSTEM (the rewrite prompt below) changes materially — recorded
 *  in each authored flow's provenance for reproducibility. */
export const PROMPT_VERSION = 1;

const SYSTEM = [
  "You are a planning assistant for a browser-automation authoring tool.",
  "A user gives a short goal for a task to perform on a web portal. Your job is",
  "to turn it into a precise, executable plan for a browser agent, and to name",
  "the per-run values that make the task reusable.",
  "",
  "Return JSON with exactly these fields:",
  '  refinedGoal: string — an explicit, NUMBERED, step-by-step instruction the',
  "    agent will follow, covering EVERY step implied by the user's goal, IN",
  "    ORDER, from the first action through the LAST one the goal names — a",
  "    5-part goal becomes numbered steps 1 through 5, never just 1-2. Number",
  "    each discrete action (1. ... 2. ... 3. ... and so on through the final",
  "    step). Be concrete about: navigating, searching (say WHAT to type and",
  "    WHERE), opening the right record/option at EACH step, making every",
  "    selection the goal names (e.g. a category, a location, a date, a time",
  "    slot), and — for updates — explicitly CLICKING SAVE/CONFIRM at the end.",
  "    Never invent data. After the numbered list, ALWAYS append one closing",
  "    sentence that explicitly instructs the agent: do NOT stop after only the",
  "    first step or two — the task is INCOMPLETE until the LAST numbered",
  "    step's end state (e.g. the final screen the goal names, such as a",
  "    review/confirmation step) is reached and visible on screen; keep going",
  "    through every remaining step before declaring success. Keep refinedGoal",
  "    portal-agnostic — describe the generic steps from the user's goal, never",
  "    a specific vendor's exact UI text or layout.",
  '  intent: one of "read","search","extract","update","navigate" — "update" if',
  "    the goal changes/saves anything, else the closest read-only intent.",
  "  entities: string[] — the domain objects involved (e.g. [\"customer\"]).",
  "  parameters: array of { name, value, description } — the per-run VALUES named",
  "    in the goal (phone numbers, ids, names, the target value of an update).",
  "    name is snake_case. value is the literal from the goal. Include the update",
  "    target value too (e.g. the new language). Omit nothing that varies per run.",
  "  expectedOutputs: string[] — what data the finished flow should have captured",
  "    (e.g. [\"customer record\",\"updated language\"]).",
  "",
  "Keep refinedGoal focused ONLY on the user's goal — do not add unrelated",
  "steps, but never omit, merge, or truncate a step the goal describes; every",
  "step the user named must appear as its own numbered instruction.",
].join("\n");

interface RewriteOptions {
  /** Provider-qualified or bare model name, e.g. "openai/gpt-5.5" or "gpt-5.5". */
  model: string;
  apiKey: string;
  /** OpenAI-compatible base URL. Defaults to OpenAI. */
  baseUrl?: string;
  startUrl?: string;
  onLog?: (line: string) => void;
  /**
   * Sector-specific domain vocabulary (SectorProfile.authoring.vocabulary) to
   * inject into the SYSTEM prompt — see buildSystemPrompt. Undefined/"" = no
   * block appended (the no-regression default for authoring without a sector).
   */
  vocabulary?: string;
  /** Sector key labeling the vocabulary block (e.g. "healthcare"); cosmetic only. */
  sectorKey?: string;
}

/**
 * Assemble the rewriter's SYSTEM prompt: the base planning instructions,
 * plus — when authoring for a known sector — a clearly delimited domain-
 * vocabulary block appended at the end. Pure (no network, no model), so the
 * prompt assembly is unit-testable without an API key. Extracted out of
 * rewriteGoal so the injection logic has a single, well-tested home.
 */
export function buildSystemPrompt(vocabulary?: string, sectorKey?: string): string {
  const trimmed = (vocabulary ?? "").trim();
  if (!trimmed) return SYSTEM;
  return `${SYSTEM}\n\nDomain context (sector: ${sectorKey || "unknown"}):\n${trimmed}`;
}

/** A safe pass-through plan when planning is unavailable. */
function passthrough(rawGoal: string): GoalPlan {
  return { refinedGoal: rawGoal, intent: "read", entities: [], parameters: [], expectedOutputs: [], rawGoal };
}

/**
 * Appends an explicit "don't stop early" reinforcement to a model-produced
 * refinedGoal. The SYSTEM prompt already asks the model for this, but a
 * multi-step SOP is exactly the case where a browser agent tends to quit
 * after the first click or two, so this belts-and-suspenders it instead of
 * trusting prompt compliance alone. Idempotent: skipped when the model's own
 * text already carries an equivalent instruction.
 */
function reinforceCompletion(refinedGoal: string): string {
  if (/do not stop|don't stop|not (yet )?(finished|complete|done) until/i.test(refinedGoal)) {
    return refinedGoal;
  }
  return (
    `${refinedGoal}\n\n` +
    "IMPORTANT: Perform every numbered step above, IN ORDER, without skipping any. " +
    "After each action, check whether further numbered steps remain — if so, continue " +
    "immediately; do NOT stop just because the first one or two actions succeeded. " +
    "This task is INCOMPLETE until the LAST numbered step's end state is visible on " +
    "screen; only then is the goal done."
  );
}

/**
 * Rough count of imperative steps in a refined goal, read off its numbered
 * list ("1. ... 2. ... 3. ..."). The author uses this to scale the agent's
 * step budget so a longer SOP gets proportionally more turns instead of a
 * flat cap that lets it quit after the first step or two. Returns 0 when no
 * numbering is present (caller falls back to a flat floor).
 */
export function countPlanSteps(refinedGoal: string): number {
  const matches = refinedGoal.match(/(?:^|\n)\s*\d+[.)]\s+\S/g);
  return matches ? matches.length : 0;
}

/**
 * Plan a raw goal into a structured, executable GoalPlan. Never throws — returns
 * a pass-through plan on any failure so authoring proceeds regardless.
 */
export async function rewriteGoal(rawGoal: string, opts: RewriteOptions): Promise<GoalPlan> {
  if (!opts.apiKey) return passthrough(rawGoal);
  const model = opts.model.includes("/") ? opts.model.split("/").slice(1).join("/") : opts.model;
  const base = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const user = `Start URL: ${opts.startUrl ?? "(unknown)"}\nUser goal: ${rawGoal}`;

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: buildSystemPrompt(opts.vocabulary, opts.sectorKey) },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      opts.onLog?.(`rewriter: model call failed (${res.status}) — using the raw goal`);
      return passthrough(rawGoal);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return passthrough(rawGoal);
    const parsed = JSON.parse(content) as Partial<GoalPlan>;
    return normalizePlan(parsed, rawGoal);
  } catch (e) {
    opts.onLog?.(`rewriter: ${e instanceof Error ? e.message : String(e)} — using the raw goal`);
    return passthrough(rawGoal);
  }
}

/** Coerce a model response into a well-formed GoalPlan, filling gaps safely. */
export function normalizePlan(p: Partial<GoalPlan>, rawGoal: string): GoalPlan {
  const intents = ["read", "search", "extract", "update", "navigate"] as const;
  const intent = intents.includes(p.intent as never) ? (p.intent as GoalPlan["intent"]) : "read";
  const parameters: GoalParameter[] = Array.isArray(p.parameters)
    ? p.parameters
        .filter((x): x is GoalParameter => Boolean(x && typeof x.name === "string" && typeof x.value === "string"))
        .map((x) => ({
          name: x.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase().replace(/^_+|_+$/g, ""),
          value: String(x.value),
          description: typeof x.description === "string" ? x.description : "",
        }))
        .filter((x) => x.name.length > 0)
    : [];
  const modelRefinedGoal = typeof p.refinedGoal === "string" ? p.refinedGoal.trim() : "";
  return {
    refinedGoal: modelRefinedGoal ? reinforceCompletion(modelRefinedGoal) : rawGoal,
    intent,
    entities: Array.isArray(p.entities) ? p.entities.filter((e): e is string => typeof e === "string") : [],
    parameters,
    expectedOutputs: Array.isArray(p.expectedOutputs) ? p.expectedOutputs.filter((e): e is string => typeof e === "string") : [],
    rawGoal,
  };
}
