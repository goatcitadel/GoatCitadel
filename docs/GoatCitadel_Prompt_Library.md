# GoatCitadel: “What Can I Do With This?” (Use Cases + Prompt Library)

Welcome to GoatCitadel. If you’ve never used agentic AI before, this page is your on-ramp: copy a prompt, paste it, get a win, repeat. 🐐🏰

## TL;DR: How to Ask (Works for 90% of things)

Use this template:

**Goal:** what you want  
**Context:** what you’re working with (links, text, files, environment)  
**Constraints:** time, budget, tone, “don’t change X”, etc.  
**Output:** checklist, table, draft, script, plan, etc.  
**Workflow:** “Plan first, then execute.”

Example:
> Goal: Fix a service that won’t load behind my reverse proxy.  
> Context: Docker on Windows, Traefik, subdomain routing. Logs below.  
> Constraints: No breaking changes. Use PowerShell commands only.  
> Output: Step-by-step diagnosis + minimal config patch.  
> Workflow: Plan first, then execute.

---

## How to AI in GoatCitadel (15-minute onboarding)

If you are brand new to AI or agent systems, follow this exact flow once:

1. Pick one tiny goal you can finish today.
2. Paste this starter prompt:

```text
Goal: [one clear outcome]
Context: [what I already have]
Constraints: [time/budget/safety limits]
Output: [checklist/table/draft]
Workflow: Plan first, then execute after my go-ahead.
```

3. If the answer is vague, ask:

```text
Make this concrete.
Give me exact next 3 actions, each with done criteria.
If anything is blocked, tell me what you need from me.
```

4. If tools are blocked, use:

```text
Do not guess.
List constraints, what you tried, and the minimum input needed to continue.
```

5. Save good prompts into Prompt Lab and re-run after changes.

### Beginner Mistake-Proofing

- Include your exact goal and constraints every time.
- Ask for a format (`checklist`, `table`, `SOP`, `email draft`) so output is usable.
- Never paste secrets (API keys, tokens, passwords).
- Ask for rollback steps before infra/config changes.
- If quality is low, ask for role-labeled output (`Product -> Architect -> Coder -> QA -> Ops`).

---

## Choose Your Path

