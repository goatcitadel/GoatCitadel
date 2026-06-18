# GoatCitadel Citadels Spec

**Status:** Draft for implementation  
**Working product name:** GoatCitadel, name TBD  
**Feature family:** Citadels  
**Core thesis:** A Citadel is a protected AI operating space for anything a person needs help running.  
**Last updated:** 2026-06-16

---

## 0. Executive Summary

GoatCitadel should evolve around **Citadels**.

A **Citadel** is not just a chat folder, project, dashboard, or automation workspace. It is a **protected AI operating space** with memory, agents, missions, automations, integrations, approvals, sharing boundaries, and encryption.

Users should be able to create Citadels for:

- personal life
- company operations
- households
- projects
- client work
- creator work
- learning and research
- teams
- anything custom

The product should not make “Company OS” more important than “Personal OS,” or vice versa. Instead, GoatCitadel should become a platform where **Personal Citadels**, **Company Citadels**, **Project Citadels**, and other Citadel types are equal first-class citizens.

The product promise:

> **Build a protected AI Citadel around anything you need help running.**

The onboarding promise:

> **Build your first AI Citadel in 10 minutes.**

The differentiator is not simply “AI agents” or “chat with tools.” The differentiator is the **Citadel model**:

```text
Citadel
├─ Charter
├─ Chambers
├─ Council
├─ Missions
├─ Archive
├─ Watchtower
├─ Gatehouse
└─ Vault
```

Chat, Cowork, and Code should eventually become **modes inside Citadels**, not top-level product buckets.

The core work modes should be:

```text
Ask
Plan
Cowork
Forge
Watch
Review
```

The setup agent should be called:

> **The Mason**

The Mason helps users design, stage, and safely activate Citadels.

Blueprints should become the portable/community artifact:

```text
citadel.blueprint.yaml
```

Blueprints allow users and external AI agents to generate, share, import, and customize Citadels safely. Blueprints must never contain secrets, credentials, private documents, tokens, or live authorization grants.

Encryption should be a core doctrine:

> **Every Citadel has walls. Every Chamber has a lock. Every Gate is a permission. Every key has an owner.**

---

## 1. Product Doctrine

### 1.1 Core Product Claim

GoatCitadel is a private AI command center where people build protected AI operating spaces called **Citadels**.

Each Citadel gives a part of life or work its own:

- purpose
- memory
- agents
- workflows
- automations
- integrations
- dashboards
- permissions
- approvals
- audit trail
- encryption boundary

### 1.2 North Star

The emotional problem:

> “I have too much going on. Help me stay oriented, make better decisions, and move things forward safely.”

This applies equally to:

- founders
- parents
- freelancers
- students
- creators
- developers
- operators
- household managers
- teams
- people trying to run their lives better

The product should help users:

1. know what matters
2. understand what changed
3. remember important context
4. plan what to do next
5. delegate safely
6. automate carefully
7. review and improve
8. protect sensitive data

### 1.3 Core Doctrine Statements

These should become product and engineering rules.

#### Rule 1: Everything belongs to a Citadel unless explicitly global.

Memory, files, agents, missions, automations, integrations, approvals, audit entries, and generated artifacts should be scoped to a Citadel unless there is a deliberate global reason.

#### Rule 2: A Citadel is a protected operating space.

It is not just a folder. It has boundaries, permissions, security posture, memory rules, and scoped agents.

#### Rule 3: AI can draft Blueprints; humans open Gates.

The Mason and external AI agents can propose Citadel structures, permissions, and integrations. Only the human user can activate sensitive access, connect accounts, invite members, enable external writes, or open high-risk Gates.

#### Rule 4: Blueprints are portable; secrets are not.

Blueprints can be shared publicly or privately. They must never contain credentials, tokens, OAuth refresh tokens, private files, or sensitive user data.

#### Rule 5: Sharing is scoped, revocable, encrypted, and auditable.

Sharing a Citadel should not automatically expose all data. Users should share Citadels, Chambers, Missions, Archive items, or Blueprints with explicit roles, expiration, audit visibility, and revocation.

#### Rule 6: Agents are identities, not extensions of humans.

Agents should have their own grants, scopes, expiry, mission context, tool permissions, and audit trails. Agents should not silently inherit a human user’s full permissions.

#### Rule 7: Ask / Plan / Cowork / Forge / Watch / Review are modes, not silos.

Every Citadel can use the same modes. A Personal Citadel can use Forge. A Company Citadel can use Watch. A Project Citadel can use Review.

#### Rule 8: Decrypt only what the current Mission needs.

Encryption is necessary but not enough. Once an AI model receives decrypted context, the risk has moved from storage security to context/tool governance. Mission context should be temporary, scoped, minimal, and auditable.

#### Rule 9: The Mason builds the Citadels.

The Mason is the setup/co-creation experience. It should be magical, conversational, and safe.

---

## 2. Terminology

### 2.1 Primary Terms

| Term | Meaning |
|---|---|
| **Citadel** | Protected AI operating space for a part of life/work |
| **Charter** | Purpose, goals, rules, boundaries, privacy expectations, success definition |
| **Chamber** | Protected subspace inside a Citadel with its own access rules and encryption posture |
| **Council** | Agents assigned to a Citadel |
| **Mission** | A goal, project, task, workflow, or multi-step AI run |
| **Archive** | Memory, files, notes, decisions, artifacts, and context |
| **Watchtower** | Automations, monitors, reminders, routines, scheduled reviews, alerts |
| **Gatehouse** | Permissions, integrations, sharing, approvals, secrets, audit, security |
| **Vault** | Encrypted storage/key-management layer for a Citadel |
| **Gate** | A specific permission grant or integration capability |
| **Ward** | A policy rule that limits what agents/tools/users can do |
| **Blueprint** | Portable Citadel configuration file |
| **The Mason** | AI setup agent that helps design/stage Citadels |
| **Passage** | Explicit cross-Citadel sharing/context bridge |
| **Sealed Chamber** | Chamber with stricter privacy/security defaults |
| **Command** | Global cross-Citadel assistant and attention surface |

### 2.2 Work Modes

| Mode | Purpose | Current GC analog |
|---|---|---|
| **Ask** | Chat, Q&A, summarization, brainstorming | Chat |
| **Plan** | Strategy, decisions, breakdowns, roadmaps | Chat/Cowork |
| **Cowork** | Multi-step guided execution with checkpoints | Cowork |
| **Forge** | Code, build, create artifacts, generate assets | Code |
| **Watch** | Monitor, automate, alert, remind | Ops/Automations |
| **Review** | Daily/weekly/monthly retrospectives and learning loops | Cowork/Ops |

### 2.3 Product Language Guidance

Use medium Citadel branding.

Good default vocabulary:

- Citadel
- Charter
- Chamber
- Council
- Mission
- Archive
- Watchtower
- Gatehouse
- Vault
- Blueprint
- Mason

Keep action labels plain:

- Ask
- Plan
- Build
- Review
- Approve
- Connect
- Share
- Remember
- Forget
- Export
- Import

Avoid over-theming everyday UI. Do not make the app say things like “summon the scribe” or “inscribe a rune” unless used as optional playful copy.

---

## 3. Product Positioning

### 3.1 Core Positioning

Possible primary line:

> **Build an AI Citadel for anything you need to run.**

Supporting line:

> GoatCitadel gives every part of your life and work its own protected command center — with memory, agents, automations, integrations, approvals, sharing, audit, and encryption built in.

### 3.2 Landing Page Promise

> **Build your first AI Citadel in 10 minutes.**

Tell the Mason what you need help running. It drafts a Blueprint with the right agents, missions, memory, automations, and permissions. You review it, open the Gates you trust, and start working.

### 3.3 Example Cards

#### Personal Citadel

Run your life, routines, goals, documents, relationships, and personal admin.

#### Company Citadel

Track customers, revenue, product, growth, support, finance, and operations.

#### Project Citadel

Plan, execute, and review ambitious projects with AI coworkers.

#### Household Citadel

Coordinate home, family, maintenance, bills, vendors, and shared responsibilities.

#### Creator Citadel

Manage ideas, publishing, sponsorships, analytics, and content workflows.

#### Client Citadel

Run client deliverables, meetings, communication, contracts, assets, and approvals.

#### Learning Citadel

Organize courses, research, notes, assignments, projects, and study plans.

#### Blank Citadel

Design your own protected AI operating space from scratch.

---

## 4. Product Architecture Overview

### 4.1 Conceptual Architecture

