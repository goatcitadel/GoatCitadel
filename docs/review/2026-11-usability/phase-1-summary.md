# Phase 1 close-out summary

We re-tested 460 findings from the earlier reviews. 301 are fixed. 113 are still open or partly open (37 open, 76 partly open). 26 need you, because they require a real account, device or installed app. 14 could not be checked here. 6 are obsolete because the screen or feature no longer exists. 109 findings carry forward into the new review (0 blocker, 4 stall, 30 friction, 75 polish).

## How to read this

- **Ids.** Each earlier finding keeps its original id. `OL-…` is a live check that an earlier merged change still owed. `PR-…` is an old Classic screen that was checked for an equivalent in the Cockpit. Ids ending `~fu206` are rows from the older 206-finding audit. `U-…` is a finding carried into this review.
- **Phase 2** is the fresh, area-by-area review that follows this close-out.
- **Task N** in a note is a later step of this same review.
- **The controller** is the agent that coordinates the review.

## Verdicts by source

| Source | fixed | open | partial | operator-only | cannot-check | obsolete | Total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| comprehensive-138 | 82 | 0 | 1 | 1 | 1 | 0 | 85 |
| comprehensive-138 + followup-157 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| followup-157 | 22 | 19 | 24 | 0 | 3 | 0 | 68 |
| ledger-233 | 160 | 16 | 43 | 0 | 8 | 5 | 232 |
| ledger-233 + owed-live | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| owed-live | 4 | 1 | 2 | 25 | 2 | 0 | 34 |
| parity-routes | 31 | 1 | 6 | 0 | 0 | 1 | 39 |
| Total | 301 | 37 | 76 | 26 | 14 | 6 | 460 |

## Verdicts by area

| Area | fixed | open | partial | operator-only | cannot-check | obsolete | Total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chat | 92 | 7 | 11 | 4 | 2 | 0 | 116 |
| inbox | 16 | 1 | 4 | 0 | 0 | 0 | 21 |
| work | 13 | 2 | 7 | 0 | 0 | 0 | 22 |
| capabilities | 14 | 1 | 1 | 2 | 0 | 0 | 18 |
| library | 14 | 0 | 6 | 0 | 0 | 0 | 20 |
| system | 17 | 1 | 5 | 0 | 2 | 1 | 26 |
| settings | 61 | 7 | 13 | 3 | 1 | 1 | 86 |
| first-run | 11 | 1 | 1 | 1 | 1 | 0 | 15 |
| messaging | 6 | 0 | 0 | 10 | 0 | 0 | 16 |
| global | 57 | 17 | 28 | 6 | 8 | 4 | 120 |
| Total | 301 | 37 | 76 | 26 | 14 | 6 | 460 |

## Carried findings

109 findings carry forward into the new review. Counts by area and severity:

| Area | blocker | stall | friction | polish | Total |
| --- | --- | --- | --- | --- | --- |
| chat | 0 | 0 | 2 | 15 | 17 |
| inbox | 0 | 0 | 3 | 3 | 6 |
| work | 0 | 1 | 4 | 5 | 10 |
| capabilities | 0 | 0 | 3 | 0 | 3 |
| library | 0 | 0 | 3 | 4 | 7 |
| system | 0 | 0 | 4 | 2 | 6 |
| settings | 0 | 2 | 4 | 12 | 18 |
| first-run | 0 | 1 | 1 | 0 | 2 |
| global | 0 | 0 | 6 | 34 | 40 |
| Total | 0 | 4 | 30 | 75 | 109 |

### Every blocker and stall

| Id | Severity | Title | Earlier ids | Trigger |
| --- | --- | --- | --- | --- |
| U-WK-001 | stall | Work cannot record a task deliverable, so a manual task cannot be marked done there | PR-cowork-tasks | In Work, open a manual task with no deliverable and try to set it Done. |
| U-ST-001 | stall | With any workspace but 'default' selected, a Settings change cannot be approved where it was made | OL-16 | Select a workspace other than 'default'; Settings › Models › Providers & models; switch 'Keep one Claude Code process between tool steps' off; Save setting. |
| U-ST-008 | stall | A notification webhook needs a keychain reference that nothing in the app creates | ST-26 | Settings › General › Notification routing › New destination › Destination kind: Keychain HTTPS webhook. |
| U-FR-001 | stall | After one save with a lost response, the approval rule cannot be saved again, and first-run Finish stays disabled, until the page is reloaded | FR-02 | In Settings or Get started, save an approval rule while the response is lost (connection drops after the request is sent). Then try to save again or press Refresh checks. |

### Friction findings by area

#### chat

