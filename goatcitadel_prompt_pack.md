# GoatCitadel Prompt Pack v4

Tracked canonical prompt pack. 108 tests across the three executable GoatCitadel surfaces plus a dedicated Tools Matrix. The core surfaces each have 9 `no-tools`, 9 `implicit-tools`, and 9 `explicit-tools` prompts. The Tools Matrix contributes 27 additional explicit-tools prompts, evenly mapped back into `chat`, `cowork`, and `code` so the current Prompt Lab runtime can execute them without schema changes.

---

## Chat Tests

### No-Tools

[TEST-C01] Fast factual compression
"Name the three main types of machine learning. Give one sentence for each and keep the full answer under 70 words."

[TEST-C02] Constraint-bound explanation
"Explain DNS to a non-technical person using one analogy. Keep it under 90 words and avoid jargon."

[TEST-C03] Decision under missing context
"Should I use a monorepo or polyrepo? Do not assume team size, languages, or deployment model. Ask only the minimum questions needed before recommending."

[TEST-C04] Honest temporal limitation
"What is the exact current Bitcoin price right now, to the cent?"

[TEST-C05] Structured tradeoff table
"Compare REST and GraphQL for an internal product API. Give 3 pros and 3 cons of each in a table."

[TEST-C06] Executive translation
"Translate this engineering concern for a non-technical VP: 'Our current background jobs are at-least-once, not idempotent, and lack replay-safe checkpoints.' Keep it to 4 bullets."

[TEST-C07] Commit-message precision
"Write a conventional-commits message for a change that renames `user_name` to `display_name`, adds a migration, updates 3 API endpoints, and fixes 2 tests. Keep it concise."

[TEST-C08] Assumption hygiene
"A founder asks, 'Should we rewrite our Node.js app in Rust?' Give a cautious first-pass answer that separates facts, assumptions, and what you'd need to know."

[TEST-C09] Follow-up minimization
"I need a rollout plan for a risky auth change. Before giving the plan, ask no more than 3 questions that materially change the answer."

### Implicit-Tools

[TEST-C10] Project-aware testing recommendation
"Based on what you know about this project and its workflow, what validation steps should I run before changing `apps/gateway`? If you do not have enough repo context, say so plainly and state what you need."

[TEST-C11] Current-regulation summary
"What are the latest meaningful developments in EU AI Act enforcement? Summarize them in 3 bullets. If you can access current sources, use them. If not, say what date your answer depends on."

[TEST-C12] URL-backed argument summary
"I saw an article at https://martinfowler.com/articles/is-quality-worth-cost.html. Summarize the main argument and give 3 thoughtful counterpoints. If you cannot access the page, say so clearly."

[TEST-C13] Fact verification with confidence
"Verify this claim: PostgreSQL 17 added native JSON table support. If you can check current sources, do so. If not, answer with a confidence level and short rationale."

[TEST-C14] Context recall honesty
"What tools and integrations have I connected to this system? If you can inspect current state, list them. If not, explain exactly what source of truth you'd need."

[TEST-C15] Run-history recall
"When was the last failed run or error in my system? Check if you have logs, runs, or reports available. If you do not, tell me where I should look."

[TEST-C16] Recent-sentiment comparison
"I'm choosing between Drizzle ORM and Prisma for a new project. What does recent sentiment seem to be, and what are the real tradeoffs? Use recent information if available."

[TEST-C17] Operator-facing SQLite assessment
"Give me a balanced view of using SQLite in production for a local-first app with one primary writer and an operator UI. Include the main upside, main failure mode, and when to move to Postgres."

[TEST-C18] Repo-aware style guidance
"Based on the current GoatCitadel repo conventions, how should an agent summarize completed coding work to the operator? If you can inspect the repo, ground the answer in it; otherwise say so."

### Explicit-Tools

[TEST-C19] Explicit memory search
"Use `memory.search` to look for notes about deployment workflows or release checklists. Summarize only what you actually find. If nothing is found, say so clearly."

[TEST-C20] Explicit web lookup
"Use `browser.search` to find the current Node.js LTS version. Return only the version number, release line, and the source URL you relied on most."

[TEST-C21] Page extraction
"Use `browser.navigate` to visit https://httpbin.org/json and extract the JSON response. Return it formatted and do not add invented fields."

[TEST-C22] Multi-tool chain
"First use `browser.search` to find the official Fastify documentation URL. Then use `browser.navigate` to visit it and extract the current stable version number from the docs or landing page."