```text
GoatCitadel
│
├─ Command
│  ├─ Cross-Citadel daily brief
│  ├─ Universal command bar
│  ├─ Global attention inbox
│  ├─ Active Missions summary
│  └─ Safe routing into Citadels
│
├─ Citadels
│  ├─ Personal Citadel
│  ├─ Company Citadel
│  ├─ Project Citadel
│  ├─ Household Citadel
│  ├─ Client Citadel
│  ├─ Creator Citadel
│  ├─ Learning Citadel
│  └─ Custom Citadel
│
├─ Missions
│  ├─ Cross-Citadel Mission list
│  ├─ Mission runs
│  ├─ Plans/checkpoints
│  ├─ Evidence/artifacts
│  └─ Approvals
│
├─ Council
│  ├─ Agent roles
│  ├─ Capabilities
│  ├─ Grants
│  ├─ Delegation
│  └─ Agent audit
│
├─ Archive
│  ├─ Memory
│  ├─ Files
│  ├─ Decisions
│  ├─ Notes
│  ├─ Artifacts
│  └─ Context packs
│
├─ Watchtower
│  ├─ Automations
│  ├─ Monitors
│  ├─ Alerts
│  ├─ Scheduled reviews
│  └─ Routines
│
├─ Gatehouse
│  ├─ Permissions
│  ├─ Sharing
│  ├─ Integrations
│  ├─ Secrets
│  ├─ Approvals
│  ├─ Wards/policies
│  └─ Audit
│
└─ Vault
   ├─ Citadel keys
   ├─ Chamber keys
   ├─ Object keys
   ├─ Member grants
   ├─ Agent grants
   ├─ Backup keys
   └─ Key rotation ledger
```

### 4.2 Citadel Anatomy

```text
Citadel
├─ Charter
│  ├─ purpose
│  ├─ goals
│  ├─ boundaries
│  ├─ privacy rules
│  ├─ success definition
│  └─ default risk posture
│
├─ Chambers
│  ├─ General
│  ├─ Private
│  ├─ Finance
│  ├─ Health
│  ├─ Legal
│  └─ Custom
│
├─ Council
│  ├─ Chief of Staff
│  ├─ Planner
│  ├─ Researcher
│  ├─ Operator
│  ├─ Archivist
│  ├─ Watcher
│  └─ Specialists
│
├─ Missions
│  ├─ active missions
│  ├─ planned missions
│  ├─ recurring missions
│  ├─ completed missions
│  └─ mission evidence
│
├─ Archive
│  ├─ memories
│  ├─ files
│  ├─ decisions
│  ├─ notes
│  ├─ generated artifacts
│  └─ knowledge/context packs
│
├─ Watchtower
│  ├─ daily briefs
│  ├─ weekly reviews
│  ├─ monitors
│  ├─ alerts
│  ├─ automation recipes
│  └─ routine runs
│
├─ Gatehouse
│  ├─ members
│  ├─ roles
│  ├─ integrations
│  ├─ tool grants
│  ├─ approval rules
│  ├─ sharing links
│  ├─ audit
│  └─ security settings
│
└─ Vault
   ├─ encryption keys
   ├─ key grants
   ├─ backup manifests
   └─ rotation history
```

---

## 5. Relationship to Current GoatCitadel Surfaces

### 5.1 Current Surfaces

Current product surfaces such as:

```text
Chat
Cowork
Code
Projects
Library
Ops
Settings
```

should not be thrown away. They should be reorganized into the Citadel model over time.

### 5.2 Future Mapping

| Current Surface | Future Concept |
|---|---|
| Chat | Ask mode |
| Cowork | Cowork mode / Missions |
| Code | Forge mode |
| Projects | Citadels + Missions |
| Library | Archive |
| Ops | Watchtower |
| Settings | Gatehouse |
| Approvals | Gatehouse + Mission checkpoints |
| Memory | Archive + Vault-scoped memory |
| Tools/Integrations | Gatehouse capabilities |
| Automations | Watchtower |

### 5.3 Migration Strategy

#### Phase A: Add Citadels as a context layer

Keep existing navigation. Introduce Citadel context selectors into Chat, Cowork, Code, Projects, Library, Ops, and Settings.

Example:

```text
Chat in: Personal Citadel
Cowork in: Company Citadel
Code/Forge in: Project Citadel
```

#### Phase B: Add Citadel-native pages

Add routes like:

```text
/citadels
/citadels/:id
/citadels/:id/charter
/citadels/:id/chambers
/citadels/:id/missions
/citadels/:id/archive
/citadels/:id/council
/citadels/:id/watchtower
/citadels/:id/gatehouse
```

#### Phase C: Promote Citadel-first IA

Eventually, top-level navigation may become:

```text
Command
Citadels
Missions
Council
Archive
Watchtower
Gatehouse
```

Chat/Cowork/Code become modes inside Citadels.

---

## 6. User Experience

### 6.1 First-Run Experience

The first-run experience should be built around the Mason.

#### Step 1: Choose the AI Brain

```text
Choose how GoatCitadel should think:

- Cloud model
- Local model
- OpenAI-compatible endpoint
- External agent-assisted setup
- Manual setup
```

The user should not be blocked if no AI model is configured. Manual/template setup must be available.

#### Step 2: Choose What to Build

```text
What do you want to build a Citadel for?

- My personal life
- A company
- A project
- A household
- Client work
- Creative work
- Learning/research
- Something custom
```

#### Step 3: Talk to the Mason

The Mason asks:

```text
What should this Citadel help you run?
What does success look like?
Who should have access?
What information is sensitive?
What tools should it connect to?
What should it never do without approval?
What should it watch for?
What should it review daily or weekly?
How much autonomy should it have?
```

#### Step 4: Generate a Blueprint

The Mason drafts:

- Charter
- Chambers
- Council
- starter Missions
- Archive schema
- Watchtower routines
- Gatehouse rules
- suggested integrations
- security warnings
- setup checklist

#### Step 5: Review the Blueprint

The UI should say:

```text
Nothing has been connected or activated yet.
Review what this Citadel can see, remember, watch, and do.
```

#### Step 6: Open Gates

The user activates specific permissions and integrations one by one.

Examples:

```text
Google Calendar: read-only
Gmail: read-only, no send
Drive: selected folders only
Stripe: read-only
GitHub: issues/PR read and draft only
Figma: selected file access
```

#### Step 7: Activate the Citadel

The user lands in the Citadel Overview with modes:

```text
Ask
Plan
Cowork
Forge
Watch
Review
```

### 6.2 Citadel Overview

The Citadel Overview should answer:

- What is this Citadel for?
- What needs attention?
- What Missions are active?
- What changed recently?
- What is the Council suggesting?
- What Gates are open?
- What is being watched?
- What risks or approvals exist?
- What can I ask/do next?

Example layout:

```text
Personal Citadel

Charter Summary:
Run daily life, personal admin, routines, goals, relationships, and documents.

Needs Attention:
- Dentist form due tomorrow
- Insurance renewal due Friday
- Weekly review not completed

Active Missions:
- Organize tax documents
- Plan July travel
- Improve morning routine

Council Suggestions:
1. Submit the dentist form.
2. Review insurance renewal.
3. Schedule a 30-minute admin block.

Modes:
Ask | Plan | Cowork | Forge | Watch | Review
```

### 6.3 Command Surface

Command is the cross-Citadel surface.

It should show:

- Today’s signals
- active Missions
- waiting approvals
- upcoming deadlines
- Watchtower alerts
- Council suggestions
- global command bar

Example:

```text
Command

Today’s Signals:
- Personal Citadel: health form due tomorrow
- Company Citadel: customer replies waiting
- Household Citadel: insurance renewal due Friday
- Project Citadel: launch checklist waiting on approval

Suggested Top 3:
1. Approve the launch checklist.
2. Submit the health form.
3. Review customer replies.
```

Command should see only permitted cross-Citadel summary data. It should not casually merge private context from all Citadels.

### 6.4 Citadel Creation UX

Creation should support three paths:

1. **Talk to the Mason**
2. **Start from Template**
3. **Import Blueprint**

The ideal UX:

```text
Build your first AI Citadel in 10 minutes.
[Talk to the Mason] [Use a Template] [Import Blueprint]
```

---

## 7. Templates

### 7.1 Template Philosophy

Templates are starter kits for Citadels. They should create useful structures without over-requesting permissions.

Templates should include:

- setup questions
- starter Charter
- default Chambers
- default Council roles
- starter Missions
- starter Watchtower routines
- suggested integrations
- Gatehouse rules
- risk posture
- optional dashboards/cards

