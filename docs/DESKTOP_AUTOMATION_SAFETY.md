# Desktop Automation Safety

Last updated: 2026-11-02

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
- **Durable before/after audit:** for every approved action, the spotlight screenshot before and a screenshot after are kept with the approval record. The URLs the errand visited are listed in its tool result in Chat.
- **Immediate stop:** Stop (on the window banner and on the Chat card) and Esc. In a channel, the operator's own account can reply `STOP` to an errand approval waiting in that conversation; at other times `STOP` there is ordinary chat.
- **Gateway enforcement:** policy, deny-wins, approvals, and network rules (private and LAN addresses are blocked) stay in the Gateway.

### Errands in channels

The operator can also start and approve errands from a channel conversation, with these rules:

- **Who counts as the operator.** Only the operator's own account: an `ownerActorIds` entry ("This is you") that is allowlisted (allowlist mode) or, on a pairing-mode connection, still approved (Telegram pairing in config, Discord pairing record). Revoking the pairing stops it. Turns typed in Mission Control count as the PC. Anyone else gets a refusal and changes nothing: a non-owner who asks for an errand gets "Only the owner can start a browser errand here."; a non-owner's exact `APPROVE`, `DENY` or `STOP` reply or button press gets "Only the owner can answer this." (replies get it at most once every 30 seconds per conversation); a non-owner's near-miss words (`ok`, `yes`, lowercase `approve`) pass through as ordinary chat.
- **Where approvals go.** An errand started from a channel asks in that conversation right away. An errand started at the PC asks in the window and Chat first; if still unanswered after 30 seconds it also goes to the one conversation picked in Settings › Tools (only the operator's own private conversation) and to the phone. Every errand's approval reaches the phone after 30 seconds if still unanswered; there is no instant phone push for errand approvals, and pushes skip approvals that were already answered.
- **What the message shows.** "GoatCitadel wants to: ..." and "Page: ..." (the address without query or fragment). The spotlight screenshot is sent in private conversations only; groups get the text plus "Screenshots are only sent in a private conversation."
- **How to answer.** On every channel, reply with the whole message `APPROVE`, `DENY`, or `STOP` in capitals while the approval is waiting in that conversation (a reply counts only once the question was actually sent there, never while it is still queued, and it is answered even while the errand that conversation started is still running); the operator's near-misses get a hint instead of counting. Where buttons are available (Telegram webhook-mode connections, Discord bot mode) they work too, and they are taken off the message once the approval is answered anywhere (best effort; a message still being sent at that moment can keep them). A press or reply on an approval that was already answered, or whose action expired, gets "This was already answered." A raw action token typed as `/approve <token>` never answers an errand approval from a channel. A voice note is never treated as an approval.
- **Sign-ins and bot checks.** When an errand pauses for a sign-in, the channel hears "GoatCitadel needs you at the PC to sign in. The errand is paused."; for a bot check or captcha it hears "GoatCitadel needs you at the PC. The errand is paused." (right away for channel-started errands; after 30 seconds, to the picked conversation, for PC-started ones). A channel-started errand in a private conversation gets its final screenshot back there.

### Accepted risks

Browser errands let GoatCitadel use its own Chrome window on this PC, with your saved logins, to do tasks you ask for. It asks before spending money, sending, deleting, or changing account settings, and hands sign-ins to you. Reading and browsing don't ask, so a hostile page could try to steer it into carrying your information to another site. Sites may notice an automated browser and limit your account.

- **Data leaving through ordinary browsing.** Reading, opening pages, and typing into search boxes never ask, and the browser profile holds real logins. A hostile page can try to get the model to read private data and carry it to another site, and none of the ask-first categories catches that. Mitigations that stay in place: private and LAN addresses are blocked, the overlay is kept out of model screenshots, the window is visible, and the URLs the errand visited are listed in its tool result.
- **Accounts flagged as automated.** Sites may flag or limit an account used by an automated browser, and their terms may discourage robots. GoatCitadel does not hide that the browser is automated (no fingerprint spoofing or stealth plugins), and bot checks and captchas always go to the operator.
- **Phone approvals.** Until the phone app update ships, the phone can see errand approvals and deny them (which ends the errand), but it cannot approve them. Approving happens in the window, in Chat, or in a channel. When the phone loads a waiting errand approval it gets the same plain line as a channel ("GoatCitadel wants to: ...") and the spotlight screenshot. The Gateway side of signed phone approvals is built but switched off in shipped builds: once it is on, a phone approve or edit counts only with a signature from that phone's own approval key over that exact approval and decision (and, for an edit, the exact edited details; an approve can carry none), made within five minutes of the Gateway's clock, and each signed decision works once, even across a restart. Device access requests are never approved from the phone, and a phone reject cannot change the request or carry a note longer than 500 characters. Turning it on is a separate, small change that waits for the phone app release that passes its device proof.
