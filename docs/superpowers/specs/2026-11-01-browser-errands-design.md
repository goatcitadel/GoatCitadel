# Browser errands design

Date: 2026-11-01
Status: draft for operator review

Delivery status: PR 1 delivered the errand browser, the Gateway errand loop and Chat tool (behind the "Browser errands" flag), approval integrity, the Chat card with approvals, and the safety doc section plus a local proof script (`scripts/dev/errand-local-proof.mjs`). PR 2 and PR 3 remain. Not yet run: the local proof script and the live Codex acceptance check have not been run; the operator is to run them.

## Intent

The operator wants GoatCitadel to "use my computer like a person would at the end of the day, smooth, seamless." This document covers the first step toward that: **browser errands**. You ask for something in Chat, from a channel, or from the phone. GoatCitadel opens its own browser window on your PC and does the errand by looking at the screen and using a mouse and keyboard, the way a person would. You can watch it work, stop it at any time, and approve the steps that matter.

The errands the operator named:

- Find a product to buy on Amazon.
- Check how much Codex or Claude Code usage is left.

Two related projects come later and each gets its own design:

- **Watches** (project 2): for example, notify the operator when a Discord DM arrives. This is read-only; GoatCitadel never sends Discord messages for the operator.
- **Full desktop control** (project 3): the same experience for the whole Windows desktop, not just a browser window.

### Why now

GoatCitadel's browser tools today are selector-based (`browser.navigate`, `browser.extract`, `browser.interact` with `click`/`type`/`press` steps). Each call launches a fresh headless Chromium. Nothing keeps a browser open, nothing shows the operator what is happening, and nothing lets the model work from what it sees on screen. There is no real computer use.

A probe on 2026-10-31 showed the operator's ChatGPT/Codex subscription can drive computer use today. See "What the probe proved" below.

## What success looks like

The first test is the operator's own errand:

1. In Chat, the operator types "how much of my Codex usage is left this week?"
2. The GoatCitadel browser window opens on the PC. The GoatCitadel cursor moves to the usage page. If the session has expired, it hands over for sign-in (see "Sign-ins").
3. Chat answers with the number and a screenshot of the page it read the number from.

The second test needs an approval. It runs on a local test page (and later a real store):

1. "Add a USB-C hub under $40 to my cart and check out."
2. It searches, picks a hub and adds it to the cart without asking.
3. Before "Place your order", the page dims, the button is outlined, and a card next to the GoatCitadel cursor explains exactly what will happen (item, total, payment method, shipping address). Approving takes one click.
4. If nobody answers in the window within 30 seconds, the same request reaches the operator's phone and chosen channel as a screenshot. Buttons work where the channel supports them; elsewhere, a reply of `APPROVE` works.

## Goals

- Errands run in a visible GoatCitadel browser window on the operator's PC. The operator can watch, take over, hand back, and stop at any time.
- The experience matches the Codex style the operator described:
  - a banner saying GoatCitadel is in control, with a stop control;
  - its own cursor that you can watch move;
  - the approval appears where that cursor is, as a card explaining what it wants to do.
- Everyday browsing never asks: reading, searching, scrolling, opening pages, filling a cart. It asks only before spending money, sending something as the operator, deleting something, or changing an account setting.
- Approvals work everywhere the operator already gets them: the window, Chat, the phone, and channels. Answering in one place clears the request in all of them.
- Errands work on the operator's ChatGPT/Codex subscription.

## Non-goals

- Full desktop control (project 3).
- Watches and notifications such as Discord DMs (project 2).
- Background errands nobody could watch. The window is always visible on the PC, even when the operator is away and approving from the phone.
- Solving captchas or other bot checks. The errand hands over to the operator instead.
- Errands on a `remote_hardened` deployment. Errands need GoatCitadel running on the operator's own desktop (the `local_dev` or `trusted_local` profile).
- Resuming an errand after a Gateway restart. The errand ends and says it was interrupted.
- Changing the phone app. Its code is not in this repository (see "Phone").

## Anti-goals

Any of these makes the feature a failure, even if it technically works:

- An errand spends money, sends a message, deletes something, or changes an account setting without the operator's explicit approval.
- The AI types, reads, or fills a password, or touches the password manager.
- A web page can fake the approval card, hide it, or press Approve. The model also must never be able to approve its own request.
- Approval messages full of IDs, kinds, risk enums, or token expiry times. The current channel approval message is like this and must not be reused for errands.
- Screenshots piling up in the main Chat conversation and crowding out everything else.
- Claiming the browser is a sandbox against hostile pages. It is the operator's real browser profile with real logins.