### 7.2 Recommended Launch Templates

Start with 8–10 excellent templates.

#### Personal Templates

1. **Personal Chief of Staff**
2. **Life Admin**
3. **Goals & Habits**
4. **Household**
5. **Learning / Research**

#### Work Templates

6. **Company Co-Founder**
7. **Solo Founder**
8. **Client Workspace**
9. **Creator Studio**
10. **Project Command**

#### Custom

11. **Blank Citadel**

### 7.3 Template Examples

#### Personal Chief of Staff

Default Chambers:

- General
- Calendar & Commitments
- People & Relationships
- Documents
- Private Reflection

Default Council:

- Chief of Staff
- Planner
- Archivist
- Watcher

Starter Missions:

- Daily brief setup
- Weekly life review
- Organize important documents
- Map current commitments
- Define top personal goals

Watchtower routines:

- daily brief
- weekly review
- monthly document review
- missed follow-up watch

Gatehouse defaults:

- no external write actions without approval
- selected-folder access only for file integrations
- restricted Chambers not included in global summaries by default

#### Company Co-Founder

Default Chambers:

- General
- Product
- Customers
- Growth
- Finance
- Legal
- Founder

Default Council:

- Founder Chief of Staff
- Product Strategist
- Growth Analyst
- Finance Operator
- Customer Advocate
- Release Manager

Starter Missions:

- Create company operating brief
- Define weekly business review
- Map current integrations
- Build customer feedback loop
- Prepare metrics dashboard

Watchtower routines:

- daily founder brief
- weekly business review
- customer feedback watch
- billing/revenue anomaly watch
- release readiness watch

Gatehouse defaults:

- production writes require approval
- finance/legal Chambers restricted
- external emails draft-only by default
- billing changes require explicit approval

#### Project Command

Default Chambers:

- General
- Requirements
- Tasks
- Decisions
- Artifacts

Default Council:

- Project Manager
- Researcher
- Builder
- Reviewer

Starter Missions:

- Define project scope
- Build milestones
- Identify risks
- Create execution plan
- Review progress weekly

Watchtower routines:

- milestone watch
- deadline watch
- weekly project review

Gatehouse defaults:

- no external writes without approval
- project-specific integrations only

---

## 8. Blueprints

### 8.1 Blueprint Purpose

A Blueprint is a portable, shareable, inspectable configuration for creating a Citadel.

Blueprints enable:

- AI-assisted setup
- community sharing
- template marketplaces
- export/import
- versioned customization
- organization-standard Citadel patterns
- external AI generation

### 8.2 Blueprint File Names

Supported:

```text
citadel.blueprint.yaml
citadel.blueprint.json
goatcitadel.blueprint.yaml
goatcitadel.blueprint.json
```

Preferred:

```text
citadel.blueprint.yaml
```

### 8.3 Blueprint Principles

Blueprints must:

- be human-readable
- be schema-validatable
- be safe to inspect before import
- never contain secrets
- never contain OAuth tokens
- never contain API keys
- never contain private documents
- never silently activate live integrations
- never grant external write actions by default
- include risk notes for requested permissions
- include provenance/author metadata
- support versioning

### 8.4 Blueprint Import Flow

```text
Import
→ Parse
→ Validate schema
→ Scan content
→ Scan permission requests
→ Show risk summary
→ Stage Citadel
→ User reviews
→ User opens Gates
→ Activate
```

### 8.5 Blueprint Export Modes

| Export Mode | Contains | Intended Use |
|---|---|---|
| **Public Blueprint** | Structure only, no private data | Community sharing |
| **Private Blueprint** | Custom structure, still no secrets | Personal/team reuse |
| **Encrypted Blueprint** | Shared with specific recipients | Private collaboration |
| **Citadel Backup** | Encrypted data + key manifest | Restore/migration, not public sharing |

Blueprints and backups must be treated as different things.

### 8.6 Blueprint Schema Sketch

```yaml
schemaVersion: "goatcitadel.blueprint.v1"

metadata:
  name: "Personal Chief of Staff"
  description: "A private Citadel for life admin, routines, commitments, documents, and goals."
  author:
    name: "GoatCitadel"
    url: "https://goatcitadel.app"
  license: "MIT"
  trustTier: "official"
  createdAt: "2026-06-16"
  updatedAt: "2026-06-16"
  compatibility:
    minGoatCitadelVersion: "1.0.0"

citadel:
  name: "Personal Citadel"
  kind: "personal"
  icon: "castle"
  defaultMode: "ask"

charter:
  purpose: "Help the owner run daily life, commitments, goals, documents, and personal routines."
  goals:
    - "Keep track of important commitments"
    - "Reduce missed follow-ups"
    - "Support weekly planning"
  boundaries:
    - "Do not send messages without approval"
    - "Do not share sensitive Chambers with other Citadels unless explicitly allowed"
  successDefinition:
    - "User gets a useful daily brief"
    - "User completes a weekly review"
    - "Important documents and commitments are easier to find"

chambers:
  - id: "general"
    name: "General"
    sensitivity: "private"
    sealed: false
  - id: "documents"
    name: "Documents"
    sensitivity: "private"
    sealed: false
  - id: "money"
    name: "Money"
    sensitivity: "restricted"
    sealed: true
  - id: "health"
    name: "Health"
    sensitivity: "restricted"
    sealed: true

council:
  - id: "chief-of-staff"
    name: "Chief of Staff"
    role: "Coordinate daily and weekly priorities."
    defaultModeAccess: ["ask", "plan", "review"]
    chamberAccess:
      - chamberId: "general"
        access: "read_draft"
  - id: "archivist"
    name: "Archivist"
    role: "Organize memories, documents, and decisions."
    defaultModeAccess: ["ask", "review"]
    chamberAccess:
      - chamberId: "documents"
        access: "read_draft"

missions:
  - id: "daily-brief"
    name: "Set up daily brief"
    mode: "review"
    recurrence: "daily"
    description: "Summarize what needs attention today."
  - id: "weekly-review"
    name: "Weekly life review"
    mode: "review"
    recurrence: "weekly"
    description: "Review goals, commitments, unfinished tasks, and next week."

watchtower:
  routines:
    - id: "daily-brief"
      name: "Daily Brief"
      schedule: "0 8 * * *"
      enabledByDefault: false
      requiresReviewBeforeEnable: true
    - id: "weekly-review"
      name: "Weekly Review"
      schedule: "0 16 * * SUN"
      enabledByDefault: false
      requiresReviewBeforeEnable: true

gatehouse:
  sharingDefault: "private"
  externalWritesDefault: "approval_required"
  memoryWritesDefault: "proposal_required"
  modelPolicyDefault: "hybrid_guarded"
  approvalRules:
    - actionPattern: "email.send"
      requireApproval: true
    - actionPattern: "calendar.create"
      requireApproval: true
    - actionPattern: "file.delete"
      requireApproval: true

suggestedIntegrations:
  - provider: "google_calendar"
    recommendedScope: "read_only"
    reason: "Needed for daily brief and schedule awareness."
    required: false
  - provider: "google_drive"
    recommendedScope: "selected_folders_read_only"
    reason: "Useful for organizing personal documents."
    required: false

riskNotes:
  - "This Blueprint does not include credentials or secrets."
  - "External write permissions are disabled until opened in the Gatehouse."
  - "Sealed Chambers should use stricter model-routing and sharing defaults."
```

### 8.7 Blueprint Risk Scanner

Blueprint imports should scan for:

- secrets accidentally included
- suspicious URLs
- broad write permissions
- hidden prompt injection instructions
- external exfiltration instructions
- overbroad memory access
- dangerous automation defaults
- destructive tool access
- live webhook activation
- non-reviewable scripts
- schema incompatibility
- unknown providers
- unclear provenance

The import UI should summarize risk:

```text
This Blueprint requests:
- 1 Citadel
- 4 Chambers
- 3 Council agents
- 2 Watchtower routines
- 2 suggested integrations
- 0 live credentials
- 0 external write permissions enabled by default

Risk level: Low
Review required before activation.
```

---

## 9. The Mason

### 9.1 Role

The Mason is the onboarding and setup agent.

The Mason helps users:

- create their first Citadel
- choose a template
- define a Charter
- identify sensitive Chambers
- pick Council roles
- define starter Missions
- choose Watchtower routines
- understand Gatehouse permissions
- create/export/import Blueprints
- validate proposed Citadel setup
- explain risks
- stage activation

The Mason should be helpful and conversational, but constrained.

