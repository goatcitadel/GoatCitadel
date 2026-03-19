# GoatCitadel Prompt Pack v3

Merged canonical prompt pack. 89 tests across chat/cowork/code modes, including the live 80-test pack plus repo-expansion prompts for sibling repositories in `F:/code`.

---

## Chat Tests

### No-Tools

[TEST-C01] Simple factual question
"What are the three main types of machine learning? Give a one-sentence definition of each."

[TEST-C02] Structured list generation
"List the 7 layers of the OSI model from bottom to top. For each layer, name one common protocol."

[TEST-C03] Explain like I'm five
"Explain how DNS works to a non-technical person. Use an analogy. Keep it under 100 words."

[TEST-C04] Compare and contrast
"Compare REST and GraphQL APIs. Give 3 pros and 3 cons of each in a table format."

[TEST-C05] Multi-step reasoning
"A startup has 3 engineers, $50K monthly burn, and 8 months of runway. They just lost their lead engineer. Walk through the decision tree: hire a replacement, redistribute work, or pivot the product scope. Recommend one path and justify it."

[TEST-C06] Ambiguity handling
"Should I use a monorepo or polyrepo? Answer without assuming my team size, language, or deployment strategy. Ask me the minimum questions needed before you can recommend."

[TEST-C07] Refusal and honesty test
"What is the exact current Bitcoin price right now, to the cent?"

[TEST-C08] Creative constraint
"Write a commit message for a change that renames a database column from `user_name` to `display_name`, adds a migration, updates 3 API endpoints, and fixes 2 tests. Follow conventional commits format. Be concise."

### Implicit-Tools

[TEST-C09] Question that benefits from memory
"Based on what you know about my project and preferences, what testing framework would you recommend for a new TypeScript service? If you don't have context about my project, say so and ask what you need."

[TEST-C10] Current events awareness
"What are the latest developments in the EU AI Act enforcement? Summarize in 3 bullets. If you cannot access current information, be transparent about that and give the most recent information you have."

[TEST-C11] URL-referenced content
"I saw an interesting article at https://martinfowler.com/articles/is-quality-worth-cost.html — can you summarize the main argument and give me 3 counterpoints?"

[TEST-C12] Fact verification
"Is it true that PostgreSQL 17 added native JSON table support? Verify this claim. If you can look it up, do so. If not, state your confidence level."

[TEST-C13] Context-dependent recommendation
"I'm choosing between Drizzle ORM and Prisma for a new project. What's the latest community sentiment? Check if you can find recent benchmarks or comparisons."

[TEST-C14] Personal context recall
"What tools and integrations have I connected to this system? If you can check, list them. If not, explain what you'd need to answer this."

[TEST-C15] Multi-source synthesis
"Give me a balanced overview of the pros and cons of using SQLite as a production database for a web app serving <1000 users. Include real-world examples if you can find them."

[TEST-C16] Temporal reasoning
"When was the last time my system had an error or failed run? Check if you have access to any logs or history. If not, tell me where I could find that information."

### Explicit-Tools

[TEST-C17] Explicit memory search
"Use memory.search to find any notes I've saved about deployment workflows. Summarize what you find. If nothing is found, say so clearly."

[TEST-C18] Explicit web search
"Use browser.search to find the current Node.js LTS version number. Return just the version number and release date."

[TEST-C19] Explicit page extraction
"Use browser.navigate to visit https://httpbin.org/json and extract the full JSON response. Return it formatted."

[TEST-C20] Multi-tool chain
"First use browser.search to find the official Fastify documentation URL, then use browser.navigate to visit it, and extract the current stable version number from the page."

[TEST-C21] Tool with error handling
"Use browser.navigate to visit https://thisdomaindoesnotexist12345.com. Report exactly what happens — the error type, status, and what you'd recommend as a fallback."

[TEST-C22] Explicit memory write then read
"Save a memory note with the key 'test-preferences' containing 'User prefers dark mode and vim keybindings.' Then immediately search for it to confirm it was saved."

[TEST-C23] Structured extraction from live page
"Use browser.navigate to visit https://books.toscrape.com/ and extract the first 10 book titles and prices as a JSON array of {title, price} objects."

[TEST-C24] Tool result interpretation
"Use browser.search for 'GoatCitadel AI agent framework'. Analyze the search results: are there any real results? Be honest about what you find — don't fabricate information if the results are empty or irrelevant."

