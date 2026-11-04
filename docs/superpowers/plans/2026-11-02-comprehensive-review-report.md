# Comprehensive review results

The review covered 325 reachable commits and recorded 96 confirmed findings.
Candidate fixes address 95 findings. Cockpit startup remains above its request
and JavaScript budgets.

The completed canonical Fast manifest records all 26 stock checks passing on
source digest `e455db7972763464c4824ebef11f3c4aca342f302a4bbd4f60a95a0ec4ff0878`.
Checks ran serially with at most two workers and one heavy job. Gateway shard 3,
policy engine, and Cockpit needed complete-check retries on unchanged source.
Their first failures remain preserved in the local verification artifacts.
The strict supervisor wrapper still failed because hygiene retained one owned
process after the command exited. The Job retired that process and confirmed
empty. This remains a separate cleanup issue.

Canonical manifest run ID is
`full-fast-7f5107-serial-f854cbefb281-merged`. It combines the 23 passed checks
from `3630aaa95e95` with three completed retries from `f854cbefb281`.
Earlier complete campaigns and interrupted attempts remain available locally.

The last verification corrections isolated tests from inherited credential-file,
secret-store, scheduler, and llama.cpp overrides. Updated expectations retain
the current installer Node pin, plugin install-plan binding, replay bounds
refresh, and exact migration versions. The task runner gained an npm entrypoint
bound to the release Node executable and longer outer deadlines.

Windows bundle deployment remains blocked by an unclassified EPERM in its
output directory. Final packaged Chat, approvals, tray Stop/Restart, final
artifact scans, and the last disposable PostgreSQL identity gate remain
unverified. Earlier source-bound proofs are retained in the local review report.
Live model requests and external sends were zero.

The full local findings ledger, commit ledger, coverage ledger, and source-bound
verification records remain under the isolated worktree's ignored
`.superpowers/sdd/2026-11-02-comprehensive-review/` directory.