### 9.2 Mason Product Copy

Possible introduction:

```text
I’m the Mason. I help build Citadels.

Tell me what part of your life or work you want help running.
I’ll draft a Blueprint with the right Chambers, Council, Missions, Watchtower routines, and Gatehouse rules.

Nothing will be connected or activated until you approve it.
```

### 9.3 Mason Boundaries

The Mason can:

- ask setup questions
- recommend templates
- draft Blueprints
- validate Blueprints
- explain risks
- stage Citadels
- propose integrations
- propose permissions
- propose automations
- create review summaries

The Mason cannot:

- connect accounts silently
- grant itself permissions
- invite people without approval
- enable external writes by default
- create live automations without approval
- export private data without approval
- include secrets in Blueprints
- bypass Gatehouse policies
- activate high-risk tools
- create cross-Citadel Passages without approval

### 9.4 Mason Flow

```text
User chooses AI brain
→ User chooses Citadel type
→ Mason asks setup questions
→ Mason drafts Blueprint
→ Blueprint is validated
→ Risk summary is shown
→ User reviews staged Citadel
→ User opens Gates
→ Citadel activates
```

### 9.5 Mason Setup Questions

Core questions:

1. What do you want this Citadel to help you run?
2. What does success look like?
3. What are the top 3 things it should help with first?
4. What information is sensitive?
5. Who, if anyone, should have access?
6. What integrations might help?
7. What should always require approval?
8. What should it never do?
9. What should it watch for?
10. What should it review daily/weekly/monthly?
11. Should this Citadel prioritize privacy, convenience, collaboration, or automation?
12. Should cloud AI be allowed, or should sensitive work prefer local AI?

---

## 10. Citadel Architect / Mason Skill

### 10.1 Purpose

Publish a skill that teaches AI agents how to safely generate GoatCitadel Blueprints.

Recommended name:

```text
Citadel Mason Skill
```

User-facing name:

```text
Citadel Architect Skill
```

### 10.2 Location

Suggested repo locations:

```text
skills/citadel-mason/SKILL.md
docs/citadel-blueprint-schema.md
docs/for-ai-agents.md
docs/llms.txt
templates/blueprints/
```

If using current GC skills conventions:

```text
packages/skills/src/citadel-mason.ts
skills/citadel-mason/SKILL.md
```

### 10.3 Skill Responsibilities

The skill should teach an AI agent to:

- ask the right setup questions
- identify the correct Citadel kind
- produce a Charter
- propose Chambers
- propose Council roles
- define starter Missions
- define Watchtower routines
- define Gatehouse policies
- suggest integrations conservatively
- avoid secrets
- avoid live credentials
- avoid unsafe external writes
- include risk notes
- output valid Blueprint YAML/JSON
- provide a human-readable review summary

### 10.4 Skill Skeleton

```md
# Citadel Mason Skill

## When to use

Use this skill when the user wants to create, customize, export, import, or review a GoatCitadel Citadel Blueprint.

## Goal

Create safe, useful, reviewable Citadel Blueprints for protected AI operating spaces.

## Core Rules

1. Never include secrets, API keys, OAuth tokens, refresh tokens, private files, or credentials.
2. Never enable external write actions by default.
3. Propose permissions; do not assume them.
4. Use Chambers for sensitive areas.
5. Use conservative Gatehouse defaults.
6. Agents must have explicit scoped grants.
7. Include risk notes for requested integrations.
8. Output schema-valid YAML or JSON.
9. Always include a review summary.
10. Blueprints are staged configuration, not live activation.

## Workflow

1. Ask what the Citadel is for.
2. Ask what is sensitive.
3. Ask who will share it.
4. Ask what tools/integrations are desired.
5. Ask autonomy/approval preferences.
6. Draft the Charter.
7. Propose Chambers.
8. Propose Council roles.
9. Propose Missions.
10. Propose Watchtower routines.
11. Propose Gatehouse policies.
12. Produce Blueprint.
13. Produce review summary.

## Output

Return:

- human-readable summary
- risks and assumptions
- valid `citadel.blueprint.yaml`
```

### 10.5 External Agent Setup

GoatCitadel should support external agents through:

1. public AI-readable docs
2. Blueprint files
3. safe setup MCP tools
4. local import validation

Possible files:

```text
/llms.txt
/FOR_AI_AGENTS.md
/docs/ai-agent-setup.md
/docs/citadel-blueprint-schema.md
```

Possible safe MCP tools:

```text
gc.describe_product
gc.list_citadel_templates
gc.get_blueprint_schema
gc.validate_blueprint
gc.stage_citadel_blueprint
gc.explain_required_permissions
gc.generate_user_review_summary
```

Do not expose dangerous setup tools to external agents:

```text
gc.activate_all_permissions
gc.connect_google_account
gc.invite_members
gc.enable_write_tools
gc.create_live_automation
```

---

## 11. Security Model

### 11.1 Security Thesis

Citadel security should be central to the product.

Core line:

> **Every Citadel is a security boundary. Every capability enters through a Gate. Every high-risk action leaves evidence.**

### 11.2 Threat Model

Important failure modes:

| Failure | Example |
|---|---|
| Over-broad memory access | Company agent reads personal health notes |
| Over-broad tool access | Agent can email, refund, and edit production data |
| Prompt injection | Malicious email tells agent to forward private files |
| Confused deputy | One integration abuses another integration/session |
| Bad sharing defaults | Contractor sees finance/legal context |
| Silent automation | Recurring automation performs external action without review |
| Credential bleed | Shared Citadel uses owner’s personal credentials incorrectly |
| Missing audit | No evidence after a bad action |
| Blast-radius failure | One compromised Citadel affects all Citadels |
| Memory poisoning | Bad content gets promoted into durable memory |
| Excessive agency | Agent takes high-impact actions without enough constraints |
| Data exfiltration | Agent summarizes/secrets leak to external destination |
| Supply-chain attack | Malicious Blueprint or integration requests dangerous access |

### 11.3 Security Principles

1. Least privilege by default
2. Deny-wins policy
3. Explicit human approvals for risky actions
4. Agents have scoped identities
5. Tools granted per Citadel/Chamber/Mission
6. Sensitive data classified before model routing
7. Secrets stored separately from normal Citadel data
8. Blueprints are validated and staged
9. Audit logs are durable and redacted
10. Citadels and Chambers are encryption boundaries
11. Revocation rotates keys where possible
12. Sharing is scoped and expires where possible
13. No dangerous tool activation from prompts alone
14. No secret injection into LLM prompts
15. Production actions require dry-run/preview/approval where possible

---

## 12. Sharing Model

### 12.1 Sharing Doctrine

Sharing should be powerful but conservative.

> **Sharing is a Gatehouse action, not a casual invite button.**

### 12.2 Shareable Objects

Users should be able to share:

- entire Citadel
- specific Chamber
- specific Mission
- specific Archive item
- specific file/artifact
- specific Watchtower routine
- read-only Blueprint
- editable Blueprint
- temporary context pack

### 12.3 Sharing Layers

```text
Citadel membership
  ↓
Chamber membership
  ↓
Object permissions
  ↓
Tool/capability grants
  ↓
Action approvals
  ↓
Audit visibility
```

Do not make “member of Citadel” mean “can see/do everything.”

### 12.4 Roles

| Role | Description |
|---|---|
| **Owner** | Full control, delete/export, manage billing/security |
| **Steward** | Manage Citadel config, members, agents, automations |
| **Builder** | Create Missions, templates, agents, automations |
| **Operator** | Run approved Missions and use granted tools |
| **Contributor** | Add files, notes, comments, tasks |
| **Viewer** | Read allowed context |
| **Guest** | Limited Chamber/object access |
| **Agent** | Non-human identity with explicit grants |

### 12.5 Sharing Defaults

Default sharing should be:

```text
read-only
no secrets
no tool grants
no agent delegation
no hidden Chambers
no inherited credentials
expires optional but recommended
audited
revocable
```

### 12.6 Sharing Flow

When sharing, ask:

```text
What are you sharing?
- Entire Citadel
- Specific Chamber
- Specific Mission
- Specific Archive item
- Blueprint only
```

Then:

```text
What can this person do?
- View
- Comment
- Contribute
- Run Missions
- Manage Council
- Manage Gates
```

Then:

```text
Can agents use this person's context?
- No
- Only inside this Chamber
- Only with approval
```

Then:

```text
Should this access expire?
- 24 hours
- 7 days
- 30 days
- Custom
- No expiration
```

### 12.7 Passages