[TEST-C25] Complex multi-step with validation
"Use browser.navigate to visit https://jsonplaceholder.typicode.com/posts/1 and extract the post data. Then verify the response has the expected fields (userId, id, title, body). Report any missing fields."

---

## Cowork Tests

### No-Tools

[TEST-W01] Simple comparison
"Compare Docker Compose and Kubernetes for a solo developer running 3 microservices. Which is better for local development vs production?"

[TEST-W02] Framework evaluation
"Evaluate React, Vue, and Svelte for building a dashboard application. Consider: learning curve, ecosystem maturity, performance, and hiring pool. Present as a decision matrix."

[TEST-W03] Architecture review
"Review this architecture decision: we're using a single PostgreSQL database for both OLTP (user transactions) and OLAP (analytics queries). What are the risks? Propose 2 alternative architectures with tradeoffs."

[TEST-W04] Research synthesis from knowledge
"Synthesize the current state of WebAssembly adoption: who's using it in production, what are the main use cases, and what are the remaining limitations? Organize by: browser-side, server-side, and edge computing."

[TEST-W05] Multi-perspective analysis
"Analyze the decision to open-source a SaaS product's core engine from 3 perspectives: (1) CTO focused on competitive advantage, (2) VP Sales worried about revenue impact, (3) Developer Relations lead focused on community growth. Synthesize a recommendation."

[TEST-W06] Cost-benefit analysis
"A team of 5 developers is considering migrating from REST to gRPC for internal service communication. Estimate the migration cost (in engineer-weeks), ongoing benefits, and break-even timeline. State your assumptions."

[TEST-W07] Failure mode analysis
"Perform a failure mode analysis for a checkout flow: user adds item to cart → enters payment → receives confirmation. For each step, list what can go wrong, likelihood (high/medium/low), impact, and mitigation."

[TEST-W08] Technology roadmap
"Create a 6-month technology roadmap for modernizing a legacy PHP monolith into TypeScript microservices. Include phases, dependencies, team allocation, and risk gates. Assume a team of 4 senior engineers."

[TEST-W26] Runtime delegation and final synthesis
"Analyze whether a 12-person SaaS team should replace a homegrown job queue with Temporal. Break the work into three specialist lenses: product delivery, platform architecture, and QA/operability. Return one operator-ready recommendation with a compact section naming what each specialist contributed. Do not dump raw internal chatter or separate child answers."

[TEST-W27] Session-tree visibility without leakage
"Evaluate a migration from Heroku to self-hosted Kubernetes for a small SaaS team. Consider three lenses: delivery risk, operational burden, and rollback readiness. Produce a single final brief with a concise 'workstreams' summary for each lens and one synthesized recommendation. Keep the answer unified rather than three disconnected essays."

[TEST-W28] Blocker-aware parent continuation
"Plan a release for enabling background document parsing in a customer-facing app. Separate the work into implementation, security review, and operator runbook lanes. If one lane appears blocked or uncertain, explicitly surface the blocker, adapt the plan, and still deliver a final merged answer that tells the operator what to do next. The final output must read like one coordinated response, not raw handoff fragments."

[TEST-W29] Parent-owned final delivery
"Assess whether to adopt event sourcing for a billing system. Weigh architecture impact, finance/compliance implications, and incident-response tradeoffs. Use whatever internal coordination is appropriate, but only the controller should speak in the final answer. Include a compact subagent-status snapshot and a single final recommendation."

[TEST-W30] Operator-steerable synthesis
"Prepare a migration recommendation for replacing Sentry with an open-source observability stack. Cover technical feasibility, monitoring gaps, and rollout controls. Provide a final answer that is easy for an operator to steer or revise: list assumptions, blockers, and next-action options while still delivering one synthesized recommendation."

### Implicit-Tools

[TEST-W09] Research with web context
"Research the current state of Bun vs Deno vs Node.js performance benchmarks. Find the latest data and synthesize a comparison. If you can access web resources, use them; otherwise give the best analysis from your knowledge."

[TEST-W10] Competitive landscape analysis
"Map the competitive landscape for open-source observability tools (logging, metrics, tracing). Include Grafana stack, Datadog alternatives, and emerging players. Use web sources if available."

[TEST-W11] Best practices compilation
"Compile current best practices for securing a Node.js API in production. Check if there are recent OWASP updates or new recommendations. Organize by: authentication, input validation, rate limiting, and secrets management."

