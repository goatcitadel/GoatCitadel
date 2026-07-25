<!--
Thanks for contributing to GoatCitadel.

Agents (Claude Code, Codex, etc.): use the agent template instead —
.github/PULL_REQUEST_TEMPLATE/agent.md
Open it in the browser with ?template=agent.md appended to the compare URL,
or pass it directly: gh pr create --body-file .github/PULL_REQUEST_TEMPLATE/agent.md
-->

## What changed

<!-- What this PR does, in plain language. One or two paragraphs. -->

## Why

<!-- The problem being solved. Link the issue if there is one: Fixes #123 -->

## Risk and blast radius

<!--
Which runtime surfaces does this touch? Call out anything that affects:
policy / approvals / wards, secrets or the vault, migrations or stored data,
gateway routes or event envelopes, packaging or the installer.
Write "none — docs only" if that is genuinely the case.
-->

- [ ] Touches policy, approvals, or Ward enforcement
- [ ] Touches secrets, the vault, or credential handling
- [ ] Adds or changes a storage migration
- [ ] Changes a REST route, status code, or realtime event envelope
- [ ] Changes packaging, the installer, or release tooling
- [ ] None of the above

## Evidence

<!--
Paste what you actually ran and what it printed. Not "tests pass" — the command
and its result. If a gate is red or was skipped, say so here rather than leaving
it out; a known-red lane with an explanation is reviewable, a silent gap is not.
-->

```
```

| Gate | Status |
| --- | --- |
| `pnpm lint` | |
| `pnpm typecheck` | |
| `pnpm -r test` | |
| `pnpm docs:check` | |
| `pnpm verify:fast` | |

## Screenshots

<!-- Required for any Mission Control UI change. Before/after if it is a visual change. -->

## Notes for the reviewer

<!--
Anything that would take a reviewer a while to reconstruct: a decision you went
back and forth on, a deliberate limitation, a follow-up you are intentionally
deferring, or an area you are least confident about.
-->

---

By opening this PR you agree it is contributed under the
[Apache License 2.0](../LICENSE) and that you have read the
[Code of Conduct](../CODE_OF_CONDUCT.md).