A **Passage** is an explicit cross-Citadel sharing bridge.

Example:

```text
Personal Citadel → Company Citadel
Share: availability summary only
Do not share: medical/family/private details
```

Passages should support:

- source Citadel
- source Chamber
- destination Citadel
- allowed summary fields
- sensitivity classification
- expiration
- audit
- revocation

### 12.8 Revocation Reality

The product should be honest:

> Access can be revoked for future data, but data already viewed, downloaded, or copied cannot be recalled.

Revocation should:

1. remove access grants
2. rotate affected keys
3. re-wrap keys for remaining members
4. re-encrypt future writes with new keys
5. optionally re-encrypt existing data
6. record audit evidence

---

## 13. Encryption and Vault Model

### 13.1 Encryption Doctrine

Everything persistent should be encrypted as much as practical.

> **Every Citadel has walls. Every Chamber has a lock. Every Gate is a permission. Every key has an owner.**

### 13.2 What to Encrypt

| Data | Encryption posture |
|---|---|
| Citadel memory | Encrypt |
| Chamber memory | Encrypt with Chamber-scoped key |
| Files/documents | Encrypt |
| Artifacts | Encrypt |
| Decision logs | Encrypt sensitive fields |
| Agent instructions | Encrypt if private/custom |
| Mission transcripts | Encrypt |
| Tool results | Encrypt or redact aggressively |
| Integration tokens | Secret store only |
| Backups | Encrypt separately |
| Blueprints | No secrets; optional signing/encryption |
| Audit logs | Tamper-evident; sensitive fields encrypted/redacted |
| Search/vector indexes | Treat as sensitive; encrypt or local-only |
| Embeddings | Treat as sensitive; scope/encrypt |
| Operational metadata | Minimize; encrypt where feasible |

### 13.3 Citadel Vault

Every Citadel has a Vault.

```text
Citadel Vault
├─ Citadel key
├─ Chamber keys
├─ Object/data keys
├─ Member key grants
├─ Agent key grants
├─ Backup keys
├─ Recovery metadata
└─ Rotation ledger
```

### 13.4 Key Hierarchy

Recommended envelope encryption model:

```text
User Root Key
  ↓ wraps
User Key Encryption Key
  ↓ wraps
Citadel Key
  ↓ wraps
Chamber Keys
  ↓ wrap
Object/Data Keys
  ↓ encrypt
Memories, files, transcripts, artifacts, indexes
```

### 13.5 Chamber-Level Encryption

Chambers should have separate keys so users can share or restrict subspaces safely.

Example:

```text
Company Citadel
├─ General Chamber          shared with team
├─ Product Chamber          shared with product/dev agents
├─ Finance Chamber          owner + finance agent only
├─ Legal Chamber            owner only
└─ Founder Chamber          owner only
```

A member can join the Company Citadel without receiving the Finance Chamber key.

### 13.6 Agent Key Grants

Agents should have separate temporary grants.

Example:

```text
Agent: Planner
Mission: Weekly Review
Citadel: Personal
Chambers: General, Goals
Excluded Chambers: Health, Money, Private Reflection
Tools: Calendar read-only
Duration: 30 minutes
Export: blocked
External write: blocked
```

### 13.7 Encryption Modes

#### Local Vault Mode

Best for privacy.

```text
- Data encrypted locally
- Keys stored in OS keychain/secure store
- Cloud sync optional
- Server cannot decrypt synced blobs
- Local model recommended for highly sensitive Citadels
```

#### Hybrid Guarded Mode

Best practical default.

```text
- Data encrypted at rest
- Local client decrypts selected context
- User allows specific context to cloud model
- Cloud model receives only scoped context
- Logs redacted/encrypted
```

#### Hosted Team Mode

Best for teams/companies needing admin recovery.

```text
- Server-managed encryption
- Cloud KMS/HSM-backed keys
- Team policy controls
- Admin recovery possible
- Easier sharing
- Less private than local-only mode
```

### 13.8 Avoid Overclaiming

Do not claim full zero-knowledge unless all relevant data, search indexes, logs, backups, and model-processing paths truly prevent the server/provider from decrypting.

Safe claim:

> Encrypted by default, with local-first and end-to-end encrypted modes where supported.

### 13.9 Cryptographic Primitives

Use standard, boring crypto.

Recommendations:

| Need | Recommendation |
|---|---|
| Symmetric encryption | AES-256-GCM or XChaCha20-Poly1305 |
| Integrity | AEAD tags, signed/tamper-evident logs |
| Randomness | OS CSPRNG only |
| Passphrase derivation | Argon2id or scrypt |
| Key wrapping | AES-KW/AES-GCM wrapping or libsodium sealed boxes |
| Sharing | Public-key wrapping per member/device |
| Audit integrity | Hash chain / Merkle-style append-only ledger |

Do not create custom cryptographic algorithms.

### 13.10 Backup Encryption

Backups must be:

- encrypted before upload/copy
- versioned
- integrity checked
- restorable only with appropriate keys
- regularly tested
- clear about recovery tradeoffs

Backup modes:

| Mode | Pros | Cons |
|---|---|---|
| Private Recovery | Strongest privacy | Lost key means lost data |
| Managed Recovery | Better for teams | Admin/provider has more power |

---

## 14. Model Routing and Context Security

### 14.1 Data Classification

Before sending context to a model, classify it.

```text
Public
Internal
Private
Sensitive
Restricted
Secret
```

### 14.2 Routing Policy

| Data Level | Model Behavior |
|---|---|
| Public | Any approved model |
| Internal | Approved cloud/local |
| Private | Cloud only with user-approved provider |
| Sensitive | Prefer local; cloud requires explicit disclosure |
| Restricted | Local-only by default |
| Secret | Never send unless manually pasted/approved for that exact use |

### 14.3 Chamber Defaults

Examples:

```text
Health Chamber → local model by default
Finance Chamber → local or explicitly approved cloud
Legal Chamber → restricted, no external tools by default
Company public docs → approved cloud okay
Secrets/tokens → never sent to model
```

### 14.4 Mission Context Grants

An agent/model should receive:

- only the relevant Citadel
- only the relevant Chambers
- only needed memories/files
- only approved tools
- only for the Mission duration
- with retrieval/evidence logged

Do not dump entire Citadels into prompts.

### 14.5 Prompt Injection Controls

For any external/untrusted content:

- label content as untrusted
- prevent it from overriding system/Gatehouse rules
- block tool calls requested inside untrusted content unless independently authorized
- do not allow emails/webpages/docs to open Gates
- quarantine suspicious instructions
- require explicit approval for external actions

---

## 15. Secrets and Integrations

### 15.1 Secret Storage

Secrets should live in a dedicated Secret Vault, not normal Citadel data.

```text
Gatehouse
└─ Secret Vault
   ├─ OAuth tokens
   ├─ API keys
   ├─ service account refs
   ├─ MCP env secrets
   ├─ webhook secrets
   ├─ provider tokens
   └─ rotation metadata
```

### 15.2 Secret Rules

- no secrets in Blueprints
- no secrets in prompts
- no secrets in normal logs
- no secrets in screenshots
- no secrets in exported public artifacts
- no secret values exposed to agents
- agents call capability wrappers
- capability wrappers retrieve secrets server-side/local-side as needed
- redact all secret-like strings in audit/output
- support rotation and expiry

### 15.3 Integration Grant Model

Every integration grant should specify:

```text
provider
account
environment
Citadel
Chamber(s)
tools/capabilities
risk level
read/write/destructive mode
expiry
owner
approval policy
audit level
```

Example:

```yaml
provider: google_calendar
account: user@example.com
citadel: personal
chambers: ["general", "calendar"]
capabilities:
  - calendar.events.read
mode: read
expiry: null
approvalPolicy: none
auditLevel: standard
```

### 15.4 Typed Connectors vs MCP

Use three integration tiers:

#### Tier 1: Read-only MCP / discovery

Best for:

- docs
- design context
- repo inspection
- data analysis
- read-only productivity context

#### Tier 2: Typed GoatCitadel connectors

Use for:

- billing
- refunds
- releases
- database mutations
- production deployments
- customer emails
- anything with money, production, private data, or public/customer impact

#### Tier 3: External automation platforms

Zapier, Pipedream, Nango, Composio, etc. can be wrapped later, but should remain behind Gatehouse permissions and capability policy.

---

## 16. Council and Agents

### 16.1 Agent Archetypes

Use workspace-neutral archetypes.