[TEST-C23] Tool failure honesty
"Use `browser.navigate` to visit https://thisdomaindoesnotexist12345.com. Report exactly what happened, the error or block you observed, and one sensible fallback."

[TEST-C24] Structured live extraction
"Use `browser.navigate` to visit https://books.toscrape.com/ and extract the first 5 book titles and prices as JSON."

[TEST-C25] Tool-result interpretation
"Use `browser.search` for 'GoatCitadel AI agent framework'. Analyze whether the results appear real, irrelevant, or empty. Be explicit if the results do not support any real claim."

[TEST-C26] Read-only repo inspection
"Use file/code tools to inspect `goatcitadel_prompt_pack.md`. Tell me how many top-level executable surface groups it contains, and cite the exact section headings you used."

[TEST-C27] Live-response validation
"Use `browser.navigate` to visit https://jsonplaceholder.typicode.com/posts/1. Extract the response and verify whether `userId`, `id`, `title`, and `body` are all present. Report any missing fields exactly."

---

## Cowork Tests

### No-Tools

[TEST-W01] Local vs production platform choice
"Compare Docker Compose and Kubernetes for a solo developer running 3 microservices. Which is better for local development vs production, and why?"

[TEST-W02] Architecture decision critique
"Review this architecture decision: one PostgreSQL database handles both OLTP user traffic and OLAP analytics queries. Identify the main risks and propose 2 alternatives with tradeoffs."

[TEST-W03] Multi-perspective strategic analysis
"Analyze the decision to open-source a SaaS product's core engine from 3 perspectives: CTO, VP Sales, and Developer Relations. End with one synthesized recommendation."

[TEST-W04] Failure-mode analysis
"Perform a failure mode analysis for a checkout flow: add item to cart -> enter payment -> receive confirmation. For each step, list what can go wrong, likelihood, impact, and mitigation."

[TEST-W05] Technology roadmap
"Create a 6-month roadmap for modernizing a legacy PHP monolith into TypeScript services. Include phases, dependencies, staffing assumptions, and risk gates."

[TEST-W06] Runtime delegation and synthesis
"Analyze whether a 12-person SaaS team should replace a homegrown job queue with Temporal. Break the work into product delivery, platform architecture, and QA/operability lenses. Return one operator-ready recommendation that names what each lens contributed without dumping raw sub-agent chatter."

[TEST-W07] Blocker-aware plan
"Plan a release for enabling background document parsing in a customer-facing app. Separate the work into implementation, security review, and operator runbook lanes. If one lane appears blocked, surface the blocker, adapt the plan, and still deliver one merged answer."

[TEST-W08] Parent-owned final delivery
"Assess whether to adopt event sourcing for a billing system. Weigh architecture impact, finance/compliance implications, and incident-response tradeoffs. Only the controller should speak in the final answer. Include a compact status snapshot and one final recommendation."

[TEST-W09] Operator-steerable synthesis
"Prepare a migration recommendation for replacing Sentry with an open-source observability stack. Cover technical feasibility, rollout controls, and operational blind spots. Make the final answer easy for an operator to steer: list assumptions, blockers, and next-action options."

### Implicit-Tools

[TEST-W10] Current benchmark synthesis
"Research the current state of Bun vs Deno vs Node.js performance benchmarks. If you can access recent sources, use them. Synthesize the findings and say what the benchmark caveats are."

[TEST-W11] Competitive landscape
"Map the current competitive landscape for open-source observability tools covering logs, metrics, and tracing. Include the Grafana stack, Datadog alternatives, and emerging players if you can verify them."

[TEST-W12] Best-practices compilation
"Compile current best practices for securing a Node.js API in production. Check for recent OWASP guidance or updated ecosystem recommendations if you can."

[TEST-W13] Trend analysis
"Analyze the adoption and perceived productivity impact of AI-assisted coding tools such as GitHub Copilot, Cursor, Claude Code, and similar products. Use recent sources if available."

[TEST-W14] Multi-source deep dive
"Deep dive into connection pooling strategies for serverless Postgres. Cover PgBouncer, provider-native poolers, and client-side workarounds. Compare latency, complexity, and failure modes."

[TEST-W15] Ecosystem evaluation with recency
"Evaluate the current Rust web framework ecosystem for a REST API. Compare Actix-web, Axum, and Rocket, and use recent signals if you can find them."

[TEST-W16] Supply-chain risk assessment
"Assess the security risk of using third-party npm packages with meaningful adoption but very few maintainers. If you can, use recent supply-chain incidents to recommend a vetting workflow."

