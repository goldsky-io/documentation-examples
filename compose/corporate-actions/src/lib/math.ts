import type { Holder, Payout } from "./types";
import { normalizeAddr } from "./normalize";

/**
 * Pro-rata payout calculator.
 *
 * Integer division floors each holder's share, leaving a remainder. To make the
 * sum equal `totalAmount` exactly, the remainder is added to the LAST holder's
 * payout. This rounding direction is documented and stable: holders are sorted
 * by address ascending so "last" is deterministic across runs.
 *
 * @param holders     non-empty list of holders with bigint balances
 * @param totalAmount total escrow to distribute (bigint)
 * @param totalSupply sum of all holder balances (bigint)
 */
export function proRata(
  holders: Holder[],
  totalAmount: bigint,
  totalSupply: bigint,
): Payout[] {
  if (holders.length === 0) return [];
  if (totalSupply === 0n) {
    throw new Error("totalSupply must be positive");
  }

  // Sort by address ascending so "last holder" is deterministic.
  const sorted = [...holders].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  );

  const payouts: Payout[] = [];
  let allocated = 0n;
  for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i];
    const isLast = i === sorted.length - 1;
    const amount = isLast
      ? totalAmount - allocated // last holder absorbs floor remainder
      : (h.balance * totalAmount) / totalSupply;
    payouts.push({
      holder: normalizeAddr(h.address),
      amount,
      sharesAtSnapshot: h.balance,
    });
    allocated += amount;
  }
  return payouts;
}
