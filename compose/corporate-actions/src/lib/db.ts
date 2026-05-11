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
  // Tack on params that bust Neon pool stickiness:
  //   - target_session_attrs=read-write → routes to primary, not a replica
  //   - application_name=<unique>      → defeats pool slot stickiness so each
  //                                      HTTP query gets a freshly-spawned
  //                                      backend connection (which sees
  //                                      committed writes, not a stale snapshot)
  // We've measured ~145s read lag without these; with them the read should
  // see writes within seconds.
  const u = new URL(url);
  u.searchParams.set("target_session_attrs", "read-write");
  u.searchParams.set(
    "application_name",
    `corp-actions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  return u.toString();
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
 * Number of Transfer rows in the per-campaign table, or `null` if the table
 * doesn't exist yet.
 *
 * Why count rather than just check existence?
 *   The Postgres sink creates the table on the very first checkpoint —
 *   even an "empty epoch" with zero matching rows commits, which creates
 *   the schema. So `aggTableExists` can return `true` while the pipeline
 *   is still mid-scan and hasn't reached blocks where the share token's
 *   Transfers live. Counting rows distinguishes "sink initialized" from
 *   "sink has actually delivered data".
 */
export async function aggTableRowCount(
  ctx: TaskContext,
  aggTable: string,
): Promise<number | null> {
  // Beefy diagnostic version: schema-qualified count, planner-stat count,
  // physical table size, schema list, and connection identity. Designed
  // to triangulate a Neon read-after-write visibility lag we've been
  // seeing where count(*) returns 0 for ~2 minutes after the pipeline
  // commits ~10 rows.
  try {
    const diag = await neonQuery(
      ctx,
      `SELECT
         (SELECT count(*)::text FROM public."${aggTable}") AS n_public,
         (SELECT pg_table_size('public."${aggTable}"')::text) AS bytes,
         pg_is_in_recovery()::text AS in_recovery,
         pg_last_xact_replay_timestamp()::text AS last_replay,
         now()::text AS now_ts,
         (SELECT EXTRACT(epoch FROM (now() - pg_last_xact_replay_timestamp()))::text) AS replay_lag_s,
         pg_backend_pid()::text AS pid,
         (SELECT setting FROM pg_settings WHERE name = 'application_name') AS app_name`,
    );
    const r = diag[0] ?? {};
    const n = Number(r.n_public ?? 0);
    console.log(
      `[db] "${aggTable}" n=${r.n_public} bytes=${r.bytes} ` +
        `recovery=${r.in_recovery} replay_lag_s=${r.replay_lag_s} ` +
        `last_replay=${r.last_replay} now=${r.now_ts} ` +
        `pid=${r.pid} app=${r.app_name}`,
    );
    return n;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/does not exist|undefined.relation|relation .* does not exist/i.test(msg)) {
      console.log(`[db] "${aggTable}" → table missing`);
      return null;
    }
    console.log(`[db] "${aggTable}" threw: ${msg}`);
    throw err;
  }
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
