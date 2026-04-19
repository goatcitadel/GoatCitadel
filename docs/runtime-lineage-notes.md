# Runtime Lineage Notes

`ChatDelegateRequest.steps?` is the preferred way to carry an existing dependency-aware execution graph into
`POST /api/v1/chat/sessions/:sessionId/delegate` and `/stream`. Callers can still send only `roles`; when `steps` is
absent, the runtime keeps synthesizing a linear chain for `sequential` and independent branches for `parallel`.

Canonical runtime lineage now resolves in this order:

1. Turn-trace durable linkage and attached `executionPlanId`
2. Execution-plan step linkage (`durableRunId`, `childSessionId`, `childTurnId`)
3. Delegation-step linkage (`durableRunId`, `childSessionId`, `childTurnId`)
4. Approval linkage and task proactive context
5. Durable payload or metadata fallback inference

`childRunId` remains deprecated in this round. It is surfaced only as diagnostic lineage detail and only counts as a run link when it still points at a real durable run and there is no canonical `durableRunId` for that step.

Legacy rows without additive linkage fields still read successfully, but they may show reduced lineage detail until newer writes naturally rewrite the relevant execution-plan or delegation records.
