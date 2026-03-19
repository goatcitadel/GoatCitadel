# GoatCitadel Prompt Pack Repo Expansion

Supplemental prompt-pack tests for sibling repositories in `F:\code`.

## Code Tests
### Explicit-Tools

[TEST-D26] GoatCitadel Arena deterministic judge audit
Read these files using file/code tools:
- `F:/code/goatcitadel-arena/packages/engine/src/judge/rules-judge.ts`
- `F:/code/goatcitadel-arena/packages/engine/src/damage.ts`
- `F:/code/goatcitadel-arena/packages/engine/src/effects.ts`
- `F:/code/goatcitadel-arena/packages/engine/__tests__/rules-judge.test.ts`

Review whether the deterministic round evaluator has any logic bugs, brittle branches, or important regression gaps.

Output exactly these sections:
- Findings
- Evidence
- Suggested tests
- Unknowns

Rules:
- In `Findings`, list only concrete bugs or clearly missing coverage.
- In `Evidence`, cite exact file paths, symbol names, and the specific condition or branch you inspected.
- If you found no concrete bug, write `No concrete findings.` under `Findings`.
- If you cannot support a claim directly from file contents, move it to `Unknowns`.
- Do not propose broad rewrites.

[TEST-D27] GoatCitadel Mobile streaming failure-mode review
Read `F:/code/personal-ai-mobile-app/src/api/streaming.ts`, `F:/code/personal-ai-mobile-app/src/api/client.ts`, and `F:/code/personal-ai-mobile-app/src/features/chat/chatRuntimeStore.ts` using file/code tools. Audit the chat streaming path for abort-handling bugs, duplicate-event risks, Android-vs-fetch behavior drift, and state-sync issues.

Output exactly these sections:
- Findings
- Evidence
- Failure scenarios
- Suggested fixes
- Unknowns

Rules:
- Focus on streaming lifecycle, cleanup, idempotency, and state propagation.
- Quote exact function names, event names, and file paths.
- If you recommend a fix, tie it to a specific observed code path.
- If no concrete bug is proven, say that plainly and focus on residual risks.

[TEST-D28] SQL Teacher sandbox security audit
Read these files using file/code tools:
- `F:/code/sql-teacher/lib/db/sandbox.ts`
- `F:/code/sql-teacher/lib/db/security.ts`
- `F:/code/sql-teacher/lib/db/pool.ts`
- `F:/code/sql-teacher/content/themes/index.ts`
- `F:/code/sql-teacher/db/init/16-security-fixes.sql`

Review whether the SQL execution sandbox is actually safe against schema escape, unsafe session state reuse, runaway queries, or privilege mistakes.

Output exactly these sections:
- Findings
- Evidence
- Residual risks
- Suggested hardening
- Unknowns

Rules:
- Separate proven findings from speculative concerns.
- Cite exact file paths, SQL statements, and helper names.
- If you found no concrete bug, write `No concrete findings.` under `Findings` and use `Residual risks` for softer concerns.
- Do not claim the sandbox is safe or unsafe without file-backed evidence.
- Do not recommend new infrastructure unless labeled optional.

[TEST-D29] PokeScout OCR-to-ranking contract review
Read these files using file/code tools:
- `F:/code/card-identifier/backend/internal/identify/engine.go`
- `F:/code/card-identifier/backend/internal/api/handler.go`
- `F:/code/card-identifier/backend/internal/tcg/types.go`
- `F:/code/card-identifier/app/lib/services/signal_extractor.dart`
- `F:/code/card-identifier/app/lib/services/api_client.dart`

Review the OCR-signal-to-backend contract for mismatch risks, trust-boundary problems, and ranking failure modes.

Output exactly these sections:
- Findings
- Evidence
- Contract mismatches
- Suggested tests
- Unknowns

Rules:
- Ground every finding in observed request/response fields, parser logic, or ranking logic.
- Cite exact file paths and symbol names.
- If you found no concrete bug, write `No concrete findings.` under `Findings`.
- If you infer behavior across Flutter and Go, explain the inference and keep it tied to observed code.
- Do not give generic mobile/backend advice.

[TEST-D30] VidTiles adapter and privacy review
Read these files using file/code tools:
- `F:/code/secret-project/server/services/discoveryService.js`
- `F:/code/secret-project/server/adapters/baseAdapter.js`
- `F:/code/secret-project/server/services/privacyService.js`
- `F:/code/secret-project/server/routes/tiles.js`
- `F:/code/secret-project/server/config.js`
- `F:/code/secret-project/server/middleware/auth.js`
- `F:/code/secret-project/server/middleware/csrf.js`

