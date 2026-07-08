/**
 * Engine runner.
 *
 * Default = **programmatic / in-process**: `launchBrowser` → a page → drive the
 * compiled plan step-by-step, with tracing, per-step screenshots, HITL, model-
 * gated recovery, and auth-profile load/refresh. This is the path the CLI + console
 * use; it needs no model and no network to Libretto Cloud, so the smoke flow stays
 * green keyless.
 *
 * Opt-in (`PORTICO_LIBRETTO_RUNNER=cli`) = **subprocess**: emit the generated
 * `workflow()` module and run it with `npx libretto run`, for when you want
 * Libretto's own auth-profile/pause/resume machinery end-to-end.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRecoveryPage, launchBrowser } from "libretto";
import type { Page } from "playwright";
import { redact } from "@portico/vault";
import type { Flow, Target } from "@portico/flow-spec";
import type { EngineRunOptions, EngineRunResult, StepTrace } from "./types.js";
import { compileFlow, emitWorkflowModule, type StepRuntime } from "./compiler.js";
import { resolveHealModel } from "./model.js";
import { refreshProfile, resolveProfile } from "./auth-profile.js";
import { createRecorder } from "./recording.js";

const now = () => Date.now();

export function runnerMode(env: NodeJS.ProcessEnv = process.env): "programmatic" | "cli" {
  return env.PORTICO_LIBRETTO_RUNNER === "cli" ? "cli" : "programmatic";
}

export async function runFlow(opts: EngineRunOptions): Promise<EngineRunResult> {
  if (runnerMode() === "cli") return runViaCli(opts);
  return runProgrammatic(opts);
}

async function runProgrammatic(opts: EngineRunOptions): Promise<EngineRunResult> {
  const { flow, target } = opts;
  const secretValues = Object.values(opts.auth.secrets);
  const scrub = (s: string) => redact(s, secretValues);

  const heal = await resolveHealModel();
  const profile = opts.profileId ? resolveProfile(opts.profileId, { refresh: true }) : undefined;

  // Prefer a persisted auth profile; fall back to a string sessionState if given.
  const storageStatePath =
    profile?.loadPath ??
    (typeof opts.auth.sessionState === "string" ? opts.auth.sessionState : undefined);

  const runId = `${target.key}-${now()}`;
  const repoRoot = process.cwd();
  const artifactsDir = opts.artifactsDir ?? resolve(repoRoot, "data", "artifacts");

  const session = await launchBrowser({
    sessionName: runId,
    headless: opts.headless ?? true,
    viewport: { width: 1440, height: 900 },
    storageStatePath,
  });
  const rawPage: Page = session.page;
  const page: Page = heal ? createRecoveryPage(rawPage, { recoveryAction: heal.recoveryAction }) : rawPage;

  const recorder = createRecorder(rawPage, {
    runId,
    artifactsDir,
    repoRoot,
    redactText: scrub,
    enabled: opts.record ?? true,
  });
  await recorder.start();

  const { plan, profileName } = compileFlow(flow, target, { heal, profileName: profile?.name });
  const traces: StepTrace[] = [];
  const output: Record<string, unknown> = {};
  const unvalidated = new Set<string>();

  const rt: StepRuntime = {
    page,
    rawPage,
    session: runId,
    input: opts.inputs,
    output,
    unvalidated,
    target,
    secrets: opts.auth.secrets,
    heal,
    profileLoaded: Boolean(profile?.loadPath),
    template: (s: string) => renderTemplate(s, opts),
  };

  try {
    const start = opts.resumeFrom ?? 0;
    for (let i = start; i < plan.length; i++) {
      const step = plan[i]!;
      const startedAt = now();
      opts.signal?.throwIfAborted();

      const emit = (status: StepTrace["status"], detail?: string, extra?: Partial<StepTrace>): StepTrace => {
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
        // Interactive HITL: if the caller can service a human step (headed
        // login/2FA), await it and continue instead of pausing the run.
        if (step.type === "human" && opts.onHuman) {
          await opts.onHuman({ index: i, label: step.label });
          const shot = await recorder.screenshot(i);
          emit("ok", "human step completed interactively", { screenshotRef: shot });
          continue;
        }

        const outcome = await step.run(rt);
        const shot = await recorder.screenshot(i);

        if (outcome.status === "paused") {
          emit("paused", `HITL required at step ${i} (${step.label ?? step.type})`, { screenshotRef: shot });
          const rrwebRef = await recorder.finalize("paused");
          return {
            status: "paused",
            output,
            traces,
            rrwebRef,
            failure: { stepIndex: i, reason: `human step: ${step.label ?? step.type}`, resumable: true },
            sessionState: await session.context.storageState(),
            unvalidatedOutputKeys: [...unvalidated],
            authProfile: profileName,
          };
        }

        emit(outcome.status === "healed" ? "healed" : "ok", outcome.detail, {
          screenshotRef: shot,
          healedFrom: outcome.healedFrom,
          healedTo: outcome.healedTo,
        });
      } catch (err) {
        const reason = scrub(err instanceof Error ? err.message : String(err));
        const shot = await recorder.screenshot(i);
        emit("failed", reason, { screenshotRef: shot });
        const rrwebRef = await recorder.finalize("failed");
        return {
          status: "failed",
          output,
          traces,
          rrwebRef,
          failure: { stepIndex: i, reason, resumable: true },
          unvalidatedOutputKeys: [...unvalidated],
          authProfile: profileName,
        };
      }
    }

    if (profile) await refreshProfile(profile, session.context); // persist login for next run
    const rrwebRef = await recorder.finalize("completed");
    return {
      status: "completed",
      output,
      traces,
      rrwebRef,
      sessionState: await session.context.storageState(),
      unvalidatedOutputKeys: [...unvalidated],
      authProfile: profileName,
    };
  } finally {
    await session.close();
  }
}

/** Substitute {{input}}, {{secrets.x}}, {{base_url}} for the programmatic runner. */
function renderTemplate(input: string, opts: EngineRunOptions): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    if (key === "base_url") return opts.target.base_url;
    if (key.startsWith("secrets.")) return opts.auth.secrets[key.slice(8)] ?? "";
    const v = opts.inputs[key];
    return v == null ? "" : String(v);
  });
}

