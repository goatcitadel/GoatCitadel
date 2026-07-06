# Verification Run 2026-07-06T00-38-14-081Z-fast-67ece928

- Lane: `fast`
- Status: `failed`
- Started: 2026-07-06T00:38:14.082Z
- Finished: 2026-07-06T00:46:34.753Z
- Duration: 8m 20.7s

## Counts

- Passed: 13
- Failed: 1
- Degraded: 0
- Skipped: 0
- Not configured: 0

## Fast Lane Performance

- Budget status: `failed` (not enforced)
- Timing artifact: `perf/fast-lane-timing.json`

## Scenarios

| ID | Subsystem | Status | Duration | Notes |
| --- | --- | --- | ---: | --- |
| fast.skills-catalog | fast | passed | 378 ms |  |
| fast.repo-hygiene | fast | passed | 1.4 s |  |
| fast.storage-migration-parity | fast | passed | 468 ms |  |
| fast.extensions-sdk-build | fast | passed | 9.7 s |  |
| fast.extensions-sdk-package | fast | passed | 725 ms |  |
| fast.typecheck | fast | passed | 1m 37.3s |  |
| fast.test.gateway | fast | failed | 2m 39.1s | {"level":"warn","ts":"2026-07-06T00:40:08.140Z","component":"core:prompt-pack-service","msg":"prompt-pack export refresh failed","packId":"pack-1","reason":"auto_score_prompt_pa... |
| fast.test.storage | fast | passed | 2m 11.0s |  |
| fast.test.policy-engine | fast | passed | 16.1 s |  |
| fast.test.mission-control-next | fast | passed | 53.4 s |  |
| fast.test.libraries | fast | passed | 48.2 s |  |
| fast.smoke | fast | passed | 7.1 s |  |
| fast.build | fast | passed | 26.9 s |  |
| fast.docs | fast | passed | 2.3 s |  |
