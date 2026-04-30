import type { TaskContext } from "compose";
import type { Campaign } from "../lib/types";

/**
 * HTTP trigger. Returns the most-recently-created campaigns from the
 * collection, newest first. Used by the demo dashboard to render the
 * history + in-flight tables.
 *
 *   GET /tasks/list_campaigns?limit=50
 *
 * Returns: { campaigns: Campaign[] }
 */
export async function main(
  context: TaskContext,
  params?: { limit?: number },
) {
  const { collection } = context;
  const limit = Math.min(Number(params?.limit ?? 50), 200);

  const campaigns = await collection<Campaign>("campaigns");
  const all = await campaigns.findMany({});
  // findMany doesn't accept ORDER BY today, so we sort client-side. The
  // table is bounded to ~100s of rows in any realistic demo session, so
  // an in-memory sort is fine.
  all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  return { campaigns: all.slice(0, limit) };
}
