# Capability self-knowledge implementation plan

**Goal:** Let Chat explain supported workflows, current availability, setup steps, and blockers using existing runtime owners.

**Design:** The approved approach combines a compact operating guide with a read-only `capabilities.explain` tool. The guide describes workflows, never permissions. The tool binds scope from the canonical session, reads workspace catalogs and connector projections, and probes tool policy using the invoking actor's context. Results are bounded, timestamped, secret-minimized, and informational. Missing evidence stays unknown; a catalog flag or a connected app alone never proves execution readiness. Existing execution gates remain authoritative.

**Approaches:** A static manual alone would drift and cannot explain live blockers. Expanding callable search alone would mix discovery and readiness. A separate explanation service reuses those owners while preserving their contracts; this is the selected approach from the conversation.

**Constraints:** Preserve all pre-existing changes. No dependencies, user-data writes, configuration changes, activation, external calls, commits, or UI layout changes. Keep runtime guide content outside the operator guidance budget. Code Mode remains governed trusted-code execution, not hostile-code sandboxing.

## Tasks

- [x] Add behavioral tests for ready, approval-needed, sign-in/setup, disabled, denied, failed-read, scope-mismatch, bounded output, and secret minimization.
- [x] Add shared explanation contracts and a concise versioned operating guide with query-selected workflow details.
- [x] Implement the read-only explanation service using catalog, policy, connector, session-preference, and Code Mode readiness owners.
- [x] Register and dispatch `capabilities.explain`; include it in normal and bounded Chat tool selection without changing search/skill feature gates or bypassing policy.
- [x] Add the compact guide to base instructions with tool-availability-aware advice; test prompt and runner integration.
- [x] Run focused tests, typechecks with output-lock wrappers, runtime authority checks appropriate to the slice, documentation checks, and review the diff against the initial dirty checkout. Runtime-truth was attempted but did not pass; see limitations below.

## Review focus

- Policy denials win over setup remedies; no suggestion to bypass a deny.
- Connector source failures and workspace selection failures never appear healthy.
- Search has explicit no-match and truncation semantics; no-match does not mean unsupported.
- Raw connector configuration and errors are omitted; metadata receives secret redaction and is treated as data rather than instructions.
- Explanations grant no execution authority and do not imply exact-argument authorization or successful completion.

## Execution notes

- Focused checks passed: 119 Gateway tests across eight files, 27 policy-engine tests across two files, and eight contract tests. Gateway typecheck, async-boundary, documentation, formatting and whitespace checks passed.
- Review identified native-search fallback, Code Mode caller eligibility, frozen approval restrictions, and profile-free feature gates. Added regressions and kept uncertain turn eligibility unknown.
- Follow-up identified sandbox loopback `EACCES` as the timeout cause: the identical isolated Gateway returned HTTP 200 for health and authenticated readiness outside the sandbox. Added permission-denial diagnostics and an HTTP-status timeout diagnostic to the verification helper. Runtime-truth then passed at `artifacts/verification/2026-11-18T16-57-32-295Z-runtime-truth-22be532b/summary.md`.
- Live Chat with the existing OpenAI Codex OAuth provider and `gpt-6.1-terra` exposed a missing inspection approval preview under the default Safe profile. Added a bounded, redacted preview and legacy reconstruction, preserving approval requirements and all pre-existing preview work. The persisted request became approvable after restarting only the owned isolated runtime.
- Rendered desktop/light (1440×1000) and mobile/dark (390×844) checks verified natural-language capability questions, real `capabilities.explain` calls, ready native search, Gmail setup, approval-needed SMTP, policy-blocked writes/shell, partial-coverage caveats, approval, denial, query/help disclosures and focus. Canonical traces contain only three executed explanation calls and one denied call, with no browse/send/write/configuration tools. Screenshots and curated traces are outside the repository in this chat's visualization directory.
- Receipt wording follow-up: concrete receipts now say "An action receipt is recorded." rather than claiming an outside change. This changes one shared formatter line, preserves backend receipt/effect truth, and passes 49 focused tests, shared-package typecheck, and desktop/light plus mobile/dark rendered checks on saved approved inspections. The throttled unmapped `runtime:evidence_envelope_recorded` browser warning remains outside this slice; no page errors or horizontal overflow were observed.
- Final follow-up validation passed: runtime-truth at `artifacts/verification/2026-11-18T17-17-38-304Z-runtime-truth-2388ab6c/summary.md`, 48 focused Gateway tests, 37 policy-engine tests, 27 verification-helper tests, Gateway typecheck, documentation checks, formatting and whitespace checks. Only desktop/light and mobile/dark combinations were rendered. All task-owned browser and isolated Gateway/UI processes were stopped; existing processes and credentials were preserved. The installed payload was not changed by this chat.
- Ruling: do not alter existing search/skill feature gates or activate tools to answer availability questions. Use the new independent explanation tool, and preserve manual-autonomy and frozen selection limits.
