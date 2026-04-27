import type { TaskContext } from "compose";
import type { ChainKey, Hex, Holder } from "./types";

/**
 * Query Neon's HTTP `/sql` endpoint via compose's IPC-routed `context.fetch`.
 *
 * Why not the `@neondatabase/serverless` driver?
 *   The compose-task child process is compiled WITHOUT `--allow-net`. Raw TCP
 *   AND `globalThis.fetch` from the task code both error with `EPERM`. The ONLY
 *   permitted egress path is `context.fetch`, which is an IPC call into the
 *   host (which has `--allow-net`). So we hand-roll the Neon HTTP query format
 *   and route every call through `context.fetch`.
 *
 * `POSTGRES_CONNECTION_STRING` is auto-injected by compose-cloud. The Turbo
 * pipelines write `share_balances` and `share_transfer_log` to the same Neon
 * DB via the auto-created `CORPORATE_ACTIONS` Goldsky secret.
 */

interface NeonRow {
  [key: string]: string | number | boolean | null;
}
interface NeonResponse {
  rows?: NeonRow[];
}

function getConnectionString(): string {
  const url = Deno.env.get("POSTGRES_CONNECTION_STRING");
  if (!url) {
    throw new Error("POSTGRES_CONNECTION_STRING not set");
  }
  return url;
}

/** Derive Neon's HTTP `/sql` URL from a Postgres connection string. */
function neonHttpUrl(connStr: string): string {
  const u = new URL(connStr);
  // Use hostname (not host) so we drop the :5432 postgres port; HTTPS goes
  // to 443. Replace the first dotted segment with "api." per the official
  // @neondatabase/serverless transformation.
  const apiHost = u.hostname.replace(/^[^.]+\./, "api.");
  return `https://${apiHost}/sql`;
}

async function neonQuery(
  ctx: TaskContext,
  query: string,
  params: unknown[],
): Promise<NeonRow[]> {
  const connStr = getConnectionString();
  const url = neonHttpUrl(connStr);
  const res = await ctx.fetch<NeonResponse>(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": connStr,
      "Neon-Raw-Text-Output": "true",
      "Neon-Array-Mode": "false",
    },
    body: { query, params },
  });
  return res?.rows ?? [];
}

/**
 * Read all current holders for a (token, chain) pair from `share_balances`,
 * the table maintained by the Turbo `postgres_aggregate` sink.
 */
export async function getHolders(
  ctx: TaskContext,
  token: Hex,
  chain: ChainKey,
): Promise<Holder[]> {
  const rows = await neonQuery(
    ctx,
    `SELECT account, balance::text AS balance
       FROM share_balances
       WHERE token = $1 AND chain = $2 AND balance > 0
       ORDER BY account ASC`,
    [token.toLowerCase(), chain],
  );
  // share_balances.balance is DOUBLE PRECISION (DataFusion can't cast
  // FixedSizeBinary→Decimal, so we store as DOUBLE and accept ~16-digit precision).
  // Convert to bigint via Math.round → BigInt to keep the rest of the math integer.
  return rows.map((r) => ({
    address: String(r.account).toLowerCase() as Hex,
    balance: BigInt(Math.round(Number(r.balance))),
  }));
}

/**
 * Latest block height the Turbo pipeline has confirmed for a given chain.
 * Used by the finality gate to ensure the snapshot is reorg-safe.
 */
export async function getPipelineHeadBlock(
  ctx: TaskContext,
  chain: ChainKey,
): Promise<bigint> {
  const rows = await neonQuery(
    ctx,
    `SELECT MAX(block_number)::text AS head
       FROM share_transfer_log
       WHERE chain = $1`,
    [chain],
  );
  const head = rows[0]?.head;
  return head ? BigInt(String(head)) : 0n;
}