| Archetype | Personal Example | Company Example |
|---|---|---|
| Chief of Staff | Life chief of staff | Founder chief of staff |
| Planner | Weekly life planner | Roadmap/planning agent |
| Operations | Life admin/household ops | Business ops |
| Finance | Bills/budget/subscriptions | Revenue/billing |
| Relationships | Friends/family follow-ups | Customers/partners |
| Researcher | Travel/product/health research | Market/competitor research |
| Coach | Habits/goals/reflection | Leadership/founder coach |
| Automation Builder | Personal routines | Business workflows |
| Archivist | Documents/memory | Company knowledge base |
| Builder | Personal scripts/assets | Code/product implementation |

### 16.2 Agent Identity

Each agent should have:

```text
id
name
role
Citadel grants
Chamber grants
mode access
tool grants
memory access
risk limit
approval requirements
expiry
audit identity
```

### 16.3 Agent Permissions

Agents should never inherit owner permissions automatically.

Example:

```ts
type AgentGrant = {
  agentId: string;
  citadelId: string;
  chamberIds: string[];
  modes: Array<"ask" | "plan" | "cowork" | "forge" | "watch" | "review">;
  capabilities: string[];
  maxRisk: "read" | "draft" | "write" | "destructive";
  expiresAt?: string;
  requiresApprovalFor: string[];
};
```

### 16.4 Council UX

The Council page should show:

- agents in the Citadel
- what they can access
- what they can do
- which Chambers they can read
- which tools they can call
- recent actions
- pending approvals
- trust/risk status

---

## 17. Missions

### 17.1 Mission Definition

A Mission is a structured unit of work.

Examples:

- plan my week
- prepare founder brief
- organize documents
- build landing page
- review failed payments
- plan a move
- draft release checklist
- compare vendors
- clean up inbox
- write content calendar

### 17.2 Mission Anatomy

```text
Mission
├─ objective
├─ Citadel
├─ Chamber scope
├─ mode
├─ assigned Council members
├─ plan
├─ steps
├─ checkpoints
├─ tools
├─ required approvals
├─ artifacts
├─ audit events
├─ outcome
└─ review
```

### 17.3 Mission Modes

| Mode | Mission Examples |
|---|---|
| Ask | “Summarize this document” |
| Plan | “Plan my week” |
| Cowork | “Help me set up a new client workflow” |
| Forge | “Build a script to organize these files” |
| Watch | “Monitor this folder for new invoices” |
| Review | “Run weekly company review” |

### 17.4 Mission States

```text
draft
planned
waiting_for_approval
running
paused
blocked
completed
failed
cancelled
archived
```

### 17.5 Evidence

Every meaningful Mission should retain:

- prompt/input summary
- Citadel/Chamber scope
- model/provider
- tools available
- tools used
- approvals requested/granted
- artifacts produced
- memory writes proposed/promoted
- external actions attempted
- outcome
- errors
- audit trail

---

## 18. Archive and Memory

### 18.1 Archive Scope

Archive contains:

- memories
- files
- decisions
- notes
- generated artifacts
- Mission outputs
- context packs
- imported docs
- references

### 18.2 Memory Types

| Type | Description |
|---|---|
| User preference | Global or Citadel-scoped preference |
| Citadel fact | Stable fact about this Citadel |
| Decision | Decision with date, reason, revisit rule |
| Policy | Rule or boundary |
| Routine | Recurring workflow |
| Relationship | Person/contact context |
| Asset | Important file/document/link |
| Metric | Tracked number or signal |
| Lesson | Learned reflection from Review |

### 18.3 Memory Promotion

Memory writes should be proposed by default unless policy allows auto-promotion.

Flow:

```text
Agent observes candidate memory
→ creates memory proposal
→ user reviews or policy accepts
→ memory promoted into Archive
→ memory receives scope/sensitivity/provenance
```

### 18.4 Memory Scoping

Memory should be scoped by:

```text
global
user
Citadel
Chamber
Mission
object/file
```

Avoid global memory unless it is truly global.

### 18.5 Sensitive Memory

Sensitive memory should:

- live in sealed Chambers
- use stricter model routing
- avoid global summaries
- require explicit sharing
- require explicit cloud-model use where needed
- be easy to forget/delete

---

## 19. Watchtower and Automations

### 19.1 Watchtower Purpose

Watchtower handles:

- recurring reviews
- monitors
- alerts
- reminders
- scheduled routines
- anomaly detection
- low-risk automations
- report generation

### 19.2 Automation Risk Modes

| Mode | Agent can do |
|---|---|
| Observe | Read only |
| Draft | Create proposals/reports/drafts |
| Stage | Prepare changes, no external side effect |
| Execute with approval | Perform approved external action |
| Autopilot | Low-risk, reversible, bounded actions only |

### 19.3 Starter Watchtower Routines

#### Personal

- daily brief
- weekly life review
- monthly document review
- missed follow-up watch
- upcoming deadline watch
- habit/routine drift review

#### Company

- daily founder brief
- weekly business review
- customer feedback watch
- revenue anomaly watch
- release readiness watch
- support backlog watch
- SEO/content review

#### Household

- maintenance reminder
- bill reminder
- shared calendar review
- vendor follow-up watch

#### Project

- milestone watch
- risk watch
- weekly project review
- blocked task review

### 19.4 Automation Safety

Every automation should declare:

```text
Citadel
Chamber scope
trigger
frequency
agent
tools
risk level
approval rules
budget/cost limits
run timeout
retry policy
audit level
failure behavior
```

External write automations should be disabled by default unless low-risk and explicitly approved.

---

## 20. Gatehouse

### 20.1 Purpose

The Gatehouse controls:

- permissions
- approvals
- integrations
- sharing
- secrets
- model access
- agent grants
- tool grants
- policies/Wards
- audit
- recovery/security settings

### 20.2 Gatehouse Pages

Suggested sections:

```text
Overview
Members
Chambers
Agents
Integrations
Tools
Approvals
Wards
Secrets
Sharing
Model Policy
Audit
Vault
Backups
```

### 20.3 Wards

Wards are policy rules.

Examples:

```yaml
- name: "No external email send without approval"
  actionPattern: "email.send"
  requireApproval: true

- name: "No production database writes from agent"
  provider: "database"
  environment: "production"
  actionPattern: ["insert", "update", "delete", "migration.apply"]
  requireApproval: true
  requireDryRun: true

- name: "No cloud model for Health Chamber by default"
  chamberKind: "health"
  modelPolicy: "local_only"

- name: "No cross-Citadel memory sharing without Passage"
  source: "*"
  destination: "*"
  requirePassage: true
```

### 20.4 Approval UX

Approvals should show:

- who/what requested action
- Citadel and Chamber scope
- tool/provider involved
- data to be sent
- side effect
- risk level
- dry-run/preview
- rollback possibility
- cost/budget impact
- audit record
- approve/deny/edit options

---

## 21. Data Model Sketch

### 21.1 TypeScript Domain Model

```ts
type CitadelKind =
  | "personal"
  | "company"
  | "project"
  | "household"
  | "client"
  | "creator"
  | "learning"
  | "team"
  | "custom";

type WorkMode = "ask" | "plan" | "cowork" | "forge" | "watch" | "review";

type Sensitivity =
  | "public"
  | "internal"
  | "private"
  | "sensitive"
  | "restricted"
  | "secret";

type RiskLevel = "read" | "draft" | "write" | "destructive";

type Citadel = {
  id: string;
  name: string;
  kind: CitadelKind;
  ownerId: string;
  charterId: string;
  defaultChamberId: string;
  vaultId: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

type Charter = {
  id: string;
  citadelId: string;
  purpose: string;
  goals: string[];
  boundaries: string[];
  successDefinition: string[];
  defaultRiskPosture: "conservative" | "balanced" | "collaborative" | "automation_forward";
  modelPolicyDefault: "local_only" | "hybrid_guarded" | "approved_cloud" | "hosted_team";
};

type Chamber = {
  id: string;
  citadelId: string;
  name: string;
  description?: string;
  sensitivity: Sensitivity;
  sealed: boolean;
  vaultKeyRef: string;
  createdAt: string;
  updatedAt: string;
};

type CouncilAgent = {
  id: string;
  citadelId: string;
  name: string;
  archetype: string;
  role: string;
  instructionsRef: string;
  allowedModes: WorkMode[];
  maxRisk: RiskLevel;
  createdAt: string;
  updatedAt: string;
};

type Mission = {
  id: string;
  citadelId: string;
  chamberIds: string[];
  title: string;
  objective: string;
  mode: WorkMode;
  state:
    | "draft"
    | "planned"
    | "waiting_for_approval"
    | "running"
    | "paused"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled"
    | "archived";
  assignedAgentIds: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type Gate = {
  id: string;
  citadelId: string;
  chamberId?: string;
  subjectType: "user" | "agent" | "integration" | "automation";
  subjectId: string;
  capability: string;
  riskLevel: RiskLevel;
  expiresAt?: string;
  createdBy: string;
  createdAt: string;
  revokedAt?: string;
};

type Ward = {
  id: string;
  citadelId: string;
  chamberId?: string;
  name: string;
  condition: Record<string, unknown>;
  effect: "allow" | "deny" | "require_approval" | "require_dry_run" | "redact" | "route_local";
  priority: number;
  enabled: boolean;
};

type Blueprint = {
  schemaVersion: "goatcitadel.blueprint.v1";
  metadata: Record<string, unknown>;
  citadel: Record<string, unknown>;
  charter: Record<string, unknown>;
  chambers: Record<string, unknown>[];
  council: Record<string, unknown>[];
  missions: Record<string, unknown>[];
  watchtower: Record<string, unknown>;
  gatehouse: Record<string, unknown>;
  suggestedIntegrations: Record<string, unknown>[];
  riskNotes: string[];
};
```

