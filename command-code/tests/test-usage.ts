// Tests: usage parsing, unknown-total handling, failure paths, and the
// fresh/stale notes surfaced by /command-code.usage and the widget.
import { inspect } from "node:util";
import {
  CreditsApiError,
  fetchCommandCodeUsage,
  formatReset,
  formatUsageLine,
  formatUsageSummary,
  parseCredits,
  type RawCreditsResponse,
} from "../src/usage.ts";

let passed = 0;
const failures: string[] = [];

function ok(condition: unknown, message: string): void {
  if (condition) {
    passed++;
    return;
  }
  failures.push(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  if (inspect(actual) === inspect(expected)) {
    passed++;
    return;
  }
  failures.push(`${message}: got ${inspect(actual)}, expected ${inspect(expected)}`);
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-11-06T12:00:00Z");

const raw: RawCreditsResponse = {
  windowLimits: {
    limited: true,
    fiveHour: { used: 4, cap: 14, resetAt: NOW + 2.5 * 60 * 60 * 1000, exceeded: false },
    weekly: { used: 30, cap: 140, resetAt: NOW + 3 * 24 * 60 * 60 * 1000 },
  },
  credits: {
    monthlyCredits: 51,
    purchasedCredits: 5,
    creditThreshold: 20,
    premiumMonthlyCredits: 0,
    openSourceMonthlyCredits: 0,
  },
  plan: { id: "goat", name: "GOAT" },
};

const usage = parseCredits(raw, NOW);
eq(usage.fiveHour.used, 4, "5h used parsed");
eq(usage.fiveHour.cap, 14, "5h cap parsed");
eq(usage.weekly.used, 30, "weekly used parsed");
eq(usage.monthlyRemaining, 51, "remaining monthly credits parsed");
eq(usage.planName, "GOAT", "plan name parsed");
ok(!usage.fiveHour.exceeded, "not exceeded");

// resetAt in seconds still normalizes
const seconds = parseCredits(
  { windowLimits: { fiveHour: { used: 1, cap: 10, resetAt: Math.floor((NOW + 60_000) / 1000) } } },
  NOW,
);
eq(seconds.fiveHour.resetAt, NOW + 60_000, "seconds-based resetAt normalized");

// cap missing → undefined, NOT a hard-coded plan pool
const noCap = parseCredits(
  { windowLimits: { fiveHour: { used: 7 }, weekly: { used: 12 } }, credits: { monthlyCredits: 3 } },
  NOW,
);
eq(noCap.fiveHour.cap, undefined, "missing cap stays unknown");
eq(noCap.monthlyRemaining, 3, "remaining credits still parsed");
ok(!formatUsageSummary(noCap, { now: NOW }).includes("70"), "no hard-coded GOAT monthly pool (70)");

// unknown totals must never invent a percentage
ok(formatUsageSummary(noCap, { now: NOW }).includes("?%"), "unknown cap → ? percent");
ok(
  formatUsageSummary(noCap, { now: NOW }).includes("total pool unavailable") ||
    formatUsageSummary(noCap, { now: NOW }).includes("not exposed"),
  "unknown monthly pool announced as unavailable",
);

// empty payload → error
let threw = false;
try {
  parseCredits({});
} catch (error) {
  threw = error instanceof CreditsApiError;
}
ok(threw, "payload without usage data rejected");

// ---------------------------------------------------------------------------
// failure paths (network / auth / malformed)
// ---------------------------------------------------------------------------

async function assertHttpFailure(status: number, body: string, label: string): Promise<void> {
  try {
    await fetchCommandCodeUsage("cc_sk_secret", undefined, (async () =>
      new Response(body, { status })) as typeof fetch);
    failures.push(`${label}: expected rejection`);
  } catch (error) {
    ok(error instanceof Error, `${label}: plain Error`);
    ok(String((error as Error).message).includes(String(status)), `${label}: mentions HTTP ${status}`);
    ok(!String((error as Error).message).includes("cc_sk_secret"), `${label}: does not leak the key`);
  }
}

await assertHttpFailure(401, '{"error":"unauthorized"}', "401 rejected");
await assertHttpFailure(403, "forbidden", "403 (e.g. non-GOAT plan) surfaces as error");
await assertHttpFailure(500, "oops", "500 surfaces as error");

// malformed JSON
try {
  await fetchCommandCodeUsage("cc_sk_secret", undefined, (async () =>
    new Response("<html>", { status: 200 })) as typeof fetch);
  failures.push("malformed JSON should reject");
} catch (error) {
  ok(error instanceof CreditsApiError && error.message.includes("invalid JSON"), "malformed JSON rejected");
}

// abort signal honored
const controller = new AbortController();
controller.abort();
try {
  await fetchCommandCodeUsage("cc_sk_secret", controller.signal, (async () =>
    new Response("{}", { status: 200 })) as typeof fetch);
  failures.push("aborted request should reject");
} catch (error) {
  ok(error instanceof Error, "observed abort rejects");
  ok(!String((error as Error).message).includes("cc_sk_secret"), "abort error does not leak key");
}

// key never appears in formatted output
const summary = formatUsageSummary(usage, { now: NOW });
ok(!summary.includes("Bearer"), "summary has no auth header");

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

ok(summary.includes("GOAT"), "summary shows plan");
ok(summary.includes("5-hour"), "summary shows 5-hour window");
ok(summary.includes("Weekly"), "summary shows weekly window");
ok(summary.includes("51"), "summary shows remaining credits");
ok(summary.includes("2h 30m") || summary.includes("2h30m") || summary.includes("2h "), "reset countdown rendered");

const stale = formatUsageSummary(usage, { stale: "refresh failed (HTTP 500); data may be expired", now: NOW });
ok(stale.includes("data may be expired"), "stale marker rendered");

const line = formatUsageLine(usage, NOW);
ok(line.startsWith("CC 5h"), "widget line prefixed");
ok(line.includes("51"), "widget line contains monthly remaining");
const noCapLine = formatUsageLine(noCap, NOW);
ok(noCapLine.includes("?%") || noCapLine.includes("?"), "widget line degrades without caps");

eq(
  formatReset(Date.parse("2026-11-06T11:00:00Z"), NOW),
  "now",
  "past reset time renders as now",
);

report();

function report(): never {
  console.log(`usage: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error(failures.map((f) => `  FAIL ${f}`).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
