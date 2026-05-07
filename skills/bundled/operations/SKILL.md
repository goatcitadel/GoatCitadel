---
name: operations
description: "Diagnose runtime issues, manage incident response, verify policy posture, and execute safe operational changes with rollback planning. Use when GoatCitadel encounters service health problems, needs deployment verification, requires incident triage, or must execute runtime-changing actions with blast radius awareness."
metadata:
  version: "0.1.0"
  tags:
    - ops
    - runtime
    - safety
    - incident-response
    - monitoring
  tools:
    - session.status
    - shell.exec
    - http.get
  keywords:
    - ops
    - sre
    - incident
    - runtime
    - monitoring
    - deploy
    - rollback
    - health check
    - service status
    - policy posture
---

# Operations

Maintain runtime reliability, enforce policy posture, and run incident response workflows for GoatCitadel services.

Use this skill when:
- A service is unhealthy or unreachable and needs diagnosis
- A deployment needs pre/post verification
- An incident requires structured triage, timeline recording, and mitigation
- A runtime-changing action needs blast radius assessment and rollback planning
- Policy posture or safety boundaries need verification

Do not use this skill when:
- The task is purely code implementation (use `coding` instead)
- The task is test strategy or regression analysis (use `qa` instead)
- The task is architecture or interface design (use the relevant design skill)

## Workflow

### Diagnose

1. Check service status with `session.status` or `http.get` health endpoints
2. Gather logs, error messages, and recent change history
3. Identify the failing component and its dependencies
4. Classify severity: **P0** (full outage), **P1** (degraded), **P2** (minor), **P3** (cosmetic)

### Plan

1. Identify the fix or mitigation action
2. Assess blast radius - what else could break
3. Define rollback path - how to undo if the fix fails
4. Verify policy impact - does this change safety boundaries, permissions, or deny-wins rules

### Execute

1. Apply the change with the smallest possible scope
2. Verify the fix resolved the issue
3. Confirm no regressions in dependent services
4. Record the incident timeline: detection -> diagnosis -> mitigation -> resolution

### Post-Incident

1. Document what happened, root cause, and resolution
2. Identify preventive measures for recurrence
3. Update monitoring or alerting if gaps were found

## Safety Rules

- Always run safe diagnostics before runtime-changing actions
- Never bypass policy engine checks or approval gates
- Never auto-disable safety boundaries to unblock a fix
- Prefer the smallest possible change that resolves the issue
- If uncertain about blast radius, escalate to the user before executing

## Tools You May Use

- `session.status` - check current session and service state
- `shell.exec` - run diagnostic or remediation commands
- `http.get` - probe health endpoints and external service status
