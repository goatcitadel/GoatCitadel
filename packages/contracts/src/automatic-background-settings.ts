/** Today's Gateway accounting for automatic background model calls. */
export interface AutomaticBackgroundSettings {
  utcDay: string;
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  pendingCount: number;
  model?: { providerId: string; model: string };
  reason?: string;
}