### 21.2 Suggested Tables

```text
citadels
citadel_charters
citadel_chambers
citadel_members
citadel_member_roles
citadel_passages

citadel_vaults
citadel_key_grants
citadel_key_rotation_events
citadel_backup_manifests

citadel_council_agents
citadel_agent_grants
citadel_agent_instructions

citadel_missions
citadel_mission_steps
citadel_mission_events
citadel_mission_artifacts

citadel_archive_items
citadel_memory_items
citadel_memory_proposals
citadel_decisions
citadel_files

citadel_watchtower_routines
citadel_watchtower_runs
citadel_alerts

citadel_gates
citadel_wards
citadel_approvals
citadel_audit_events
citadel_integrations
citadel_secret_refs

citadel_blueprints
citadel_blueprint_imports
citadel_blueprint_scans
citadel_templates
```

---

## 22. API Sketch

### 22.1 Citadels

```http
GET    /api/citadels
POST   /api/citadels
GET    /api/citadels/:id
PATCH  /api/citadels/:id
DELETE /api/citadels/:id
```

### 22.2 Mason

```http
POST /api/mason/sessions
GET  /api/mason/sessions/:id
POST /api/mason/sessions/:id/message
POST /api/mason/sessions/:id/generate-blueprint
POST /api/mason/sessions/:id/stage-citadel
```

### 22.3 Blueprints

```http
GET  /api/blueprints/templates
POST /api/blueprints/validate
POST /api/blueprints/scan
POST /api/blueprints/import
POST /api/blueprints/export
GET  /api/blueprints/imports/:id
POST /api/blueprints/imports/:id/activate
```

### 22.4 Chambers

```http
GET    /api/citadels/:id/chambers
POST   /api/citadels/:id/chambers
PATCH  /api/citadels/:id/chambers/:chamberId
DELETE /api/citadels/:id/chambers/:chamberId
```

### 22.5 Council

```http
GET    /api/citadels/:id/council
POST   /api/citadels/:id/council
PATCH  /api/citadels/:id/council/:agentId
DELETE /api/citadels/:id/council/:agentId
POST   /api/citadels/:id/council/:agentId/grants
DELETE /api/citadels/:id/council/:agentId/grants/:grantId
```

### 22.6 Missions

```http
GET    /api/citadels/:id/missions
POST   /api/citadels/:id/missions
GET    /api/missions/:missionId
PATCH  /api/missions/:missionId
POST   /api/missions/:missionId/start
POST   /api/missions/:missionId/pause
POST   /api/missions/:missionId/cancel
POST   /api/missions/:missionId/review
```

### 22.7 Gatehouse

```http
GET  /api/citadels/:id/gatehouse
GET  /api/citadels/:id/gates
POST /api/citadels/:id/gates
POST /api/citadels/:id/gates/:gateId/revoke

GET  /api/citadels/:id/wards
POST /api/citadels/:id/wards
PATCH /api/citadels/:id/wards/:wardId

GET  /api/citadels/:id/approvals
POST /api/citadels/:id/approvals/:approvalId/approve
POST /api/citadels/:id/approvals/:approvalId/deny
```

### 22.8 Vault

```http
GET  /api/citadels/:id/vault/status
POST /api/citadels/:id/vault/lock
POST /api/citadels/:id/vault/unlock
POST /api/citadels/:id/vault/rotate
GET  /api/citadels/:id/vault/key-grants
POST /api/citadels/:id/vault/key-grants
POST /api/citadels/:id/vault/key-grants/:grantId/revoke
```

---

## 23. Monorepo Recommendation

### 23.1 Keep Citadels in the Monorepo

Citadels should be a core GoatCitadel feature, not a separate repo at first.

Reasons:

- Citadels depend on gateway-owned runtime behavior.
- Citadels depend on memory, approvals, integrations, policy, audit, and durable execution.
- Citadels will reshape the product IA.
- Citadels are likely the core use case of the product.
- Security and encryption boundaries should be first-class, not plugin-only.
- The Blueprint ecosystem can split later once contracts stabilize.

### 23.2 Suggested Package Layout

```text
packages/citadel-core/
packages/citadel-blueprints/
packages/citadel-security/
packages/citadel-templates/
packages/citadel-runtime/
packages/citadel-skills/
```

### 23.3 Suggested App Layout

```text
apps/mission-control-next/src/features/citadels/
apps/mission-control-next/src/features/mason/
apps/mission-control-next/src/features/blueprints/
apps/mission-control-next/src/features/gatehouse/
apps/mission-control-next/src/features/watchtower/
```

### 23.4 Suggested Gateway Layout

```text
apps/gateway/src/routes/citadels.ts
apps/gateway/src/routes/citadel-blueprints.ts
apps/gateway/src/routes/mason.ts
apps/gateway/src/routes/citadel-gatehouse.ts
apps/gateway/src/routes/citadel-vault.ts

apps/gateway/src/services/citadel-service.ts
apps/gateway/src/services/citadel-blueprint-service.ts
apps/gateway/src/services/citadel-setup-service.ts
apps/gateway/src/services/citadel-permission-service.ts
apps/gateway/src/services/citadel-vault-service.ts
apps/gateway/src/services/citadel-sharing-service.ts
apps/gateway/src/services/mason-service.ts
```

### 23.5 Future Extraction

Once stable, externalizable pieces can move into SDK/marketplace packages:

- Blueprint schema
- Blueprint validator
- official template packs
- Citadel Mason Skill
- community template registry
- external integration packs

Core runtime, Vault, Gatehouse, and security policy should remain in the main repo.

---

## 24. Implementation Phases

### Phase 0: Spec and Naming

Deliverables:

- finalize Citadel vocabulary
- rewrite existing Company/Personal OS spec into Citadel spec
- create `docs/specs/citadels.md`
- create `docs/citadel-blueprint-schema.md`
- create `skills/citadel-mason/SKILL.md`
- define initial Blueprint schema
- define security principles

### Phase 1: Citadel Core

Deliverables:

- Citadel model
- Charter model
- basic Chamber model
- Citadel list/create/edit
- Citadel Overview page
- Citadel context selector in Chat/Cowork/Code
- Archive/Mission/Council placeholders
- default Citadel templates
- basic local encryption posture

Goal:

> Users can create a Citadel and use existing Chat/Cowork/Code within that Citadel context.

### Phase 2: Mason MVP

Deliverables:

- Mason session flow
- template-driven setup
- conversational questions
- Blueprint generation
- Blueprint validation
- staged Citadel preview
- activation flow
- user-friendly risk summary

Goal:

> Users can build their first AI Citadel in 10 minutes.

### Phase 3: Blueprints

Deliverables:

- export Blueprint
- import Blueprint
- scan Blueprint
- official template Blueprints
- Blueprint diff/review UI
- no-secrets validation
- schema tests
- public/private export modes

Goal:

> Users can share Citadel recipes safely.

### Phase 4: Gatehouse + Sharing

Deliverables:

- member roles
- Chamber-level sharing
- agent grants
- Gate grants
- Wards/policies
- approvals UI
- audit trail
- revocation flow
- key grant records

Goal:

> Citadels become shareable without losing security boundaries.

### Phase 5: Vault Hardening

Deliverables:

