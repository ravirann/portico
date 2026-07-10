# Authoring eval suite

Scores the two-source reconciliation (`../agent-actions.ts`) over saved capture
fixtures, so a reconciliation/locator regression fails CI instead of needing a
human to eyeball an authoring run.

- `fixtures/` — synthetic captures shaped like a saved
  `data/author-evidence-latest.json` (`rawClicks` + raw `agentActions`), each
  with an `expectedNames` ground truth. `clean-wizard.ts` is the ideal case;
  `blob-noise-wizard.ts` reproduces the live bug where every control's DOM
  hook double-fires (clean node + a page-level container/root blob) amid
  untouched noise, agent xpath == the clean node's.
- `score.ts` — `scoreFixture(fixture)` runs `reconcileClicks(extractAgentActions(...), ...)`
  and reports `cleanNameRate`, `containerIdCacheCount`, `noiseDropped`,
  `blobLeakCount`, and the confidence distribution.
- `eval.test.ts` — asserts thresholds per fixture (`cleanNameRate === 1`,
  `containerIdCacheCount === 0`, blobs/noise dropped).

Run: `node --import tsx --test packages/author/src/eval/*.test.ts`
(also covered by the repo-wide `pnpm test`).