[TEST-W17] Industry analysis
"Research how fintech startups are handling PCI DSS compliance in 2026. What are the common approaches, what is still painful, and what tooling is simplifying the work?"

[TEST-W18] Repo-aware validation strategy
"Based on the current GoatCitadel repo and docs, propose the 5 highest-value overnight validation checks to run before a private beta. If you can inspect the repo, ground the answer in it; if not, say so."

### Explicit-Tools

[TEST-W19] Explicit multi-source research
"Use `browser.search` to find the top 3 most-starred TypeScript ORMs on GitHub. Then use `browser.navigate` on each repository page and extract stars, last commit date, and open issues count. Compare them in a table."

[TEST-W20] Documentation comparison
"Use `browser.search` to find the official migration guides for Prisma and Drizzle. Visit each and compare ease of setup, migration workflow, and TypeScript integration quality."

[TEST-W21] Release verification
"Use `browser.search` and `browser.navigate` to verify the current latest stable release of PostgreSQL, when it was released, and what major features it introduced. Cross-reference at least 2 sources."

[TEST-W22] Edge deployment recommendation
"Use `browser.search` to find official docs for Cloudflare Workers, Deno Deploy, and Vercel Edge Functions. Visit each, extract supported runtimes and key limitations, then recommend one for a real-time API proxy."

[TEST-W23] Repo target prioritization
"Roles in order: `Researcher`, `Architect`, `QA`.

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
- Do not rely on repo knowledge outside the listed files."

[TEST-W24] Repo-specific prompt design pass
"Roles in order: `Researcher`, `Architect`, `QA`.

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
- Every prompt must mention exact file paths."

[TEST-W25] GoatCitadel prompt-lab improvement review
"Roles in order: `Researcher`, `Architect`, `QA`.

Using file/code tools, inspect these local files only:
- `F:/code/personal-ai/goatcitadel_prompt_pack.md`
- `F:/code/personal-ai/apps/gateway/src/services/prompt-pack-service.ts`
- `F:/code/personal-ai/apps/mission-control/src/pages/PromptLabPage.tsx`
- `F:/code/personal-ai/docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md`

Recommend the single highest-value Prompt Lab improvement to ship next.

Output exactly these sections in this order:
- Researcher
- Architect
- QA
- Synthesis

Rules:
- `Researcher` must summarize the current prompt-pack source-of-truth and execution flow using exact file citations.
- `Architect` must propose one bounded improvement with a small implementation shape.
- `QA` must call out regression risk and how to validate the improvement.
- `Synthesis` must choose one recommendation only."

[TEST-W26] Browser state control pass
"Roles in order: `Researcher`, `QA`.

Use `browser.context.configure`, `browser.navigate`, `browser.cookies.set`, `browser.cookies.get`, `browser.cookies.clear`, `browser.storage.set`, `browser.storage.get`, and `browser.storage.clear` against `https://example.com/`.

Output exactly these sections in this order:
- Researcher
- QA
- Synthesis

Rules:
- `Researcher` must report what state operations were attempted and what evidence was returned.
- `QA` must separate successful state changes from blocked or unverified ones.
- `Synthesis` must state whether browser-state tools appear production-ready, partially blocked, or non-functional.
- If any tool is blocked by policy or approval, keep it in the analysis instead of skipping it."

[TEST-W27] Interactive web flow plus POST echo
"Roles in order: `Researcher`, `Architect`, `QA`.

Use `browser.interact` on `https://httpbin.org/forms/post` to attempt a minimal form submission, then use `http.post` on `https://httpbin.org/post` with a tiny JSON payload.

Output exactly these sections in this order:
- Researcher
- Architect
- QA
- Synthesis

Rules:
- `Researcher` must describe what the interactive flow and POST call returned, or the exact block/failure point.
- `Architect` must explain whether the current tool contract is sufficient for reliable browser-interaction testing.
- `QA` must call out approval, policy, or determinism risks.
- `Synthesis` must make a go/no-go recommendation for exposing these tools more broadly in Prompt Lab."

---

## Code Tests

### No-Tools

[TEST-D01] Code pattern explanation
"Explain the Repository Pattern in TypeScript. Show a simple interface and one concrete implementation. Keep the code under 40 lines."

[TEST-D02] Code review from description
"Review this approach: storing user sessions in a JavaScript `Map` inside a Node.js Express server. Identify 3 problems and suggest a fix for each."

[TEST-D03] Algorithm design
"Design a TypeScript function that merges overlapping time intervals. Provide the code, state the time complexity, and include the type definition for the interval input."