- **New here?** Start with: [Beginner Quick Wins](#beginner-quick-wins-5-10-min)  
- **Comfortable delegating?** Go to: [Intermediate Workflows](#intermediate-workflows-plan--draft--iterate)  
- **Want full agent orchestration?** Go to: [Power Workflows](#power-workflows-multi-agent-style)  
- **Want it UI-friendly?** See: [How to Integrate Into GoatCitadel UI](#how-to-integrate-into-goatcitadel-ui)

---

## Pick a “Role” (Optional, but fun)

These “roles” are just mental presets. Use them in prompts like:  
**“Act as the Mechanic…”** or **“Be my Producer…”**

- 📚 **Librarian**: organize, summarize, extract, structure knowledge
- 🛠️ **Mechanic**: troubleshoot, debug, diagnose, propose fixes safely
- 🎬 **Producer**: plan projects, timelines, deliverables, messaging
- 🔎 **Researcher**: compare options, gather evidence, recommend
- 🎲 **GM Mode**: worldbuilding, NPCs, encounters, campaign tooling

---

# Beginner Quick Wins (5–10 min)

### 1) Turn chaos into next steps
**Prompt**
```text
I’m overwhelmed. Here’s everything on my mind:
[paste]

Turn it into:
1) A top-5 priority list
2) The next 3 actions I can do in 15 minutes
3) What to defer and why
Output as a checklist.
```

### 2) Summarize + extract action items
```text id="c3fuar"
Summarize this. Then list:
- Decisions
- Open questions
- Action items (with suggested owner + deadline)
Text:
[paste]
```

### 3) Draft a reply that sounds human
```text id="y5zg8p"
Rewrite this reply to be clear, calm, and helpful.
Keep it under 120 words.
Give me 3 tone options: warm / neutral / firm.
Draft:
[paste]
```

### 4) Make a checklist from anything
```text id="gs2n8f"
Convert this into a step-by-step checklist with "done" criteria for each step:
[paste]
```

### 5) Meeting prep in 2 minutes
```text id="0jq1k9"
I have a meeting about: [topic].
Give me:
- 5 smart questions
- likely risks
- a 30-second opener
- a 30-second closer with a clear next step
```

### 6) “Explain it like I’m busy”
```text id="z95a0s"
Explain this like I’m smart but new to it.
Then give me a cheat sheet + a mini glossary.
Topic/text:
[paste]
```

### 7) Quick decision helper
```text id="nlb22o"
I’m deciding between A and B:
A: [details]
B: [details]

Ask me up to 5 questions total, then recommend one.
Include tradeoffs and a fallback plan if your pick is wrong.
```

---

# Everyday Life Admin

### 8) Weekend mission plan
```text id="vpsjdb"
I want to accomplish [goal] this weekend.
Plan it like a mission:
- prep
- execution
- fallback plan
- reward
Keep it realistic.
```

### 9) Meal ideas from ingredients
```text id="i7khfh"
I have: [ingredients].
Give me:
- 2 fast meals
- 2 healthy meals
- 1 "treat" meal
Include a shopping list if needed.
```

### 10) Budget cuts without suffering
```text id="8ocyiw"
I want to cut $200/month.
Ask me the minimum questions, then give me a ranked list of cuts with tradeoffs.
```

### 11) “Paperwork translator”
```text id="hk5t18"
Explain each question in this form in plain English.
Then tell me what info I need to gather before filling it out:
[paste form text]
```

---

# Work: Support, Success, Ops, Projects

### 12) Customer call recap email
```text id="l47o7b"
Turn these messy notes into a professional recap email with:
- Summary
- What we did
- Action items (owner + date)
- Next meeting ask
Notes:
[paste]
```

### 13) Objection handling generator
```text id="3mnia5"
Customer says: "[quote]"
Give me 5 response options:
- 2 empathetic
- 2 data-driven
- 1 firm boundaries
```

### 14) Create a runbook from tribal knowledge
```text id="ykrhl8"
Turn this process into a runbook:
- prerequisites
- steps
- rollback
- common failure cases
- "how to verify it's working"
Process:
[paste]
```

### 15) New hire SOP
```text id="1nnjn9"
Turn this into a step-by-step SOP for a new hire who knows nothing.
Add a troubleshooting section and "common mistakes."
Content:
[paste]
```

### 16) Project breakdown (MVP first)
```text id="4f0hqj"
Goal: [goal]
Constraints: [time/budget/tools]
Make:
- 2-week MVP plan
- milestones
- risks + mitigations
- dependencies
Output as a table.
```

### 17) Executive summary generator
```text id="43zkd7"
Write a 1-page exec summary from this:
- key metrics
- what changed
- risks
- recommended decision
Text:
[paste]
```

---

# Homelab + Tech (GoatCitadel’s natural habitat 🧰)

### 18) Troubleshooting with guardrails
```text id="06pbr1"
I’m seeing this error:
[paste logs]

Ask up to 3 diagnostic questions max.
Then give me:
1) a safe diagnosis plan
2) commands to run (PowerShell only)
3) the smallest fix first
No breaking changes.
```

### 19) Script generator with dry-run
```text id="c7hfdb"
Write a PowerShell script to do: [task]
Requirements:
- include -WhatIf / dry-run mode
- clear comments
- no destructive actions unless I confirm
```

### 20) Docker Compose sanity check
```text id="v5dn42"
Review this docker-compose.yml for:
- security issues
- ports exposure
- volumes
- networking gotchas
Suggest improvements without changing functionality.
File:
[paste]
```

### 21) Reverse proxy routing plan
```text id="9vx32z"
I have these services + subdomains:
[list]

Propose a routing plan for my reverse proxy:
- routers/services/middlewares conceptually
- auth approach
- safest defaults
Output: steps + config patterns (no giant walls of config).
```

### 22) Backup plan that’s actually testable
```text id="1jp78k"
Create a backup plan for:
- docker volumes
- app configs
- db dumps (if needed)
Include:
- retention
- restore steps
- how to do a monthly restore test
```

### 23) Monitoring checklist
```text id="aa8own"
Design a monitoring plan for my self-hosted stack:
- uptime
- logs
- disk/CPU/RAM
- backup health
- SSL expiration
Give recommended alert rules and what tools to use.
```

---

# Creativity + Worldbuilding + “GM Mode” 🎲

### 24) NPC factory
```text id="zwfoyr"
Create 12 NPCs for this setting: [setting].
Each needs:
- a hook
- a secret
- what they want
- what they can offer
```

### 25) Encounter generator with knobs
```text id="1cojz9"
Generate 6 encounters for:
- tone: [grim/hopeful/weird]
- difficulty: [easy/medium/hard]
- environment: [ruins/arcology/wastes/etc]
Include a twist for each encounter.
```

### 26) Faction toolkit
```text id="shq8wn"
Generate 10 factions with:
- name style: [style]
- vibe
- conflict
- signature tech
- what they want from the players
```

### 27) Campaign “scene board”
```text id="qctb0a"
Turn this premise into a session outline:
- cold open
- 3 scenes
- 2 optional scenes
- finale
- 3 clues that point forward
Premise:
[paste]
```

---

# Intermediate Workflows (Plan → Draft → Iterate)

### 28) Plan first, then execute
```text id="fw9nav"
Goal: [goal]
First: produce a plan with checkpoints.
Second: wait for my "go" before executing.
```

### 29) Builder + Critic (self-improving loop)
```text id="kn8lom"
Act as two roles:
Builder: produces a draft.
Critic: attacks assumptions and finds gaps.
Then Builder revises once.
Task:
[task]
```

### 30) Inbox-to-zero loop (paste-driven)
```text id="fgneyu"
I will paste messages one-by-one.
For each:
- summarize
- classify (Do now / Delegate / Defer / Delete)
- draft a reply (if needed)
End each item with: "Waiting for next message."
```

### 31) Research → Compare → Recommend
```text id="rl5ws7"
Research [topic].
Compare options in a table (pros/cons/cost/effort/risk).
Recommend one based on my constraints:
[constraints]
End with what you need from me to finalize.
```

### 32) Decision tree playbook
```text id="p9zs4x"
Create a decision tree for: [process].
Include triggers, actions, escalation points, and "how to verify success."
```

---

# Power Workflows (Multi-Agent Style)

These prompts are designed to route work across specialized “agents” in GoatCitadel.

### 33) Orchestrated delivery (Producer + Researcher + Mechanic)
```text id="cilngf"
We’re doing this as an orchestrated workflow.

Producer: define scope, timeline, deliverables.
Researcher: gather options + tradeoffs.
Mechanic: implement safely with minimal changes.

Goal:
[goal]
Context:
[context]
Constraints:
[constraints]
Output:
[output]
```

### 34) “Create a system, not a one-off”
```text id="ncmazd"
Don’t just answer. Create a reusable system.

Task:
[task]

Deliver:
- a template I can reuse
- a checklist
- a short SOP
- common failure cases
```

### 35) Continuous improvement loop
```text id="qgle4w"
Given this current version:
[paste]

1) Identify top 5 weaknesses
2) Propose 3 improvements
3) Implement the best 1 (draft it)
4) Explain how to validate it worked
```

---

# Prompt Packs (Copy-Paste Bundles)

## Pack A: “Make me look competent in 60 seconds”
```text id="7frkq3"
I need to sound like I know what I’m doing about: [topic]
Give me:
- a 60-second explanation
- 5 smart questions to ask
- 3 common pitfalls and how to avoid them
```

## Pack B: “TL;DR, then tell me what to do”
```text id="fa25w4"
TL;DR this.
Then tell me exactly what to do next.
If you’re missing info, ask only the essential questions.
Text:
[paste]
```

## Pack C: “Turn my notes into a living doc”
```text id="ogqzzo"
Turn these notes into a structured doc:
- headings
- TL;DR
- action items
- glossary
- tags
Notes:
[paste]
```

---

# Safety Rails (Recommended Defaults)

- Don’t paste passwords, API keys, private tokens.
- For scripts/config changes: **plan first**, then execute after approval.
- Prefer smallest change first.
- Always include a rollback path when editing infrastructure.

---

# How to Integrate Into GoatCitadel UI

This section is meant for Codex to implement the experience inside GoatCitadel.

## UI Concept: Prompt Cards + Filters + Copy Button

### Suggested UI layout
- **Header**: “What can GoatCitadel do?” + search bar
- **Tabs**: Beginner | Intermediate | Power
- **Role chips**: Librarian | Mechanic | Producer | Researcher | GM Mode
- **Category filters**: Personal | Work | Tech | Creativity | Learning
- **Prompt cards**: title, 1-line description, tags, “Copy Prompt”, “Customize”
- **Customization drawer**: fill-in fields for placeholders like `[goal]`, `[constraints]`, `[paste logs]`

### Prompt Card schema (suggested)
```json id="4u57c1"
{
  "id": "tech.troubleshoot.ps_only",
  "title": "Troubleshoot an Error (PowerShell Only)",
  "level": "Beginner",
  "role": ["Mechanic"],
  "category": ["Tech"],
  "tags": ["logs", "diagnosis", "safe-changes"],
  "estimated_time": "10-20m",
  "prompt_template": "I’m seeing this error:\n[paste logs]\n\nAsk up to 3 diagnostic questions max...\n",
  "placeholders": [
    { "key": "paste_logs", "label": "Paste logs", "type": "multiline" }
  ],
  "outputs": ["Diagnosis plan", "Commands to run", "Minimal fix first", "Rollback steps"],
  "safety": ["plan_first", "no_secrets", "rollback_required"]
}
```

## Recommended product behaviors
- **“Plan First” toggle** (default ON for Tech + Scripts)
- **“PowerShell Only” toggle** (sticky user preference)
- **“Use my environment defaults”** (Docker/Traefik/Windows style assumptions)
- **Prompt enhancement**: automatically inject user preferences (tone, OS, tooling) into the prompt
- **One-click examples**: “Show me a filled example” for each prompt

## Onboarding flow (simple)
1) Ask: “What are you here for today?” (Work / Tech / Personal / Creative)
2) Show 6 starter cards
3) After first success: offer “Save as a reusable template”

---

# Expansion Instructions for Codex (Generate More Use Cases)

When generating additional prompts:
- Keep each prompt **copy-pastable** and beginner-friendly.
- Add tags, level, role, and expected outputs.
- Prefer templates with placeholders like `[goal]`, `[context]`, `[constraints]`.
- Include variations tuned for:
  - Work (support/success ops)
  - Tech (Docker, reverse proxy, automation)
  - Creative (worldbuilding + writing)
  - Learning (explain, drill, quiz)
- Add at least:
  - 20 more “Beginner Quick Wins”
  - 15 more “Tech + Automation”
  - 15 more “Work + Messaging”
  - 10 more “GM Mode”

---

# GoatCitadel Agentic Usage Mini-Playbook

## Single-role vs multi-role prompting

- Single-role: fastest when you only need one kind of output.
- Multi-role: use when you need cross-checks (requirements -> design -> implementation -> validation).

### Single-role template

```text
Do not spawn multiple agents.
Act as [role].
Goal: [goal]
Context: [context]
Constraints: [constraints]
Output: [format]
```

### Multi-role template

```text
Route this in order: Product -> Architect -> Coder -> QA -> Ops.
Goal: [goal]
Constraints: [constraints]
Require role-labeled sections in order.
If any role is blocked, include Constraints + Workarounds + Next input needed.
```

## Approval-safe prompting

```text
Before any risky action, stop for approval.
Give me: risk summary, blast radius, rollback, and smallest safe step first.
```

## Tool-blocked fallback prompt

```text
If tools are blocked or unavailable, do not guess.
Return:
1) What failed
2) What you did instead
3) Exact input needed from me
```

## Prompt Lab iteration loop

1. Draft prompt.
2. Run benchmark subset first.
3. Fix weak sections (routing/honesty/handoff/robustness/usability).
4. Re-run full pack only after subset is stable.

---

# New Task Cards (36-85)

## Personal productivity + life admin (36-47)

### 36) Morning reset plan
**When to use:** you wake up overloaded and need direction fast.  
**Copy-paste prompt**
```text
I have 90 minutes and too many priorities.
Build me a focused morning plan:
1) top 3 tasks
2) exact order
3) stop criteria
Output as checklist.
```
**Expected output:** ranked checklist with sequencing.  
**If blocked, do this next:** paste your top 10 tasks as raw list.

### 37) Weekly focus board
**When to use:** you want a realistic weekly plan.  
**Copy-paste prompt**
```text
Turn this into a weekly focus board with:
- Must do
- Should do
- Nice to do
- Deferred
Items:
[paste]
```
**Expected output:** 4-bucket plan with priorities.  
**If blocked, do this next:** add deadlines next to each item.

### 38) Calendar rescue
**When to use:** your schedule is full but you need time back.  
**Copy-paste prompt**
```text
I need to free 4 hours this week.
Given this schedule:
[paste]
Suggest cuts, merges, and async swaps with tradeoffs.
```
**Expected output:** concrete time recovery options.  
**If blocked, do this next:** include non-negotiable meetings.

### 39) Decision in one page
**When to use:** you’re stuck between options.  
**Copy-paste prompt**
```text
Help me choose between options.
A: [details]
B: [details]
Ask up to 4 clarifying questions, then output:
Recommendation, Risks, Fallback plan.
```
**Expected output:** recommendation with risk framing.  
**If blocked, do this next:** provide budget and deadline.

### 40) Family logistics coordinator
**When to use:** household planning is messy.  
**Copy-paste prompt**
```text
Build a weekly family logistics plan from this:
[paste]
Include errands, prep windows, and contingency slots.
```
**Expected output:** calendar-style logistics plan.  
**If blocked, do this next:** add must-attend events first.

### 41) New habit with fallback
**When to use:** you want to start and sustain one habit.  
**Copy-paste prompt**
```text
Design a 14-day habit plan for [habit].
Include trigger, minimum version, fail-day recovery, and tracking template.
```
**Expected output:** habit protocol + tracking.  
**If blocked, do this next:** define available time per day.

### 42) Inbox cleanup sprint
**When to use:** messages pile up and need triage.  
**Copy-paste prompt**
```text
I will paste messages.
For each, classify:
Do now / Delegate / Defer / Delete
Then draft reply if needed.
```
**Expected output:** per-message triage + drafts.  
**If blocked, do this next:** paste first 5 messages.

### 43) Trip planning with constraints
**When to use:** planning travel with budget/time limits.  
**Copy-paste prompt**
```text
Plan a [trip type] for [dates] with budget [amount].
Give 2 itinerary options, cost estimate, and risk notes.
```
**Expected output:** two feasible itineraries.  
**If blocked, do this next:** list departure city and hard constraints.

### 44) Home project scope
**When to use:** home improvement tasks are unclear.  
**Copy-paste prompt**
```text
Scope this home project:
[project]
Output: materials, steps, skill level, time estimate, risk checklist.
```
**Expected output:** scoped project brief.  
**If blocked, do this next:** add dimensions/photos summary.

### 45) Difficult conversation prep
**When to use:** you need calm structure before a hard talk.  
**Copy-paste prompt**
```text
Help me prepare for a difficult conversation about:
[topic]
Give: opener, key points, boundary line, and de-escalation phrases.
```
**Expected output:** script options with tone controls.  
**If blocked, do this next:** specify relationship and desired outcome.

### 46) Personal knowledge organizer
**When to use:** notes are scattered and hard to reuse.  
**Copy-paste prompt**
```text
Turn these notes into a reusable structure:
Summary -> Actions -> Risks -> Questions.
Text:
[paste]
```
**Expected output:** structured knowledge card.  
**If blocked, do this next:** split notes by topic first.

### 47) Burnout prevention check
**When to use:** workload feels unsustainable.  
**Copy-paste prompt**
```text
Audit my current workload and identify burnout risk.
Return:
Top risk signals, what to pause now, and a 7-day stabilization plan.
```
**Expected output:** practical workload reset plan.  
**If blocked, do this next:** provide weekly hours and obligations.

## Work communication + operations (48-57)

### 48) Stakeholder update draft
**When to use:** weekly status needs to be clear and concise.  
**Copy-paste prompt**
```text
Draft a stakeholder update from this:
[paste]
Format:
Progress, Risks, Decisions Needed, Next Week.
```
**Expected output:** send-ready update.  
**If blocked, do this next:** include audience and tone.

### 49) Escalation note that de-risks
**When to use:** issue escalation without panic language.  
**Copy-paste prompt**
```text
Write an escalation note for:
[issue]
Include impact, urgency, options, recommended path, and owner asks.
```
**Expected output:** calm escalation memo.  
**If blocked, do this next:** add impact metrics.

### 50) SOP from transcript
**When to use:** convert call/chat logs into process docs.  
**Copy-paste prompt**
```text
Convert this transcript into SOP:
[paste]
Include prerequisites, steps, validation, rollback, and common mistakes.
```
**Expected output:** runnable SOP.  
**If blocked, do this next:** mark where outcomes were successful/failed.

### 51) Incident comms pack
**When to use:** operational incident needs messaging.  
**Copy-paste prompt**
```text
Create an incident comms pack:
1) internal update
2) customer-facing note
3) leadership summary
Context:
[paste]
```
**Expected output:** three audience-specific drafts.  
**If blocked, do this next:** include severity + ETA confidence.

### 52) Delegation-ready task brief
**When to use:** handoff to teammate without ambiguity.  
**Copy-paste prompt**
```text
Turn this work item into a delegation brief:
[paste]
Include objective, scope, done criteria, dependencies, and check-in cadence.
```
**Expected output:** assignable brief.  
**If blocked, do this next:** specify deadline and owner.

### 53) Sales discovery prep
**When to use:** prep for a customer discovery call.  
**Copy-paste prompt**
```text
Build a discovery call plan for [customer type].
Give: 10 questions, qualification rubric, and follow-up email template.
```
**Expected output:** ready-to-use call pack.  
**If blocked, do this next:** share ICP and product scope.

### 54) Meeting notes to action tracker
**When to use:** turn meetings into accountable action.  
**Copy-paste prompt**
```text
From these notes:
[paste]
Create action tracker with owner, due date, risk if late, and dependency.
```
**Expected output:** action table.  
**If blocked, do this next:** add attendees and decisions.

### 55) Process bottleneck finder
**When to use:** team process slows delivery.  
**Copy-paste prompt**
```text
Analyze this process:
[paste]
Find top 3 bottlenecks and propose fixes by effort vs impact.
```
**Expected output:** ranked improvements.  
**If blocked, do this next:** include cycle-time data if available.

### 56) Executive decision memo
**When to use:** leadership needs a recommendation quickly.  
**Copy-paste prompt**
```text
Write a 1-page decision memo:
Context: [paste]
Need: decision by [date]
Include options, tradeoffs, recommendation, and rollback trigger.
```
**Expected output:** concise decision memo.  
**If blocked, do this next:** specify decision owner and constraints.

### 57) Customer objection response set
**When to use:** recurring objections need repeatable responses.  
**Copy-paste prompt**
```text
Generate objection responses for:
[objection list]
Provide: empathetic, data-driven, and firm boundary variants.
```
**Expected output:** response playbook.  
**If blocked, do this next:** include industry and tone policy.

## Learning, research, and decision quality (58-65)

### 58) Learn a topic in 30 minutes
**When to use:** fast ramp on unknown topic.  
**Copy-paste prompt**
```text
Teach me [topic] in 30 minutes.
Give: core concepts, what to ignore, quiz me with 5 questions.
```
**Expected output:** concise study path + quiz.  
**If blocked, do this next:** specify your current skill level.

### 59) Compare tools objectively
**When to use:** avoid hype-driven tool choice.  
**Copy-paste prompt**
```text
Compare these options:
[list]
Use criteria: cost, complexity, reliability, lock-in, learning curve.
Recommend one with confidence level.
```
**Expected output:** comparison matrix + recommendation.  
**If blocked, do this next:** add weighted priorities.

### 60) Claim checker
**When to use:** information sources conflict.  
**Copy-paste prompt**
```text
I have conflicting claims about:
[topic]
Present both sides, confidence level, and what evidence would resolve it.
```
**Expected output:** balanced conflict analysis.  
**If blocked, do this next:** provide source snippets.

### 61) Debate yourself then decide
**When to use:** challenge your own assumptions.  
**Copy-paste prompt**
```text
Act as two experts with opposing views on:
[topic]
Debate in 6 rounds, then provide a synthesis and final recommendation.
```
**Expected output:** adversarial reasoning + conclusion.  
**If blocked, do this next:** define risk tolerance.

### 62) Turn docs into flashcards
**When to use:** retain key concepts from dense material.  
**Copy-paste prompt**
```text
Create 20 flashcards from this text:
[paste]
Format: question | answer | difficulty.
```
**Expected output:** study-ready flashcard set.  
**If blocked, do this next:** trim to one chapter.

### 63) Teach-back validator
**When to use:** verify you actually understand something.  
**Copy-paste prompt**
```text
I will explain [topic] in my own words.
Score my explanation for correctness and gaps.
Then give me a better version.
```
**Expected output:** scored feedback + improved explanation.  
**If blocked, do this next:** provide your draft explanation.

### 64) Research plan before search
**When to use:** avoid random browsing and unclear findings.  
**Copy-paste prompt**
```text
Before researching [topic], create:
1) key questions
2) source hierarchy
3) stop criteria
4) confidence rubric
```
**Expected output:** disciplined research plan.  
**If blocked, do this next:** share decision deadline.

### 65) Risk register builder
**When to use:** pre-mortem on project or decision.  
**Copy-paste prompt**
```text
Build a risk register for:
[project]
Columns: risk, likelihood, impact, trigger, mitigation, owner.
```
**Expected output:** actionable risk table.  
**If blocked, do this next:** include scope and timeline.

## GoatCitadel agentic orchestration cards (66-77)

### 66) Minimal role routing
**When to use:** choose correct goats without over-routing.  
**Copy-paste prompt**
```text
Given this task:
[task]
Pick the minimum goats needed (1-3), explain routing in 3 bullets, then ask only essential questions.
```
**Expected output:** lean routing + clarifying questions.  
**If blocked, do this next:** add expected deliverable.

### 67) Product -> Architect -> Coder chain
**When to use:** move from concept to implementable plan.  
**Copy-paste prompt**
```text
Route in order:
Product -> Architect -> Coder.
Task: [task]
Output: PRD outline, architecture, coding checklist.
```
**Expected output:** ordered multi-role plan.  
**If blocked, do this next:** provide constraints.

### 68) Full delivery chain with QA + Ops
**When to use:** delivery planning with release safety.  
**Copy-paste prompt**
```text
Route in order:
Product -> Architect -> Coder -> QA -> Ops.
Goal: [goal]
Require role-labeled sections in order.
```
**Expected output:** end-to-end execution plan.  
**If blocked, do this next:** define target environment.

### 69) Tool honesty enforcement
**When to use:** prevent fake access/hallucinated tool reads.  
**Copy-paste prompt**
```text
Before answering, verify tool/file access.
If unavailable, state limits clearly and continue with a constrained answer.
Question: [question]
```
**Expected output:** truthful constrained response.  
**If blocked, do this next:** supply required file/content.

### 70) Constraint-first response mode
**When to use:** tool blocks/policy gates are common.  
**Copy-paste prompt**
```text
If blocked, output exactly:
Constraints
Workarounds
Next input needed
Then stop.
Task: [task]
```
**Expected output:** deterministic fallback structure.  
**If blocked, do this next:** include approval details.

### 71) Prompt Lab improvement loop
**When to use:** iterating weak prompt tests.  
**Copy-paste prompt**
```text
Given this failing prompt test:
[test]
Return:
1) likely score failures by rubric
2) revised prompt
3) what to verify in rerun
```
**Expected output:** targeted prompt revision plan.  
**If blocked, do this next:** include previous run output.

### 72) Approval-safe tool plan
**When to use:** risky actions need explicit approval points.  
**Copy-paste prompt**
```text
Design an execution plan with explicit approval gates before risky steps.
For each gate include: risk, blast radius, rollback.
Task: [task]
```
**Expected output:** gated execution plan.  
**If blocked, do this next:** define risk threshold.

### 73) Memory-aware assistant style
**When to use:** enforce format consistency across responses.  
**Copy-paste prompt**
```text
Remember this format: Summary -> Actions -> Risks -> Questions.
Apply it to this task now:
[task]
```
**Expected output:** formatted response with memory hint.  
**If blocked, do this next:** restate preferred format explicitly.

### 74) Cross-agent disagreement arbitration
**When to use:** roles conflict on speed vs quality/safety.  
**Copy-paste prompt**
```text
Simulate role conflict resolution:
[role A position]
[role B position]
Return compromise plan, phased scope, and deferred risks.
```
**Expected output:** mediated phased plan.  
**If blocked, do this next:** add release timeline.

### 75) Tool profile recommendation
**When to use:** decide safe vs power tool posture per task.  
**Copy-paste prompt**
```text
Recommend tool profile for this task:
[task]
Options: minimal, standard, coding, ops, research, danger.
Explain tradeoffs and safest default.
```
**Expected output:** profile recommendation with rationale.  
**If blocked, do this next:** clarify task sensitivity.

### 76) MCP trust-tier planning
**When to use:** adding external MCP servers safely.  
**Copy-paste prompt**
```text
For this MCP server idea:
[server]
Recommend trust tier, default state, redaction policy, and first test procedure.
```
**Expected output:** safe MCP onboarding plan.  
**If blocked, do this next:** provide server transport/auth model.

### 77) Run-vs-score failure analysis
**When to use:** Prompt Lab failures need triage by severity.  
**Copy-paste prompt**
```text
Given these Prompt Lab results:
[results]
Separate:
1) run failures (runtime/tooling)
2) score failures (quality)
Then propose fix order.
```
**Expected output:** severity-ranked remediation order.  
**If blocked, do this next:** include failing test codes.

## Troubleshooting, safety, and recovery cards (78-85)

### 78) Log triage scaffold
**When to use:** logs are missing or incomplete but action is needed.  
**Copy-paste prompt**
```text
I will paste logs next.
For now give:
root cause candidates,
top 3 next actions,
the single next log line you need first.
```
**Expected output:** deterministic triage scaffold.  
**If blocked, do this next:** paste first 100 lines.

### 79) Incident first 30 minutes
**When to use:** real incident and immediate structure required.  
**Copy-paste prompt**
```text
Give me a first-30-minutes incident runbook for:
[incident]
Include triage, containment, comms, and evidence capture.
```
**Expected output:** time-boxed runbook.  
**If blocked, do this next:** include impact scope.

### 80) Safe rollback plan
**When to use:** change failed and rollback needed now.  
**Copy-paste prompt**
```text
Generate rollback plan for this failed change:
[change]
Include pre-checks, rollback steps, verification, and postmortem notes.
```
**Expected output:** safe rollback checklist.  
**If blocked, do this next:** provide last known good version.

### 81) Config break-fix checklist
**When to use:** config edits broke app startup.  
**Copy-paste prompt**
```text
Create a break-fix checklist for config startup failures.
Prioritize non-destructive checks first and include repair order.
```
**Expected output:** diagnostic checklist with sequence.  
**If blocked, do this next:** share current error output.

### 82) Security posture quick audit
**When to use:** verify safe private-beta setup.  
**Copy-paste prompt**
```text
Audit this setup for security posture:
[setup]
Check auth, host exposure, origins, token handling, approvals, and auditability.
```
**Expected output:** security gaps + fixes.  
**If blocked, do this next:** provide env/config snippets.

### 83) Backup + restore drill planner
**When to use:** production readiness requires recoverability.  
**Copy-paste prompt**
```text
Design a backup and restore drill for:
[system]
Include backup scope, retention, restore test, and pass/fail criteria.
```
**Expected output:** restore drill plan.  
**If blocked, do this next:** define RPO/RTO targets.

### 84) Tool-failure loop breaker
**When to use:** repeated identical tool errors waste runs.  
**Copy-paste prompt**
```text
I hit repeated tool failures:
[errors]
Propose a circuit-breaker rule and fallback behavior that stops loops.
```
**Expected output:** anti-loop policy + fallback.  
**If blocked, do this next:** include tool name + exact error repeats.

### 85) Post-incident learning brief
**When to use:** close the loop after recovery.  
**Copy-paste prompt**
```text
Create a post-incident learning brief:
Context: [incident]
Need: timeline, root causes, corrective actions, prevention experiments, owner/date.
```
**Expected output:** actionable retrospective.  
**If blocked, do this next:** include incident timeline notes.

## Deep engineering audits (86-87)

### 86) Omega++ structural truth audit
**When to use:** a normal bug/prod review already happened and you want the strongest repo-specific audit for conceptual honesty, state ownership, event truth, replay/auditability, operator trust, maintainability, and future connector/platform scaling. This version is designed to resist shallow analysis by forcing concrete repo evidence across Mission Control, gateway, contracts, and storage, resolving moved files to their current equivalents, and turning unprovable claims into explicit proof obligations instead of hand-waving.  
**Prompt:** use [CODEX_OMEGA_AUDIT_PROMPT.md](./CODEX_OMEGA_AUDIT_PROMPT.md).  
**Expected output:** ranked structural findings, authority and state/event truth maps, proof obligations, lifecycle formalization candidates, a minimum structural cleanup plan, support-risk analysis, consolidation recommendations, and a hard verdict on platform integrity. Missing canonical architecture/state/event docs should be called out as findings, not silently normalized away.  
**If blocked, do this next:** tell Codex to inspect `README.md`, `docs/VISION_STATUS_MATRIX.md`, `apps/mission-control/src/content/page-registry.ts`, `apps/mission-control/src/api/client.ts`, `apps/gateway/src/routes`, `apps/gateway/src/services/gateway-service.ts`, `packages/contracts`, and `packages/storage` first.

### 87) Production + Omega combo pass
**When to use:** you want both "is this broken?" and "is this honest and scalable?" in sequence.  
**Prompt order:**
1. [CLAUDE_PROD_REVIEW_PROMPT.md](./CLAUDE_PROD_REVIEW_PROMPT.md)
2. [CODEX_OMEGA_AUDIT_PROMPT.md](./CODEX_OMEGA_AUDIT_PROMPT.md)

**Expected output:** first a conventional production-risk review, then a structural truth/state/event/platform audit that avoids repeating the first pass and ends with a smallest-high-leverage cleanup plan.  
**If blocked, do this next:** run the production prompt first and feed its top unresolved findings into the Omega++ pass as prior context.
