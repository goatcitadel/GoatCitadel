# Execution Spine Operator Proof

Use this checklist to confirm the same delegation run resolves to the same truth across operator surfaces.

## Manual QA

1. Launch a delegated run with more than four branches and confirm only four child workers are active at once.
2. Launch a dependency-gated run and confirm downstream work does not start until its prerequisites settle.
3. Force one prerequisite to fail and confirm dependents end as `skipped`, not `failed`.
4. Confirm stream updates can arrive out of order while the final stitched output stays ordered by `step.index`.
5. Open Chat or Cowork and confirm the attached delegation summary shows running, failed, and skipped steps plus stitched output.
6. Open Tasks and confirm execution plans, delegation runs, delegation steps, and canonical durable lineage match the same run.
7. Open Sessions and Approvals for the same run or approval and confirm lineage IDs match Chat and Tasks.
8. If `childRunId` appears, confirm it is presented as deprecated diagnostic detail only.

## Same Run, Same Truth

- `runId`, `taskId`, and `executionPlanId` match across surfaces.
- `durableRunId`, `childSessionId`, and `childTurnId` prefer canonical linkage over payload previews.
- Skipped dependents stay skipped everywhere.
- Legacy fallback sources can be inspected, but they never override canonical lineage.