[TEST-D04] Error handling strategy
"Design an error handling strategy for a REST API with route handler -> service -> repository layers. Show the error types, how they propagate, and what the client receives."

[TEST-D05] Database schema design
"Design a SQLite schema for a small task app with users, projects, tasks, and task comments. Include indexes and explain why each index exists."

[TEST-D06] Refactoring assessment
"A function currently validates input, queries the database, transforms data, sends an email, and logs the result. Show how you would decompose it using the Single Responsibility Principle. Give function signatures only."

[TEST-D07] Test design
"Design at least 10 test cases for `calculateDiscount(price, customerTier, couponCode)`. Cover normal cases, boundaries, invalid input, and error conditions."

[TEST-D08] Security review
"Review this pseudocode for SQL injection: `db.query('SELECT * FROM users WHERE name = ' + req.params.name)`. Explain the exploit path and provide the safe parameterized version."

[TEST-D09] Runtime-state design
"Design a minimal durable approval state machine for a gateway that can pause, resume, and reject approval-gated work. Include states, transitions, and one key invariant that prevents duplicate resolution."

### Implicit-Tools

[TEST-D10] Contextual input validation
"Add input validation to the POST `/api/tasks` endpoint in my project. The validation should require `title` to be a non-empty string under 200 characters and allow `description` only if it is under 2000 characters. If you can inspect the existing code, do so. Otherwise, write the validation assuming an Express handler."

[TEST-D11] Bug investigation
"There's likely a bug in `utils.ts`: `clampValue` may not handle `NaN` inputs correctly. Investigate and fix it if you can inspect the file. If you cannot, describe the likely bug and the smallest safe fix."

[TEST-D12] Partial-update feature
"Add a PATCH endpoint for tasks that applies partial updates only for fields present in the request body. If you can inspect the existing code, follow its current style and data flow."

[TEST-D13] Dependency analysis
"Analyze the dependencies in this project's `package.json`. Are any obviously outdated, redundant, or risky? If you can inspect the file, do a concrete analysis. If not, describe the exact review process."

[TEST-D14] Test generation
"Write unit tests for the utility functions in `src/utils.ts`. Cover all functions with at least 2 test cases each, including edge cases. Use the project's configured test framework if you can inspect it."

[TEST-D15] Code quality improvement
"Inspect the prompt-pack fixture server and identify the single highest-value code quality improvement that would not change behavior. If you can inspect the code, ground your answer in exact files and symbols."

[TEST-D16] Repo-native validation contract
"Based on the current GoatCitadel repo, what validation steps should accompany a change to `apps/gateway/src/services/prompt-pack-service.ts`? If you can inspect the repo, give a concrete answer with command examples."

[TEST-D17] First-class tools section design
"The current prompt-pack workflow only has `chat`, `cowork`, and `code` executable modes. Based on the current repo if you can inspect it, explain the smallest safe way to add a dedicated tools section without breaking imports or scoring."

[TEST-D18] Source-of-truth hardening
"Based on the current GoatCitadel repo, propose the smallest repo-native fix that prevents prompt packs from living only in SQLite exports or ignored artifacts. If you can inspect the repo, ground the proposal in exact files."

### Explicit-Tools

[TEST-D19] Read and refactor
"Read `fixtures/prompt-pack-workspace/src/utils.ts` using file tools. Identify any functions that could be improved. Refactor `slugify` so it handles unicode characters better and provide the updated code."

[TEST-D20] Import and dependency audit
"Read `fixtures/prompt-pack-workspace/src/index.ts` and `fixtures/prompt-pack-workspace/package.json` using file tools. List all imports used by the server entry file and report any missing or suspicious dependencies."

[TEST-D21] Full project audit
"Read all source files in `fixtures/prompt-pack-workspace/` using file/code tools. Produce a project audit covering structure, code quality, type safety, error handling, test gaps, and security concerns. Reference actual code."

[TEST-D22] Migration implementation plan
"Read `fixtures/prompt-pack-workspace/src/index.ts` using file/code tools. The task API currently uses an in-memory `Map`. Write a concrete implementation plan to migrate it to SQLite. Reference actual functions and files."

[TEST-D23] End-to-end implementation
"Read `fixtures/prompt-pack-workspace/src/index.ts` and `fixtures/prompt-pack-workspace/src/utils.ts` using file/code tools. Add a new `GET /api/tasks/stats` endpoint that returns `{totalTasks, byStatus: {pending, in_progress, done}, averageTitleLength}`. Show the exact code changes needed."

[TEST-D24] GoatCitadel Arena deterministic judge audit
"Read these files using file/code tools:
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
- Do not propose broad rewrites."

