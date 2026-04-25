// Run from compose/nav-oracle/: npx tsx --test tests/scaling.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toScaled18 } from "../src/lib/scaling";

test("scales whole USD to 18 decimals", () => {
  assert.equal(toScaled18(1), 1_000_000_000_000_000_000n);
  assert.equal(toScaled18(0), 0n);
});

test("scales fractional USD via toFixed(18) — float noise in the input survives", () => {
  // 0.1 + 0.2 holds the double 0.30000000000000004; toFixed(18) emits
  // "0.300000000000000044". The function does not (and cannot) recover bits
  // that were never in the input. Asserting the actual behavior locks in the
  // contract for callers.
  assert.equal(toScaled18(0.1 + 0.2), 300_000_000_000_000_044n);
  assert.equal(toScaled18(50_825_000), 50_825_000_000_000_000_000_000_000n);
});

test("scales values up to MAX_SAFE_INTEGER", () => {
  // 9_007_199_254_740_991 is exactly representable in a double.
  assert.equal(
    toScaled18(Number.MAX_SAFE_INTEGER),
    9_007_199_254_740_991_000_000_000_000_000_000n
  );
});

test("rejects negative values", () => {
  assert.throws(() => toScaled18(-1), /negative value/);
});

test("rejects non-finite values", () => {
  assert.throws(() => toScaled18(NaN), /non-finite value/);
  assert.throws(() => toScaled18(Infinity), /non-finite value/);
  assert.throws(() => toScaled18(-Infinity), /non-finite value/);
});

test("rejects values above MAX_SAFE_INTEGER instead of silently corrupting them", () => {
  // toFixed(18) emits scientific notation for values >= 1e21, which would
  // produce an invalid bigint string. The guard fires first regardless.
  assert.throws(() => toScaled18(1e21), /exceeds Number\.MAX_SAFE_INTEGER/);
  assert.throws(
    () => toScaled18(Number.MAX_SAFE_INTEGER + 2),
    /exceeds Number\.MAX_SAFE_INTEGER/
  );
});
