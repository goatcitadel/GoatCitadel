# Work Passport

Status: implemented vertical slice for Chat preflight and immutable turn inspection.

## Product intent

Work Passport helps an operator notice when an AI-assisted task reaches beyond the workspace baseline they explicitly configured, then makes the appropriate review and evidence posture visible before the work is relied on or acted upon.

It classifies the task, not the person. It is not an occupation classifier, competence score, employee-performance system, legal determination, or replacement for accountable judgment.

## Research basis

OpenAI's 2026 workplace study analyzes more than 800,000 consumer ChatGPT conversations and introduces "task crossover": work conversations may involve activities common in an occupation but outside the user's likely occupational boundary. It reports that 16.8% of work-related messages and 43.5% of occupation-specific messages crossed those boundaries. The paper also states material limits: messages are not completed projects or hours, the sample is not workforce-representative, and the study does not measure output quality, use, time saved, or specialist review. Product implication: crossover can be a useful reflection signal, but it cannot responsibly become a hidden worker score or a claim of competence. Sources: [OpenAI overview](https://openai.com/index/how-ai-is-expanding-what-people-do-at-work/), [full report](https://cdn.openai.com/pdf/work-at-the-frontier-report.pdf).

The domain taxonomy is inspired by task-level occupational analysis, not tied to a person's inferred occupation. O*NET's content model links detailed task statements to broader work activities and provides a useful precedent for task-oriented classification. GoatCitadel v1 uses a small local taxonomy rather than calling O*NET or claiming an exact O*NET mapping. Source: [O*NET overview](https://www.onetcenter.org/overview.html).

The trust design follows NIST AI RMF expectations: define context and task, document knowledge limits and risk tolerance, assign human-oversight roles, and use independent review and testing where risk warrants it. Source: [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/).

The interaction design follows the Microsoft human-AI guidelines most relevant here: make capabilities and limits clear, show contextually relevant information, let people correct the system, scope behavior when uncertain, explain why the system acted, and provide granular control. Source: [Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/).

The feature also adopts the ILO's task-level framing that transformation is generally more likely than complete automation and that continued human input and social dialogue matter. Source: [Generative AI and Jobs: A 2025 Update](https://www.ilo.org/publications/generative-ai-and-jobs-2025-update).

## User experience

1. The operator writes a task in Chat.
2. Normal route preflight resolves a server-owned capability profile.
3. The Gateway creates a local deterministic Work Passport for the task and freezes it into that profile.
4. Chat shows a compact card with:
   - detected task domains
   - within-baseline, cross-domain, mixed, unclear, or baseline-not-configured status
   - low, moderate, or high consequence
   - self-check, independent-review, or domain-expert-required posture
   - concrete evidence requirements
5. The operator may expand the card and correct the workspace baseline by editing a role label and selecting primary domains.
6. Saving the baseline forces a fresh preflight. The turn cannot silently reuse the prior fingerprint.
7. The frozen Work Passport appears again in persisted run detail.

If no baseline exists, GoatCitadel may show task-domain signals but must not claim that the operator crossed a boundary.

## Data and authority model

### Operator-authored workspace baseline

The baseline is stored as a reserved namespace of facts in the existing workspace-scoped operator profile:

- `work-passport:role`
- `work-passport:domain:<domain>`

Updates are explicit operator actions. The write path preserves facts outside this namespace, runs the memory secret gate, increments the operator-profile revision, and invalidates its frozen-digest cache. GoatCitadel does not learn or silently change this baseline from conversations.

### Task classification

`WorkPassportService` applies bounded local phrase rules to the current task. It returns at most three domain signals and describes their strength as `low`, `medium`, or `high`; it does not expose a pseudo-scientific probability. Reasons are generic matched-cue descriptions and never echo prompt content.

The v1 taxonomy is:

- administration
- customer experience
- data analysis
- design
- engineering
- finance
- healthcare
- human resources
- legal
- marketing
- operations
- procurement
- project management
- research
- sales
- security

### Immutable turn binding

The record is stored at `ChatTurnCapabilityProfileSelection.workPassport`. The existing capability-profile canonical JSON, section hashes, preflight fingerprint, insert-only persistence, and verification cover it. Adding the optional selection field requires no database migration because the repository already stores and verifies the complete profile JSON.

The model receives a concise server-owned instruction containing boundary, consequence, review posture, action posture, and evidence requirements. The instruction explicitly says that the passport is advisory and that review must not be represented as completed without evidence.

## API

Both routes are operator-scoped and first verify that the workspace exists.

### Read baseline

`GET /api/v1/work-passport/baseline?workspaceId=<id>`

Response:

```json
{
  "workspaceId": "workspace-id",
  "baseline": {
    "configured": true,
    "roleLabel": "Product engineer",
    "primaryDomains": ["engineering", "design"],
    "revision": 4
  }
}
```

### Replace baseline

`PUT /api/v1/work-passport/baseline`

```json
{
  "workspaceId": "workspace-id",
  "roleLabel": "Product engineer",
  "primaryDomains": ["engineering", "design"]
}
```

An empty role and domain list clears the baseline. Domains outside the finite taxonomy fail validation.

## Consequence and review policy

- Low consequence with no crossover signal: self-check.
- Moderate consequence, sensitive subject matter, cross-domain, or mixed work: independent review.
- Consequential action or advice in finance, healthcare, HR, legal, or security: accountable domain-expert review.
- Explicit external-action language: `approval_before_external_action`.

This policy is additive. It does not grant tools, activate capabilities, weaken deny-wins policy, bypass approvals, expand path or network allowlists, or claim that a review occurred. Existing Gateway policy and approval owners remain authoritative.

## Privacy and misuse boundaries

Work Passport must not provide:

- inferred occupations or inferred employee seniority
- individual or team productivity rankings
- manager dashboards comparing crossover rates
- automatic hiring, promotion, compensation, discipline, or termination recommendations
- silent baseline updates from chat history
- a claim that frequent crossover means higher capability

The role label is optional, bounded, secret-checked, and workspace-scoped. Task text is not duplicated into the baseline or Work Passport reasons.

## Failure and uncertainty behavior

- No domain signal: `generic_or_unclear`, with a self-check requirement.
- No baseline: `baseline_not_configured`; do not claim crossover.
- Multiple signals spanning the baseline: `mixed`.
- Baseline update failure: retain the old frozen preflight and show an error.
- Baseline update success: force a new preflight before send.
- Persisted malformed passport: capability-profile verification fails closed.
- Legacy profiles without a passport: remain readable as legacy-compatible capability profiles.

## Validation and rollout

Current focused proof:

- classification, baseline replacement, high-stakes review, and namespace preservation tests
- operator-scoped route and taxonomy validation tests
- capability-profile resolver, persistence, and operator-profile regression tests
- Mission Control typecheck and Work Passport rendering test

Before treating this as a release-level governance control:

1. Add a curated evaluation set covering ambiguous, multi-domain, and adversarial phrasing.
2. Have representative operators test whether cards are understandable and corrections are easy.
3. Measure correction rate, review-posture acceptance, false-positive/false-negative reports, and time-to-understand.
4. Add accessibility and browser proof for keyboard-only baseline editing and mobile disclosure.
5. Add a named end-to-end proof that updates a baseline, refreshes preflight, sends a turn, and verifies the persisted passport hash.

Success is not a high crossover rate. Success is that people correctly understand the task boundary, correct bad classifications or baselines, obtain review when needed, and can inspect the exact contract that governed a turn.

## Known v1 limitations

- English phrase rules only.
- The finite taxonomy is intentionally broad and will miss specialized domains.
- Classification uses the current user task, not attached document content.
- Requirements guide the response but do not create a separate blocking approval type.
- Routed source context currently retains its existing direct-route and subagent-off constraints.
- A deterministic classifier is auditable but less semantically flexible than a governed model-assisted classifier; any future model-assisted version must remain correctable, privacy-bounded, versioned, evaluated, and frozen into the profile.
