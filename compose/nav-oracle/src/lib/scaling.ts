/**
 * Convert a non-negative USD number (e.g. 42_500_000.50) to a 18-decimal
 * fixed-point bigint (e.g. 42500000500000000000000000n).
 *
 * Precision caveat: the input is already a JS double, so any precision
 * already lost in the float representation (e.g. 0.1 + 0.2 holds the value
 * 0.30000000000000004) survives into the output. Using toFixed(18) +
 * string concatenation avoids *additional* float ops in the conversion
 * path; it does not recover bits that were never in the input. For amounts
 * that need exact decimal precision, accept a decimal string upstream and
 * parse it with a fixed-point library instead of taking a number here.
 *
 * Bounds:
 *   - |value| > Number.MAX_SAFE_INTEGER (~9e15) is rejected: integer bits
 *     are already lost in the double, and at >= 1e21 V8's toFixed switches
 *     to scientific notation, which would produce a malformed bigint string.
 *   - Negative and non-finite values are rejected.
 */
export function toScaled18(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`toScaled18: non-finite value ${value}`);
  }
  if (value < 0) {
    throw new Error(`toScaled18: negative value ${value}`);
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `toScaled18: value ${value} exceeds Number.MAX_SAFE_INTEGER (9.007e15). ` +
        `Pass a string and parse with a fixed-point library to preserve precision.`
    );
  }
  const fixed = value.toFixed(18);
  const [whole, frac = ""] = fixed.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole + padded);
}
