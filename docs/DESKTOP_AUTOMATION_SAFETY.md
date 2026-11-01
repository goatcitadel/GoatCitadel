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

## Browser errands

Browser errands are a narrow, operator-approved form of automation: GoatCitadel drives its own browser window on the operator's PC to do a task the operator asked for in Chat. They are not general desktop control. Arbitrary coordinate automation of other applications is still not an acceptable default; that stays with the separate desktop-automation project.

Errands are off until the operator turns on the "Browser errands" switch in Settings › Tools. They also need Chat's Web access on.

### How errands meet the seven requirements above

- **Explicit operator session:** errands are off until the operator turns them on, and each one starts from the operator's request.
- **Allowlisted applications and actions:** one application only, GoatCitadel's own browser window. Within it, the ask-first categories decide which actions need approval.
- **Visible screen and cursor:** the window is visible, with a banner and the GoatCitadel cursor.
- **Approval-gated side effects:** spending, sending, deleting, and changing account settings need approval. Sign-ins are handed to the operator.
- **Durable before/after audit:** for every approved action, the spotlight screenshot before and a screenshot after are kept with the approval record, along with the URLs visited.
- **Immediate stop:** Stop, Esc, and `STOP`.
- **Gateway enforcement:** policy, deny-wins, approvals, and network rules (private and LAN addresses are blocked) stay in the Gateway.

### Accepted risks

Browser errands let GoatCitadel use its own Chrome window on this PC, with your saved logins, to do tasks you ask for. It asks before spending money, sending, deleting, or changing account settings, and hands sign-ins to you. Reading and browsing don't ask, so a hostile page could try to steer it into carrying your information to another site. Sites may notice an automated browser and limit your account.

- **Data leaving through ordinary browsing.** Reading, opening pages, and typing into search boxes never ask, and the browser profile holds real logins. A hostile page can try to get the model to read private data and carry it to another site, and none of the ask-first categories catches that. Mitigations that stay in place: private and LAN addresses are blocked, the overlay is kept out of model screenshots, the window is visible, and visited URLs are audited.
- **Accounts flagged as automated.** Sites may flag or limit an account used by an automated browser, and their terms may discourage robots. GoatCitadel does not hide that the browser is automated (no fingerprint spoofing or stealth plugins), and bot checks and captchas always go to the operator.
- **Phone approvals.** Until the phone app's matching update ships, the phone shows errand approvals and can deny or stop them, but approving happens in the window or in Chat. Approving from a channel arrives with a later PR.
