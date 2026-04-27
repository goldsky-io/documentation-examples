import type { Hex } from "./types";

const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Normalize an EVM address to lowercase 0x-hex.
 * Apply at every boundary: Postgres reads, collection keys, contract args.
 */
export function normalizeAddr(s: string): Hex {
  if (!ADDR_RE.test(s)) {
    throw new Error(`invalid address: ${s}`);
  }
  return s.toLowerCase() as Hex;
}

export function isHexBytes32(s: string): boolean {
  return BYTES32_RE.test(s);
}