[TEST-W12] Trend analysis
"Analyze the trend of AI-assisted coding tools (GitHub Copilot, Cursor, Claude Code, etc.). What's the adoption rate, developer satisfaction, and impact on productivity? Use recent sources if you can find them."

[TEST-W13] Multi-source deep dive
"Deep dive into database connection pooling strategies for serverless environments. Cover PgBouncer, Supabase pooler, Neon's approach, and Prisma Accelerate. Compare latency, cost, and complexity."

[TEST-W14] Ecosystem evaluation with context
"Evaluate the current state of the Rust web framework ecosystem. Compare Actix-web, Axum, and Rocket for building a REST API. Check for recent benchmarks and community activity."

[TEST-W15] Risk assessment with research
"Assess the security risks of using third-party npm packages with >1000 weekly downloads but <5 contributors. Research recent supply chain attacks and recommend a vetting process."

[TEST-W16] Industry analysis
"Research how fintech startups are handling PCI DSS compliance in 2026. What are the most common approaches? Are there new tools or services that simplify compliance? Synthesize findings into actionable recommendations."

### Explicit-Tools

[TEST-W17] Explicit multi-source research
"Use browser.search to find the top 3 most-starred TypeScript ORMs on GitHub. Then use browser.navigate to visit each repository page and extract: stars, last commit date, and open issues count. Compare them in a table."

[TEST-W18] Documentation analysis
"Use browser.navigate to visit https://docs.anthropic.com/en/docs and extract the main documentation sections. Summarize the structure and identify what topics are covered."

[TEST-W19] Data extraction and synthesis
"Use browser.navigate to visit https://survey.stackoverflow.co/2024 and extract the top 10 most popular programming languages. Then synthesize trends compared to what you know about previous years."

[TEST-W20] API exploration
"Use browser.navigate to visit https://jsonplaceholder.typicode.com and extract all available API endpoints. Then use browser.navigate to fetch /users and /posts, and analyze the data relationship between them."

[TEST-W21] Competitive research with tools
"Use browser.search to find pricing pages for Vercel, Netlify, and Cloudflare Pages. Visit each pricing page and extract the free tier limits and first paid tier price. Present as a comparison table."

[TEST-W22] Technical documentation comparison
"Use browser.search to find the official migration guides for both Prisma and Drizzle ORM. Navigate to each guide and compare: ease of setup, TypeScript integration quality, and migration workflow. Provide a structured comparison."

[TEST-W23] Real-time data verification
"Use browser.search and browser.navigate to verify: (1) the current latest stable release of PostgreSQL, (2) when it was released, (3) what major features it introduced. Cross-reference at least 2 sources."

[TEST-W24] Multi-step research workflow
"Research the state of edge computing deployment options. Use browser.search to find Cloudflare Workers, Deno Deploy, and Vercel Edge Functions documentation. Visit each, extract supported runtimes and limitations, and synthesize a recommendation for a real-time API proxy use case."

[TEST-W25] Comprehensive analysis with citations
"Use browser.search and browser.navigate to research the environmental impact of large language model training. Find at least 3 credible sources, extract key data points (energy consumption, carbon footprint estimates), and synthesize a balanced summary with proper citations."

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

---

## Code Tests

### No-Tools

[TEST-D01] Code pattern explanation
"Explain the Repository Pattern in TypeScript. Show a simple interface and one concrete implementation. Keep it under 40 lines of code."

[TEST-D02] Code review from description
"Review this approach: storing user sessions in a JavaScript Map object in a Node.js Express server. Identify 3 problems and suggest fixes for each."

[TEST-D03] Algorithm design
"Design a function that takes an array of time intervals [{start, end}] and merges overlapping intervals. Provide TypeScript code with type annotations and explain the time complexity."

[TEST-D04] Error handling strategy
"Design an error handling strategy for a REST API with 3 layers: route handler → service → repository. Show the error types, how errors propagate, and what the client receives. Use TypeScript."

[TEST-D05] Database schema design
"Design a SQLite schema for a simple task management app with: users, projects, tasks, and task comments. Include indexes. Show the CREATE TABLE statements and explain your index choices."

[TEST-D06] Refactoring assessment
"Here's a function that does too much: it validates input, queries the database, transforms data, sends an email, and logs the result. Describe how you would decompose it into smaller functions following the Single Responsibility Principle. Show the function signatures."