[TEST-D25] GoatCitadel Mobile streaming failure-mode review
"Read `F:/code/personal-ai-mobile-app/src/api/streaming.ts`, `F:/code/personal-ai-mobile-app/src/api/client.ts`, and `F:/code/personal-ai-mobile-app/src/features/chat/chatRuntimeStore.ts` using file/code tools. Audit the chat streaming path for abort-handling bugs, duplicate-event risks, Android-vs-fetch behavior drift, and state-sync issues.

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
- If no concrete bug is proven, say that plainly and focus on residual risks."

[TEST-D26] SQL Teacher sandbox security audit
"Read these files using file/code tools:
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
- Do not recommend new infrastructure unless labeled optional."

[TEST-D27] GoatCitadel prompt-lab source-of-truth review
"Read these files using file/code tools:
- `F:/code/personal-ai/goatcitadel_prompt_pack.md`
- `F:/code/personal-ai/apps/gateway/src/services/prompt-pack-service.ts`
- `F:/code/personal-ai/apps/gateway/src/services/prompt-pack-service.test.ts`
- `F:/code/personal-ai/.gitignore`

Review whether Prompt Lab currently has a clear source of truth for prompt packs, or whether source files, SQLite imports, and ignored artifacts can drift.

Output exactly these sections:
- Findings
- Evidence
- Drift risks
- Suggested fix
- Unknowns

Rules:
- Keep the review bounded to source-of-truth, import/export, and ignored-artifact behavior.
- Cite exact file paths, constants, tests, and ignore rules.
- If you found no concrete bug, write `No concrete findings.` under `Findings`.
- If a risk is process-based rather than code-enforced, label it clearly."

---

## Tools Matrix

Dedicated tool-discipline coverage. These prompts remain import-compatible by nesting under the existing executable modes.

### Chat Tests

#### Explicit-Tools

[TEST-T01] Session and clock sanity
"Use `session.status` and `time.now`.

Return exactly these sections:
- Session summary
- Time summary
- Tool evidence
- Unknowns

Rules:
- `Session summary` must state only what `session.status` directly supports.
- `Time summary` must include both local time and UTC if the tool returns them.
- `Tool evidence` must name both tools explicitly.
- If either tool is unavailable, say which one and do not guess the missing output."

[TEST-T02] Local file reconnaissance ladder
"Using local file/code tools only, inspect `fixtures/prompt-pack-workspace`.

Required tool path:
1. Use `fs.list` on `fixtures/prompt-pack-workspace`
2. Use `fs.stat` on `fixtures/prompt-pack-workspace/package.json`
3. Use `fs.read` on `fixtures/prompt-pack-workspace/package.json`
4. Use `file.find` to locate `slugify`
5. Use `file.read_range` on `fixtures/prompt-pack-workspace/src/utils.ts`

Return exactly these sections:
- Directory view
- File metadata
- Package summary
- Symbol evidence
- Unknowns

Rules:
- Do not skip directly to `fs.read`; follow the required tool order.
- `Symbol evidence` must cite the exact file path and helper name you verified.
- If any tool fails, say which step failed and continue with the completed evidence only."

[TEST-T03] Code search narrowing pass
"Using local file/code tools only, locate how the fixture server derives its runtime port and task routes.

Required tool path:
1. Use `code.search_files` to find the likely server entry file
2. Use `code.search` for `app.listen`, `/api/tasks`, and `clampValue`
3. Use `file.read_range` or `fs.read` only on the files needed to confirm the result

Return exactly these sections:
- Located files
- Route summary
- Port derivation
- Tool evidence
- Unknowns

Rules:
- Keep the read set minimal; do not dump entire files if search already narrowed the target.
- `Port derivation` must explain the observed fallback/default path from code, not a guess.
- Cite exact file paths and symbol names."

[TEST-T04] Web lookup with citation bundle
"Use `browser.search`, `browser.navigate`, `http.get`, and `citations.build` to answer this:

What is the current Node.js LTS version, and what page most directly supports that claim?

Return exactly these sections:
- Answer
- Supporting URLs
- Citation bundle summary
- Tool evidence
- Unknowns

Rules:
- Use at least one search result and one direct page fetch.
- `Answer` must be concise.
- `Supporting URLs` must include the source you relied on most.
- If `citations.build` is unavailable, say so explicitly instead of implying citations were created."

[TEST-T05] Memory and retrieval honesty check
"Use `memory.read`, `memory.search`, and `embeddings.query` to look for any saved context about deployment workflows or prompt-pack preferences.

