import postgres from "postgres";
import type { ChainKey, Holder, Hex } from "./types";

/**
 * Postgres client backed by compose-cloud's auto-provisioned hosted Neon DB.
 * `POSTGRES_CONNECTION_STRING` is injected by compose-cloud at runtime — no
 * user setup required.
 *
 * The Turbo pipelines in pipeline/*.yaml write to the same DB via the
 * auto-created `CORPORATE_ACTIONS` Goldsky secret.
 */
function getClient() {
  const url = Deno.env.get("POSTGRES_CONNECTION_STRING");
  if (!url) {
    throw new Error(
      "POSTGRES_CONNECTION_STRING not set. " +
        "Run via `goldsky compose deploy` (cloud) or set it manually for local runs.",
    );
  }
  return postgres(url, { ssl: "require", max: 1 });
}

/**
 * Read all current holders for a (token, chain) pair from the running
 * `share_balances` table maintained by the Turbo `postgres_aggregate` sink.
 *
 * Returns balances as bigint (pg returns numeric(78,0) as string; we convert).
 */
export async function getHolders(token: Hex, chain: ChainKey): Promise<Holder[]> {
  const sql = getClient();
  try {
    const rows = await sql<
      { account: string; balance: string }[]
    >`SELECT account, balance::text AS balance
        FROM share_balances
        WHERE token = ${token.toLowerCase()}
          AND chain = ${chain}
          AND balance > 0
        ORDER BY account ASC`;
    return rows.map((r) => ({
      address: r.account.toLowerCase() as Hex,
      balance: BigInt(r.balance),
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Latest block height the Turbo pipeline has confirmed for a given chain.
 * Used by the finality gate in process_campaigns to ensure the snapshot read
 * isn't vulnerable to reorgs at the time of payout.
 */
export async function getPipelineHeadBlock(chain: ChainKey): Promise<bigint> {
  const sql = getClient();
  try {
    const rows = await sql<
      { head: string | null }[]
    >`SELECT MAX(_gs_block_number)::text AS head
        FROM share_transfer_log
        WHERE chain = ${chain}`;
    const head = rows[0]?.head;
    return head ? BigInt(head) : 0n;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
