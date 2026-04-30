import type { TaskContext } from "compose";
import {
  aggTableName,
  CONFIG,
  landingTableName,
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
  const aggTable = aggTableName(input.campaignId);
  const landing = landingTableName(input.campaignId);
  const tokenLower = input.shareToken.toLowerCase();

  return {
    resource_size: "s",
    job: true,
    sources: {
      transfers: {
        type: "dataset",
        dataset_name: `${CONFIG.chain}.erc20_transfers`,
        // v1.0.0 (NOT v1.2.0): v1.0.0 stores address columns as
        // FixedString (Utf8-compatible) while v1.2.0 emits them as
        // FixedSizeBinary(32) which DataFusion can't auto-cast to Utf8 for
        // CONCAT/lower(). v1.0.0 is the proven shape for in-pipeline SQL.
        version: "1.0.0",
        start_at: "earliest",
        end_block: Number(input.recordBlock),
        filter: `lower(address) = '${tokenLower}'`,
      },
    },
    transforms: {
      signed_deltas: {
        type: "sql",
        primary_key: "id",
        sql:
          `SELECT CONCAT(id, '-credit') AS id,
                  block_number,
                  lower(recipient) AS account,
                  CAST(amount AS DOUBLE) AS delta
             FROM transfers
            UNION ALL
           SELECT CONCAT(id, '-debit') AS id,
                  block_number,
                  lower(sender) AS account,
                  -CAST(amount AS DOUBLE) AS delta
             FROM transfers
            WHERE lower(sender) != '0x0000000000000000000000000000000000000000'`,
      },
    },
    sinks: {
      balances: {
        type: "postgres_aggregate",
        from: "signed_deltas",
        schema: "public",
        landing_table: landing,
        agg_table: aggTable,
        primary_key: "id",
        secret_name: "CORPORATE_ACTIONS",
        group_by: {
          account: { type: "text" },
        },
        aggregate: {
          balance: {
            from: "delta",
            fn: "sum",
            type: "double precision",
          },
        },
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
      `${API_BASE}/pipelines/${encodeURIComponent(name)}/state`,
      { method: "GET", headers: authHeaders(ctx.env) },
    );

    // Streamling-agent returns `{success: false, error: "..."}` when the
    // k8s deployment is missing — that's a hard failure (the pod never came
    // up), not a transient state we should keep polling on.
    if (res?.success === false) {
      const errMsg = String(res?.error ?? "").toLowerCase();
      if (/not found|missing|deployment/i.test(errMsg)) return "error";
    }

    const raw = (res?.status ?? res?.state ?? "unknown").toString().toLowerCase();
    if (
      raw === "running" ||
      raw === "starting" ||
      raw === "paused" ||
      raw === "stopped" ||
      raw === "completed"
    ) {
      return raw;
    }
    // Treat any failed/error variant as "error" so the cron marks the
    // campaign failed immediately instead of polling indefinitely.
    if (raw === "error" || raw === "failed") return "error";
    return "unknown";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 404 = the pipeline doesn't exist in the project. Two real cases:
    //   1. Turbo auto-cleaned a job-mode pipeline ~1h after it completed.
    //   2. The pipeline was never successfully created, or got deleted before
    //      we could observe its terminal state.
    // Both surface as 404. The caller (driveSnapshot) is responsible for
    // distinguishing — it checks aggTableExists + holder count before flipping.
    if (/404|not found/i.test(msg)) return "completed";
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
