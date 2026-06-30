# Required status checks for `main` (readiness finding F-B5)

The 2026-06-13 1.0 readiness review found that **no status checks are enforced as _required_** on
`main`, so a red CI run (e.g. a failing `pnpm test` or a coverage regression) can still merge — the
workflows already RUN on every push/PR and detect failures, they just don't gate the merge.

Making checks required is a repo-settings/admin action (it cannot be committed as code that
auto-applies), so apply one of the options below.

## Option A — GitHub UI (recommended, ~2 min)

**Settings → Rules → Rulesets → New branch ruleset** (or **Branches → Branch protection**) targeting
`main`. Enable **Require a pull request before merging** (≥1 approval) and **Require status checks to
pass**, then add these as required (also tick "Require branches to be up to date before merging"):

| Check | Workflow | What it gates |
| --- | --- | --- |
| **Code Quality** | `.github/workflows/code-quality.yml` | eslint `--max-warnings 0`, typecheck, Mission Control CSS guards |
| **Verification Fast** | `.github/workflows/verification-fast.yml` | `pnpm test`, `docs:check`, `verify:fast`, **production coverage gate**, real-Postgres storage lane |
| **Code Mode Sandbox Canary** | `.github/workflows/code-mode-sandbox-canary.yml` | Code Mode sandbox metadata/fail-closed proof on Linux |
| **Code Mode Hostile Sandbox Canary** | `.github/workflows/code-mode-sandbox-canary.yml` | Windows AppContainer hostile-code canary proof and claim gating |
| **Security Trivy** | `.github/workflows/security-trivy.yml` | vuln / secret / misconfig scan (HIGH/CRITICAL) |

> ⚠️ **Verification Fast** is the only always-on workflow that runs the full test suite, `docs:check`,
> production coverage gate, and real-Postgres storage lane — it MUST be in the required set (Code
> Quality alone does not run tests). It also re-runs on `v*` tags (finding F-M16), so the exact
> release SHA is re-proven before a release.

## Option B — API (`gh`)

Pick the actual check **context** names from a recent PR's *Checks* tab (usually the job id, e.g.
`fast` for Verification Fast), then:

```bash
gh api -X POST repos/<owner>/<repo>/rulesets \
  -f name='main protection' -f target='branch' -f enforcement='active' \
  -F 'conditions[ref_name][include][]=refs/heads/main' \
  -F 'rules[][type]=pull_request' \
  -F 'rules[][type]=required_status_checks' \
  -F 'rules[][parameters][strict_required_status_checks_policy]=true' \
  -F 'rules[][parameters][required_status_checks][][context]=fast' \
  -F 'rules[][parameters][required_status_checks][][context]=code-quality' \
  -F 'rules[][parameters][required_status_checks][][context]=Code Mode Sandbox Canary' \
  -F 'rules[][parameters][required_status_checks][][context]=Code Mode Hostile Sandbox Canary' \
  -F 'rules[][parameters][required_status_checks][][context]=security-trivy'
```

(Adjust the `context` values to match the check names GitHub shows; the snippet is a starting point.)