## What the operator decided

### Watching an errand

- Errands run in **GoatCitadel's own browser window**, not the operator's everyday browser, and not the whole desktop. The operator's real mouse and keyboard stay theirs, and they can keep working in other windows.
- While GoatCitadel is in control, the window shows a banner, for example "GoatCitadel is using this browser · Finding a USB-C hub under $40 · step 6". The banner has **Take over**, **Stop**, and an Esc shortcut for Stop.
- GoatCitadel has its own visible cursor in the window, separate from the operator's pointer. You can watch it move between targets.

### Approvals

- **Look:** the operator picked the **spotlight** style. The page dims, the exact element GoatCitadel wants to click is outlined in cyan, and an approval card sits next to the GoatCitadel cursor. The card names the action ("Click 'Place your order'") and explains in one or two plain sentences what will happen. For money it shows the item, total, how it pays, and where it ships. Approve is one click; "Not now" turns the request down.
- **When it asks:** before spending money, sending something as the operator, deleting something, or changing an account setting. It does not ask for reading, searching, scrolling, opening pages, or adding to a cart.

### Sign-ins

- The GoatCitadel browser keeps **its own saved logins**, separate from the operator's everyday Chrome. Logins persist between errands, so the operator signs in to each site once.
- The operator uses **LastPass** to fill passwords. LastPass must work in the GoatCitadel browser.
- When an errand reaches a sign-in page, it stops and hands the window to the operator. The banner changes to "Sign in, then press Hand back". The operator signs in (LastPass fills the password; the operator handles any two-factor code) and hands control back. The same handoff happens when a saved login expires mid-errand.

### Channels and the phone

- When an errand needs approval and the operator is reached through a channel or the phone, GoatCitadel sends a **screenshot of what it is going to do and where it will click**.
- Channels with buttons get **Approve** and **Deny** buttons.
- Channels without buttons accept a reply of exactly **`APPROVE`**, in all caps.

## Decisions made on the operator's behalf

The operator heard and accepted these during the conversation. They are still choices made for the operator, so the builder should treat them as settled but may raise a concrete problem.

- **The approval card is drawn by GoatCitadel, not the page.** A page cannot see, alter, hide, fake-trigger, or cover it, and the model cannot click it (see "Approval integrity").
- **`APPROVE` rules:**
  - Only a message whose whole text is `APPROVE` counts. Surrounding whitespace is ignored; anything else fails.
  - "approve", "Approve", "yes", or "ok" do not approve. They get a reply: "Reply APPROVE in capitals to approve."
  - `APPROVE` counts only from the operator's own paired identity, in the conversation the request was sent to, and only for that errand's most recent pending request.
  - `DENY` turns the request down. `STOP` ends the errand. Both are whole-message and all caps, matching `APPROVE`.
  - An unanswered request expires; the errand then stops and says why.
- **The channel and phone screenshot is the spotlight view:** page dimmed, target outlined, GoatCitadel cursor on it. It comes with one plain line, such as "Click Place your order: buys 1 × hub for $37.48, Visa on Amazon, ships Home". No IDs or jargon.
- **One answer clears everywhere.** Resolving in the window, Chat, the phone, or a channel resolves the single Gateway approval, and the other surfaces update.
- **Sign-ins while away:** the operator cannot sign in from the phone, so the errand pauses with "needs you at the PC to sign in".
  - The pause is a notice, not an approval. It shows in Chat and goes to the same channel conversations approvals go to.
  - It reaches the phone only if the push path can carry a notice that isn't an approval without app changes. Otherwise it skips the phone in v1.
  - A paused errand waits up to the approval expiry, then stops and says why.
- **Only the operator counts in channels.**
  - `APPROVE`, `DENY`, `STOP`, and the buttons count only from the operator's own account, marked "This is you" (`ownerActorIds`). Other paired people get "Only the owner can answer this."
  - Today the owner mark is honored only on allowlist-mode connections (`apps/gateway/src/services/channel-owner-access.ts`).
  - The builder extends recognition for errand approvals to pairing-mode connections, as long as that account's pairing is still approved. That way the operator doesn't have to switch modes, and revoking a pairing still stops it.