Return exactly these sections:
- Memory hits
- Retrieval hits
- Tool evidence
- Unknowns

Rules:
- If there are no relevant hits, say `No relevant memory hits.` or `No relevant retrieval hits.` plainly.
- Do not invent stored context.
- If `embeddings.query` has no indexed material to search, say that clearly."

[TEST-T06] Screenshot-backed page check
"Use `browser.navigate`, `browser.extract`, and `browser.screenshot` on `https://books.toscrape.com/`.

Return exactly these sections:
- Page summary
- First book evidence
- Screenshot status
- Tool evidence
- Unknowns

Rules:
- `First book evidence` must include one observed title and price from the page.
- `Screenshot status` must say whether a screenshot artifact was successfully created.
- If screenshot capture fails, keep the textual evidence and report the failure plainly."

[TEST-T07] Explicit browser failure handling
"Use `browser.navigate` on `https://thisdomaindoesnotexist12345.com/`.

Return exactly these sections:
- Observed result
- Error classification
- Suggested fallback
- Tool evidence
- Unknowns

Rules:
- Report the exact observed failure or block.
- Do not retry the same failing action repeatedly.
- Do not replace the failed result with a guessed network explanation."

[TEST-T08] Local-plus-web version comparison
"Use `fs.read` to inspect `fixtures/prompt-pack-workspace/package.json`, then use `browser.search` or `browser.navigate` to compare the pinned `express` and `typescript` versions against current official release pages.

Return exactly these sections:
- Local versions
- Current versions
- Delta summary
- Tool evidence
- Unknowns

Rules:
- `Local versions` must come from the file you read.
- `Current versions` must come from the web evidence you actually visited.
- If a package is missing locally or a web source is unavailable, say that explicitly."

[TEST-T09] Doc discovery chain
"First use `browser.search` to find the official Fastify docs or homepage. Then use `browser.navigate` to visit it and extract the most recent stable version reference you can verify.

Return exactly these sections:
- Located source
- Version evidence
- Tool evidence
- Unknowns

Rules:
- Do not rely on a non-official site if the official docs are available.
- `Version evidence` must quote the page context in paraphrase, not from memory.
- If the page does not expose a stable version clearly, say so."

### Cowork Tests

#### Explicit-Tools

[TEST-T10] Browser state control pass
"Roles in order: `Researcher`, `QA`.

Use `browser.context.configure`, `browser.navigate`, `browser.cookies.set`, `browser.cookies.get`, `browser.cookies.clear`, `browser.storage.set`, `browser.storage.get`, and `browser.storage.clear` against `https://example.com/`.

Output exactly these sections in this order:
- Researcher
- QA
- Synthesis

Rules:
- `Researcher` must report what state operations were attempted and what evidence was returned.
- `QA` must separate successful state changes from blocked or unverified ones.
- `Synthesis` must state whether browser-state tools appear production-ready, partially blocked, or non-functional.
- If any tool is blocked by policy or approval, keep it in the analysis instead of skipping it."

[TEST-T11] Interactive web flow plus POST echo
"Roles in order: `Researcher`, `Architect`, `QA`.

Use `browser.interact` on `https://httpbin.org/forms/post` to attempt a minimal form submission, then use `http.post` on `https://httpbin.org/post` with a tiny JSON payload.

Output exactly these sections in this order:
- Researcher
- Architect
- QA
- Synthesis

Rules:
- `Researcher` must describe what the interactive flow and POST call returned, or the exact block/failure point.
- `Architect` must explain whether the current tool contract is sufficient for reliable browser-interaction testing.
- `QA` must call out approval, policy, or determinism risks.
- `Synthesis` must make a go/no-go recommendation for exposing these tools more broadly in Prompt Lab."

[TEST-T12] Multi-source pricing comparison
"Roles in order: `Researcher`, `Architect`, `QA`.

Use `browser.search` and `browser.navigate` to find pricing pages for Vercel, Netlify, and Cloudflare Pages. Extract the free-tier limits and first paid-tier price you can verify.

Output exactly these sections in this order:
- Researcher
- Architect
- QA
- Synthesis

Rules:
- `Researcher` must list the exact URLs visited and the pricing facts extracted from each.
- `Architect` must explain which platform best fits a small side project vs a production app.
- `QA` must call out ambiguity, outdated pricing risk, or missing plan details.
- `Synthesis` must give one concise recommendation."

[TEST-T13] Cross-source release verification
"Roles in order: `Researcher`, `QA`.

