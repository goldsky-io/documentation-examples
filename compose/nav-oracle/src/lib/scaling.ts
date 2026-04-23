/**
 * Convert a human-readable USD number (e.g. 42_500_000.50) to a
 * 18-decimal fixed-point bigint (e.g. 42500000500000000000000000n).
 *
 * Uses string math to avoid binary-float precision loss that would
 * otherwise corrupt values like 0.1 + 0.2.
 */
export function toScaled18(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`toScaled18: non-finite value ${value}`);
  }
  if (value < 0) {
    throw new Error(`toScaled18: negative value ${value}`);
  }
  const fixed = value.toFixed(18);
  const [whole, frac = ""] = fixed.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole + padded);
}