- **Only the operator can start an errand from a channel**, under the same owner rule. Anyone else gets a plain refusal.
  - Channel turns otherwise keep browser tools on by default (`DEFAULT_CHANNEL_TOOLSET_POSTURE` in `apps/gateway/src/services/channel-command-contract.ts`). The errand tool must be excluded from non-owner turns.
  - Results and screenshots from an errand go only to a private conversation with the operator. In a group conversation the errand replies with text only and says so.
- **Errands are off until the operator turns them on.** A Settings switch, "Browser errands", enables the errand tool. Turning it on is the operator's explicit opt-in to coordinate-based browsing of the public web.
- **Buttons where the platform has them.**
  - Telegram already has inline approval buttons.
  - Discord's bot handles approvals through `/approve` and `/deny` slash commands today. Errand approvals add Discord buttons, because the operator asked for buttons wherever the channel supports them.
  - Every other channel uses the `APPROVE` reply.
- **Errands run in their own loop, not inside the main Chat context.** The Chat model starts an errand with a goal; a dedicated errand loop drives the browser with a vision model and returns a short result (answer, final screenshot, step summary) to the Chat turn. Reasons:
  - Screenshots are large and would swamp the Chat context (see anti-goals).
  - Errands keep working whichever model the Chat uses. For example, the Claude CLI bridge may not carry images in tool results.
  - The errand model can be set on its own, defaulting to the operator's subscription.
- **The errand model defaults to `gpt-6.1-sol` through the ChatGPT/Codex subscription**, the model the probe verified.
  - Any model that can call functions and read images in tool results may be chosen, but only the default is verified for v1.
  - `gpt-6.1-sol` is not yet in GoatCitadel's model list for the subscription provider; add it.

## What the probe proved (2026-10-31)

A throwaway script (not in the repository) used GoatCitadel's own Codex subscription login and drove a local test page in Playwright. Results:

- **OpenAI's native `computer` tool does not work on the subscription.** The standard `tools` field returns HTTP 400 `Unsupported tool type: computer`. GoatCitadel's "lite" mode (tools sent in an `additional_tools` input item with the `x-openai-internal-codex-responses-lite` header) silently drops it.
- **A function tool named `computer` that mirrors OpenAI's action schema works.**
  - Schema: `actions: [{ type: click | double_click | drag | move | scroll | keypress | type | wait | screenshot, x, y, button, text, keys, scroll_x, scroll_y, path }]`.
  - The screenshot goes back as an `input_image` part inside `function_call_output`.
  - `gpt-6.1-sol` clicked a text box, typed, and clicked Submit in one batch. On the next request it read the result off the new screenshot. Two requests in total.
- **Continuation:** the subscription runs with `store: false`, so `previous_response_id` is not available. Replaying the earlier `function_call` and `function_call_output` items (without item ids) works.
- **Lite mode** requires `reasoning.context: "all_turns"`.
- **The model fills every schema field**, using empty strings, zeros, and `[]` for fields an action doesn't use. The action runner must ignore fields irrelevant to the action type.
- **Coordinates** are in the pixel space of the screenshot sent. If screenshots are scaled, the runner must map coordinates back.

Every step sends a full screenshot, which counts against the operator's subscription usage.

Relevant code today:

- `apps/gateway/src/services/llm-service.ts`:
  - Tool results map to `function_call_output` through `normalizeToolOutputContent`, which already passes array content through `mapOpenAiResponsesContent`.
  - Subscription detection and lite mode: `isOpenAICodexResponsesProvider`, `usesOpenAICodexResponsesLite`, `applyOpenAICodexResponsesLiteHeader`.
  - The response parser handles `function_call`, `message`, and `image_generation_call`.
- `apps/gateway/src/services/openai-codex-oauth-service.ts` holds the subscription login.

## Approval integrity

These are hard requirements; the mechanism is the builder's call.

- **A real person resolves every approval.** The approval is a Gateway approval (the existing approval lifecycle), never a flag the errand loop sets itself.
- **While a request is pending, the errand loop dispatches no browser actions.** The model therefore cannot click the card, and a prompt-injected page cannot make it try.
- **Screenshots sent to the model never include GoatCitadel's own overlay:** no banner, cursor, card, or dimming. The model sees the page as it is. The spotlight screenshot (with overlay) is only for people.
- **The page cannot reach the card.**
  - Page script cannot read it, restyle it, remove it, place something over it, or call whatever the card uses to report Approve.
  - In particular, a function the page can call (such as a Playwright binding on `window`) must not be able to approve.
  - An approval from the window must come from a real input event by the operator.
  - Options the builder may weigh:
    - a GoatCitadel-owned window positioned over the browser at the cursor;
    - a GoatCitadel browser extension's own UI;
    - an in-page overlay whose events are verified as trusted and whose report channel the page cannot call.
  - Pick one and say why.