Use `browser.search` and `browser.navigate` to verify the current latest stable PostgreSQL release, release date, and one feature you can confirm from official materials.

Output exactly these sections in this order:
- Researcher
- QA
- Synthesis

Rules:
- Cross-check with at least two visited pages.
- `Researcher` must state which source appeared most authoritative.
- `QA` must call out any disagreement between sources or stale-result risk.
- `Synthesis` must give a short final answer with date."

[TEST-T14] Edge runtime documentation sweep
"Roles in order: `Researcher`, `Architect`, `QA`.

Use `browser.search` and `browser.navigate` to inspect official docs for Cloudflare Workers, Deno Deploy, and Vercel Edge Functions. Extract supported runtimes and one limitation per platform.

Output exactly these sections in this order:
- Researcher
- Architect
- QA
- Synthesis

Rules:
- `Researcher` must cite the exact docs pages visited.
- `Architect` must recommend one platform for a real-time proxy use case and justify it.
- `QA` must flag missing, outdated, or ambiguous documentation claims.
- `Synthesis` must keep the recommendation operator-ready."

[TEST-T15] Repo target prioritization pass
"Roles in order: `Researcher`, `Architect`, `QA`.

Using file/code tools, inspect these local files only:
- `F:/code/goatcitadel-arena/README.md`
- `F:/code/personal-ai-mobile-app/README.md`
- `F:/code/sql-teacher/package.json`
- `F:/code/card-identifier/README.md`

Rank which two repos should contribute the next high-signal prompt-pack tests.

Output exactly these sections in this order:
- Researcher
- Architect
- QA
- Synthesis

Rules:
- Stay bounded to the listed files.
- `Researcher` must summarize each repo with exact file citations.
- `Architect` must pick two repos and name the most valuable prompt family for each.
- `QA` must call out the main bluffing risk for each pick.
- `Synthesis` must return a ranked top-two only."

[TEST-T16] GoatCitadel docs-grounded improvement scan
"Roles in order: `Researcher`, `Architect`, `QA`.

Using file/code tools, inspect these local files only:
- `F:/code/personal-ai/goatcitadel_prompt_pack.md`
- `F:/code/personal-ai/docs/GOATCITADEL_AGENTIC_CODING_WORKFLOW.md`
- `F:/code/personal-ai/AGENTS.md`

Recommend the next highest-value improvement to GoatCitadel's evaluation strategy.

Output exactly these sections in this order:
- Researcher
- Architect
- QA
- Synthesis

Rules:
- `Researcher` must quote the current evaluation shape from the inspected files using exact citations.
- `Architect` must recommend one bounded improvement only.
- `QA` must explain how to validate that change.
- `Synthesis` must keep the final recommendation concise."

[TEST-T17] Security-best-practices compilation
"Roles in order: `Researcher`, `QA`.

Use `browser.search` and `browser.navigate` to compile current best practices for securing a Node.js API in production.

Output exactly these sections in this order:
- Researcher
- QA
- Synthesis

Rules:
- `Researcher` must organize findings under authentication, input validation, rate limiting, and secrets management.
- `QA` must identify where the guidance is general best practice versus explicitly source-backed.
- `Synthesis` must give a short operator-ready checklist."

[TEST-T18] Fixture workspace audit with bounded reads
"Roles in order: `Researcher`, `QA`.

Use only file/code tools on `fixtures/prompt-pack-workspace` to assess structure, code quality, and missing validation scripts.

Output exactly these sections in this order:
- Researcher
- QA
- Synthesis

Rules:
- Keep the read set bounded to files needed to support the claim.
- `Researcher` must cite exact files read.
- `QA` must call out any places where the evidence is incomplete.
- `Synthesis` must list the top 3 improvements only."

### Code Tests

#### Explicit-Tools

[TEST-T19] Citation-backed environment claim check
"Roles in order: `Researcher`, `Architect`, `QA`.

Use `browser.search`, `browser.navigate`, and `citations.build` to answer this question: which official page most directly states the currently supported Node.js release line for production use?

Output exactly these sections in this order:
- Researcher
- Architect
- QA
- Synthesis

Rules:
- `Researcher` must list the pages visited and which one appears canonical.
- `Architect` must explain why that page is the right operator reference.
- `QA` must call out any citation or source-gathering gaps.
- `Synthesis` must name the single best page."

[TEST-T20] Read-only verification command pass
"Using `git.status`, `git.diff`, `build.run`, `tests.run`, and `lint.run`, inspect the prompt-pack fixture workspace at `fixtures/prompt-pack-workspace`.

