# Skill install scanning: design (short)

Date: 2026-11-25. Status: draft for operator approval.

## Why

Hermes Agent scans every skill it installs, gives it a verdict and refuses the dangerous ones. GoatCitadel already scans Skill Hub imports and plugin skills, but some install paths skip the scan, some content gets past the scanner without being read, and the operator never sees the result. The goal is for every way a skill or prompt text reaches the model to get the same scan, with a verdict the operator can see.

## Goals

- Every install path runs the same scan and produces one verdict: clean, warn or block.
- Content the scanner can't read is reported, never passed silently.
- The verdict and its findings show where the operator installs or reviews the skill.

## Non-goals

- Sandboxing skill scripts. Code Mode stays the only governed way to run code, and we make no hostile-code claims.
- A marketplace, a Verified tier, or remote reputation lookups.
- AI-decided verdicts. The scan is deterministic.

## Anti-goals

- New friction for the operator's own skills (see the decision below).
- A second scanner that disagrees with the first. There is one scan function, called from every path.

## Operator decision

Skills in the operator's own folders (`skills/workspace/`, `.assistant/skills/`) **warn**: they install and stay callable, and the finding shows on the skill. Untrusted sources (Skill Hub, plugins, Claude Code plugin import, URL/Git imports) keep blocking dangerous findings, with no override.

## Gaps to close (from the code at 879dae19c)

1. Workspace and `.assistant` skills are discovered as `approved` with no scan (`capability-system-service.ts`, the `workspace` branch of the source classification). Fix: run the shared scan at discovery and attach the verdict. A dangerous finding warns; it doesn't block.
2. Binary or undecodable files pass without notice (`tryReadFileText` in `skill-import-service.ts`). Fix: record an "unreadable file" finding. It blocks for untrusted sources and warns for the operator's own.
3. The script check is weak: 4 regexes, a short extension list, and scripts and network calls are only warnings. Fix: widen the extension list (sh, ps1, bat, cmd, py, js, mjs, ts, rb, pl), add patterns (download-and-run, encoded commands, credential paths, persistence such as cron/registry Run keys), and make download-and-run a block for untrusted sources.
4. Plugin prompt packs get no promptware scan (`plugin-install-change-plan-adapter.ts`, `addPromptPacks`). Fix: run the promptware scan on each pack during plugin inspection, so a dangerous pack refuses the whole install before the Change Plan is approved.
5. The promptware scanner doesn't normalize text (`assembled-prompt-injection-guard.ts`). Fix: NFKC-normalize; flag bidi controls and zero-width characters; decode long base64 runs once and scan the result.
6. Promptware covers only `.md`/`.txt`. Fix: also scan `.json`, `.yaml`/`.yml`, `.toml`, `.html` and whole script files (scripts were first read for comments only; each comment-parsing shortcut proved a way around the check, so scripts are now read whole).
7. The UI doesn't show `riskLevel` or the findings. Fix: a verdict pill (Clean / Warning / Blocked) on the skill row and in the install review, with the findings listed on demand. This is one click to see, in keeping with the one-click approval rule.
8. The legacy `confirmHighRisk` flag is still wired (routes/skills.ts, chat `--confirm-high-risk`, gateway-service). Fix: keep the flag for the operator's own folders; ignore it for untrusted sources, where blocked stays blocked. Remove it if no remaining path needs it.

## Approach

One shared `scanSkillContent(files, { origin: "operator" | "untrusted" })` returns `{ verdict, findings[] }` and is used by Skill Hub import, plugin inspection (skills and prompt packs), Claude Code plugin import, URL/Git import, workspace discovery and self-authoring drafts. The origin decides only whether a dangerous finding warns or blocks. The findings stay the same for both origins.

Approaches considered:
- **One shared scan with an origin flag (picked):** one ruleset, so paths can't drift apart, and the warn/block split is a single branch.
- Per-path scanners: less refactoring, but this is how today's gaps happened.
- Scan only at load time (when a skill enters the model's context): this catches everything, but it reports too late, after install, and costs time on every turn.

## Left to the builder

- Exact pattern list and finding wording (plain operator language, no jargon in Cockpit copy).
- Whether the verdict is stored with the skill record or recomputed at discovery (store it if the content hash is unchanged).
- PR split. Suggested: (a) shared scan + gaps 2, 3, 5, 6; (b) wiring into workspace discovery and plugin prompt packs (1, 4, 8); (c) UI verdict (7).

## Validation

Unit tests for each new finding and for both origins. Focused tests for skill-import, plugin-install and capability-system. Gateway typecheck. `pnpm verify:fast`. For the UI pill, a rendered check in the cockpit (skill row, install review, light and dark themes, phone width).
