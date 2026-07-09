/**
 * Unit tests for the authentication precondition gate — the pure classifier
 * that refuses to compile an authoring run captured while NOT logged in. The
 * canonical failure it must catch is the observed URMC MyChart case: the agent
 * attached to a session sitting on "Main Login" and only reached Epic's
 * anonymous/pre-login scheduling funnel, which used to compile into a dead flow.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAuthWall } from "./index.js";

test("blocks the observed MyChart login-wall run", () => {
  const r = detectAuthWall({
    finalUrl: "https://mychart.urmc.rochester.edu/mychart/",
    title: "UR Medicine MyChart - Main Login",
    hasPasswordField: true,
    requests: [
      { pathname: "/MyChart/Scheduling/Anonymous/GetSpecialtyData" },
      { pathname: "/MyChart/Scheduling/Anonymous/GetSchedulingWorkflowData" },
      { pathname: "/MyChart/ProxySwitch/LoadForPrelogin" },
    ],
  });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /isn't logged in/i);
  assert.match(r.reason, /pre-login/i); // mentions the guest funnel it detected
});

test("passes a genuinely logged-in run (authenticated portal data)", () => {
  const r = detectAuthWall({
    finalUrl: "https://pulse.clinikk.com/claims/workspace?claimId=4305",
    title: "Claim 4305 · Pulse",
    hasPasswordField: false,
    requests: [
      { pathname: "/api/proxy/v1/claims" },
      { pathname: "/api/proxy/v1/claims/4305/notes" },
    ],
  });
  assert.equal(r.blocked, false);
  assert.equal(r.reason, "");
});

test("blocks an SPA login page with no password field yet (login title + login URL)", () => {
  const r = detectAuthWall({
    finalUrl: "https://portal.example.com/auth/login",
    title: "Sign in — Example Portal",
    hasPasswordField: false,
    requests: [],
  });
  assert.equal(r.blocked, true);
});

test("does NOT trip on a password field mid-flow without corroboration (change-password page)", () => {
  const r = detectAuthWall({
    finalUrl: "https://portal.example.com/account/settings",
    title: "Account settings",
    hasPasswordField: true,
    requests: [{ pathname: "/api/account/profile" }],
  });
  assert.equal(r.blocked, false);
});

test("does NOT trip on a lone 'guest'-ish path with no login signals", () => {
  // A legit page whose path merely contains a matched word must not be flagged
  // unless a login title/URL corroborates — keeps the gate low-false-positive.
  const r = detectAuthWall({
    finalUrl: "https://shop.example.com/guest/cart",
    title: "Your Cart",
    hasPasswordField: false,
    requests: [{ pathname: "/api/guest/cart" }],
  });
  assert.equal(r.blocked, false);
});

test("blocks the observed v2 guest-funnel run even though it ends on a scheduling page", () => {
  // The failing v2 flow: agent ended on /openscheduling (no password field, a
  // non-login title) but the run had passed through the login/pre-login flow.
  // The login-API hits must be decisive on their own — this is the case the
  // earlier gate missed and let compile into a validation-failing flow.
  const r = detectAuthWall({
    finalUrl: "https://mychart.urmc.rochester.edu/MyChart/openscheduling",
    title: "MyChart - Schedule an Appointment",
    hasPasswordField: false,
    requests: [
      { pathname: "/MyChart/Scheduling/Anonymous/GetSchedulingWorkflowData" },
      { pathname: "/MyChart/ProxySwitch/LoadForPrelogin" },
      { pathname: "/MyChart/Authentication/Login/GetPasskeyGetParams" },
    ],
  });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /sign-in \/ pre-login flow/i);
});

test("passes a genuinely authenticated scheduling run (no login/pre-login calls)", () => {
  // Same scheduling GOAL, but from a logged-in session: the endpoints are the
  // authenticated scheduler's, with no Anonymous/prelogin/passkey traffic. This
  // must NOT be blocked, or the gate would reject the very flow we want.
  const r = detectAuthWall({
    finalUrl: "https://mychart.urmc.rochester.edu/MyChart/scheduling/workflow",
    title: "Schedule an Appointment",
    hasPasswordField: false,
    requests: [
      { pathname: "/MyChart/scheduling/GetProviders" },
      { pathname: "/MyChart/scheduling/GetOpenSlots" },
    ],
  });
  assert.equal(r.blocked, false);
  assert.equal(r.reason, "");
});

test("blocks a pre-login funnel reached from a login URL", () => {
  const r = detectAuthWall({
    finalUrl: "https://mychart.example.org/prelogin",
    title: "MyChart",
    hasPasswordField: false,
    requests: [{ pathname: "/Scheduling/Anonymous/GetSpecialtyData" }],
  });
  assert.equal(r.blocked, true);
});
