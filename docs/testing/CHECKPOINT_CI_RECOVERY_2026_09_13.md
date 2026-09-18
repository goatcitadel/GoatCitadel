# Comparison and UI checkpoint CI recovery

The operator requested preservation of both the comparison implementation and
the UI/UX task on GitHub `main`. Checkpoint `a15fdb851` saved the combined work;
`136494173` added the verified Citadel profile revision follow-up. Local and
remote `main` matched before this recovery slice. These commits preserve work;
they do not establish completion of the comparison program.

## Source cleanup

The first full Code Quality run at `136494173` reported 11 React hook errors and
35 warnings. This slice removes unused imports, bindings and obsolete helper
functions; captures stable draft callbacks; includes keyed session setters in
effect dependencies; and captures the desktop inspector element for focus
restoration during unmount. It preserves the rendered layouts and callback
contracts.

Two files exceeded the existing 1,000-line rule. Quality dashboard formatting and
its unavailable snapshot now live in `QualityDashboardRoutePage.helpers.ts`.
The remote-worker inference wire projections now live in
`remote-worker-inference-exchange-projections.ts`, with public types re-exported
through the existing protocol service. The explicit field allowlist, receipt
validation and frozen responses remain unchanged. No lint rule was relaxed.

## Dependency review

The Trivy run at `136494173` reported 18 high-severity findings. GitHub advisory
ranges and npm release availability were checked on 2026-09-13 before updating
the following dependency families:

| Dependency | Previous | Patched version | Owner |
| --- | --- | --- | --- |
| `@xmldom/xmldom` | 0.8.13 | 0.8.15 | `mammoth` document import |
| `browserslist` | 4.28.1 | 4.28.7 | Babel build tooling |
| `fast-uri` | 3.1.5 | 3.1.6 | Ajv validation |
| `js-yaml` | 4.3.1 | 4.3.2 | Cosmiconfig tooling |
| `sharp` | 0.35.3 | 0.35.4 | Policy-engine image tools and repo tooling |
| `tar` | 7.5.18 | 7.5.21 | CycloneDX SBOM tooling |