| Id | Title | Earlier ids | Trigger |
| --- | --- | --- | --- |
| U-CH-002 | At 1024px wide the Chat transcript is squeezed to about 536px by the side navigation and the conversations rail | CH-25 | Open /chat in a 1024x768 window |
| U-CH-012 | Revert-all in the build editor does not say how many files go or that it cannot be undone | CH-N12 | Open a Code Mode run's build editor and choose Revert all. |

#### inbox

| Id | Title | Earlier ids | Trigger |
| --- | --- | --- | --- |
| U-IN-001 | An Inbox row for a shell approval does not say what it would run | IN-04 | Open Inbox with a pending shell approval ('Review shell exec'). |
| U-IN-003 | The Inbox recovery dialog tells the operator to review the run but shows no run, attempts or effects | IN-N06 | Inbox > a failed or stopped run > Retry run / Recover run. |
| U-IN-006 | The Inbox item you open is not in the URL, so Back, reload and sharing lose it | GL-20 | Open /inbox, press Review on the pending approval, then reload or copy the address. |

#### work

| Id | Title | Earlier ids | Trigger |
| --- | --- | --- | --- |
| U-WK-003 | The Work board still puts tasks and runs in the same run-status lanes, so a task's lane does not match its own state | WK-01 | Work > Board with tasks in Planning, In progress, Blocked and In review plus waiting Chat runs. |
| U-WK-004 | A run page still ends in a stack of evidence panels, with the recorded errors list at the bottom | WK-05 | Work > Board > open a waiting 'Chat turn' run. |
| U-WK-005 | A task page can say 'Review its run' without giving a link to that run | WK-07 | Work > Board > open 'Capture prompt-pack quality posture'. |
| U-WK-010 | Pausing or resuming a schedule, and archiving or restoring a task, each need a review dialog | WK-N11 | Work > Schedules > Review schedule > Pause; Work > Archived tasks > Review archive. |

#### capabilities

| Id | Title | Earlier ids | Trigger |
| --- | --- | --- | --- |
| U-CP-001 | A plugin skill that fails its check says only that it failed, not why or what to fix | OL-31 | Capabilities › Plugins › Add from folder with a plugin whose skill has no front matter; press Check. |
| U-CP-002 | A plugin with a repeated piece id is refused without saying which id | OL-35 | Capabilities › Plugins › Add from folder with a manifest whose two pieces both have id skill-2; press Check. |
| U-CP-003 | 'Change this workspace's skills' and 'Change workspace capabilities' open a page that says it is unavailable | PR-settings-workspace-capabilities | A skill shown as 'Left out of this workspace', or a connector the workspace hides: press the link in its panel (Capabilities › Skills or Connectors). Opened live at /settings/citadel#workspace-capabilities. |

#### library

| Id | Title | Earlier ids | Trigger |
| --- | --- | --- | --- |
| U-LB-002 | Text fields in Library notes, files, mail, journey and knowledge forms have borders too faint to see (1.5 to 1.9 to 1) | GL-N02 | Open Library › Notes (new note), Files (upload), Mail (compose), Knowledge (add source) and look at the input outlines. |
| U-LB-003 | Memory search needs an 'Apply memory filter' click while every other Library list filters as you type | LB-08 | Library › Memory: type in Search memory. |
| U-LB-005 | Skill scenario, baseline and improvement runs and the Skill Hub panel from Classic's Library › Skills have no Cockpit screen or Classic link | PR-library-skills | Open /library/skills in the Cockpit and look for Generate scenarios, Run baseline, Run improvement or Skill Hub. |

#### system

