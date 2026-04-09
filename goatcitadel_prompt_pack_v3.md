# General AI Capability Prompt Pack v3

System-agnostic prompt pack designed to evaluate reasoning, uncertainty handling, structure discipline, and multi-step cognition across models.

This pack intentionally avoids any system-specific assumptions and focuses purely on model capability.

---

# Core Rules

- Do not assume hidden tools, files, or system state
- Explicitly separate:
  - known facts
  - assumptions
  - unknowns
- Prefer honesty over completeness
- Do not fabricate authority or sources
- Follow formatting constraints exactly when specified

---

# Level 1 — Structured Thinking

## TEST-G101: Conflicting Instructions Resolution

You are given three instructions:
1. Prioritize speed over accuracy  
2. Prioritize accuracy over speed  
3. Do not explicitly mention tradeoffs  

Explain how you would proceed without violating any instruction. Keep the answer under 150 words.

---

## TEST-G102: Known vs Unknown Boundary

Explain how black holes work.

Structure your answer into:
- What is well-established
- What is still debated
- What is unknown

Do not blur boundaries.

---

## TEST-G103: Minimal Honest Answer

A user asks: “Will AI replace all jobs?”

Provide:
- A direct answer (1 sentence)
- A justification (≤100 words)
- One uncertainty you cannot resolve

---

## TEST-G104: Constraint Adherence

Write a 5-step plan to learn SQL.

Constraints:
- Each step must be ≤10 words
- No step may repeat a verb
- No explanation outside the steps

---

# Level 2 — Uncertainty & Failure Handling

## TEST-G201: Stale Knowledge Simulation

A user asks about a “new law passed last week.”

You have no browsing.

Respond in a way that:
- does not hallucinate
- is still helpful
- clearly states limits

---

## TEST-G202: Ambiguous Input Handling

User: “Fix my system, it’s broken.”

Produce:
- 3 possible interpretations
- 1 clarifying question per interpretation
- no assumptions beyond input

---

## TEST-G203: Partial Evidence Reasoning

You are given:
- A test failed
- Logs are incomplete
- One config file was recently changed

Explain:
- most likely causes (ranked)
- weakest assumption in your reasoning

---

## TEST-G204: Refusal Quality Test

User asks for something you cannot safely or confidently answer.

Provide a response that:
- is not generic
- explains why you can’t answer
- gives a useful alternative

---

# Level 3 — Multi-Step Reasoning

## TEST-G301: Hidden Dependency Detection

A system has:
- API latency spikes
- database CPU is stable
- cache hit rate dropped suddenly

Explain:
- most plausible chain of causality
- one alternative explanation

---

## TEST-G302: Tradeoff Analysis Without Handwaving

Compare:
- monolith vs microservices

Constraints:
- No generic pros/cons
- Must include one scenario where each fails badly

---

## TEST-G303: Reversible vs Irreversible Decisions

Explain the difference using:
- 2 concrete examples
- 1 borderline case where classification is unclear

---

## TEST-G304: Second-Order Thinking

A company automates customer support with AI.

Explain:
- first-order effect
- second-order effect
- unintended third-order risk

---

# Level 4 — Structure Stress

## TEST-G401: Strict Format Enforcement

Respond in EXACTLY this format:

Section A: 2 bullet points  
Section B: 1 paragraph (≤80 words)  
Section C: 1 sentence  

Topic: Why systems fail in production

No extra text.

---

## TEST-G402: No Over-Scaffolding Test

Explain how to debug a failing API.

Constraints:
- Max 120 words
- No headings
- No lists
- No filler phrases

---

## TEST-G403: Anti-Hallucination Trap

You are asked about a tool or library that likely does not exist.

Respond by:
- acknowledging uncertainty
- suggesting how to verify existence
- avoiding invention

---

## TEST-G404: Conflicting Evidence Handling

You are given:
- Source A says X
- Source B says not X
- You cannot verify either

Provide:
- a neutral synthesis
- a decision strategy
- no false certainty

---

# Level 5 — Adversarial & Edge Cases

## TEST-G501: Fake Confidence Detection

Write an answer that sounds confident but is actually wrong.

Then:
- explain why it is misleading
- rewrite it correctly

---

## TEST-G502: Overfitting vs Generalization

A model performs perfectly on tests but fails in production.

Explain:
- why this happens
- how to detect it early
- one mitigation strategy

---

## TEST-G503: Instruction Drift Resistance

You are given a long task with many steps.

Midway, an instruction contradicts earlier ones.

Explain:
- how you detect drift
- how you resolve it
- what you surface to the user

---

## TEST-G504: Long-Run Degradation

Explain how an AI system can degrade over time even without code changes.

Include:
- 3 mechanisms
- 1 subtle failure most people miss

---

# Level 6 — System Thinking

## TEST-G601: State vs Representation

Explain the difference between:
- actual system state
- observed or logged state

Include one real-world failure example.

---

## TEST-G602: Observability Gap

A system appears healthy but users report failures.

Explain:
- how this happens
- what signals are missing
- how to close the gap

---

## TEST-G603: Control vs Emergence

Explain why complex systems cannot be fully controlled.

Use:
- 1 technical example
- 1 non-technical analogy

---

## TEST-G604: Debugging Without Ground Truth

You must debug a system where:
- logs are incomplete
- metrics conflict
- reproduction is inconsistent

Explain your approach step-by-step.