[TEST-D07] Test case design
"Design test cases for a `calculateDiscount(price, customerTier, couponCode)` function. Cover: normal cases, edge cases (zero price, negative, null tier), boundary values, and error conditions. List at least 10 test cases with expected outcomes."

[TEST-D08] Security review
"Review this pseudocode for SQL injection vulnerabilities: `db.query('SELECT * FROM users WHERE name = ' + req.params.name)`. Explain the vulnerability, show an exploit example, and provide the fix using parameterized queries."

### Implicit-Tools

[TEST-D09] Contextual code generation
"Add input validation to the POST /api/tasks endpoint in my project. The validation should check that title is a non-empty string under 200 characters and description is optional but under 2000 characters. If you can read the existing code, do so. Otherwise, write the validation assuming an Express handler."

[TEST-D10] Bug investigation
"There's likely a bug in the utils.ts file — the `clampValue` function might not handle NaN inputs correctly. Investigate and fix it if you can access the file, or describe the likely issue and fix if you can't."

[TEST-D11] Feature addition with context
"Add a PATCH endpoint for tasks that allows partial updates (only the fields provided in the request body should be updated). Check the existing code patterns if possible and follow the same style."

[TEST-D12] Dependency analysis
"Analyze the dependencies in my project's package.json. Are there any that look outdated, redundant, or have known security issues? If you can read the file, do a concrete analysis. Otherwise, describe the process."

[TEST-D13] Test generation
"Write unit tests for the utility functions in src/utils.ts. Cover all functions with at least 2 test cases each, including edge cases. Use whatever test framework the project is configured for, or default to vitest."

[TEST-D14] Code quality improvement
"Look at src/index.ts and identify code quality improvements: missing error handling, type safety issues, potential memory leaks, or violations of immutability principles. Suggest specific fixes."

[TEST-D15] Configuration review
"Review the tsconfig.json in my project. Is it using recommended strict settings? Are there any missing options that would improve type safety or catch common errors? Suggest improvements."

[TEST-D16] Architecture assessment
"Assess the overall architecture of the fixture project. Is the code organized well? What would you change if this needed to scale to handle 50 endpoints and 10,000 requests/second?"

### Explicit-Tools

[TEST-D17] Read and refactor
"Read the file at fixtures/prompt-pack-workspace/src/utils.ts using file tools. Identify any functions that could be improved. Refactor the `slugify` function to handle unicode characters and provide the updated code."

[TEST-D18] Read and analyze imports
"Read fixtures/prompt-pack-workspace/src/index.ts using file tools. List all imports and verify they reference modules that exist in the project. Report any potentially missing dependencies."

[TEST-D19] Multi-file analysis
"Read both fixtures/prompt-pack-workspace/src/index.ts and fixtures/prompt-pack-workspace/src/utils.ts using file tools. Identify which utility functions from utils.ts are actually used in index.ts and which are unused dead code."

[TEST-D20] Package.json audit
"Read fixtures/prompt-pack-workspace/package.json using file tools. Analyze the scripts section — are there missing scripts that a TypeScript project should have (lint, format, test:coverage)? Suggest additions."

[TEST-D21] TypeScript config analysis
"Read fixtures/prompt-pack-workspace/tsconfig.json using file tools. Check if the config is production-ready. Identify missing strict options and suggest the optimal configuration for a Node.js 22 project."

[TEST-D22] Full project audit
"Read all source files in fixtures/prompt-pack-workspace/ using file tools. Produce a project audit report covering: file structure, code quality, type safety, error handling, test coverage gaps, and security concerns. Be specific — reference actual code."

[TEST-D23] Implementation plan from code
"Read fixtures/prompt-pack-workspace/src/index.ts using file tools. The task API currently uses an in-memory Map. Write a detailed implementation plan to migrate to SQLite: what files to create, what changes to existing files, and the migration steps. Reference actual function names and line numbers."

[TEST-D24] Cross-reference with documentation
"Read fixtures/prompt-pack-workspace/package.json using file tools. Then use browser.search to check if the pinned versions of express and typescript are the latest. Report what versions are in use vs what's currently available."

[TEST-D25] End-to-end implementation
"Read fixtures/prompt-pack-workspace/src/index.ts and src/utils.ts using file tools. Add a new GET /api/tasks/stats endpoint that returns {totalTasks, byStatus: {pending, in_progress, done}, averageTitleLength}. Write the complete implementation following the existing code patterns. Show the exact code changes needed."

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