Primary references: [xmldom 0.8.15](https://github.com/xmldom/xmldom/releases/tag/0.8.15),
[Browserslist advisory](https://github.com/advisories/GHSA-73wf-gq98-2v4g),
[fast-uri advisory](https://github.com/advisories/GHSA-jqff-g426-hqxp),
[js-yaml advisory](https://github.com/advisories/GHSA-2883-xcg3-v3hh),
[sharp advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c), and
[tar advisory](https://github.com/advisories/GHSA-r292-9mhp-454m).

The scan with development dependencies included identified two additional `tar`
findings, CVE-2026-59873 and CVE-2026-73566. Both are addressed by 7.5.21. The
lockfile changes stay within these six families and their required dependency
trees; unrelated direct dependencies were not upgraded.

`image-size` remains at the patched local 1.2.1 dependency used by `pptxgenjs`.
The current npm release, 2.0.2, still has no published fix for
[CVE-2025-71329](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) or
[CVE-2025-71330](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr).
The unchanged local patch passed bounded malformed-input probes and normal PNG
detection again. Only the existing two exceptions were renewed, through
2026-09-27; no additional CVEs, packages or source paths were excluded.

## Local validation

- Full-repository ESLint passed with `--max-warnings 0`.
- The final 11 focused UI suites passed 204 tests, including the new inspector
  unmount regression.
- Remote-worker execution protocol: 52 tests passed.
- Locked Gateway, Mission Control and policy-engine TypeScript build checks passed.
- The locked Mission Control production build passed with the updated build dependencies.
- `pnpm docs:check` passed, including nine Docker-secret source tests.
- `pnpm verify:gateway:async-boundary` passed ten tests and scanned 997 production
  TypeScript files.
- The image parser patch review passed all three tests before renewal and after
  the frozen dependency installation.
- Policy-engine tests with the updated image and document dependencies: 927
  passed across 70 files.
- The SBOM tool's resolved `tar` 7.5.21 dependency created and read a compressed
  fixture archive successfully, without extracting it.

Lockfile resolution and frozen installation completed. The final Trivy 0.69.3
scan used a freshly downloaded database and included development dependencies:
1,380 pnpm dependency entries, zero unsuppressed high or critical findings. The
scope was `pnpm-lock.yaml`, with the same two expiring image-parser exceptions
described above. This does not assert that every severity, secret or
misconfiguration finding is clear. Evidence:

- `.tmp/comparison-checkpoint-trivy-all-dependencies-final.json`
- `.tmp/comparison-checkpoint-ci-policy-engine-final.log`
- `.tmp/comparison-checkpoint-image-patch-final.log`
- `.tmp/comparison-checkpoint-tar-proof-final.json`
- `.tmp/comparison-checkpoint-ci-typecheck-final.log`
- `.tmp/comparison-checkpoint-ci-next-build-final.log`

Source cleanup commit `efee19b6e` was pushed to `main`; GitHub's Code Quality
workflow passed for that commit. The dependency update is a separate checkpoint.

## Hosted failures at the initial checkpoint

The Verification Fast run `34771617145` at `136494173` also exposed failures
outside this lint/dependency slice. Its checks partition passed 11 of 12
scenarios, including typecheck, build, smoke, docs, migration parity and the async
boundary. Repository hygiene failed because four script tests imported unbuilt
`dist` files and four shell-verifier assertions described the older UI.

Other failed suites cover demo bootstrap fixtures, mesh dispatch fixtures,
permission-profile facade fixtures, the Gateway facade size guard, the MCP
turn-context construction boundary, MCP child-process lifecycle assertions,
memory maintenance UI fixtures and a virtualized-list DOM lifetime. The real
PostgreSQL job failed its v149 catalog-lineage test. These are recorded failures,
not dismissed or assumed to be harmless fixture drift. The follow-up below
records their reproduction and correction; full CI success still needs a fresh
hosted run.

The original logs and downloaded manifests remain under
`.tmp/comparison-ci-136494173/`; compact inventories are
`.tmp/comparison-ci-failure-inventory-136494173.json` and
`.tmp/comparison-ci-test-failures-136494173.json`.

The broader C1-C6 implementation and live acceptance remain open. Drive
formatting is paused. This slice performs no virtual-disk, installed-service,
user-database, provider-credential or external-channel operation.

## Follow-up: current contracts, asynchronous boundaries, and packaging

Commit `80fbba5d7` preserved the MCP context-owner and shell-inspector corrections.
Its hosted Gateway shard 2 passed. Repository hygiene then ran 1,029 tests: 996
passed, 32 platform-specific tests skipped, and one failed because worker
packaging still pinned `fast-uri` 3.1.5 after the security update to 3.1.6.

The following changes address the remaining reproduced failures:

- Demo bootstrap fixtures return the canonical memory page shape, preserving
  idempotent seeding and the optional-memory failure case.
- MCP lifecycle tests wait for actual initialize and tool-call writes before
  injecting crashes or cancellation. A separate case proves cancellation before
  launch starts no child. Runtime environment and approval checks are unchanged.
- Mesh route tests wait for the persisted dispatch event and settle or cancel
  their own pending invocations before closing the temporary database.
- Permission-profile default tests use the real SQLite repository through the
  Gateway, including selection review, record revisions, activation replacement,
  context resolution, and stale-retry rejection. Projection-failure and hardened
  deployment fixtures use the current atomic owner methods and review inputs.
- The composition guard accounts for the three explicitly typed and bound
  permission-selection and MCP preparation methods added by the implementation.
- Memory UI fixtures use opaque revisions, prove conflict detection even when
  timestamps match, preserve the original draft revision across remount, and
  unmount every test renderer.
- Waiting for the notes list's lazy import reproduced the hosted Virtuoso null
  DOM error locally. The test now explicitly waits for that import and exercises
  all 55 row callbacks with a DOM-free virtualizer fixture before searching.
  This is search/selection proof, not browser layout or windowing proof.
- Worker packaging accepts the installed `fast-uri` 3.1.6 graph and rejects both
  the older version and an unreviewed future version. Exact graph checks remain.
- The v149 PostgreSQL test applies migrations through v149, then verifies replay
  is empty and retains its existing catalog assertions. It previously applied
  versions 150-173 while expecting only 149. Historical migration source is unchanged.

Final local evidence for this follow-up:

- Five Gateway suites: 90 tests passed, with no unhandled rejections.
- Full Mission Control coverage lane: 1,142 tests passed across 145 files.
- Worker package integrity tests: 29 passed, including Windows junction checks.
- Real PostgreSQL 16 v149 test: one passed, zero skipped. Its fresh loopback
  cluster was stopped; PID file, process, and listener absence were verified.
- Strict lint, locked Gateway/Mission Control/storage typechecks, documentation
  checks, migration parity, and whitespace checks passed.

Logs: `.tmp/comparison-ci-gateway-fixtures-final.log`,
`.tmp/comparison-ci-ui-coverage-final.log`,
`.tmp/comparison-ci-odysseus-import-before.log`,
`.tmp/comparison-ci-worker-package-after-v2.log`,
`.tmp/comparison-ci-v149-postgres-tests-v1.log`, and
`.tmp/comparison-ci-v149-cleanup-final.json`.

Full hosted verification remains pending. No installed worker payload was
rebuilt or activated in this follow-up. C1-C6 and the remaining mutation-owner,
native-worker, physical-machine, provider/channel, and comparison acceptance
requirements remain open. Formatting stays paused.

## Follow-up: portable evidence paths and database fixture setup

The `e954a9c94` hosted run passed the canonical Mission Control suite, Gateway
shards 1-4, bundled PostgreSQL restart, and the real PostgreSQL lanes. Its Checks
job then rejected machine-specific paths in the comparison evidence document.
The UI job's library partition failed one Gateway-core accounting case after
22.2 seconds of fresh SQLite setup exceeded its 20-second test deadline.

The evidence document now uses `%TEMP%` for 141 historical temporary-directory
prefixes and retains every receipt directory and filename. The standalone
repository hygiene check reproduced the failure before this change and passes
after it. No receipt was moved or deleted.

Accounting tests still create a separate real SQLite database for every case.
Database setup now has a 60-second `beforeEach` hook deadline; the accounting
behavior keeps its existing 20-second test deadline and all settlement, retry,
cost, uncertainty, and persistence-fault assertions. Cleanup verifies the owned
temporary root before removal. The full Gateway-core coverage suite passes:
86 tests across six files. Strict lint, locked typecheck, and documentation checks
also pass.

Evidence: `.tmp/comparison-ci-hygiene-before.log`,
`.tmp/comparison-ci-hygiene-after.log`,
`.tmp/comparison-ci-accounting-before.log`,
`.tmp/comparison-ci-accounting-hook-coverage.log`,
`.tmp/comparison-ci-accounting-hook-lint.log`, and
`.tmp/comparison-ci-accounting-hook-typecheck.log`, with final documentation proof
in `.tmp/comparison-ci-hook-docs-final.log`. Hosted artifacts are retained locally under
`.tmp/comparison-ci-e954a9c94/`.

The hosted retry is still required. Charter/template/blueprint atomicity and
reviewed writes remain open alongside the rest of C1-C6. Formatting remains paused.

## Follow-up: bound the concurrent UI and library test workers

The `7ca337b4c` hosted Checks job passed, and all 15 accounting tests passed in
the library partition. That partition then timed out the first event-ingestion
case after 20.7 seconds. Its fresh SQLite initialization ran alongside the UI
suite and recursive library packages whose Vitest pools were not capped.

The concurrent stage now permits two UI test workers and one test worker for
each of two concurrent library packages, for a combined limit of four. The ten
package filters, coverage instrumentation, and behavior deadlines remain intact.
The descriptor regression check verifies that the library worker option reaches
the package test script and that the combined pool stays bounded.

The named local command
`pnpm verify:fast --commands=fast.test.mission-control-next,fast.test.libraries`
passed both selected scenarios in 2m 6s: 1,142 canonical UI tests and 2,522 tests
across all ten library/desktop packages. On PowerShell, quote the entire
`--commands=...` argument to preserve the comma. The one focused descriptor test
and strict script lint also pass.

Evidence: `artifacts/verification/2026-09-13T19-14-30-955Z-fast-f6532d6f/`,
`.tmp/comparison-ui-library-pool-lane-final.log`,
`.tmp/comparison-fast-pool-contract-test.log`, and
`.tmp/comparison-fast-pool-lint.log`. This is local proof of the selected stage;
the scheduling change has not yet been exercised by GitHub. The full fast lane,
remaining mutation owners, and C1-C6 acceptance are not claimed complete.