- **Re-check before acting.** After approval, before acting, re-check that the page is still the one that was approved: same URL origin, and the target element still under the point. "A page can navigate or change focus while a person decides" (OpenAI computer-use guidance). If it changed, ask again; never click blind.
- **Classifying risky actions cannot rest only on the acting model's own word.** The model may declare that an action is risky, but GoatCitadel must also check independently. Examples:
  - the target's visible text and role ("Place your order", "Buy now", "Pay", "Send", "Delete", "Confirm", "Save changes");
  - form submits on checkout, payment, messaging, or settings pages;
  - a second classifier pass on the spotlight screenshot.
  
  When unsure, ask. The exact heuristics are the builder's call. They need tests that include a hostile page whose text tries to talk the model out of asking.
- **Sign-in protection.** The errand never clicks into password fields or one-time-code fields, and never interacts with password-manager UI. Reaching one means handing over to the operator.

The existing guardrails in `apps/gateway/src/browser-runtime-guardrails.ts` (`evaluateComputerUseSafety`, `evaluateDeploymentProfileToolAccess`) are written for `browser.interact` steps. The new errand tool needs its own registration in the tool catalog and policy, with deny-wins kept. On `remote_hardened` it is refused outright.

## The browser

- **Headed, long-lived, persistent profile.** Today's per-call headless launch (`withBrowserPage` in `packages/policy-engine/src/browser-tools.ts`) cannot carry an errand.
  - An errand needs one visible browser that stays open across steps, with a persistent profile under GoatCitadel's data directory.
  - The `BROWSER_CHROMIUM_SECURITY_ARGS` WebRTC policy stays.
- **LastPass has to work.** The builder must confirm this early, before building on top of it. The proposed route:
  - Launch the operator's installed Google Chrome (Playwright `channel: "chrome"`) with a dedicated user-data directory.
  - The operator installs LastPass from the Chrome Web Store into that profile once.
  - Recent Chrome versions ignore command-line extension loading, so a Web Store install is the expected path.
  - If installed Chrome can't be driven this way, report back before choosing another route.
- **Network.** Errands browse the public web the way Chat's full-web-access mode does: the network allowlist plus `*`, through the existing egress proxy. Private, LAN, loopback, and metadata addresses stay blocked, as they are today. Whether an errand needs the operator's per-turn full-web toggle, or errands imply it, is left to the builder. Prefer not adding a second prompt.
- **One errand at a time.** A second request queues or is refused with a clear message.
- **Window lifetime** after an errand ends (stay on the final page, minimize, or close) is the builder's call. The profile persists either way.

## The window experience

- Banner, Take over, Hand back, Stop, and Esc, as described above.
  - Take over pauses the errand loop, and the operator drives the window.
  - Hand back resumes it with a fresh screenshot.
  - Stop ends the errand. Chat gets a truthful result: what was done and what was not.
- **Cursor:** a cyan GoatCitadel arrow with a short fading trail that glides between targets, so a person can follow it. Honor `prefers-reduced-motion`.
- **Spotlight approval:** as described above. Colors follow `DESIGN.md` (cyan accent only; status colors mean status).
- **Mockup:** the brainstorm mockup the operator reacted to showed a banner on the dark navy mark color, a cyan window frame, the cursor with a "GoatCitadel" tag, and three card styles; the operator chose B, spotlight. The builder should rebuild the look from `DESIGN.md` tokens, not from the mockup's raw colors.

## Chat