Review whether the discovery pipeline and privacy controls are coherent, or whether adapters can bypass intended privacy or fetch-discipline guarantees.

Output exactly these sections:
- Findings
- Evidence
- Privacy/control gaps
- Suggested safeguards
- Unknowns

Rules:
- Keep the review scoped to adapter registration, discovery flow, request handling, and privacy service behavior.
- Cite exact file paths, exported functions, class names, and route names.
- If you found no concrete bug, write `No concrete findings.` under `Findings`.
- If the control is described in README but not proven in code, treat it as unverified.
- Do not drift into frontend styling or product suggestions.

[TEST-D31] Starpit frontmatter parser robustness audit
Read these files using file/code tools:
- `F:/code/Starpit/src/data/vault.ts`
- `F:/code/Starpit/src/types/index.ts`
- `F:/code/Starpit/src/store/matchStore.ts`
- `F:/code/Starpit/content/fighters/velvet-steel.md`
- `F:/code/Starpit/content/fighters/cipher.md`

Review whether the custom frontmatter parser is robust against malformed content, nested data drift, or type mismatches with the runtime fighter model.

Output exactly these sections:
- Findings
- Evidence
- Parser edge cases
- Suggested tests
- Unknowns

Rules:
- Focus on parsing behavior, schema assumptions, and runtime model compatibility.
- Cite exact file paths, helper names, and content keys.
- If you found no concrete bug, write `No concrete findings.` under `Findings`.
- If a malformed input case is hypothetical, label it as such and explain why the current parser appears vulnerable.
- Do not recommend replacing the parser unless a concrete limitation justifies it.

[TEST-D32] OpenClaw bounded contributor-risk review
Read `F:/code/_tmp_openclaw_compare/README.md`, `F:/code/_tmp_openclaw_compare/package.json`, and `F:/code/_tmp_openclaw_compare/AGENTS.md` using file/code tools. Determine whether this repo is safe to use as a prompt-pack target right now, given its size and surface area, and propose one tightly bounded test that would reduce bluffing.

Output exactly these sections:
- Findings
- Evidence
- Recommended bounded test
- Anti-bluff constraints
- Unknowns

Rules:
- Stay bounded to the files listed above.
- Do not claim knowledge of deeper subsystems you did not inspect.
- If you found no concrete blocking issue, write `No concrete findings.` under `Findings`.
- The `Recommended bounded test` must be concrete enough to paste into Prompt Lab.
- `Anti-bluff constraints` must be specific, not generic.

## Cowork Tests
### Explicit-Tools

[TEST-W31] Cross-repo prompt-pack target prioritization
Roles in order: `Researcher`, `Architect`, `QA`.

Using file/code tools, inspect these local files only:
- `F:/code/goatcitadel-arena/README.md`
- `F:/code/personal-ai-mobile-app/README.md`
- `F:/code/sql-teacher/package.json`
- `F:/code/card-identifier/README.md`
- `F:/code/secret-project/README.md`
- `F:/code/Starpit/ARCHITECTURE.md`

Decide which three sibling repos should be added next as prompt-pack targets and what prompt families each should contribute.

Output exactly these sections in this order:
- Researcher
- Architect
- QA
- Synthesis

Rules:
- `Researcher` must summarize what each inspected repo appears to contain, with exact file citations.
- `Architect` must recommend the top three additions and the prompt families for each.
- `QA` must explain the main bluffing or maintenance risk for each recommended repo.
- `Synthesis` must give a ranked final recommendation with a short rationale.
- Do not rely on repo knowledge outside the listed files.

[TEST-W32] Repo-specific prompt design pass
Roles in order: `Researcher`, `Architect`, `QA`.

Using file/code tools, inspect these local files only:
- `F:/code/goatcitadel-arena/packages/engine/src/judge/rules-judge.ts`
- `F:/code/personal-ai-mobile-app/src/api/streaming.ts`
- `F:/code/sql-teacher/lib/db/sandbox.ts`
- `F:/code/card-identifier/backend/internal/identify/engine.go`

Design one high-signal Prompt Lab test for each repo. Each proposed test must be grounded in the inspected code and must include anti-hallucination constraints.

Output exactly these sections in this order:
- Researcher
- Architect
- QA
- Synthesis

Rules:
- `Researcher` must summarize the most testable subsystem in each inspected file.
- `Architect` must draft one prompt per repo with a clear output contract.
- `QA` must add one anti-hallucination or anti-bluff constraint per prompt.
- `Synthesis` must present the four finished prompts in a compact numbered list.
- Every prompt must mention exact file paths.
