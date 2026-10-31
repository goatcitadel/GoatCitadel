# critique

### Purpose

Resolve one stable target, run two independent assessments, synthesize a design critique, and ask the user what to improve next. The chat response is the deliverable.

### Hard Invariants

- Assessment A (design review) and Assessment B (render evidence) are both required.
- The GoatCitadel critique turn carries routed context, which pins the provider and model and disables delegation, so Assessment A and Assessment B run sequentially in this context: finish and record Assessment A before reading the render evidence and advisories for Assessment B.
- The report's first line MUST declare the method: `Method: single-context (routed-context critique)`.
- Assessment A must finish before render evidence and runtime advisories enter the synthesis. Advisories are deterministic, but they still anchor judgment.
- Viewable targets require inspection of the attached renders when they are available.
- The question is the LAST thing in the response. Write the entire report out first, then ask; nothing follows the question. Prose emitted after a structured question is withheld until the user answers it, so a report written after the question reads as if the critique never ran.
- A run that ends with neither the targeted questions nor a literal `Questions skipped: <reason>` line is an incomplete run. The report is not the finish; the close is.

### Setup

1. **Resolve the target** to a concrete file path or URL. Prefer a source path over a dev-server URL when both identify the same surface; ports drift, paths do not.
   - "the homepage" -> `site/pages/index.astro` or `index.html`
   - "the settings modal" -> the primary component file
   - "this page" -> the current URL or source file

### Assessment Orchestration

Run Assessment A, then Assessment B. Record Assessment A's findings before Assessment B begins so the evidence cannot anchor the review. Do not show findings to the user until synthesis.

### Assessment A: Design Review

Read the artifact markup from the routed context and inspect the attached renders when they are available. Think like a design director.

