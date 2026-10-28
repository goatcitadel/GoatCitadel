import type { ChatToolRunRecord } from "@goatcitadel/contracts";

/** One row of a turn's tool list: the latest try of a step, after any failed tries of the same tool just before it. */
export type ChatToolRunGroup = {
  /** Stable across new tries: the first try's id, so a row does not remount when a retry arrives. */
  key: string;
  /** The try the row shows: the newest one. */
  run: ChatToolRunRecord;
  /** Failed tries before it, oldest first. They stay listed under the row; nothing is hidden. */
  earlier: ChatToolRunRecord[];
};

/**
 * Trying a tool again after it failed is normal: back-to-back calls of the same tool, where each earlier call
 * failed, read as one step with several tries instead of a wall of near-identical rows.
 * (After hob's work-log rows, https://github.com/FrigadeHQ/hob, MIT.)
 */
export function groupToolRunRetries(runs: readonly ChatToolRunRecord[]): ChatToolRunGroup[] {
  return runs.reduce<ChatToolRunGroup[]>((groups, run) => {
    const last = groups.at(-1);
    if (last && last.run.toolName === run.toolName && last.run.status === "failed") {
      return [...groups.slice(0, -1), { key: last.key, run, earlier: [...last.earlier, last.run] }];
    }
    return [...groups, { key: run.toolRunId, run, earlier: [] }];
  }, []);
}
