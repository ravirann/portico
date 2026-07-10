/**
 * Unit tests for the runner's pure helpers. The runner itself needs a live
 * browser; what's tested here is the start-navigation origin inference that
 * lets read/api-first flows run when the target has no base_url.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Flow } from "@portico/flow-spec";
import { inferStartOrigin } from "./runner.js";

const steps = (arr: unknown[]) => arr as Flow["steps"];

test("inferStartOrigin: read-first flow (Gmail shape) yields the first api step's origin", () => {
  const s = steps([
    { type: "read", read: { expression: "localStorage.getItem('x')", as: "x" } },
    {
      type: "read",
      label: "Update result (POST)",
      api: { url: "https://mail.google.com/sync/u/0/i/s?hl=en", method: "POST" },
    },
    { type: "read", api: { url: "https://ogads-pa.clients6.google.com/$rpc/x", method: "POST" } },
  ]);
  assert.equal(inferStartOrigin(s), "https://mail.google.com");
});

test("inferStartOrigin: navigate urls count too, and templated origins are skipped", () => {
  const s = steps([
    { type: "navigate", url: "{{n}}/MyChart/Scheduling" }, // relative template — no origin
    { type: "navigate", url: "https://{{host}}/portal" }, // templated origin — unusable
    { type: "navigate", url: "https://portal.example.com/login?next=1" },
  ]);
  assert.equal(inferStartOrigin(s), "https://portal.example.com");
});

test("inferStartOrigin: no absolute concrete URL anywhere → undefined", () => {
  const s = steps([
    { type: "read", read: { expression: "1+1", as: "x" } },
    { type: "navigate", url: "{{base_url}}/home" },
  ]);
  assert.equal(inferStartOrigin(s), undefined);
});
