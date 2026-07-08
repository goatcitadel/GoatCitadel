# GoatCitadel Prompt Pack v3.3 Fixup Loop

Focused repair pack for the latest orchestrator fixes.

Use this pack for fast validation after the current exact-evidence, Cowork section-repair, and minimal-test fallback changes. It intentionally stays small and repeats only the failure families that were just patched.

## Pack-wide Quality Rules

### Evidence and honesty

- Do not invent files, routes, UI states, worker behavior, or hidden runtime state.
- If a prompt asks for exact evidence, cite only files that were actually read.
- Search-only evidence is not enough for exact-evidence prompts.
- Negative results count. If a subsystem was searched but not concretely read, say that plainly.
- Do not cite template placeholders or template paths such as `{{SYSTEM_NAME}}`.

### Cowork contract discipline

- Preserve the exact requested role order.
- Do not add `Synthesis`, `Evidence Used`, `Required Citations`, recap, or any extra heading unless the prompt explicitly asks for it.
- If the prompt says requested-role-order-only, treat that as a hard contract.

### Code/test answer discipline

- Prefer the smallest repo-native test or patch that proves the seam.
- If the prompt asks for a minimal automated test, include setup, act, assert, and failure signature unless the prompt explicitly asks for a different shape.
- If the prompt asks for a plain-English test idea, do not rewrite it into an unrelated scaffold.

# Chat

## Explicit Tools

### TEST-C201: Guidance loading chain exact evidence

Use file or code tools to inspect the current guidance-loading chain for global docs, workspace docs, and runtime guidance resolution. Summarize the observed loading path and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Separate `Observed loading chain` from `Still ambiguous`.
- Do not cite a file unless it was concretely read.

### TEST-C202: Memory lifecycle exact evidence

Use file or code tools to inspect memory routes, memory-context storage, and the operator-facing Memory UI. Explain the current operator-facing lifecycle with exact citations from the files you used.

Answer contract:
- Cite the exact files used.
- Use exactly three bullets labeled `Route surface`, `Stored state`, and `Operator-facing surface`.
- Do not guess unseen maintenance behavior.

### TEST-C203: Workspace override resolution without template leakage

Use file or code tools to inspect how GoatCitadel resolves global docs, workspace docs, and repo guidance at runtime. Summarize the observed chain and cite the exact files used.

Answer contract:
- Cite the exact files used.
- Use exactly three bullets labeled `Observed precedence`, `Operator-visible trace`, and `Still unverified`.
- Do not cite template files or placeholder paths.

# Cowork

## Explicit Tools

### TEST-W201: Memory lifecycle role repair

Use file or code tools to inspect memory routes, memory context services, and any related Memory UI surfaces. Create role-labeled sections for the first fresh regression checks to add.

Answer contract:
- Keep exactly these sections in order: `Researcher`, `QA`.
- Do not add any intro, recap, synthesis, evidence appendix, or citation appendix.
- Each section must contain exactly two bullets.

### TEST-W202: Built-in cron/report seam repair

Use file or code tools to inspect built-in cron wiring, scheduled review execution, and the operator-visible report or cost surface. Create role-labeled sections for the first fresh trust-preserving regression checks to add.

Answer contract:
- Keep exactly these sections in order: `Researcher`, `Ops`, `QA`.
- Do not add any extra headings.
- Keep each section compact and decision-oriented.

### TEST-W203: Rank-1 wake hardening repair

Use file or code tools to inspect approval wake handling, durable-run wake state, runtime lifecycle reads, and the durable contract. Create role-labeled sections for the highest-value fresh hardening checks.

Answer contract:
- Keep exactly these sections in order: `Researcher`, `QA`, `Product`.
- Do not add a synthesis section.
- Do not add an evidence appendix or citation appendix.

# Code

## Explicit Tools

### TEST-D201: Approval wake ordering minimal test

Use file or code tools to inspect the approval wake ordering path and name the exact minimal automated test needed.

Answer contract:
- Include exactly these labels: `Target test file or suite`, `Setup`, `Act`, `Assert`, `Failure signature`.
- The target must stay in the approval wake/effects harness if the repo evidence supports that.
- Fail the answer if it only says to “investigate more.”

### TEST-D202: Plain-English parser regression

Use file or code tools to inspect `goatcitadel_prompt_pack_v2.md` and the current prompt-pack parsing path. Then answer in one short paragraph naming the single parser-focused regression test you would add to prove the v2 pack parses cleanly and stays distinct from the frozen baseline fixture.

Answer contract:
- Return one paragraph only.
- Do not rewrite the answer into labeled scaffolding unless the prompt requires it.
- Mention the concrete pack file you inspected.

### TEST-D203: Exact citation list beyond four files

Use file or code tools to inspect typed wake outcomes, producer call sites, consumer or status shaping, and the validation path. Cite the exact files used, name the contract file, and describe the patch points.

Answer contract:
- Cite the exact files used.
- Include contract, producer, consumer/status, compatibility note, and validation step.
- Do not silently drop a cited file when more than four exact files were used.

### TEST-D204: Generic minimal test fallback should stay specific

Inspect the repo if needed and propose the exact minimal automated test that proves gate selection can intentionally target an expansion pack without silently preferring the older baseline.

Answer contract:
- Include `Setup`, `Act`, `Assert`, and `Failure signature`.
- Anchor the answer in the concrete file evidence if the repo was inspected.
- Do not answer with a placeholder or “keep investigating” language.
