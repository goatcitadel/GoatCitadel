# Runtime Self-Configuration Security Validation

Date: 2026-08-07

Disposition: **partial source implementation; not shipped self-repair parity**

## Scope

This validation covers the first governed runtime-configuration vertical: a primary local Chat turn that encounters a missing or rejected Brave Search or Parallel Search credential, renders a Gateway-owned secure input control, verifies the credential with the official provider, stores it in the installation OS keychain, seals a secret-free receipt into the durable continuation, and resumes the turn.

The design comparison used immutable upstream source pins:

- OpenClaw `62937ea6fc2515782d65c566399cf98e16af6893`: typed system-agent search wizard, sensitive wizard projection, atomic configuration/revalidation, and doctor-style repair.
- Hermes Agent `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`: provider-declared requirements/acquisition help, password UI, the `secret.request` custody split, and bounded doctor/dependency recipes.

## Security properties established in source and focused proof

1. The raw credential uses a dedicated, strict, bounded, direct-loopback secure-submit route. The generic Chat response route rejects secure configuration material.
2. The secure route is no-store, request-logging-silent, and rate-limited across all session/turn/prompt paths for one actor/IP even when general loopback rate limiting is disabled.
3. The model receives only an allowlisted target ID. Credential acquisition URLs and labels are fixed by the Gateway target descriptor, not supplied by the model or caller.
4. The Gateway rechecks actor, installation scope, deployment profile, deny-wins policy, exact provider host allowlist, prompt expiry, and durable run authority before activation.
5. A database reservation fences the waiting run before provider/keychain effects. SQLite and PostgreSQL schemas store only secret-free control data and the final target/provider/revision/scope receipt.
6. Active duplicate or post-restart submissions never infer effect ownership from the run version and perform no credential effect. Expired ambiguity remains quarantined until a fresh verified replacement reconciles it.
7. A candidate key is masked from concurrent search until durable settlement. Same-process settlement failure restores the previous key when possible; rollback failure clears retained raw compensation material and leaves the target quarantined.
8. Missing and rejected official-provider credential results deterministically offer repair. Known keychain, network, deployment-profile, policy, and Ward limitations project sanitized operator guidance instead of exposing arbitrary exception text or a dead-end password form.

## Validation evidence

| Lane | Result |
|---|---:|
| Policy engine full suite | 65 files, 846 tests passed |
| Gateway secure/runtime/durable/HTTP/keychain suite | 10 files, 275 tests passed |
| Storage reservation, migration, and schema-parity suite | 4 suites, 63 tests passed |
| Mission Control shared API and secure-card tests | 2 files, 22 tests passed |
| Threaded Chat outbound tests | 1 file, 49 tests passed |
| Named durable recovery verification | Passed; artifact `artifacts/verification/2026-08-07T22-37-13-987Z-durable-recovery-a3d3f98f` |
| Contracts, storage, policy-engine, Gateway, Mission Control, and threaded-surface typechecks | Passed |
| Governance/docs checks, including bounded response reads and Docker secret checks | Passed |
| `git diff --check` | Passed; only line-ending conversion warnings |

The focused negative cases include generic-route secret rejection, strict schemas, missing auth, forwarded/remote submission, body limits, no-store error responses, path-splitting rate-limit attempts, stale/wrong actor/run/target/expiry, policy/profile/host failure, duplicate/replayed reservations, provider rejection, audit failure, rollback failure, secret-free durable receipt replay, candidate masking, and crash ambiguity quarantine.

## Open limitations and required follow-up

- No real Brave or Parallel credential was available, so no live provider-issued canary probe or packaged UI journey was executed. Mocked probes do not close that case.
- Live PostgreSQL tests were not run because an isolated test database URL was unavailable. PostgreSQL migration integrity and SQLite/PostgreSQL schema parity passed, but cross-process PostgreSQL behavior remains unproved here.
- Existing installations must add the exact provider host through the Settings/config-generation owner. The credential flow intentionally does not widen the global egress allowlist. This installation currently lacks those hosts.
- A process crash after reservation does not yet regenerate the original secure prompt. The reservation fails closed and later expires into quarantine; a later turn can submit a fresh replacement, but exact original-turn crash recovery is not complete.
- Ward policies that require separate apply-time approval fail closed before secure input. One-time approval authority is not yet bound through prompt, reservation, and submit.
- If keychain rollback and its failure audit both fail, durable quarantine survives, but the storage record does not yet retain a sanitized reason-specific rollback-failure state.
- The slice covers installation-global Brave/Parallel credentials on `local_dev` and `trusted_local`. Remote custody, model-provider bootstrap, OAuth, managed dependencies, service repair, delegated child resume, and arbitrary self-modification are not implemented.
- The named `pnpm verify:self-configuration` packaged/browser/live-provider lane does not exist yet. Public claims must remain “governed repair foundations,” not generic self-configuration or self-healing parity.

## Verdict

The source now has a materially stronger first credential-repair vertical than either upstream pattern alone: OpenClaw's Chat-owned typed workflow plus Hermes' out-of-band secret custody, strengthened with GoatCitadel's OS-keychain storage, deny-wins/network gates, bounded live probe, durable pre-effect reservation, receipt-bound continuation, and fail-closed crash quarantine. It is suitable for continued integration and manual testing after the exact host prerequisite is applied, but it is not yet evidence for generic or restart-complete self-repair parity.