Evaluate:
- **Design specificity**: Is the composition, interaction, and visual language grounded in this product, or could an unrelated product use it unchanged? Make this judgment before seeing the renders or the runtime advisories.
- **Holistic design**: hierarchy, IA, emotional fit, discoverability, composition, typography, color, accessibility, states, copy, and edge cases.
- **Cognitive load**: consult the [Cognitive Load Assessment](#cognitive-load-assessment) section below; report checklist failures and decision points with >4 visible options.
- **Emotional journey**: peak-end rule, emotional valleys, reassurance at high-stakes moments.
- **Nielsen heuristics**: consult the [Heuristics Scoring Guide](#heuristics-scoring-guide) section below; score all 10 heuristics 0-4, marking any heuristic the mode-applicability rule allows as `n/a` instead of forcing a number.

Return: design-specificity verdict, heuristic scores, cognitive load, emotional journey, 2-3 strengths, 3-5 priority issues, persona red flags, minor observations, and provocative questions.

### Assessment B: Render Evidence

Review the render evidence GoatCitadel attached to this critique: offline PNG snapshots of the artifact at desktop (1440×900) and phone (390×844) viewports when the provider can inspect images, plus the runtime design advisories recorded on the artifact. Assessment B is mandatory and must remain isolated from Assessment A until both are complete.

Read the renders like a design director: compare the desktop and phone snapshots for hierarchy, density, overflow, contrast, and responsive breaks, and tie every observation to a region of the page. When no renders were attached, say so and assess the markup alone.

Return: what each render shows, the runtime advisories with counts and line locations, false positives, and whether renders were unavailable with the concrete reason.

### Generate Combined Critique Report

Synthesize both assessments into a single report. Do not simply concatenate. Weave the findings together, noting where the design review and the render evidence or advisories agree, where the advisories caught issues the review missed, and where advisories are false positives.

The chat response is the deliverable. Present the full structured critique below in chat; do not replace it with a summary and a link.

Structure your feedback as a design director would:

#### Report header provenance

The report's first line declares the method:
- `Method: single-context (routed-context critique)`

#### Design Health Score
> *Consult the [Heuristics Scoring Guide](#heuristics-scoring-guide) section below.*

Present the Nielsen's 10 heuristics scores as a table:

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | ? | [specific finding or "n/a" if solid] |
| 2 | Match System / Real World | ? | |
| 3 | User Control and Freedom | ? | |
| 4 | Consistency and Standards | ? | |
| 5 | Error Prevention | ? | |
| 6 | Recognition Rather Than Recall | ? | |
| 7 | Flexibility and Efficiency | ? | |
| 8 | Aesthetic and Minimalist Design | ? | |
| 9 | Error Recovery | ? | |
| 10 | Help and Documentation | ? | |
| **Total** | | **??/[applicable max]** | **[Rating band]** |

The applicable maximum is 4 times the number of heuristics you actually scored: **/40** when all ten apply, **/32** when two are `n/a`. Never print `/40` over a partial set.

Be honest with scores. A 4 means genuinely excellent. Most real interfaces score 20-32 out of 40.

**Mode applicability**: heuristics 7 (Flexibility and Efficiency) and 10 (Help and Documentation) may be scored `n/a` on Persuade and Experience surfaces (landing pages, campaigns, portfolios, bodies of work), as may any other heuristic that genuinely cannot apply to the surface under review. Write `n/a` in the Score cell with a one-line reason, and renormalize the total to the applicable maximum (e.g. **24/32** when two heuristics are n/a) so the rating band stays proportional.

#### Design Specificity Verdict

**Start here.** Does the result feel authored for this product, or category-interchangeable?

**LLM assessment**: Your unanchored evaluation of design specificity. Cover overall coherence, structural sameness, category-interchangeable choices, and missed opportunities for product character.

**Runtime advisories**: Summarize the design advisories GoatCitadel recorded on the artifact, with counts and line locations. Note any additional issues they caught that you missed, and flag any false positives.

**Render evidence** (when snapshots were attached): Say what the desktop and phone renders show that the markup alone would not. When no renders were attached, state that the critique is text-only.

#### Overall Impression
A brief gut reaction: what works, what doesn't, and the single biggest opportunity.

#### What's Working
Highlight 2-3 things done well. Be specific about why they work.

#### Priority Issues
The 3-5 most impactful design problems, ordered by importance.

For each issue, tag with **P0-P3 severity** (see [Issue Severity below](#issue-severity-p0p3) for definitions):
- **[P?] What**: Name the problem clearly
- **Why it matters**: How this hurts users or undermines goals
- **Fix**: What to do about it (be concrete)
- **Suggested command**: Which command could address this (from: shape, init, document, extract, critique, audit, polish, bolder, quieter, distill, harden, onboard, animate, colorize, typeset, layout, delight, overdrive, clarify, adapt, optimize)

#### Persona Red Flags
> *Consult the [Personas reference](#persona-based-design-testing) below.*

Auto-select 2-3 personas most relevant to this interface type (use the selection table in the reference). If the workspace PRODUCT.md or DESIGN.md names the audience or brand, also generate 1-2 project-specific personas from that context.

For each selected persona, walk through the primary user action and list specific red flags found:

**Alex (Power User)**: No keyboard shortcuts detected. Form requires 8 clicks for primary action. Forced modal onboarding. High abandonment risk.

**Jordan (First-Timer)**: Icon-only nav in sidebar. Technical jargon in error messages ("404 Not Found"). No visible help. Will abandon at step 2.

Be specific. Name the exact elements and interactions that fail each persona. Don't write generic persona descriptions; write what broke for them.

#### Minor Observations
Quick notes on smaller issues worth addressing.

#### Questions to Consider
Provocative questions that might unlock better solutions:
- "What if the primary action were more prominent?"
- "Does this need to feel this complex?"
- "What would a confident version of this look like?"

**Remember**:
- Be direct. Vague feedback wastes everyone's time.
- Be specific. "The submit button," not "some elements."
- Say what's wrong AND why it matters to users.
- Give concrete suggestions. Cut "consider exploring..." entirely.
- Prioritize ruthlessly. If everything is important, nothing is.
- Don't soften criticism. Developers need honest feedback to ship great design.

### Deliver the Report

Write the full report into the chat response now. This is the deliverable.

### Ask the User

**After presenting findings**, use targeted questions based on what was actually found. Ask the operator with the user_input.request tool and wait for the answer. These answers will shape the action plan.

Ask in the same message that carries the report, with the report written out first and the question last. Do not split the two across turns: a turn that ends on the report is a turn that ends, and the questions never arrive. Order within the message is what matters, because prose emitted after a structured question is withheld until the user answers.

Ask questions along these lines (adapt to the specific findings; do not ask generic questions):

1. **Priority direction**: Based on the issues found, ask which category matters most to the user right now. For example: "I found problems with visual hierarchy, color usage, and information overload. Which area should we tackle first?" Offer the top 2-3 issue categories as options.

2. **Design intent**: If the critique found a tonal mismatch, ask whether it was intentional. For example: "The interface feels clinical and corporate. Is that the intended tone, or should it feel warmer/bolder/more playful?" Offer 2-3 tonal directions as options based on what would fix the issues found.

3. **Scope**: Ask how much the user wants to take on. For example: "I found N issues. Want to address everything, or focus on the top 3?" Offer scope options like "Top 3 only", "All issues", "Critical issues only".

4. **Constraints** (optional; only ask if relevant): If the findings touch many areas, ask if anything is off-limits. For example: "Should any sections stay as-is?" This prevents the plan from touching things the user considers done.

**Rules for questions**:
- Every question must reference specific findings from the report. Never ask generic "who is your audience?" questions.
- Keep it to 2-4 questions maximum. Respect the user's time.
- Offer concrete options, not open-ended prompts.
- Skipping is allowed only when the report listed **fewer than 3 Priority Issues**. Count them; do not judge the findings "straightforward" by feel. At 3 or more, the questions are required.

**Final-question gate.** The user-visible response must either include the targeted questions or carry the literal line `Questions skipped: <reason>` naming the count that permitted the skip. Each question must include 2-3 concrete answer options tied to the actual critique findings. Do not end with only open-ended questions, and do not end with neither: stopping after the report, having asked nothing and printed no skip line, is the most common way this command fails.

### Recommended Actions

**After receiving the user's answers**, present a prioritized action summary reflecting the user's priorities and scope from Ask the User.

#### Action Summary

List recommended commands in priority order, based on the user's answers:

1. **`@skill impeccable command-name`**: Brief description of what to fix (specific context from critique findings)
2. **`@skill impeccable command-name`**: Brief description (specific context)
...

**Rules for recommendations**:
- Only recommend commands from: shape, init, document, extract, critique, audit, polish, bolder, quieter, distill, harden, onboard, animate, colorize, typeset, layout, delight, overdrive, clarify, adapt, optimize
- Order by the user's stated priorities first, then by impact
- Each item's description should carry enough context that the command knows what to focus on
- Map each Priority Issue to the appropriate command
- Skip commands that would address zero issues
- If the user chose a limited scope, only include items within that scope
- If the user marked areas as off-limits, exclude commands that would touch those areas
- End with `@skill impeccable polish` as the final step if any fixes were recommended

After presenting the summary, tell the user:

> You can ask me to run these one at a time, all at once, or in any order you prefer.
>
> Re-run `@skill impeccable critique` after fixes to see your score improve.

---

## Parts

This reference is split by section so the runtime can load one part at a time. Read the parts in order.

- [Reference Material](critique/01-reference-material.md)