| Id | Title | Earlier ids | Trigger |
| --- | --- | --- | --- |
| U-SY-002 | On a healthy fresh install, System > Health says '1 check needs attention' because service control is unsupported | N-12 | Open System > Health on a source or dev-run install where the Gateway reports daemonStatus.supported=false (the sandbox). |
| U-SY-003 | The board editor's 'Preview live widgets' does not show the layout you are arranging | SY-08 | System > Dashboards > New board > Add widgets, set positions with Adjust + Apply, then 'Preview live widgets'. |
| U-SY-004 | A failed load on System pages looks like an empty page: no error tone, icon or alert announcement | SY-10 | Make a System read fail (for example stop the Gateway's events route), then open System > Activity. |
| U-SY-006 | System > Quality opens with four stacked server-written caveats in developer words, on every tab | SY-N06, SY-06 | Open System > Quality, then switch between Gates, Evaluations and Design. |

#### settings

| Id | Title | Earlier ids | Trigger |
| --- | --- | --- | --- |
| U-ST-002 | Advanced provider configuration offers three more provider choosers under the guided setup's own provider picker | ST-07, ST-01~fu206 | Settings › Models › Providers & models › Advanced provider configuration. |
| U-ST-005 | The provider change-plan dialog's main action looks the same as Cancel | ST-15 | Settings › Models › Providers & models; start a change that opens the review dialog (it uses the shared ChatChangePlanActionDialog). |
| U-ST-010 | Models shows two different step lists for the same setup, with different names and states | ST-N03 | Settings › Models › Get started, then Providers & models. |
| U-ST-011 | Switching an integration on or off needs a modal with a paragraph of text | ST-N09 | Capabilities › Connectors › Advanced setup › Integrations › Review enable on a saved integration. |

#### first-run

| Id | Title | Earlier ids | Trigger |
| --- | --- | --- | --- |
| U-FR-002 | The 'Access' link in Diagnostics' Ecosystem proof lanes opens a 'Settings destination unavailable' page | FR-06 | Open System > Diagnostics, expand 'Ecosystem proof lanes', choose the 'Access' link. |

#### global

| Id | Title | Earlier ids | Trigger |
| --- | --- | --- | --- |
| U-GL-001 | In Windows high-contrast (forced colors) the primary button loses its outline and reads as plain text | GL-05 | Turn on forced colors (Windows high contrast, or Playwright forcedColors) and open Work: 'New task' is the only header action with no border. With a run queued, the sidebar Work dot (filled, no border) also disappears. |
| U-GL-006 | On a phone, the 'Advanced setup' link on Capabilities is only 17 px tall | GL-16 | At 375 px wide with touch, open Capabilities > Connectors and measure 'Advanced setup'. |
| U-GL-025 | Switching area by keyboard or sidebar gives a screen-reader user no sign that the page changed | NV-05 | Open Inbox, press g then w (or click Work in the sidebar). Read document.activeElement and the live regions. |
| U-GL-027 | On a phone or tablet the page never shows which workspace you are acting in | NV-11 | Open /chat at 375 px or 820 px wide with the sandbox workspace. Read the visible text, then tap More (phone). |
| U-GL-034 | Internal words (durable run, projection, canonical, replay, authority) still appear as ordinary text on System and Library pages | GL-L02, GL-07~fu206 | Open System › Activity, System › Quality, System › Dashboards, System › Diagnostics, Settings › Advanced, Library › Journey and Library › Prompt packs. |
| U-GL-045 | The linked-scope banner does not say which workspace or Citadel the link asks for and cannot be dismissed | SH-N12 | Open any Cockpit link that carries a workspaceId or citadelId different from the active one. |

## Where open rows cluster

| Area | Open + partly open | Rows in area | Share of area |
| --- | --- | --- | --- |
| global | 45 | 120 | 37.5% |
| settings | 20 | 86 | 23.3% |
| chat | 18 | 116 | 15.5% |
| work | 9 | 22 | 40.9% |
| library | 6 | 20 | 30.0% |
| system | 6 | 26 | 23.1% |
| inbox | 5 | 21 | 23.8% |
| capabilities | 2 | 18 | 11.1% |
| first-run | 2 | 15 | 13.3% |
| messaging | 0 | 16 | 0.0% |

Most open and partly open rows sit in global (45), settings (20) and chat (18). Measured as a share of its own rows, work is highest (9 of 22, 40.9%). Phase 2 spends more time in these areas.

## For you to check

26 rows need a real account, device or installed app. These notes were written by the review agents, quoted unchanged, and "I" is the agent that tested the row in the sandbox. Each note says what was already checked in the sandbox and what is left for you; a polished checklist comes in the final report.

### chat

**Real models: cloud model with tools, reasoning model with thinking stream (PERF-01 re-test), local llama.cpp with two idle tabs** (OL-04)

Needs real models. Steps: (1) in Chat pick a cloud model with tools, ask it to run a tool, and confirm the approval and run cards show action, scope and result; (2) pick a reasoning model with thinking on and watch the thinking stream, then record frame times in the browser Performance panel (pass: frames under 50 ms); (3) with a local llama.cpp model, leave two idle Chat tabs for 3 minutes and count requests in Network (pass: 6 or fewer per minute per tab).

**Review answer in Chat: the Reviewing the answer status and the answer-review result are visible and correct** (OL-12)

Sandbox with the stub: Review answer toggled in the + panel shows a 'Review answer' pill, and the live region announced 'Reviewing the answer.' while the turn ran; afterwards the answer line read 'Review unavailable' (the stub cannot review). A readable verdict needs a real model. Steps: turn on Review answer, send a question that has a checkable fact, watch for 'Reviewing the answer' while it runs, then confirm a readable review result under the answer. Pass: status shows while running and the result states agree or concerns in plain words.

**Deep research document truncation (#682): a generated document that is cut says so on screen** (OL-13)

Needs a real model to write an oversized document. Steps: ask Chat for a document with a body above 12000 characters, or a section above 2000, saved as pdf or docx. Pass: the answer says text was cut (the tool result carries 'Some text is missing from the document: Cut 1 body to 12000 characters.') and the artifact shows the same notice. Code note: git grep finds no cockpit component that shows tool-result warnings or designReport.residualRisks directly, so the notice depends on the model relaying it; if it does not, record a finding.

**Code Mode PDF in a turn: a PDF produced by a Code Mode run appears in the Chat turn** (OL-15)

Needs a real model and a Code Mode approval. Steps: in Chat ask for a PDF made by running code, approve the Code Mode request card once, wait for the run. Pass: the turn shows the PDF file and its artifact record (Library > Artifacts) and 'Open run in Work' opens the run.

### capabilities

**Native skill import in Chat: the use <name> grammar installs or selects a skill from Chat** (OL-14)

Needs a real model reply, so it was not run here (the bundled skills themselves are present: skills/bundled/ponytail/SKILL.md). Steps:

1. Open Library › Skills and confirm 'ponytail' and 'debugging' are listed as bundled and on.
2. In Chat with a real model, send 'use ponytail' and, in a second message, 'use impeccable critique this page'.
3. Send an unrelated message that only contains a common word, such as 'keep this small'. Pass: after step 2 the reply or the turn's skill chip names the skill it loaded and what it did; after step 3 no explicit-only skill is loaded.

**Vendor MCP connector: add and use a vendor MCP connector from Capabilities** (OL-18)

Checked here: Capabilities › Connectors lists 78 available vendor connectors; opening Atlassian shows what it lets GoatCitadel do, 'Signs in at mcp.atlassian.com', 'Installing makes sure mcp.atlassian.com is on your network allowlist', 'Reads run on their own. Anything that creates or changes something asks you first', and the button 'Sign in and install'. I did not press it (it signs in at the vendor). Operator steps:

1. Capabilities › Connectors, press Install on a vendor you have an account with.
2. Press 'Sign in and install' and finish the vendor's sign-in in the browser window.
3. Return: the row reads Connected.
4. In Chat ask for something only that vendor can answer. Pass: the connector shows Connected, Chat calls one of its tools and shows it, and a tool that changes something asks for approval first.

### settings

**Windows embedded Google consent action could not open the sign-in page** (DESKTOP-008)

Needs the installed Windows desktop app and a Google account. Steps: open the desktop app, Capabilities › Connectors › Advanced setup › Integrations, open the saved Google connection, choose 'Open Google setup in browser' (code: GoogleWorkspaceSignIn.tsx opens it in a new window and MainWindow.xaml.cs:220 hands it to the default browser). Pass: your default browser opens the page, you finish Google consent there, return to the app, 'Refresh sign-in status' shows Connected, and Disconnect still works.

**Firecrawl base URL and allowlist in Settings: save, probe and use from Chat** (OL-17)

Needs the LAN Firecrawl server and a real Chat model; I did not change the network allowlist (a security setting) in the sandbox. Steps: Capabilities › Connectors › Advanced setup › Web & Search; set Self-hosted base URL to the LAN Firecrawl address, add its host to the allowlist if asked (approve), Save Firecrawl, then Test connection; then in Chat (Web access on) ask a question that needs a web page. Pass: the save is confirmed, the test says Reachable (or says plainly why not), and the Chat answer's source is the configured Firecrawl. Code check: the key is only stored after a passing check (web-search-credential-service.ts:185).

**Google desktop-app sign-in: sign in to Google Workspace from the desktop app** (OL-19)

Needs the installed Windows desktop app, a Google client ID in the connection and a real Google account. Steps: as for DESKTOP-008, then check the connection card. Pass: the consent action opens the sign-in page in your browser, the connection shows Connected after you return and refresh, and Disconnect returns it to not connected.

### first-run

**Packaged Windows app and macOS input: dark cold start, shortcuts, Japanese-input Enter, Gateway-stop banner hint** (OL-05)

Steps (verification-gaps check 9): install the latest release-installers build on Windows (note the installed version first).

1. Start the app in the dark theme and watch for any light flash.
2. Press Ctrl+K, Ctrl+1 to Ctrl+5 and Ctrl+B in the composer and outside it.
3. In the Chat composer with the Japanese input method, confirm a conversion with Enter.
4. Stop the Gateway from the tray or service controls and read the banner's hint. Repeat step 3 with the macOS Japanese input method on a Mac. Pass: no light flash, each shortcut acts once, the conversion Enter does not send, and the banner names a next step.

### messaging

**Discord channel end to end: connect, send a test message, receive and answer one** (OL-20)

Checked here (sandbox, no account): Chat › Messaging › Add › Discord opens a 4-5 step page (make the bot in the Developer Portal, paste the token, invite it, choose where it posts, say hi, turn on). A made-up token 'test-invalid-token' was refused with 'Discord didn't accept that token, or GoatCitadel couldn't reach Discord. Check the token and try again.' in about 6 s; Start over deleted the draft (saved drafts 0, connections 0 afterwards). Left to the operator, with a real Discord account:

1. Chat › Messaging › Add › Discord.
2. Make a bot in the Developer Portal and paste its token, Check token.
3. Use the invite link, choose where it may post.
4. Say hi to the bot in Discord.
5. Turn it on, send the test message, reply from Discord. Pass: the token check names the bot, hi arrives, the test message lands in Discord, a Discord reply is answered in Chat.

**Slack channel end to end: connect, send a test message, receive and answer one** (OL-21)

Checked here (sandbox, no account): Add › Slack opens 'Make your Slack app' (a link that opens Slack with the app settings filled in), 'Install it and copy two tokens' (Bot token and App-level token), then posting, say hi and turn on. Two made-up tokens were refused with 'Slack didn't accept the bot token, or GoatCitadel couldn't reach Slack. Check it and try again.' (about 6 s); Start over left no draft. Left to the operator, with a real Slack account:

1. Add › Slack, press 'Create the Slack app', choose your workspace, Create.
2. Install it and paste both tokens, Check tokens.
3. Choose the channel it posts in.
4. Say hi.
5. Turn on, send the test message, answer in Slack. Pass: both tokens are accepted, the app says hi back, the test message appears in Slack and a Slack reply is answered.

**Telegram channel end to end: connect, send a test message, receive and answer one** (OL-22)

Checked here (sandbox, no account): Add › Telegram opens 'Make your bot' (QR code and Open BotFather link, 4 steps), 'Paste your bot's key', 'Say hi to your bot', 'Turn it on'. The made-up key was refused with 'Telegram didn't accept that key, or GoatCitadel couldn't reach Telegram. Check the key and try again.' (about 6 s), steps 3 and 4 stayed locked, and Start over deleted the draft. Left to the operator, with a real Telegram account:

1. Add › Telegram, make a bot with BotFather (/newbot) and copy its key.
2. Paste it, Check key.
3. Say hi to the bot in Telegram.
4. Turn it on, send the test message, reply from Telegram. Pass: the key check names your bot, hi arrives, the test message lands in Telegram and your reply is answered in Chat.

**Google Chat channel end to end: connect, send a test message, receive and answer one** (OL-23)

Checked here (sandbox, no account): Add › Google Chat goes to Advanced channel setup with Google Chat preselected ('Google Chat app and webhook integration. intermediate, about 10 minutes') and 'Start guided setup' opened the guided wizard (a saved draft was created; I deleted it with 'Delete saved draft', drafts 0 afterwards). No credentials were entered. Left to the operator, with a real Google Chat account:

1. Set the public web address (receiving needs one).
2. Add › Google Chat › Start guided setup and follow the steps with your Google Cloud app.
3. Validate, run the live test, finish.
4. Send a message in Google Chat. Pass: the live test passes, the connection turns on, the message is answered.

**Teams channel end to end: connect, send a test message, receive and answer one** (OL-24)

Checked here (sandbox, no account): Add › Microsoft Teams goes to Advanced channel setup ('Send Adaptive Card notifications to a Teams channel through a Workflows webhook. Sends only. beginner, about 6 minutes'); 'Start guided setup' creates a saved draft (deleted afterwards, drafts 0). No webhook was entered. Left to the operator, with a real Microsoft Teams account:

1. Create a Workflows webhook in Teams.
2. Start guided setup, paste the webhook address, validate.
3. Run the live test. Pass: the test card appears in the Teams channel (Teams is send-only, so no reply is expected).

**WhatsApp (Cloud API) channel end to end: connect, send a test message, receive and answer one** (OL-25)

Checked here (sandbox, no account): Add › WhatsApp opens a guided page: 1 'Give GoatCitadel a public web address' (https only, Save address / Clear), 2 'Make your Meta app' (Phone number ID, WhatsApp Business Account ID, App ID and secret), then the later steps. I did not save a web address or enter any value. Left to the operator, with a real WhatsApp account:

1. Save your public https address.
2. Make the Meta app and paste its ids and secret.
3. Register GoatCitadel's webhook address in Meta.
4. Say hi from WhatsApp, turn it on, send the test message. Pass: Meta verifies the webhook, hi arrives, the test message is delivered and a WhatsApp reply is answered.

**LINE channel end to end: connect, send a test message, receive and answer one** (OL-26)

Checked here (sandbox, no account): Add › LINE goes to Advanced channel setup with LINE preselected ('LINE Messaging API integration. intermediate, about 6 minutes'; picker note: receiving needs a public web address). I read the entry page only; the wizard was not started for LINE. Left to the operator, with a real LINE account:

1. Save the public web address.
2. Start guided setup, paste the channel secret and access token.
3. Set the webhook address in the LINE console.
4. Run the live test, send a message from LINE. Pass: the live test passes and a LINE message is answered.

**Matrix channel end to end: connect, send a test message, receive and answer one** (OL-27)

Checked here (sandbox, no account): Add › Matrix goes to Advanced channel setup; 'Start guided setup' opened a 7-step wizard (What this connection does, Make the bot account and a room, Connect the account, Choose destinations and access, Validate the draft, Finish setup, Verify the first conversation) with 'What you need' and the note that encrypted rooms are not supported. The draft it created was deleted afterwards (drafts 0). No token was entered. Left to the operator, with a real Matrix account:

1. Make a bot account and an unencrypted room, invite the bot.
2. In the wizard paste the access token, allow the homeserver host.
3. Validate, run the live test, finish.
4. Say hi in the room. Pass: the test notice arrives in the room, a message from an allowed Matrix ID is answered.

**QQBot channel end to end: connect, send a test message, receive and answer one** (OL-28)

Checked here (sandbox, no account): Add › QQBot goes to Advanced channel setup ('QQBot text sends and replies, with signed webhook inbound. advanced, about 25 minutes'; picker note: needs a public web address). Entry page read only; the wizard was not started. Left to the operator, with a real QQBot account:

1. Save the public web address.
2. Start guided setup with your QQ bot app id and secret.
3. Register the signed webhook.
4. Run the live test and send a message. Pass: the live test passes and a QQ message is answered.

**WeCom channel end to end: connect, send a test message, receive and answer one** (OL-29)

Checked here (sandbox, no account): Add › WeCom goes to Advanced channel setup ('WeCom application text sends, with encrypted callback inbound. intermediate, about 25 minutes'; picker note: receiving needs a public web address). Entry page read only; the wizard was not started. Left to the operator, with a real WeCom account:

1. Save the public web address.
2. Start guided setup with the corp id, agent id and secret.
3. Register the encrypted callback.
4. Run the live test and send a message. Pass: the live test passes and a WeCom message is answered.

### global

**Cross-browser smoke in Firefox and WebKit: every Cockpit area loads without page errors** (OL-01)

Firefox and WebKit are not installed on this PC (Playwright has Chromium only) and installing them is a download that needs operator approval. Steps:

1. pnpm exec playwright install firefox webkit.
2. Start a sandbox with pnpm testbench.
3. node scripts/verification/cross-browser-smoke.mjs --ui <UI URL>. Pass: one ok line per engine for chat, inbox, work, capabilities, library, system and settings; any FAIL is rerun in Chromium to see if it is engine-specific.

**Real browsers by hand (Firefox, Safari): send with Enter and button, Japanese-input Enter, approval review then cancel, inspector by keyboard, dark reload flash, Tab focus** (OL-02)

Needs real Firefox and Safari (Safari needs a Mac). Steps at 1440 and 390 px: send a Chat message by Enter and by the Send button; type Japanese with an IME and confirm Enter while composing does not send; open an approval review then cancel; open the inspector by keyboard; reload in dark theme and watch for a light flash; Tab through Chat, Inbox and Library checking the focus ring. Pass: every step behaves as the checklist in check 6 describes.

**Screen readers (NVDA, Narrator, VoiceOver): route changes, send and reply announcements, Inbox J/K focus, approval dialog, unsaved-changes dialog after Back** (OL-03)

Needs a screen reader (NVDA, Narrator, VoiceOver). Steps: switch areas and listen for the route announcement; send a message and a reply and listen for both; in Inbox press J and K and confirm focus and announcement follow; open an approval dialog and check focus lands in it and returns on close; edit a setting, press Back and check the unsaved-changes dialog is announced. Pass: each of the five journeys in check 7 is announced and focus never lands on a hidden element.

**Gateway outage and recovery: outage banner, Check again feedback, composer state, request rate while down, chunk-failure fallback** (OL-07)

A real outage needs the Gateway stopped, which this review may not do to the shared sandbox. I tried to emulate it in Chromium by cutting the network for 60 s; the already-open event stream stayed up, so the outage banner never appeared and the test says nothing about it (draft stayed intact). Steps: with the launcher running a Gateway you own, open Chat, type a draft, stop the Gateway process only; expect within ~15 s the banner 'GoatCitadel is unreachable. Sending is paused; your draft is kept.', press Check again and see 'Checking…' then 'Still unreachable · checked <time>', count requests in the Network tab for 30 s (about one probe every 5 s), restart the Gateway and expect the banner to clear without reload and the draft to remain. Chunk failure: block one lazy JS chunk in DevTools and open that area; expect an error with a way to reload.

**Long session: four hours with Chat and idle Inbox tabs, heap size and request rate stay flat** (OL-08)

Needs four hours of wall time, which does not fit this review. Steps: open Chat and an idle Inbox in two tabs on a sandbox, record performance.memory.usedJSHeapSize and the Network request count per minute at 0, 1, 2, 3 and 4 hours (DevTools console or a Playwright loop). Pass: heap and requests per minute stay roughly flat with no steady climb.

**Nightly UX-budgets workflow dispatched once on main and its failures classified** (OL-10)

Dispatching a GitHub Actions workflow is an action outside this PC, which the review rules forbid. Steps: gh workflow run verification-ux-budgets-nightly.yml --ref main, wait for the run, then label every non-passing scenario harness, product or environment (see checks 1 and 2 in docs/review/2026-10-cockpit-verification-gaps.md). Pass: the run completes and each failure has a class.

## Could not be checked here

- **CH-48** Hidden (retained) Chat still re-renders at idle priority on every navigation. Reason: Chat is retained in React Activity (hidden mode renders at low priority by design). Whether it still re-renders on unrelated navigation needs a React profiler run, which this read-only pass did not do.
- **CH-52** Leaving Chat and returning closes the Build editor and restarts retained streams. Reason: Chat (including its Build editor state) is retained in React Activity, which should survive leaving and returning. Whether a running stream reattaches without duplicate replay needs a live run with timing that this pass did not do.
- **GL-47** @goatcitadel/contracts lacks sideEffects:false; root imports pull zod v3 schemas. Reason: packages/contracts/package.json now has sideEffects: false, but whether the production bundle drops the unused schema graph needs a build and a bundle analysis; the sandbox is a dev server (it loads zod either way) and builds are out of scope here.
- **GL-61** Dead design-system surface: unused variants, unreachable inspector CSS, idle primitives. Reason: Needs a consumer audit of every design primitive, variant and CSS rule (including unreachable inspector CSS) with visual proof. It has no operator-visible symptom and the review is read-only, so it was not attempted.
- **GL-62** manualChunks hoists every Radix primitive into one eager chunk; slot/primitive dupes. Reason: Actual initial transfer needs a production build; the sandbox is a Vite dev server. The chunk selector was rewritten (boot-graph ownership in vite.config.ts) but a vendor-radix chunk is still produced, and whether it loads eagerly cannot be settled from the code.
- **N-04** With auth mode “none” (what the example config ships), Dashboards is a dead end and Chat logs a 403 on every open. Reason: Dashboards half is fixed: under auth none the board list loads (live), a 401/403 stops polling, disables Refresh and offers 'Review access in Settings'. The Chat-composer 403 half is the approval-mode read the controller reserved for a later classification task, so it is left unjudged here. No finding recorded from this row.
- **OL-09** First-answer baseline: time and clicks from first run to a completed first reply, stub and real provider. Reason: needs a fresh install: Task 12 covers it. The sandbox already finished onboarding, so first-run time and clicks cannot be timed here. The real-provider half is operator-only: in a second fresh sandbox, run the same journey adding a real provider key through Get started, and record time, clicks and every point where the next step was unclear.
- **OL-11** Large-data run with 1,000 records waits for a count-aware long-lists proof; System > Quality may stop at 200 stored prompt packs. Reason: Needs a 1,000-record run (CI dispatch of the nightly with long_list_count, once the proof is count-aware); the sandbox holds 2 prompt packs. Code read: System > Quality asks the Gateway for at most 200 packs and its only cap disclosure is the generic 'bounded read' sentence, with no 'showing the first 200' message. The proof's count-awareness is an engineering item.
- **PERF-COCKPIT-001** Production Cockpit exceeds both cold startup budgets. Reason: Cold-start request count and gzip bytes are production-build measurements; the sandbox is a Vite dev server, so no valid number can be taken and the code does not settle it. To check later: run scripts/verification/lib/scenarios/cockpit-performance-proof.mjs (via its verification lane) against a production build and compare with 20 startup requests and 350,000 initial JS gzip bytes.

## Design decisions to confirm

Each of these earlier findings recommended a change that the product's design documents (DESIGN.md, PRODUCT.md) deliberately do not make. No action is needed unless you want to change the design.

- **GL-08** Risk labels 'Safe' and 'Nuclear' overclaim and joke; raw risk words leak into help text (fixed). Risk badges and help text now go through one presenter and read Safe, Caution, Danger, Nuclear everywhere, which is the wording DESIGN.md lines 54, 60 and 71 specify. The old review's Low/Medium/High/Critical labels were a design alternative that was never adopted; the policy enum values are unchanged.
- **GL-34** Surface ladder is nearly flat: light washes out, dark sunken equals canvas (1.06:1) (obsolete). The surface values (canvas, raised, sunken, overlay) are exactly the hex pairs in DESIGN.md's colour table (line 30) and line 48 specifies 'Flat surfaces with hairline borders', so the flat ladder (dark canvas to sunken 1.06:1) is the documented design; separation comes from borders.
- **GL-35** Dark text tiers collapse: secondary is 1.26:1 and muted 1.66:1 from primary (obsolete). The text tiers are exactly the values in DESIGN.md's colour table (line 31). The current values are the documented design and the readability floor is met: every tier is at least 5.2:1 (light) and 7.8:1 (dark) on the surfaces, above the 4.5:1 body-text rule.
- **GL-57** Manual 'Refresh' buttons on almost every page, despite live updates (obsolete). Current behavior is the documented design (DESIGN.md:102 puts 'the primary action, then Refresh' in every AreaHeader). Live, Refresh is on Inbox, Work, Library, Activity and Settings, while System shows 'Updated just now'. Observation for the Settings review, not a finding here: b5-desktop-m1.json shows four Refresh buttons on /settings/models where DESIGN.md:102 specifies one in the header.
- **GL-60** Status palette aliases UI tokens: running = accent, neutral = muted text (obsolete). Current behavior is the documented design. DESIGN.md:34 sets running to the accent colour and neutral to the muted text colour, and DESIGN.md:54 says status is never conveyed by colour alone; the rail and phone strip add distinct icon shapes per tone (stream-status.ts HEALTH_TONE_ICON).
- **ST-14** Citadel settings stack 8 undefined fantasy terms plus 'posture' (15+ uses) (fixed). DESIGN.md:69 says 'Plain names first, Citadel names second (Rules · Wards)'. Live: the Citadel tabs read 'Rules · Wards', 'Agents · Council', 'Secrets · Vault', 'Export/import · Blueprint', and the empty state says 'No rules yet'. Enums go through plain-word label tables.
- **ST-16** Card-in-card nesting: three levels of bordered boxes on Settings and System (fixed). DESIGN.md:103 forbids a bordered box inside another. Measured live on Models (expanded), General, Safety, Access, Advanced and Citadel: no bordered box sits inside another (deepest nesting 1), sections use hairline separators.
- **SY-09** System's Dashboards and Quality tabs duplicate other areas or serve developers (obsolete). PRODUCT.md:37 defines System as 'Runtime health, activity, cost, diagnostics, backups, and release proof' and PRODUCT.md:15 keeps expert inspection in the product, so keeping Dashboards and Quality there is the specified shape; the old row's own criterion was to retain them. No finding.

## Engineering notes

Developer-hygiene rows with no symptom an operator can see.

- **GL-13~fu206** cockpit.css resets the radius scale, so bare `rounded` falls outside the 6/8/12 tokens; spacing drifts off the 4px grid; compact density sets --spaci… (cannot-check). Bare 'rounded' is at zero in the cockpit, and compact density still sets --spacing: 0.21875rem (cockpit.css:131); that is a CSS-token and spacing-grid matter with no operator-visible defect, listed as a known deferral.
- **GL-49** WindowedRecordList copies data and re-renders all rows on every range change (cannot-check). WindowedRecordList still passes a fresh data copy and context object on every range change (lists above 100 rows only); there is no operator-visible symptom and no profile was taken, so it is not carried as a finding.
- **GL-N07** `AREA_TABS` (the old tabs-above-h1 strip) has no users, and the CSS comment still describes Library and System strips "once they carry this class". (cannot-check). AREA_TABS is still exported with no importer (git grep finds only its definition) and the stale CSS comment remains; this is dead code with no operator-visible symptom.
- **NV-10** Navigation context churns each render; 39 consumers and 6+ handoff owners re-render (cannot-check). The navigation provider still builds its context value inline each render (consumers fell from 39 to 11 files); the criterion needs a profile and has no operator-visible symptom, so it is not carried as a finding.
- **ST-N18** Radix `TabsContent` makes every panel a tab stop (tabIndex 0, with an added focus ring), the focusable panels seen live. (cannot-check). SettingsSectionTabs.tsx:132 now documents the choice ('Panels open with a heading or text, not a control, so the tabs pattern keeps them a tab stop'), the earlier review marked it already satisfied, and the only operator symptom is one extra Tab stop per panel, which I did not measure.
