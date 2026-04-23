# GoatCitadel External Review Synthesis Template

Use this template after both external reviews exist.

Inputs:
- Claude Code first-pass review
- ChatGPT Pro review
- `docs/review/REVIEW_MASTER_BRIEF.md`

Goal:
- merge both reviews into one decision-grade synthesis
- preserve disagreements instead of flattening them
- identify consensus risks, root-cause clusters, and best next actions

Note:
- ChatGPT Pro may have run as a true second pass with Claude's review attached, or as an independent parallel review without Claude's output.
- Preserve that context in the synthesis because it affects how much disagreement should be interpreted as genuine difference versus missing prior context.

## Run Instructions

1. Attach both completed review outputs.
2. Normalize finding titles that describe the same issue in different language.
3. Combine duplicate findings when they are materially the same.
4. Preserve disagreements when the reviewers truly differ on severity, confidence, ownership, or scope.
5. Keep the original evidence paths from both reviewers.
6. Do not force consensus if the evidence or framing differs.
7. Re-tag findings consistently with:
   - severity: `critical`, `high`, `medium`, `low`
   - confidence: `high`, `medium`, `low`
   - release tier: `shipped`, `legacy`, `experimental`
   - certainty: `confirmed`, `likely`, `runtime-validation-needed`

## Normalization Rules

- Prefer one merged title for duplicate findings, but keep both reviewers listed.
- If reviewers disagree on severity, keep the disagreement visible in notes.
- If one reviewer found a user-facing symptom and the other found the deeper root cause, merge them under the deeper root cause and keep the symptom in the notes.
- If two findings only overlap loosely, keep them separate.
- Do not downgrade an issue to consensus just because both reviewers mentioned it. Make sure they are actually pointing at the same risk.

## Finding Record Template

Use this record for each merged or preserved finding.

```md
### [Finding Title]
- Severity: `critical|high|medium|low`
- Confidence: `high|medium|low`
- Release tier: `shipped|legacy|experimental`
- Certainty: `confirmed|likely|runtime-validation-needed`
- Reviewers: `Claude|ChatGPT|Both`
- Evidence paths:
  - `path/to/file`
  - `path/to/other/file`
- Why it matters:
  - ...
- Recommended action:
  - ...
- Notes on agreement/disagreement:
  - ...
```

## Consensus Critical/High Risks

List only findings where both reviewers materially agree the issue is severe and real.

### Finding 1
- Severity:
- Confidence:
- Release tier:
- Certainty:
- Reviewers:
- Evidence paths:
- Why it matters:
- Recommended action:
- Notes:

### Finding 2
- Severity:
- Confidence:
- Release tier:
- Certainty:
- Reviewers:
- Evidence paths:
- Why it matters:
- Recommended action:
- Notes:

## Important Disagreements

Capture findings where the reviewers disagree on:
- whether the issue is real
- how severe it is
- whether it is `shipped`, `legacy`, or `experimental`
- whether it is architectural debt versus a 1.0 trust problem

### Disagreement 1
- Claude position:
- ChatGPT position:
- Shared evidence:
- What remains unresolved:
- Best runtime validation or extra inspection:

### Disagreement 2
- Claude position:
- ChatGPT position:
- Shared evidence:
- What remains unresolved:
- Best runtime validation or extra inspection:

## Claude-Only Findings Worth Keeping

Keep findings that Claude surfaced well and ChatGPT did not materially replace.

### Finding 1
- Severity:
- Confidence:
- Release tier:
- Certainty:
- Evidence paths:
- Why it matters:
- Recommended action:

## ChatGPT-Only Findings Worth Keeping

Keep findings that ChatGPT surfaced well and Claude did not materially replace.

### Finding 1
- Severity:
- Confidence:
- Release tier:
- Certainty:
- Evidence paths:
- Why it matters:
- Recommended action:

## Likely Root-Cause Clusters

Group multiple findings that appear to stem from the same deeper issue.

### Cluster 1
- Root cause hypothesis:
- Related findings:
- Why this cluster matters:
- Best next move:

### Cluster 2
- Root cause hypothesis:
- Related findings:
- Why this cluster matters:
- Best next move:

## Fix Before Broader Testing

List the issues that should be addressed before inviting materially broader usage or external confidence.

- [ ] Item 1
- [ ] Item 2
- [ ] Item 3

## Fix Before 1.0 Positioning

List the issues that may not block internal iteration, but still weaken honest 1.0 claims.

- [ ] Item 1
- [ ] Item 2
- [ ] Item 3

## Acceptable To Defer

List issues that are real but not currently worth disrupting the roadmap for.

- [ ] Item 1
- [ ] Item 2
- [ ] Item 3

## Runtime Validations To Run Next

List the highest-value live checks that would resolve the most uncertainty with the least effort.

### Validation 1
- What to test:
- Why this is high value:
- Which disagreement or finding it resolves:

### Validation 2
- What to test:
- Why this is high value:
- Which disagreement or finding it resolves:

## Final Combined Verdict

Answer:
- Is GoatCitadel actually close to 1.0 in reality, or mostly in surface impression?
- What is most likely to bite next if nothing changes?
- Which issues are structural versus just cleanup debt?
- What should happen next: hardening, decomposition, runtime validation, claim-tightening, or some combination?

## Subsystem Scorecard

Rate each subsystem with exactly one of:
- `1.0-safe`
- `close but risky`
- `not yet trustworthy`

| Subsystem | Rating | Notes |
| --- | --- | --- |
| Gateway/runtime authority |  |  |
| Approvals/orchestration/durable runs |  |  |
| Realtime events and operator truth |  |  |
| Memory lifecycle and admin surfaces |  |  |
| Current UI (`mission-control-next`) |  |  |
| Legacy UI and redirect compatibility |  |  |
| Contracts, migrations, and compatibility |  |  |
| Policy, auth, and tool governance |  |  |
| Integrations, connectors, and MCP |  |  |
| Verification harness and test coverage |  |  |
| Packaging, install, backup, and ops posture |  |  |

## Final Sanity Check

Before finalizing the synthesis:
- confirm terminology matches the master brief
- confirm every top issue still has evidence paths attached
- confirm disagreements are preserved rather than hand-waved
- confirm the final verdict distinguishes `shipped`, `legacy`, and `experimental` concerns
- confirm the scorecard reflects both reviews, not only the louder one