// ---------------------------------------------------------------------------
// Subprocess runner (opt-in): emit a workflow module and `npx libretto run` it.
// ---------------------------------------------------------------------------

async function runViaCli(opts: EngineRunOptions): Promise<EngineRunResult> {
  const dir = mkdtempSync(join(tmpdir(), "portico-wf-"));
  const modulePath = join(dir, `${opts.flow.key}.workflow.ts`);
  writeFileSync(modulePath, emitWorkflowModule(opts.flow, opts.target, opts.profileId), "utf8");

  const args = ["libretto", "run", modulePath, opts.headless === false ? "--headed" : "--headless"];
  if (opts.profileId) args.push("--session", opts.profileId);

  const startedAt = now();
  const { code, stdout, stderr } = await spawnCollect("npx", args, opts.signal);
  const traces: StepTrace[] = [
    {
      index: 0,
      type: "subprocess",
      label: `npx ${args.join(" ")}`,
      status: code === 0 ? "ok" : "failed",
      detail: (code === 0 ? stdout : stderr).trim().slice(-2000) || undefined,
      startedAt,
      endedAt: now(),
    },
  ];
  if (code === 0) return { status: "completed", output: parseTailJson(stdout), traces };
  return {
    status: "failed",
    output: {},
    traces,
    failure: { stepIndex: 0, reason: stderr.trim().slice(-500) || `libretto run exited ${code}`, resumable: false },
  };
}

function parseTailJson(out: string): Record<string, unknown> {
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
  if (!line.startsWith("{")) return {};
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function spawnCollect(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { env: process.env, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}