- Chat shows a running errand as a tool card with live state (current step text, latest screenshot thumbnail) and the same Stop.
- A pending approval appears in place in Chat and is approvable in one click (the operator's standing preference: approvals pop up in place, details on demand, at most one click, auto-apply after).
- The final result is the answer plus the final screenshot. The step log stays collapsible.

## Channels

Starting an errand:

- An errand can start from a channel conversation, the same way any Chat turn can.
- Its final answer and screenshot reply in that conversation.
- The window still opens on the PC.

Where approvals go (the operator's decision, "window first, then out"):

- **Errand started from a channel conversation:** the approval goes to that conversation right away, as well as to the window and Chat.
- **Errand started at the PC (Chat in Mission Control):** the approval shows in the window and Chat first. If it is still unanswered after 30 seconds, it also goes to the phone and to one channel conversation the operator picks for errand approvals, set once in Settings next to the "Browser errands" switch.
- **Errand started from the phone:** the approval goes to the phone right away, as well as to the window and Chat.

Today approvals reach channels only when an operator issues a one-time action token by hand (`POST /api/v1/approvals/:approvalId/remote-token`, operator-only). Nothing calls it on its own. Errand approvals need a server-side path that:

- issues those tokens automatically for the targets above;
- uses the same token custody (keychain reference, expiry);
- revokes the outstanding tokens when the approval is resolved anywhere.

Approval delivery:

- Approvals go out through the existing connector delivery path (`apps/gateway/src/services/approval-connector-delivery.ts`). The errand approval needs its own message format: the spotlight screenshot plus one plain line, not the ID-heavy text `buildIntegrationApprovalDeliveryMessage` produces today.
- Channel messages already support image attachments (`apps/gateway/src/services/connector-delivery.ts`).
- Channels with inline actions already get Approve and Deny buttons through `interactiveActionTemplate`.

Text replies:

- A `/approve <approval-id>` chat command exists (`apps/gateway/src/services/chat-command-service.ts`). Discord buttons use it behind the scenes.
- The `APPROVE` / `DENY` / `STOP` replies are new. They resolve the errand's latest pending request in that conversation, from the operator's paired identity only.

Privacy:

- A screenshot can show an address, an order, or account details.
- Errand approval screenshots go only to the operator's own approval delivery targets.
- If a target is a group conversation, the builder should flag it in setup or send text only. This is the builder's call; mention what was chosen.

## Phone

The operator decided the phone must be able to **approve** errands, not just see and deny them.

What exists today:

- A push says an approval is waiting, and the paired phone loads it (`apps/gateway/src/services/mobile-push-service.ts`, `apps/gateway/src/routes/mobile.ts`).
- A paired phone can review and reject, but `POST /api/v1/approvals/:approvalId/resolve` refuses approve and edit from a companion (`apps/gateway/src/routes/approvals.ts`).
- Device approval keys exist but are switched off ("production-dark"):
  - `apps/gateway/src/services/mobile-approval-key-service.ts` registers an Ed25519 key per device grant and can verify a signed decision.
  - It always reports verification as "unavailable".
  - It leaves single-use nonce (replay) protection to the approvals route.
  - Its own note says the switch waits on the phone app's device-authentication release proof.

This work:

- **Wires signed phone approvals into the approvals route.** A companion approve or edit is accepted only with a valid signature from the grant's active key over the decision contract (`goatcitadel.mobile-approval-decision.v1`). Each nonce is accepted once, signature-time skew is checked, and every failure closes.
- **Tests the route with a test signer.** These tests cover replay, a stale timestamp, a revoked key, and the wrong approval.
- **Leaves the capability switched off in shipped builds** until the phone app's matching release passes its device proof. That flip is a separate, small change, recorded as a follow-up.
- **Puts the errand's spotlight screenshot and plain line on the approval the phone loads.**

The phone app's code is not in this repository. Until its update ships, the phone shows errand approvals and can deny or stop them, and approving happens in the window, Chat, or a channel. The doc and the Settings text must say so plainly.

## Accepted risks

The operator accepted these for v1. They must be written down where the operator will see them: in the "Browser errands" Settings text and in the `docs/DESKTOP_AUTOMATION_SAFETY.md` section.

- **Data leaving through ordinary browsing.** Reading, opening pages, and typing into search boxes never ask. The whole public web is reachable, and the browser profile holds real logins. A hostile page can try to get the model to read private data and carry it to another site by opening a URL or filling a form, and none of the four ask-first categories catches that. The operator chose to browse freely rather than ask before each new site. Mitigations that stay in place:
  - private and LAN addresses are blocked;
  - the overlay is kept out of model screenshots;
  - the window is visible;
  - there is an audit trail of visited URLs.
- **Accounts flagged as automated.** Sites such as Amazon may notice an automated browser and flag or limit the account, and their terms discourage robots. The operator accepted that risk on their own accounts.
  - GoatCitadel does not hide that the browser is automated: no fingerprint spoofing or stealth plugins.
  - Bot checks and captchas always go to the operator.

## Limits

These are the builder's starting values; adjust with reason:

- At most 60 model steps per errand.
- At most 20 minutes of wall time, not counting time waiting on the operator.
- An unanswered approval expires after 10 minutes. The errand then stops and says so.
- The Chat card shows the step count, and the result reports how many model requests were used, since each one costs subscription usage.

## Relationship to earlier work

- `docs/review/HX_416_GOVERNED_NATIVE_DESKTOP_COMPUTER_USE_PACKET_2026-07-16.md`, on the unmerged branch `codex/hx416-computer-use-architecture-20260716`, froze a native Windows desktop design. In that design every capture and every action needs its own approval.
- For browser errands, this document replaces that approval model with the operator's: ask only before spending, sending, deleting, or changing settings.
- The packet stays parked as input for project 3, where the operator will decide again.
- `open-computer-use` (github.com/iFurySt/open-computer-use, MIT) is an open-source Codex-style computer-use MCP server for macOS, Linux and Windows. Its Windows runtime uses UI Automation. For project 3 it is prior art worth studying:
  - an accessibility tree with element-index actions beside screenshots;
  - failing closed on hidden, minimized, occluded or off-screen windows;
  - a built-in password-manager denylist;
  - an explicit opt-in before moving the real pointer.
- For browser errands it contributes:
  - the cursor motion model (Bezier + arc + spring);
  - the rule never to act on a screenshot of a hidden window. A minimized errand window is restored before capture.
- Its sibling `open-browser-use` drives real Chrome through an extension plus native host. That is the fallback if the persistent-profile route can't support LastPass.
- `docs/DESKTOP_AUTOMATION_SAFETY.md` covers desktop automation and says arbitrary coordinate automation is not an acceptable default. Browser errands meet it like this:
  - **Explicit operator session:** errands are off until the operator turns them on, and each one starts from the operator's request.
  - **Allowlisted applications and actions:** one application only, GoatCitadel's own browser window. Within it, the operator's ask-first categories decide which actions need approval.
  - **Visible screen and cursor:** the banner and the GoatCitadel cursor.
  - **Approval-gated side effects:** spending, sending, deleting, and changing settings.
  - **Durable before/after audit:** for every approved action, the spotlight screenshot before and a screenshot after are kept with the approval record.
  - **Immediate stop:** Stop, Esc, and `STOP`.
  - **Gateway enforcement:** policy, deny-wins, and the network rules.
- The builder adds a "Browser errands" section to that document saying exactly this. The document stays true for desktop automation, which is project 3.

## Constraints

- The Gateway owns the errand loop, approvals, policy, and evidence. Mission Control is a client. Durable execution owns the Chat turn that starts the errand. Approval-gated waits re-enter durable execution, never only UI state.
- No new runtime dependency unless it is truly needed. Playwright 1.58.2 is already in `@goatcitadel/policy-engine`.
- Keep `gateway-service.ts` under its line limit by extracting code. Do not add architecture allowances, and never run `architecture:baseline:update`.
- Windows is the primary platform. Errands must work on the operator's Windows 11 PC.
- Durable evidence per errand:
  - who started it;
  - each approval and its resolution (where, by whom);
  - the URLs visited;
  - for approved actions, the before (spotlight) and after screenshots, kept with the approval record.
  
  Step screenshots sent to the model are not stored durably.

## Left to the builder

- How the approval card is drawn and how it reports Approve, within "Approval integrity".
- The risky-action classifier details and its tests.
- Tool names, the errand runner's shape, and how it plugs into durable execution and the Chat turn.
- Screenshot size and scaling, and coordinate mapping.
- Window lifetime after an errand.
- Whether errands imply full-web access or reuse the per-turn toggle.
- How to show group-channel privacy.
- The automated test plan, which must at least cover:
  - the local test page errand;
  - an approval resolved from each surface (window, Chat, a button channel, an `APPROVE` reply, a signed phone decision from a test signer);
  - the 30-second hand-off from the window to the phone and channel;
  - a lowercase "approve" being refused;
  - an `APPROVE` from a paired account that isn't the owner being refused;
  - a replayed or stale phone signature being refused;
  - a hostile page that tries to fake or trigger approval, or to talk the model out of asking;
  - the sign-in handoff;
  - Stop and Esc.
- The live Codex usage check with the operator, as the acceptance test.