- Citadel keys
- Chamber keys
- object/data keys where needed
- OS secure store integration
- encrypted backups
- key rotation
- recovery mode UX
- secret vault separation
- model routing by sensitivity

Goal:

> Citadels are encrypted by default and honest about privacy modes.

### Phase 6: Watchtower + Missions

Deliverables:

- Mission model
- Mission page
- recurring routines
- Watchtower page
- daily/weekly review flows
- automation policy
- Mission evidence
- cross-Citadel Command brief

Goal:

> Citadels become operating spaces, not just configured chat containers.

### Phase 7: Community Blueprints

Deliverables:

- Blueprint gallery
- trust tiers
- official vs community Blueprints
- signed Blueprints
- reviews/import counts
- risk badges
- versioning
- compatibility checks

Goal:

> A community forms around safe, reusable Citadel Blueprints.

---

## 25. MVP Definition

### 25.1 MVP Promise

> Build your first AI Citadel in 10 minutes.

### 25.2 MVP Must-Haves

1. Citadel creation
2. Citadel templates
3. Mason setup flow
4. Blueprint generation
5. Blueprint import/export
6. Charter
7. lightweight Chambers
8. basic Council
9. basic Missions
10. basic Archive
11. basic Watchtower routines
12. Gatehouse permissions summary
13. encrypted local storage posture
14. no secrets in Blueprints
15. Citadel context in Ask/Plan/Cowork/Forge/Watch/Review
16. review-before-activation flow

### 25.3 MVP Nice-to-Haves

- Chamber-specific encryption keys
- Blueprint signature verification
- community gallery
- local/cloud model routing by Chamber sensitivity
- advanced sharing
- automation marketplace
- Passage UI

### 25.4 MVP Non-Goals

- full marketplace
- full zero-knowledge hosted collaboration
- arbitrary production write automation
- unreviewed community scripts
- broad third-party plugin execution
- enterprise compliance claims
- replacing all current nav at once
- perfect multi-device E2EE key sync

---

## 26. First 30 Implementation Tickets

1. Create `docs/specs/citadels.md`.
2. Create initial `packages/citadel-core`.
3. Define TypeScript domain types for Citadel, Charter, Chamber, Mission, CouncilAgent, Gate, Ward.
4. Add Citadel storage repository.
5. Add Gateway routes for create/list/read/update Citadels.
6. Add `apps/mission-control-next/src/features/citadels`.
7. Build Citadel list page.
8. Build Citadel creation page.
9. Add template selector.
10. Add default templates for Personal Chief of Staff and Company Co-Founder.
11. Add Charter editor.
12. Add lightweight Chambers UI.
13. Add Citadel context selector to Chat.
14. Add Citadel context selector to Cowork.
15. Add Citadel context selector to Code/Forge.
16. Create `packages/citadel-blueprints`.
17. Define Blueprint JSON schema.
18. Add Blueprint validation service.
19. Add Blueprint export from existing Citadel.
20. Add Blueprint import staging.
21. Add Blueprint risk scanner v1.
22. Add “no secrets in Blueprint” scanner.
23. Create Mason setup route/session model.
24. Build Mason onboarding UI.
25. Implement Mason question flow.
26. Generate staged Blueprint from Mason answers.
27. Add staged Citadel preview.
28. Add activation flow.
29. Add Gatehouse summary page.
30. Add basic encrypted storage/key reference model.

---

## 27. Verification and Tests

### 27.1 Unit Tests

- Blueprint schema validation
- Blueprint no-secrets scanner
- risk scanner
- Citadel creation
- Chamber creation
- Gate grants
- Ward matching
- key grant model
- Mason question flow
- template generation

### 27.2 Integration Tests

- create Citadel from template
- create Citadel from Mason Blueprint
- export/import Blueprint
- reject Blueprint with secret-like content
- reject dangerous auto-enabled write permission
- create Chamber and restrict agent access
- agent cannot access ungranted Chamber
- sharing grant creates audit record
- revocation blocks future access

### 27.3 Security Tests

- prompt injection in imported Blueprint
- prompt injection in Archive file
- secret redaction in logs
- cross-Citadel leakage attempt
- Chamber leakage attempt
- agent privilege escalation attempt
- external write without approval
- stale grant after revocation
- key rotation after sharing change

### 27.4 UX Tests

- first Citadel created in under 10 minutes
- user understands no integrations are activated yet
- user can identify what permissions a Blueprint requests
- user can tell which Chambers are shared
- user can tell which agents have access
- user can revoke a share
- user can export a safe Blueprint

### 27.5 Release Gates

Before claiming Citadels are production-ready:

- Citadel creation works end-to-end
- Mason setup works end-to-end
- Blueprint validation/scanning works
- no-secrets Blueprint export is enforced
- Gatehouse approval boundaries are real
- audit records are retained
- Chamber permissions are enforced
- local encryption posture is implemented and documented
- docs match behavior

---

## 28. Open Design Decisions

### 28.1 Product Name

Current working product name remains GoatCitadel. Name TBD.

Need decide:

- keep GoatCitadel
- shorten to GC internally only
- rename public product while preserving Citadel vocabulary
- use GoatCitadel as company/product and Citadels as core object

### 28.2 Setup Agent Naming

Current decision:

- user-facing setup agent: **The Mason**
- optional formal copy: **Citadel Mason**

Potential UI copy:

```text
The Mason builds your Citadel.
```

### 28.3 Chamber Complexity in MVP

Decision recommendation:

- include Chambers in MVP
- keep them lightweight
- every Citadel has default Chamber
- sensitive templates create Sealed Chambers
- advanced nested permissions can come later

### 28.4 Top-Level Navigation Timing

Do not immediately replace Chat/Cowork/Code.

Recommended path:

1. introduce Citadel context
2. add Citadel-native pages
3. gradually move users toward Command/Citadels/Missions/Council/Archive/Watchtower/Gatehouse
4. eventually reposition Chat/Cowork/Code as modes

### 28.5 Hosted vs Local Encryption

Need decide MVP default:

- Local Vault Mode for desktop/local-first installs
- Hybrid Guarded Mode for cloud model users
- Hosted Team Mode later

### 28.6 Blueprint Marketplace Timing

Recommendation:

- start with local import/export
- add official templates
- add private sharing
- add community gallery only after scanner/trust/versioning are mature

---

## 29. References and Research Notes

This spec was informed by the current direction of AI workspaces, project-scoped assistants, custom agent builders, MCP-style tool access, and agent security guidance.

Relevant public reference areas:

- Model Context Protocol specification and security guidance  
  <https://modelcontextprotocol.io/specification>
- OWASP Top 10 for LLM Applications  
  <https://genai.owasp.org/llm-top-10/>
- OWASP AI Agent Security Cheat Sheet  
  <https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html>
- OWASP Cryptographic Storage Cheat Sheet  
  <https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html>
- OWASP Secrets Management Cheat Sheet  
  <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html>
- NIST SP 800-38D, GCM authenticated encryption  
  <https://csrc.nist.gov/pubs/sp/800/38/d/final>
- NIST SP 800-57, key management guidance  
  <https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final>

Adjacent product patterns considered:

- ChatGPT Projects and Custom GPTs
- Dust Pods
- Notion AI
- Fabric
- Taskade
- Lindy
- Zapier AI
- Microsoft Copilot Studio
- Google Workspace with Gemini

The opportunity for GoatCitadel is not to copy “AI workspace” patterns, but to create a more coherent and defensible model:

> **Protected AI operating spaces called Citadels, created by the Mason, shared through Blueprints, governed by the Gatehouse, monitored by the Watchtower, remembered in the Archive, worked through Missions, and protected by the Vault.**

---

## 30. Final Direction

The product direction is now:

# GoatCitadel Citadels

## Protected AI operating spaces for life, work, projects, and organizations.

Users create Citadels around what they need to run.

Each Citadel has:

- Charter
- Chambers
- Council
- Missions
- Archive
- Watchtower
- Gatehouse
- Vault

Users work through:

- Ask
- Plan
- Cowork
- Forge
- Watch
- Review

Users build Citadels with:

- The Mason
- starter templates
- importable/exportable Blueprints
- external AI agent support through a Citadel Mason Skill

Security posture:

- encrypted by default
- Chamber-scoped access
- separate agent identities
- explicit Gates
- conservative sharing
- auditable actions
- no secrets in Blueprints
- sensitive model-routing policies
- human approval for risky actions

The flagship promise:

> **Build your first AI Citadel in 10 minutes.**

The core product sentence:

> **A Citadel is a protected AI operating space for anything you need help running.**
