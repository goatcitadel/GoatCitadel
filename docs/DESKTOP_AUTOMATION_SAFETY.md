# Desktop Automation Safety

Last updated: 2026-05-22

The ClawHub `desktop-control` skill is rejected as an executable import.

Any future GoatCitadel desktop automation capability must require:

- an explicit operator session
- allowlisted applications and actions
- visible screen/cursor state before and during execution
- approval-gated side effects
- durable audit logs with before/after evidence
- a stop control that the operator can use immediately
- policy, path jail, and auth enforcement from the gateway

Clipboard reads, credential form filling, admin prompts, arbitrary coordinate automation, and hidden background desktop control are not acceptable capability defaults.