Return exactly these sections:
- Workspace status
- Build result
- Test result
- Lint result
- Tool evidence
- Unknowns

Rules:
- Keep this read-only; do not use write or shell tools.
- If a tool is unavailable or the workspace lacks the required script/config, say which one and include the exact tool result.
- Do not claim a command passed unless the tool result directly supports it."

[TEST-T21] Write-jail and artifact coverage
"Use `fs.write`, `artifacts.create`, and `fs.read`.

Required actions:
1. Attempt to write `./workspace/prompt-pack-tool-coverage.txt` with one line of text.
2. Attempt to create a short markdown artifact summarizing the fixture package scripts.
3. If either write succeeds, read the created file back with `fs.read`.

Return exactly these sections:
- Write attempt
- Artifact attempt
- Readback evidence
- Tool evidence
- Unknowns

Rules:
- Report the exact final path if the runtime redirects the write into a safe jail.
- If a write is blocked by policy or approval, say that explicitly and do not pretend the file exists.
- Keep the artifact content minimal."

[TEST-T22] Approval-gated command behavior
"Use `shell.exec`, `shell.exec_background`, and `git.exec` against `fixtures/prompt-pack-workspace`.

Requested actions:
- `shell.exec`: try a harmless foreground command that reports the workspace package name
- `shell.exec_background`: try a harmless short-lived background command
- `git.exec`: try a non-destructive status-style git command

Return exactly these sections:
- Foreground command result
- Background command result
- Git command result
- Tool evidence
- Unknowns

Rules:
- If approval or policy blocks any command, quote the block reason plainly.
- Do not retry the same blocked action repeatedly.
- Do not switch to another tool to hide the blocked result."

[TEST-T23] Knowledge mutation and retrieval round-trip
"Use `memory.write`, `memory.upsert`, `memory.read`, `memory.search`, `docs.ingest`, `embeddings.index`, and `embeddings.query`.

Required actions:
1. Write a deterministic memory note titled `prompt-pack-tool-coverage`.
2. Upsert that same note with one additional sentence.
3. Read or search it back to confirm the latest content.
4. Ingest a short inline note about the fixture `slugify` helper.
5. Attempt indexing/query retrieval for that ingested note.

Return exactly these sections:
- Memory write result
- Memory readback
- Document ingest result
- Retrieval result
- Tool evidence
- Unknowns

Rules:
- Keep the saved content short and obviously synthetic.
- If ingest or indexing is unavailable, say so explicitly.
- Do not claim vector retrieval worked unless the tool output directly confirms it."

[TEST-T24] Test and lint honesty pass
"Use `tests.run` and `lint.run` on `fixtures/prompt-pack-workspace`.

Return exactly these sections:
- Test result
- Lint result
- Tool evidence
- Unknowns

Rules:
- If the workspace lacks a configured test or lint script, say that explicitly.
- Do not imply a pass when the tool output is missing, blocked, or partial.
- Keep the interpretation grounded in the direct tool result."

[TEST-T25] Build interpretation pass
"Use `build.run` on `fixtures/prompt-pack-workspace`.

Return exactly these sections:
- Build result
- Evidence
- Interpretation
- Unknowns

Rules:
- `Interpretation` must separate direct evidence from inference.
- If the build tool is unavailable or the workspace is missing required config, say so plainly.
- Do not invent compiler output."

[TEST-T26] Source-of-truth drift evidence pass
"Use file/code tools to inspect these files:
- `F:/code/personal-ai/goatcitadel_prompt_pack.md`
- `F:/code/personal-ai/.gitignore`
- `F:/code/personal-ai/apps/gateway/src/services/prompt-pack-service.ts`

Return exactly these sections:
- Source file evidence
- Ignore-rule evidence
- Export-path evidence
- Drift risk
- Unknowns

Rules:
- `Source file evidence` must cite the canonical prompt-pack file.
- `Ignore-rule evidence` must cite the artifact ignore behavior if present.
- `Export-path evidence` must cite the export directory or path logic from code.
- Do not claim drift unless the evidence supports it."

[TEST-T27] Mixed tool-chain repo check
"Use `code.search`, `file.read_range`, `browser.search`, and `browser.navigate` to answer this question: does the fixture workspace pin dependencies that are older than the current official releases?

Return exactly these sections:
- Local evidence
- Web evidence
- Version delta
- Tool evidence
- Unknowns

Rules:
- `Local evidence` must come from the fixture `package.json`.
- `Web evidence` must come from official release or documentation pages you actually visited.
- If a package does not have a clearly current official page, say so instead of guessing."
