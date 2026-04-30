import type { TaskContext } from "compose";
import {
  aggTableName,
  CONFIG,
  pipelineName,
} from "./constants";
import type { Hex } from "./types";

/**
 * HTTP client for Goldsky's Turbo pipeline API. Same endpoints the `goldsky`
 * CLI uses, talking directly to api.goldsky.com over public ingress (the
 * compose pod has outbound network for this).
 *
 * Auth is a project API token surfaced as `context.env.GOLDSKY_PROJECT_KEY`
 * — declared in compose.yaml's `secrets:` block, set once via
 * `goldsky secret create GOLDSKY_PROJECT_KEY <value>`.
 */

const API_BASE = "https://api.goldsky.com/api/v1";

function authHeaders(env: Record<string, string>): Record<string, string> {
  const key = env.GOLDSKY_PROJECT_KEY;
  if (!key) {
    throw new Error(
      "GOLDSKY_PROJECT_KEY missing — declare it under `secrets:` in compose.yaml " +
        "and set its value with `goldsky secret create GOLDSKY_PROJECT_KEY <key>`",
    );
  }
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

export type TurboState =
  | "running"
  | "starting"
  | "paused"
  | "stopped"
  | "error"
  | "completed"
  | "unknown";

interface StateResponse {
  status?: string;
  state?: string;
  errors?: unknown;
  success?: boolean;
  error?: string;
}

/**
 * Build the job-mode pipeline definition that snapshots holders of a single
 * ERC-20 at a specific block.
 *
 * Why `erc20_transfers` and not `logs`?
 *   `job: true` requires every source to be a "hybrid source" (one that
 *   supports a bounded backfill). On Base mainnet, `logs` is NOT hybrid;
 *   `erc20_transfers` is. (Pipeline that tried `base.logs` failed with
 *   `job_mode is enabled but the following source(s) do not support it`.)
 *
 * Why `to_u256(amount)` before the cast?
 *   `erc20_transfers.amount` is `FixedSizeBinary(32)` and DataFusion has no
 *   direct cast from FixedSizeBinary to DOUBLE/DECIMAL. `to_u256` is the
 *   canonical bridge — it returns a numeric type that casts cleanly.
 *   (See the failing `corp-actions-5a06330a7f49ce61` pod which tripped on
 *   `Unsupported CAST from FixedSizeBinary(32) to Float64`.)
 *
 * Pieces:
 *   - source: `base.erc20_transfers` filtered to the share token (Fast Scan
 *     triggers on a source-level `filter` over a hybrid dataset with
 *     `start_at: earliest`), bounded by `end_block: recordBlock`
 *   - transform: split each Transfer into `+amount` at `recipient` and
 *     `-amount` at `sender` (skip zero-address sender for mints)
 *   - sink: postgres_aggregate sums per-account deltas into a per-campaign
 *     agg table so concurrent campaigns can't collide on SUM
 */
export function buildSnapshotPipeline(input: {
  campaignId: string;
  shareToken: Hex;
  recordBlock: bigint;
}): Record<string, unknown> {
  const transfersTable = aggTableName(input.campaignId);
  const tokenLower = input.shareToken.toLowerCase();

  return {
    resource_size: "s",
    job: true,
    sources: {
      transfers: {
        type: "dataset",
        dataset_name: `${CONFIG.chain}.erc20_transfers`,
        version: "1.2.0",
        // `start_at` MUST be 'earliest' for hybrid-source / job-mode
        // semantics. Setting it to a block number makes the source
        // non-hybrid and Turbo refuses to run with job:true. The address
        // filter below should still trigger Fast Scan within the
        // start_at:earliest path.
        start_at: "earliest",
        end_block: Number(input.recordBlock),
        filter: `lower(address) = '${tokenLower}'`,
      },
    },
    // The v1 pipelines API requires a `transforms` object even when there's
    // nothing to do — leave it empty.
    transforms: {},
    // Why no SQL transform?
    //   We tried — extensively. `amount` arrives as `FixedSizeBinary(32)` at
    //   the DataFusion layer and there is no in-pipeline conversion to a
    //   numeric/decimal that the planner accepts. Every UDF route either
    //   silently passes binary through (invalid Utf8 downstream),
    //   misinterprets hex as decimal, or hits "Unsupported CAST from
    //   FixedSizeBinary(32) to <T>". The Postgres sink, however, has its
    //   own binary→numeric mapping. So we sink the raw Transfer rows and
    //   compute balances via a SQL aggregate over Postgres at read time
    //   (see `getHolders` in lib/db.ts). One more network round-trip per
    //   campaign in exchange for not fighting DataFusion.
    sinks: {
      transfers_sink: {
        type: "postgres",
        from: "transfers",
        schema: "public",
        table: transfersTable,
        primary_key: "id",
        secret_name: "CORPORATE_ACTIONS",
      },
    },
  };
}

export async function createSnapshotPipeline(
  ctx: TaskContext,
  input: {
    campaignId: string;
    shareToken: Hex;
    recordBlock: bigint;
  },
): Promise<{ name: string }> {
  const name = pipelineName(input.campaignId);
  const definition = buildSnapshotPipeline(input);

  const body = {
    name,
    resource_size: "s",
    description: `Holder snapshot for campaign ${input.campaignId} at block ${input.recordBlock}`,
    definition,
  };

  console.log(`[turbo] POST /pipelines: name=${name}, end_block=${input.recordBlock}`);
  try {
    const res = await ctx.fetch(`${API_BASE}/pipelines`, {
      method: "POST",
      headers: authHeaders(ctx.env),
      body,
    });
    console.log(`[turbo] POST /pipelines response: ${JSON.stringify(res).slice(0, 500)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[turbo] POST /pipelines threw: ${msg}`);
    throw err;
  }
  return { name };
}

/**
 * Read raw upstream pipeline state.
 *
 * NB: we use `/state` (proxied unchanged from streamling) NOT `/status`. The
 * v1 `/status` endpoint runs a status normalizer that maps `completed` →
 * `"UNKNOWN"`, which would silently break job-mode termination detection.
 */
export async function getPipelineState(
  ctx: TaskContext,
  name: string,
): Promise<TurboState> {
  try {
    const res = await ctx.fetch<StateResponse>(
      `${API_BASE}/pipelines/${encodeURIComponent(name)}`,
      { method: "GET", headers: authHeaders(ctx.env) },
    );

    const raw = (res?.status ?? res?.state ?? "unknown").toString().toLowerCase();
    // Job-mode pipelines on this Goldsky deployment transition to `paused`
    // when they finish their `end_block` range (the docs say `completed` but
    // the API surfaces `paused` in practice). Treat both as success.
    if (raw === "completed" || raw === "paused" || raw === "stopped") {
      return "completed";
    }
    if (raw === "running" || raw === "starting" || raw === "deploying") {
      return "running";
    }
    if (raw === "error" || raw === "failed") return "error";
    return "unknown";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 404 used to be treated as `completed` here on the assumption that
    // Turbo auto-cleaned the pipeline after it finished. That fired
    // prematurely on transient API blips during snapshotting, marking
    // campaigns failed and racing the cron's table-drop against the
    // still-running pipeline (see `corp-actions-509e1c9730550e80`).
    // Now we surface 404 as `unknown` and let the caller use the agg table's
    // contents (not pipeline existence) as the success signal.
    if (/404|not found/i.test(msg)) return "unknown";
    throw err;
  }
}

export async function deletePipeline(
  ctx: TaskContext,
  name: string,
): Promise<void> {
  try {
    await ctx.fetch(
      `${API_BASE}/pipelines/${encodeURIComponent(name)}`,
      { method: "DELETE", headers: authHeaders(ctx.env) },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Idempotent: a 404 just means the pipeline was already cleaned up. Any
    // other error is real and the caller should know about it.
    if (!/404|not found/i.test(msg)) throw err;
  }
}
