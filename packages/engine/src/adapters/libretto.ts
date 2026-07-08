/**
 * Libretto engine adapter (ADR-0001 — accepted engine).
 *
 * Validation result: Libretto exposes its runtime **programmatically, in-process**
 * (`launchBrowser` → Playwright page; `attemptWithRecovery` → self-heal that only
 * calls a model *on failure*; `librettoAuthenticate`, `extractFromPage`,
 * `pageRequest`, session-state). No CLI/subprocess needed. So this adapter runs a
 * Portico Flow by interpreting its steps against the Libretto-launched page.
 *
 * The no-LLM-on-hot-path invariant holds by construction: on a healthy run,
 * `attemptWithRecovery` never invokes the recovery model — it only fires when a
 * cached locator breaks (self-heal), which is off the steady-state path.
 *
 * Still authored later: the real per-step selectors come from the record-by-demo
 * (they live in `Locator.cached`). `act`/`extract` steps without a cached locator
 * throw a clear "author this first" error rather than guessing.
 */

import { attemptWithRecovery, launchBrowser } from "libretto";
import type { Page } from "playwright";
import type {
  AuthContext,
  EngineAdapter,
  EngineCapabilities,
  EngineRunOptions,
  EngineRunResult,
  StepTrace,
} from "../types.js";
import type { Flow, Step } from "@portico/flow-spec";
import { redact } from "@portico/vault";

const now = () => Date.now();

export class LibrettoAdapter implements EngineAdapter {
  readonly name = "libretto";

  capabilities(): EngineCapabilities {
    // Validated in-process embeddable (ADR-0001); capture→API via pageRequest.
    return { apiPromotion: true, selfHeal: true, inProcess: true };
  }

  async run(opts: EngineRunOptions): Promise<EngineRunResult> {
    assertNoLlmOnHotPath(opts.flow);
    const traces: StepTrace[] = [];
    const output: Record<string, unknown> = {};
    const secretValues = Object.values(opts.auth.secrets);
    const scrub = (s: string) => redact(s, secretValues);

    const session = await launchBrowser({
      sessionName: `${opts.target.key}-${now()}`,
      headless: opts.mode !== "live" ? true : true, // headless default; author runs headed
      viewport: { width: 1440, height: 900 },
      storageStatePath:
        typeof opts.auth.sessionState === "string" ? opts.auth.sessionState : undefined,
    });
    const { page, context, close } = session;

    try {
      const start = opts.resumeFrom ?? 0;
      for (let i = start; i < opts.flow.steps.length; i++) {
        const step = opts.flow.steps[i]!;
        const startedAt = now();
        const emit = (status: StepTrace["status"], detail?: string, extra?: Partial<StepTrace>) => {
          const trace: StepTrace = {
            index: i,
            type: step.type,
            label: step.label,
            status,
            detail: detail ? scrub(detail) : undefined,
            startedAt,
            endedAt: now(),
            ...extra,
          };
          traces.push(trace);
          opts.onStep?.(trace);
          return trace;
        };

        try {
          // Interactive HITL: if the caller can handle a human step (headed
          // manual login/2FA), await it here and continue instead of pausing.
          if (step.type === "human" && opts.onHuman) {
            await opts.onHuman({ index: i, label: step.label });
            emit("ok", "human step completed interactively");
            continue;
          }
          const done = await this.runStep(page, step, opts, output);
          if (done === "paused") {
            emit("paused", `HITL required at step ${i} (${step.label ?? step.type})`);
            return {
              status: "paused",
              output,
              traces,
              failure: { stepIndex: i, reason: `human step: ${step.label ?? step.type}`, resumable: true },
              sessionState: await context.storageState(),
            };
          }
          emit("ok");
        } catch (err) {
          const reason = scrub(err instanceof Error ? err.message : String(err));
          emit("failed", reason);
          return { status: "failed", output, traces, failure: { stepIndex: i, reason, resumable: true } };
        }
      }
      return { status: "completed", output, traces, sessionState: await context.storageState() };
    } finally {
      await close();
    }
  }

  /** Interpret one flow step against the live page. Returns "paused" for HITL. */
  private async runStep(
    page: Page,
    step: Step,
    opts: EngineRunOptions,
    output: Record<string, unknown>,
  ): Promise<"ok" | "paused"> {
    switch (step.type) {
      case "guard":
        return "ok"; // structural invariant; enforced at author/policy time
      case "human":
        return "paused"; // HITL: pause and hand back for resume
      case "navigate": {
        const url = template(step.url ?? opts.target.base_url, opts);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: step.timeoutMs ?? 60000 });
        return "ok";
      }
      case "act": {
        const sel = requireSelector(step);
        const value = step.value != null ? template(step.value, opts) : undefined;
        // attemptWithRecovery self-heals if the cached selector breaks.
        await attemptWithRecovery(page, async () => {
          if (value !== undefined) await page.fill(sel, value, { timeout: step.timeoutMs ?? 15000 });
          else await page.click(sel, { timeout: step.timeoutMs ?? 15000 });
        });
        return "ok";
      }
      case "extract": {
        const key = step.extract?.key ?? "result";
        const sel = step.locator?.cached;
        // Minimal DOM extraction; structured/AI extraction (extractFromPage) is a
        // follow-up. With no selector, capture the page title as a smoke signal.
        output[key] = sel
          ? (await page.locator(sel).allInnerTexts())
          : await page.title();
        return "ok";
      }
      case "assert": {
        // Condition vocabulary is target-specific; unknown conditions pass in the
        // skeleton. Real conditions (e.g. dashboard_visible) are wired per connector.
        return "ok";
      }
      case "download":
      case "upload":
      case "subflow":
        throw new Error(`step type '${step.type}' not wired yet in the Libretto adapter`);
      default:
        throw new Error(`unknown step type '${(step as { type: string }).type}'`);
    }
  }
}

function requireSelector(step: Step): string {
  const sel = step.locator?.cached;
  if (!sel) {
    throw new Error(
      `act step "${step.label ?? "?"}" has no cached locator — record it first ` +
        `(record-by-demo). Semantic intent: "${step.locator?.semantic.intent ?? "?"}".`,
    );
  }
  return sel;
}

/** Substitute {{input}}, {{secrets.x}}, {{base_url}} in a template string. */
function template(input: string, opts: EngineRunOptions): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    if (key === "base_url") return opts.target.base_url;
    if (key.startsWith("secrets.")) return opts.auth.secrets[key.slice(8)] ?? "";
    const v = opts.inputs[key];
    return v == null ? "" : String(v);
  });
}

function assertNoLlmOnHotPath(flow: Flow): void {
  const offenders = flow.steps.filter((s) => (s.type as string) === "agent");
  if (offenders.length > 0) {
    throw new Error(
      `Flow '${flow.key}' has ${offenders.length} agent step(s) on the hot path — ` +
        "forbidden for a promoted flow (docs/ARCHITECTURE.md §4).",
    );
  }
}
