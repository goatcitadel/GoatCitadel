# Verification Run 2026-07-05T07-02-05-279Z-fast-2dc0ae1f

- Lane: `fast`
- Status: `failed`
- Started: 2026-07-05T07:02:05.279Z
- Finished: 2026-07-05T07:09:56.177Z
- Duration: 7m 50.9s

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
| fast.skills-catalog | fast | passed | 462 ms |  |
| fast.repo-hygiene | fast | failed | 1.6 s | Repo hygiene check failed: - [TRACKED_PERSONAL_PATH] docs/citadel_update/review-2026-07-02/FINDINGS_REPORT_R2.html: Tracked file contains Windows F drive source path. - [TRACKED... |
| fast.storage-migration-parity | fast | passed | 539 ms |  |
| fast.extensions-sdk-build | fast | passed | 10.3 s |  |
| fast.extensions-sdk-package | fast | passed | 856 ms |  |
| fast.typecheck | fast | passed | 1m 46.8s |  |
| fast.test.gateway | fast | passed | 2m 44.8s |  |
| fast.test.storage | fast | passed | 1m 10.6s |  |
| fast.test.policy-engine | fast | passed | 19.3 s |  |
| fast.test.mission-control-next | fast | passed | 1m 5.8s |  |
| fast.test.libraries | fast | passed | 57.0 s |  |
| fast.smoke | fast | passed | 5.0 s |  |
| fast.build | fast | passed | 30.8 s |  |
| fast.docs | fast | passed | 2.7 s |  |
