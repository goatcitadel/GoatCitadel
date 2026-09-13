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

## Remaining hosted failures

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
not dismissed or assumed to be harmless fixture drift. They require focused
reproduction and correction before claiming full CI success.

The original logs and downloaded manifests remain under
`.tmp/comparison-ci-136494173/`; compact inventories are
`.tmp/comparison-ci-failure-inventory-136494173.json` and
`.tmp/comparison-ci-test-failures-136494173.json`.

The broader C1-C6 implementation and live acceptance remain open. Drive
formatting is paused. This slice performs no virtual-disk, installed-service,
user-database, provider-credential or external-channel operation.
