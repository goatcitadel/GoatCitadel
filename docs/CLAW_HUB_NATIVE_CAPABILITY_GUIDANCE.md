# ClawHub Native Capability Guidance

Last updated: 2026-05-22

GoatCitadel absorbs the reviewed ClawHub ideas as native capabilities, not raw callable skill imports.

## Disposition Summary

- Reference only: auto-updater, multi-search-engine, proactive-agent, automation-workflows, neosoul-decision-agent, elite-longterm-memory, superdesign, ui-ux-pro-max, openai-whisper, ontology.
- Conditional: free-ride, github, gog, humanizer, canvas.
- Rejected: self-improving, self-improving-agent, desktop-control.

## Native Owners

- Update ideas belong to Update Scout and the improvement ledger.
- Search ideas belong to the global search broker, with no hidden scraping fallback.
- Proactive ideas belong to durable proactive runs and prompted-notification labels.
- Memory and ontology ideas belong to `MemoryLifecycleService`.
- Decision-agent ideas belong to typed decision records and retrospectives.
- Automation ideas belong to `WorkflowRecipeService` and cron review queues.
- Design and canvas ideas belong to A2UI proof lanes and Mission Control Next frontend guidance.
- Voice ideas belong to the managed local whisper runtime.
- GitHub, GOG, and free-ride ideas are connector/playbook and provider-advice improvements.

## Frontend And Copy Review Pack

Mission Control Next copy should be clear, operator-visible, and honest about runtime state.

Review checklist:

- no false certainty about roadmap, proof, sandboxing, local inference, or connector transport
- no primary surface that depends on raw JSON or raw tables for normal operator work
- visible destructive actions and approval states
- visible loading, error, empty, degraded, and blocked states
- compact text that does not overflow controls at desktop or mobile widths
- status labels that distinguish advisory, reference-only, conditional, rejected, prompted notification, and autonomous durable run

`humanizer`, `superdesign`, and `ui-ux-pro-max` should strengthen this review pack. They should not become separate runtime tools that rewrite factual claims or fight GoatCitadel's operations-console design language.

## Voice Backlog

OpenAI Whisper source ideas are covered by the managed local `whisper.cpp` path. Translation, SRT export, and batch transcription remain backlog items until implemented through the existing voice runtime.

## Desktop Automation Boundary

Executable desktop control is intentionally out of scope for this pass. Any future desktop automation capability must satisfy the separate desktop automation safety note before becoming callable.
