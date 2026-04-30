import type { TaskContext } from "compose";
import type { Hex, Holder } from "./types";

/**
 * Query Neon's HTTP `/sql` endpoint via compose's IPC-routed `context.fetch`.
 *
 * Why not the `@neondatabase/serverless` driver?
 *   The compose-task child process is compiled WITHOUT `--allow-net`. Raw TCP
 *   AND `globalThis.fetch` from the task code both error with `EPERM`. The ONLY
 *   permitted egress path is `context.fetch`, which IPCs into the host process
 *   (which has `--allow-net`).
 *
 * `POSTGRES_CONNECTION_STRING` is auto-injected by compose-cloud. The Turbo
 * job-mode pipelines that this app spawns write into the same Neon DB via
 * the auto-created `CORPORATE_ACTIONS` project secret.
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

export async function neonQuery(
  ctx: TaskContext,
  query: string,
  params: unknown[] = [],
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
 * Compute holder balances for a campaign's snapshot.
 *
 * Each campaign's pipeline writes raw Transfer rows to its own
 * `share_balances_<id>` table (no in-pipeline aggregation — see the rant in
 * `lib/turbo.ts` about FixedSizeBinary handling). The aggregate runs here
 * as a Postgres SQL: every transfer credits the recipient and debits the
 * sender (skipping the zero-address sender for mints), summed per account.
 *
 * Postgres handles binary→numeric coercion at write time — `amount` lands
 * as `numeric(78,0)` which we can cast to text and parse as a JS bigint
 * without precision loss.
 */
export async function getHolders(
  ctx: TaskContext,
  table: string,
): Promise<Holder[]> {
  // `table` is a constructed identifier from pipelineId() — alphanumeric +
  // underscore only — so direct interpolation is safe. (Postgres prepared
  // statements don't support parameterising table names anyway.)
  const rows = await neonQuery(
    ctx,
    `SELECT account, SUM(delta)::text AS balance
       FROM (
         SELECT lower(recipient) AS account, amount AS delta
           FROM "${table}"
         UNION ALL
         SELECT lower(sender) AS account, -amount AS delta
           FROM "${table}"
          WHERE lower(sender) != '0x0000000000000000000000000000000000000000'
       ) ledger
      GROUP BY account
     HAVING SUM(delta) > 0
      ORDER BY account ASC`,
  );
  return rows.map((r) => ({
    address: String(r.account).toLowerCase() as Hex,
    balance: BigInt(String(r.balance)),
  }));
}

/**
 * True if the agg table exists in Postgres. Used as a defensive check —
 * we only read it once Turbo says the job is `completed`.
 */
export async function aggTableExists(
  ctx: TaskContext,
  aggTable: string,
): Promise<boolean> {
  const rows = await neonQuery(
    ctx,
    `SELECT EXISTS (
       SELECT 1 FROM pg_tables
       WHERE schemaname = 'public' AND tablename = $1
     ) AS present`,
    [aggTable],
  );
  return rows[0]?.present === true || rows[0]?.present === "t";
}

/**
 * Drop the per-campaign table. Called on terminal cleanup so the user's
 * Neon DB doesn't accumulate orphaned tables across many campaigns.
 *
 * MUST be called AFTER the pipeline has been DELETE-ed — Turbo's sink writer
 * holds a connection, and dropping while it's still active is racing.
 */
export async function dropCampaignTables(
  ctx: TaskContext,
  transfersTable: string,
): Promise<void> {
  await neonQuery(ctx, `DROP TABLE IF EXISTS "${transfersTable}"`);
}
