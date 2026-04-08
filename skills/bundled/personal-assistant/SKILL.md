---
name: personal-assistant
description: "Summarize context, track action items, manage reminders, and support day-to-day operator workflows with prioritized next steps. Use when the operator needs a situation summary, action list triage, follow-up tracking, meeting prep, or coordinated handoff between tasks or sessions."
metadata:
  version: "0.1.0"
  tags:
    - assistant
    - productivity
    - coordination
    - summaries
  tools:
    - memory.read
    - http.get
    - session.status
  keywords:
    - assistant
    - summarize
    - organize
    - reminder
    - follow-up
    - action items
    - meeting prep
    - status update
    - handoff
---

# Personal Assistant

Support day-to-day operator workflows with context summaries, action tracking, and prioritized recommendations.

Use this skill when:
- The operator needs a summary of current context, recent activity, or session state
- Action items need to be extracted, prioritized, and owner-tagged
- Follow-ups or reminders need tracking across tasks or sessions
- Meeting prep requires gathering relevant context and open items
- A handoff between sessions needs structured state transfer

Do not use this skill when:
- The task is code implementation (use `coding` instead)
- The task is incident response or runtime ops (use `operations` instead)
- The task is research or analysis (use `research` instead)

## Workflow

### Gather Context

1. Read current session state via `session.status`
2. Check `memory.read` for relevant stored preferences and prior context
3. Identify the operator's immediate need: summary, action list, reminder, or handoff

### Summarize

1. Lead with the most actionable information first
2. Group related items by topic or urgency
3. Keep summaries concise — bullet points over paragraphs
4. Flag blockers or decisions that need operator input

### Track Actions

1. Extract action items from context with clear owners and deadlines
2. Prioritize by urgency and impact: **now** → **today** → **this week** → **backlog**
3. Keep action lists short — max 7 items at the top level
4. Mark completed items and surface newly created ones

### Hand Off

1. State what was done, what is pending, and what needs attention
2. Include relevant links, file paths, or references
3. Note any assumptions or decisions made during the session

## Guidelines

- Prefer practical recommendations over abstract advice
- Keep action lists owner-tagged so responsibility is clear
- Respect stored preferences from memory — reuse when confidence is high
- Ask before writing long-term memory when a write grant is required

## Tools You May Use

- `memory.read` — recall stored preferences and prior context
- `http.get` — fetch external context or status information
- `session.status` — check current session state and activity
