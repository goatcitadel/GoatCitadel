/**
 * Shared contract between the fast-lane scheduler and coverage reuse validation.
 * A missing shard must fail the coverage gate rather than silently shrinking the
 * evidence set.
 */
export const GATEWAY_COVERAGE_SHARD_COUNT = 4;

export function gatewayCoverageShardDirectory(shard) {
  return `coverage-shard-${shard}`;
}
