# Channels guided setup

Channels uses the existing fourteen adapters. The Gateway owns setup drafts,
credential custody, checks, evidence and activation; Mission Control renders that
state. Setup follows prerequisites, account identity, destinations and access,
reviewed checks, governed activation, then first-message verification.

## Operator flow

- Start from **Needs attention**, **Connected accounts**, **Resume setup**, or
  **Add channel**. Repair and credential rotation hydrate a revision-bound draft.
- In the Cockpit, Telegram, Discord, Slack and WhatsApp are added from Chat ›
  Messaging: select **+ Add**, then the channel (see "Telegram quick setup",
  "Discord quick setup", "Slack quick setup" and "WhatsApp quick setup" below).
  The picker opens the other channels in Settings › Channels with that channel
  already chosen.
- Complete account credentials and choose destinations. Slack and Telegram use
  editable destination cards with one explicit default. Discovery adds candidates
  for review and preserves existing thread information and selections.
- For inbound webhook adapters, choose who may message the bot. Destination IDs
  are routing configuration; sender identities authorize incoming conversations.
  An empty allowlist denies all senders. Existing open legacy access remains
  visible until an operator deliberately changes it.
  Removing an individual pairing or allowlist entry does not create a per-user
  deny inside an explicitly open legacy policy; select allowlist access to
  restrict who can start new work.
- Review the exact live-test input before dispatch. Provider acceptance, cleanup,
  deferred checks, failure details and timestamps are separate evidence.
- Reopen a saved draft to inspect its bounded check history. Fresh proof for the
  unchanged setup resumes automatically without sending another test message.
  Historical, expired or superseded receipts remain visible but cannot enable
  activation.
- Review and apply the exact Settings-origin Change Plan in Chat. Returning to
  Channels restores the draft or connection within the matching workspace. A
  workspace mismatch requires an explicit workspace selection before review.
  The review contains bounded public destination, access and installation details;
  structured edits remain in Channels and do not become JSON fields in Chat.
  After its canonical approval, select **Continue after approval** on that exact
  plan; channel approval does not silently resume activation.
- After activation, inspect transport readiness, accepted ingress and its linked
  reply. Historical activity from a different connection generation cannot
  complete a changed setup.

Instructions and checklist acknowledgements are preparation, not proof of
connectivity. Advanced input remains secondary and obeys the setup definition's
manual-mode policy. Configured credentials are masked and never copied back into
form controls.

## Telegram quick setup

New Telegram connections receive by polling. GoatCitadel asks Telegram for new
messages (`getUpdates` long polling), which works from any network and needs no
public web address and no webhook secret. Delivery to a public HTTPS web address
(a webhook) is the advanced option.

- **Where.** Chat › Messaging › **+ Add** opens the channel picker at
  `/chat/messaging/add`; **Telegram** opens its page at
  `/chat/messaging/add/telegram`. The page has four steps, each opening when the
  one before it checks out:
  1. **Make your bot.** A QR code and link open BotFather; send `/newbot`.
  2. **Paste the key BotFather sent you.** The key is checked with Telegram
     (`getMe`, `getWebhookInfo`, `getUpdates`) and stored as a masked credential;
     the page never shows it again.
  3. **Say hi to your bot.** The page shows a one-time code as a QR code, a link
     and plain text. The private-chat sender who sends it within ten minutes
     becomes the bot's only allowed sender and its recorded owner, and that
     private chat becomes the default destination. **Get a new code** replaces an
     expired code. When a full page of waiting messages hides the code, the step
     says so and offers **Clear waiting messages**, which confirms them once (see
     Starting and resuming); a hi sent earlier than the newest message may need
     sending again.
  4. **Turn it on.** The step lists what will change, then sends a test message
     to that chat, removes it and applies the activation Change Plan in place. If
     the approval cannot be given there, the step links to Inbox or Settings.
- **Receive mode.** The connection stores `receiveMode`: `poll` (the default for
  new connections), `webhook` (Telegram sends to a public web address and the
  webhook secret fields apply) or `off`. Settings › Channels offers the same
  choice. Existing connections are not switched: one with a webhook secret stays
  `webhook` and one without stays `off` until an operator changes it.
- **Who can message the bot.** Polling uses the same update handler as the web
  address route, so sender allowlist, pairing and policy gates are unchanged. An
  empty allowlist still denies every sender. The web address route ignores updates
  for connections in `poll` or `off` mode. The owner the setup page recorded needs
  no pairing code: on an `allowlist` connection, an actor in both `ownerActorIds`
  and `allowedSenders` is let through like an approved pairing. Anyone else pairs
  first, and taking the owner off the allowlist ends it.
- **Starting and resuming.** The first time a bot is polled, GoatCitadel skips
  whatever is already waiting, including the setup messages. After that it saves
  its place in Telegram's queue after each message, so a restart resumes there.
  Messages Telegram no longer holds are not recovered. An update that fails eight
  times is skipped with a warning diagnostic so it cannot block later ones.
- **One reader per bot.** Telegram refuses `getUpdates` while the bot sends to a
  web address, and while another app is reading the same bot. The page says which
  applies. For a web address it offers **Stop sending to that address**, which
  calls `deleteWebhook` only after the operator asks. Another reading app has to
  be stopped in that app.
- **Allowed hosts.** Polling needs `api.telegram.org` in the network allowlist.
  When it is missing, the Turn on step lists it as a change, and Turn on adds it
  through its own approved Change Plan. Turn on approves only the plan it created
  or resumed and never uses the Settings approval skip.
- **Changing the key.** Chat › Messaging › the channel's page › **Change the
  key** (`/chat/messaging/<connection id>/key`) checks a new key and saves it with
  the same in-place approval. It keeps the connection's receive mode and does not
  offer to stop a web address.
- **Settings.** Settings › Channels points to Messaging, and
  `/settings/connections?channel=<catalog id>#channels` opens with that channel
  preselected, for example `channel.slack`.

## Discord quick setup

New Discord setups receive through a bot that GoatCitadel keeps connected to
Discord, so no public web address is needed. The picker lists Discord at "About 5
min".

- **Where.** Chat › Messaging › **+ Add** › **Discord** opens
  `/chat/messaging/add/discord`. The page has five steps, each opening when the
  one before it checks out:
  1. **Make your bot.** A link opens Discord's Developer Portal: New Application,
     then Bot › Reset Token, and copy the token.
  2. **Paste your bot's token.** The token is checked with Discord
     (`GET /users/@me`, `GET /applications/@me`, `GET /users/@me/guilds`) and
     stored as a masked credential; the page never shows it again. The step names
     the bot, and the next opens only once Message Content Intent is on (either of
     Discord's two Message Content flags counts). GoatCitadel's connection asks
     Discord for that intent and Discord refuses the connection without it, so
     Turn on waits for it even though direct messages alone would not need it.
     When it is off, the step says where to switch it on and offers **Check
     again**.
  3. **Invite your bot to a server.** The page builds Discord's
     `oauth2/authorize` link for this bot with the `bot` and
     `applications.commands` scopes and only View Channel, Send Messages and Read
     Message History (permissions `68608`). It asks Discord every few seconds, for
     ten minutes, whether the bot has joined a server; **Check again** waits
     another round.
  4. **Choose where it posts.** Direct messages with the person who made the bot
     are chosen for you; the other choices are the text channels of one server
     (asked which when the bot is in several). A bot that belongs to a Discord
     team asks which accepted team member it is for. People, servers and
     channels are named, never numbered. Choosing direct messages makes
     GoatCitadel ask Discord to open that person's direct-message channel
     (`POST /users/@me/channels`, which sends nothing); it refuses to open one
     with anyone who didn't make the bot. Each choice is saved to the draft as it
     is made.
  5. **Turn it on.** The step lists what will change, then sends a test message
     to the chosen place, removes it and applies the activation Change Plan in
     place. If the approval cannot be given there, the step links to Inbox or
     Settings.
- **Receive mode.** The draft saves `runtimeMode: "gateway"`, so GoatCitadel logs
  in to Discord and stays connected. A webhook with no bot (send-only) is a
  Settings option.
- **Who can message the bot.** Discord says who made the bot (`GET
  /applications/@me`: the app's owner, or a team's owner first and then its
  accepted members), and that cannot be faked, so the page has no "say hi" step.
  That person is the only one let in: the page saves `ownerActorIds`,
  `allowedSenders` and `inboundAccessMode: "allowlist"` together, and the pairing
  bypass needs all three. A person who is both an owner and on that allowlist
  skips the pairing code in direct messages and direct-message slash commands. In
  the chosen server and channel the bot answers only the people on the allowlist
  (`allowedSenders` on an `allowlist` connection), and only when they mention it.
  The direct-message policy stays `pairing`, so anyone else who messages the bot
  privately still gets a pairing code, and anyone else in the chosen channel is
  ignored. The "This is you" mark on the channel page only decides whether the
  maker skips pairing in direct messages: clearing it sends them to pairing
  there, and the chosen channel still answers only the allowlist. Taking the
  maker off the allowlist ends the bypass, and their answers in the channel while
  someone else is still on the list. An empty allowlist does not close the
  channel: it goes back to answering anyone who mentions the bot there, so add the
  next person before removing the last one.
- **Starting and resuming.** A setup made on this page is marked
  (`setupPage: "messaging"`) as soon as its draft is made, before the token is
  stored, so even a draft whose first check failed goes on there. Opening the
  page again goes on with the newest unfinished one, or the one the address
  names; the stored token is checked with Discord again, so a change in the
  Developer Portal shows. Where it posts comes back from the draft. A new token
  for a different bot (another `applicationId`) drops the old bot's choices, and
  who may message it and where it posts are chosen again. **Start over**
  discards the draft and its stored token.
- **Allowed hosts.** Discord's REST calls need `discord.com` in the network
  allowlist. When it is missing, the Turn on step lists it as a change, and Turn
  on adds it through its own approved Change Plan. Turn on approves only the plan
  it created or resumed and never uses the Settings approval skip.
- **Changing the key.** Chat › Messaging › the channel's page › **Change the
  key** (`/chat/messaging/<connection id>/key`) checks a new token and saves it
  with the same in-place approval. It is offered only for a Discord connection
  that receives through the bot; a webhook-only (bridge) connection keeps its
  link to Settings. The page warns when the token belongs to a different bot than
  the one saved with the connection, and keeps saving locked while Message
  Content Intent is off.
- **Settings.** Settings › Channels keeps Discord's guide for the other ways to
  connect, such as a webhook with no bot, and the page links to it as **More
  options in Settings**. A setup begun on this page goes on here; only Telegram
  sends new setups from Settings to Chat.
- **Not yet run against a real bot.** Browser proof used a sandbox that blocked
  all outbound traffic. The operator still owes the real-account checks: token,
  intent, invite, a direct message, a mention in the chosen channel, and Turn on.

## Slack quick setup

New Slack setups receive over Socket Mode: GoatCitadel opens a connection to
Slack, so no public web address is needed. Delivery to a public web address (the
signed Events API webhook) and the OAuth sign-in stay in Settings. The picker
lists Slack at "About 5 min".

- **Where.** Chat › Messaging › **+ Add** › **Slack** opens
  `/chat/messaging/add/slack`. The page has five steps, each opening when the one
  before it checks out:
  1. **Make your Slack app.** **Create the Slack app** opens Slack's
     create-an-app address
     (`https://api.slack.com/apps?new_app=1&manifest_json=<URL-encoded JSON>`),
     which builds the app from a manifest. The app is named "GoatCitadel" and its
     bot `goatcitadel`; both can be renamed in Slack afterwards. The manifest
     turns Socket Mode on, subscribes to the `app_mention` and `message.im`
     events and asks for the bot scopes `app_mentions:read`, `channels:read`,
     `chat:write`, `groups:read`, `im:history`, `im:read` and `users:read`.
  2. **Install it and copy two tokens.** In the app's settings, OAuth &
     Permissions › Install to Workspace gives the Bot User OAuth Token
     (`xoxb-`), and Basic Information › App-Level Tokens › Generate Token and
     Scopes, with the `connections:write` scope, gives the app-level token
     (`xapp-`). Both are checked with Slack (`auth.test` and
     `apps.connections.open`) and stored as masked credentials; the page never
     shows them again. The address Slack answers with carries a one-time ticket,
     so it is never read, kept or returned. The step names the bot and the
     workspace.
  3. **Say hi to your bot.** The page shows a one-time code. Send it to the bot
     in Slack (find it under Apps). The page asks Slack every six seconds by
     reading the bot's newest direct-message conversations (`conversations.list`
     and `conversations.history`) and keeps nothing on the server between asks.
     The code works for ten minutes, and **Get a new code** replaces an expired
     one. When the bot has more conversations than GoatCitadel looks at, the step
     says so and the code can be sent again.
  4. **Choose where it posts.** Direct messages with the person who said hi are
     chosen for you; the other choices are the channels the bot is in. The bot is
     in a channel only after someone adds it there (`/invite @<bot name>` in the
     channel), and **Refresh channels** reads the list again. The list is read
     once when the step opens and again only on that button, because it shares
     Slack's rate limits with looking for the hi.
  5. **Turn it on.** The step lists what will change, then sends a test message
     to the chosen place, removes it and applies the activation Change Plan in
     place. If the approval cannot be given there, the step links to Inbox or
     Settings.
- **Receive mode.** The connection stores `receiveMode`: `socket` (the page's
  choice; the app-level token is stored as `appToken`) or `webhook` (Slack posts
  signed events to a public web address). Settings › Channels offers the same
  choice. Connections saved before the choice existed receive by `webhook`.
  Socket Mode always lets in only allowlisted senders, as every stream channel
  does: a connection switched to it in Settings is saved with
  `inboundAccessMode: "allowlist"`, and a socket event is checked as allowlist-only
  even on a connection still saved as open, so a legacy open connection is never
  open to the whole workspace. The web address route is unchanged.
- **Who can message the bot.** The person who sends the code becomes the bot's
  only allowed sender and its recorded owner (`allowedSenders`, `ownerActorIds`
  and `inboundAccessMode: "allowlist"`), and their direct messages become the
  default destination. The app receives direct messages and mentions of the bot
  in channels it has been added to; it does not receive every message in a
  channel. A mention arrives as an `app_mention` event, and the same post can
  also arrive as a `message` event; both runs share one idempotency key
  (`slack:<connection id>:message:<channel>:<ts>`), so the post starts one turn.
  Sender allowlist and policy gates are the ones the web address route uses. The
  page writes no Slack installation identity (workspace and bot id), which the
  gateway reserves for OAuth installs, so a connection made here does not check
  an event's workspace against a saved one, and a mention still starts with the
  bot's own `<@…>` text. Voice messages over Socket Mode are left out: the app
  has no `files:read` scope, so the socket path does not read the voice setting
  and an audio share with no text is ignored.
- **Starting and resuming.** Slack ends each connection every few hours.
  GoatCitadel opens the next one at once, without an error or a backoff, when
  Slack sends a `disconnect` with reason `warning` or `refresh_requested`, and
  also when an hour passes with no frame at all. A `link_disabled` reason stops
  it with "Slack turned Socket Mode off for this app." and the runtime backs off
  before trying again. A new connection, the first or one opened for a refresh,
  that sends no `hello` within 30 seconds is closed with "The connection to Slack
  closed.", and the runtime backs off too. An event is acknowledged only after
  GoatCitadel has handled it, so one that failed stays unacknowledged for Slack
  to send again; GoatCitadel does not fetch Slack's history, so messages sent
  while it is disconnected are not read later.
  The setup page is marked (`setupPage: "messaging"`) as soon as its draft is
  made, before the tokens are stored, so even a draft whose first check failed
  goes on where it was left: the page checks both stored tokens with Slack
  again, and who said hi and where it posts come back from the draft, so no new
  code is asked for. A draft whose tokens were stored before it was set to
  `receiveMode: "socket"` (the page closed, or that write failed) is set then,
  before the later steps open; if that write fails, they stay shut and the page
  says why. When someone else says hi with a new code, they replace the
  earlier sender, whose direct messages are dropped from the draft. **Start
  over** discards the draft and its stored tokens.
- **Allowed hosts.** Slack needs `slack.com` in the network allowlist, for the Web
  API and for `apps.connections.open`. When it is missing, the Turn on step lists
  it as a change, and Turn on adds it through its own approved Change Plan. Slack
  gives a different `wss://…slack.com` address on every connect, so that address
  is not added to the allowlist: GoatCitadel opens only a `wss:` address under
  `.slack.com` that Slack returns. Turn on approves only the plan it created or
  resumed and never uses the Settings approval skip.
- **Changing the key.** Chat › Messaging › the channel's page › **Change the
  key** (`/chat/messaging/<connection id>/key`) asks for both tokens, checks
  them and saves them with the same in-place approval. It is offered only for a
  Slack connection whose `receiveMode` is `socket`; webhook and OAuth connections
  keep their link to Settings. A connection made on the Slack page saved no bot
  identity to compare, so the page cannot warn that the tokens belong to a
  different bot.
- **Settings.** Settings › Channels keeps Slack's guide for the other ways to
  connect: an incoming webhook with no app, the signed web address and the OAuth
  sign-in, which is unchanged. The page links to it as **More options in
  Settings**. A setup begun on this page goes on here.
- **Not yet run against a real app.** Browser proof used a sandbox that blocked
  all outbound traffic. The operator still owes the real-account checks: creating
  the app from the manifest, installing it, both tokens, hi, a direct-message
  reply, a mention in a channel, Turn on, and a socket refresh after a few hours.

## WhatsApp quick setup

New WhatsApp setups use Meta's WhatsApp Business Cloud API with your own Meta
app. Meta delivers messages only to a public `https://` address, so unlike
Telegram, Discord and Slack this page needs a public web address (see "Public web
address" below). The picker lists WhatsApp at "About 15 min" with the note
"Business account + public web address". Personal WhatsApp QR linking is not
offered, and nothing on the page uses an unofficial client.

- **Where.** Chat › Messaging › **+ Add** › **WhatsApp** opens
  `/chat/messaging/add/whatsapp`. The page has six steps, each opening when the one
  before it checks out (step 2 is instructions and is always open):
  1. **Give GoatCitadel a public web address.** The step shows the same field as
     Settings › Channels and is done once an address is saved. GoatCitadel doesn't
     provide one: use your own domain, reverse proxy or tunnel.
  2. **Make your Meta app.** **Open Meta for Developers** opens
     `https://developers.facebook.com/apps`. The step lists where each value is
     found: create an app for WhatsApp ("Connect with customers through WhatsApp");
     in API Setup, the Phone number ID and the WhatsApp Business Account ID (Meta's
     test number is fine); in App settings › Basic, the App ID and the App secret;
     in Business Settings › System users, a token for this app with the
     `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
  3. **Paste your WhatsApp details.** The five values are the access token, the
     Phone number ID, the WhatsApp Business Account ID, the App ID and the App
     secret (the IDs are digits only). One **Check** asks Meta, in this order and
     stopping at the first refusal, with read-only calls:
     `GET /{phone-number-id}?fields=display_phone_number,verified_name` (the
     number is real and has a verified name), `GET /debug_token` (the token is
     valid, was made for this App ID, and when it stops working), `GET
     /{business-account-id}/phone_numbers?fields=id&limit=100` (the number belongs
     to the account) and `GET /{business-account-id}/subscribed_apps` (whether this
     app already receives the account's messages). The calls go to
     `https://graph.facebook.com/v23.0`. The access token and the App secret are
     stored as masked credentials and the page never shows them again; the IDs are
     saved on the draft. The step names the number ("Works. Your number is … (the
     verified name).").
     Meta's answer to a failed call becomes one fixed sentence, and never a quote of
     the request or of Meta's text: the token was refused, the number or the
     account wasn't found, the number isn't in the account, the token belongs to
     another Meta app, the App ID and secret were refused, or GoatCitadel couldn't
     reach Meta. A Graph error with code `190` (Graph's access-token error) says
     the token was refused whatever the HTTP status, which is how an expired
     temporary token reads. Only the first 100 numbers of the account are read:
     the next page's address carries the access token, so it is never followed.
     A token that stops working (`debug_token` gives an expiry that isn't `0`)
     shows a note, "This token stops working <time>.", that tells you to make a
     system user's token and change the key from WhatsApp's page once it's on. The
     note doesn't block the setup, and step 3 stays closed: reopening it would need
     all five values again.
  4. **Point Meta at GoatCitadel.** You set Meta's address by hand; GoatCitadel
     only makes the address and the token and then listens. The step shows the
     **Callback URL** (the public web address, then
     `/api/v1/integrations/connections/<draft id>/whatsapp/webhook`) and the
     **Verify token** as copy fields. In your Meta app, open WhatsApp ›
     Configuration, paste both, choose Verify and save, and subscribe to
     `messages`. The page makes the verify token (32 characters) and stores it with
     the other secrets, and shows it only while the page holds it: after a reload
     it is not shown again, and **Make a new verify token** makes one to paste into
     Meta (offered only while the page holds none and Meta hasn't checked the
     address). A **Check** repeated after a failure keeps the stored token, so an
     address Meta has already checked stays valid.
     GoatCitadel answers Meta's verification request at that address while the
     listener runs (see "The setup listener" below). The page asks every six
     seconds, for ten minutes, whether Meta has checked the address, and then
     notes the time on the draft (`webhookCheckedAt`). It says "Meta checked your
     address just now." only when that page session saw the check arrive, and "Meta
     has checked your address." for everything that stays on screen or comes back
     from the draft. After ten minutes without a check the step says "Meta hasn't
     checked your address yet. Choose Verify and save in Meta, then check again."
     and offers **Check again**, which waits another round. When Meta's
     `subscribed_apps` doesn't list this app, the step offers **Let this app
     receive your number's messages**, which calls `POST
     /{business-account-id}/subscribed_apps` with the access token and no body.
     That is the only write GoatCitadel makes to Meta during setup, and it runs only
     from that button. The step is done when Meta has checked the address and the
     app is subscribed.
  5. **Say hi from your phone.** The page shows a one-time code as a QR code, a
     `wa.me` link (`https://wa.me/<number's digits>?text=<code>`) and plain text.
     Send the code from your phone, as it is, to the number. With Meta's test
     number the phone may first need to be added under API Setup › To. The same
     listener hears it (see below) and the page asks every six seconds. The code
     works for ten minutes and **New code** replaces an expired one. The person
     whose message carries the code becomes the bot's only allowed sender and its
     recorded owner, and their WhatsApp number becomes the default recipient.
  6. **Turn on.** The step lists what will change (only that person can message
     the bot, replies go to them, a test message GoatCitadel sends that WhatsApp
     can't remove afterwards, and `graph.facebook.com` if it is not yet allowed),
     then sends the test message and applies the activation Change Plan in place.
     If the approval cannot be given there, the step links to Inbox or Settings.
     WhatsApp offers no way to remove a message, so when GoatCitadel can't remove
     the test message the step says "GoatCitadel couldn't remove its test message.
     Delete it in WhatsApp if you like."
- **The setup listener.** Until Turn on, the draft's address is
  `/api/v1/integrations/connections/<draft id>/whatsapp/webhook`, and a new
  connection keeps its draft's ID, so the same address goes on working when the
  connection is turned on. Only a draft made on this page for a new connection
  (`setupPage: "messaging"`, create mode) is answered; any other id is a 404, as
  before. For such a draft GoatCitadel answers Meta's verification `GET`
  (`hub.mode=subscribe`, `hub.challenge`, `hub.verify_token`) with the challenge
  when the verify token matches, and hears a delivery signed with
  `X-Hub-Signature-256` (HMAC-SHA256 of the exact body, keyed with the App secret
  the page stored) for the draft's Phone number ID. A text message whose whole text
  is the draft's one-time code is remembered; every other signed delivery is
  answered 200 and forgotten. Nothing starts a conversation, creates a session or
  reaches an agent. What the listener remembers is in memory only, per draft, for
  15 minutes (at most 32 drafts, the oldest dropped first): the time Meta checked
  the address, and the code with the sender's number and name. It keeps no message
  text, message id or timestamp, and a restart forgets it. A wrong or missing
  signature is a 401 and a verification with the wrong token is a 401, with fixed
  sentences. A verified delivery spends an accepted-delivery rate limit of the same
  size as a saved connection's, and the 256 KiB body limit and Host check apply. The listener
  exists for Chat-made drafts only; a draft made in Settings has no listener.
- **Receive mode.** The connection is a signed webhook, the way every WhatsApp
  connection is. Inbound routing needs both the App secret and the verify token,
  and the page stores both.
- **Who can message the bot.** The person who says hi becomes the bot's only
  allowed sender and its recorded owner (`allowedSenders`, `ownerActorIds` and
  `inboundAccessMode: "allowlist"`). Pairing for other people is not on this page
  yet: anyone else who messages the number is dropped by the allowlist with a
  `channel.sender_not_allowlisted` diagnostic. Add more numbers (digits only) to
  `allowedSenders` in Settings › Channels.
- **The 24-hour reply window.** WhatsApp allows a free-form message only within
  24 hours of the person's last message, and each new message of theirs starts it
  again; Meta refuses a later one with error code `131047`. GoatCitadel refuses it
  first, in two places, with the sentence "WhatsApp allows a reply only within 24
  hours of their last message. Once they message again, you can reply.":
  1. **The Chat composer.** For a WhatsApp conversation the composer is off, the
     sentence is its reason line (the one status line it already has), and Send
     does nothing. The composer re-checks whenever it draws, with no timer, so a
     composer left idle across the 24th hour stays on until the next draw.
  2. **GoatCitadel.** The operator's send (`sendOperatorDeskMessage`) is refused
     with a 409 and the same sentence before anything is accepted or sent, in both
     the plain and the streaming path.

  The window is measured from the time GoatCitadel stored for the person's last
  message in that conversation, to the second, and it closes at exactly 24 hours. A
  WhatsApp conversation with no stored message from the person counts as closed.
  GoatCitadel's stored time can differ a little from Meta's, so a send near the end
  can still pass and then be refused by Meta with `131047`. Other channels have no
  window. **Answers the agent writes are not checked**: the agent replies to a
  message it has just been given, and a later refusal from Meta shows as a failed
  delivery. Turn on's test message and the key page's test message are plain text,
  so Meta delivers them only within 24 hours of the recipient's last message to the
  number; have them message it first.
- **Changing the key.** Chat › Messaging › the channel's page › **Change the
  key** (`/chat/messaging/<connection id>/key`) asks for the access token alone,
  checks it with Meta against the connection's saved Phone number ID, WhatsApp
  Business Account ID, App ID and App secret (the same four calls as step 3), and
  saves it with the same in-place approval. It is offered only for a WhatsApp
  connection that keeps all four of those; a connection made in Settings without
  them keeps its link to Settings. Its save step says that WhatsApp delivers the
  test message only within 24 hours of the person's last message and can't remove
  it.
- **Starting and resuming.** The page marks its draft (`setupPage: "messaging"`)
  as soon as the draft is made, before any key is stored, so even a draft whose
  first check failed goes on there. Opening the page again goes on with the newest
  unfinished one, or the one the address names; the stored token is checked with
  Meta again, the number and the expiry come back, and who said hi comes back from
  the draft (as the number: the draft keeps no name). A check noted on the draft
  skips the wait for Meta. **Start over** discards the draft and its stored keys,
  and Meta's Callback URL then points at a draft that no longer exists.
- **Allowed hosts.** GoatCitadel calls `graph.facebook.com`. When it isn't in the
  network allowlist, the Turn on step lists it as a change, and Turn on adds it
  through its own approved Change Plan. Turn on approves only the plan it created or
  resumed and never uses the Settings approval skip.
- **Settings.** Settings › Channels keeps WhatsApp's guide for the other ways to
  connect, such as environment-variable keys and a send-only connection, and the
  page links to it as **More options in Settings**. The guide keeps the App ID and
  the WhatsApp Business Account ID (`appId`, `businessAccountId`) with the
  connection. A setup begun on this page goes on here.
- **Not yet run against a real account.** Browser proof used a sandbox that blocked
  all outbound traffic and answered Meta from a local stub. The operator still owes
  the real-account checks: creating a Meta app, pasting the five values, setting the
  Callback URL, saying hi, Turn on, a reply within the window, and a reply after 24
  hours.

## Public web address

Some channels (WhatsApp today) need to tell a vendor where on the internet to send
messages. GoatCitadel can't know that address, so the operator sets it once.

- **Where.** Settings › Channels › **Public web address** (the field also appears
  on step 1 of the WhatsApp page). **Save address** stores it; **Clear** removes it.
  It is stored as `assistant.publicWebAddress` in the assistant config and returned
  by `GET /api/v1/settings` as `publicWebAddress` (absent when none is set).
- **Saving is a Settings change.** `PATCH /api/v1/settings` with `publicWebAddress`
  (a string, or `null` to clear) makes, when the Control Plane is on, a Change Plan
  with the operation `public_web_address_configuration` and the risk `caution`; the
  Control Plane's own refusal of a request that changes a second setting applies
  as for any Settings change. The operator's click approves the plan in place, the
  way Settings approves Firecrawl's address. A bad address is a 400 with its
  sentence and no plan is made. Chat's Change Plan tool does not offer this
  operation: the operator sets the address, a model in Chat does not.
- **What is accepted.** The address is trimmed and must be a full `https://`
  address of at most 200 characters, with no user name or password, nothing after
  `?` or `#`, and a host the internet can reach (not `localhost`, a private,
  loopback or link-local address, or an IPv4-mapped IPv6 form of one). A path prefix
  is allowed. It is stored tidied: lower-case host, no port the scheme assumes, no
  trailing slash. The problems are fixed sentences that never repeat what was typed:
  "Enter a full address that starts with https://.", "Use an https:// address. Meta
  and the other services send only to secure addresses.", "Leave the user name and
  password out of the address.", "Leave out anything after ? or #.", "Use an
  address the internet can reach, not one on this computer or your home network."
  and "Use an address under 200 characters." The same check runs in the field, in
  the PATCH, when a Change Plan is made and applied, and when the config loads
  (a saved value that fails is dropped with a logged fixed sentence, never the
  address). Names such as `.local` and single-label hosts are not refused.
- **What uses it.** The WhatsApp page builds its Callback URL from it. Every
  channel webhook address block (Settings › Channels, and the Classic guide) shows
  the full address, public web address first, then the connection's path, with
  **Copy**. With no address set the block shows the placeholder
  `https://<your public address>` and a **Set your public web address** link.
- **What it doesn't do.** It doesn't make GoatCitadel reachable. The operator
  provides the domain, reverse proxy or tunnel, and should keep token auth on for
  any installation reachable from outside (see "Before You Start" in the
  [Communication Channel Setup Guide](./COMMUNICATION_CHANNEL_SETUP_GUIDE.md)).

## Channel boundaries

| Channel | Supported setup and completion evidence |
| --- | --- |
| Telegram | Bot identity, explicit chats/default, how messages are received (polling by default; a webhook secret only for web-address delivery) and coordinated pairing/sender allowlist; an authorized incoming message and linked provider-accepted reply. |
| Discord | Paired direct messages or separately allowlisted server/guild/channel/user/role rules; identity/intents and invitation guidance; the Chat page lets in only the person Discord names as the bot's maker. DM-only destination checks may remain deferred until runtime activation and pairing. |
| Slack | Explicit adoption of a bound OAuth install or existing supported credentials, workspace/channel membership and scopes, signed Events callbacks when configured, or Socket Mode with an app-level token (the Chat page's way); linked ingress/reply evidence for conversations. |
| WhatsApp | Business Cloud API sender phone-number resource and recipient. Both app secret and webhook verify token are needed for inbound routing. The Chat page (needs a public web address) checks the five values with Meta, answers Meta's address check and hears a signed one-time code from the one person who becomes the allowed sender; free-form replies are allowed only within 24 hours of that person's last message. Personal WhatsApp QR linking is unavailable. |
| LINE | Messaging API identity and user/group/room destinations; sender authorization is distinct from destination selection. Signed webhook ingress and its reply prove a conversation. |
| Nextcloud Talk | Registered bot/room and shared signing token, reviewed live send and signed callback; authorized ingress and linked reply. |
| ntfy | Server/topic/auth and subscription guidance; dry-run, published notification and manual receipt remain distinct. |
| Google Chat | Space/thread incoming webhook and reviewed card delivery; provider acceptance and human receipt are separate. |
| Teams | Signed Workflows webhook with Anyone trigger authentication, explicit flow owner/co-owner and reviewed Adaptive Card delivery. Tenant-authenticated triggers need bearer support that this adapter does not provide. Retired connector URLs require migration; provider acceptance and visible destination receipt remain separate. |
| Mattermost | Server, bot, team/channel and permissions; action-specific outbound receipts. |
| Matrix | Homeserver URL, bot account access token and joined room; whoami and joined-room checks plus a test notice. Opt-in `/sync` inbound stays allowlist-only and resumes from a persisted sync token (a homeserver-rejected token re-primes and skips the gap). Outbound is text-only. |
| QQBot | AppID, AppSecret in an environment variable and the QQ hosts in the network allowlist; token mint and bot-identity checks plus an optional active test message. The signed (ed25519) webhook is default-deny by QQ openid, replies are passive replies to the inbound message id, and outbound is text-only. |
| WeCom | CorpID, AgentId and application Secret, with the gateway IP on the application's trusted IP list; token and application checks plus a test message. The encrypted callback (Token and EncodingAESKey) is optional, default-deny by WeCom userid, and outbound is text-only. |
| Zalo OA | Official Account token and eligible recipient; narrow outbound receipt and separate human confirmation. |

Adapters without an inbound transport omit conversation requirements. A successful
notification send does not establish human receipt. Attachments, approvals,
scheduled delivery and reconnect behavior remain bounded by each adapter's
advertised capabilities and existing policy.

## Evidence and eligibility

`channel_setup_evidence` stores immutable redacted test, acknowledgement and
activation receipts. It excludes raw credentials, custody locators, arbitrary
provider payloads and incoming message bodies. Test evidence records its original
draft and connection revisions and input fingerprint. Activation evidence also
records the exact draft revision consumed by activation and commits
with the connection and draft removal in the same storage transaction.
Database append order selects the latest result even when timestamps tie. A newer
failed result supersedes older proof and acknowledgements; activation rechecks
that ordering atomically rather than trusting a process cache.

The Gateway computes finalization eligibility. Required failures, unknown
warnings, skipped required checks and ambiguous sends block activation. Optional
test message cleanup can remain advisory only when a successful provider receipt and
an explicit acknowledgement exist. Acknowledging cleanup preserves warning
severity. Legitimate post-activation checks remain deferred rather than becoming
fabricated passes. Fresh unchanged-input evidence can be restored after restart;
changed inputs, connection revisions or expired proof require retesting.
Current runtime content, validation and test versions also invalidate older proof.
Gateway-resolved credential changes invalidate its private input fingerprint.
Current results expose the original `proofExpiresAt`; acknowledgements never
extend it. An open editor disables preparation and acknowledgement at expiry
while retaining historical receipts.
The read-only draft-evidence API returns history separately from the Gateway's
current eligibility decision; reading it does not run probes or write draft state.

A new connection keeps its draft's ID. Finalization saves it under that ID, so a
webhook channel's address, which holds the connection ID, is known and shown
while the setup is still a draft. The address answers only once the connection is
finished and on. Drafts and connections stay separate records, and a finished
draft cannot be finalized again. A change to a saved connection keeps the saved
connection's own ID.

The bounded journey projection follows canonical ingress, turn and delivery
links. The Gateway stamps accepted ingress with its connection revision. Provider
retries preserve their original event identity and accepted generation across
configuration changes; only authority metadata is excluded from duplicate-content
comparison.
First-conversation completion and latest reply delivery are separate observations;
a later failed or uncertain reply cannot be presented as an older successful
receipt. Endpoint URLs in unstructured evidence text are redacted.

Teams guidance was checked against [Microsoft's Workflows webhook instructions](https://support.microsoft.com/en-us/workflows/send-messages-in-teams-using-incoming-webhooks)
and [connector retirement notice](https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams/).
The existing HTTP card adapter supports the unsigned-header Anyone trigger;
structural URL recognition never establishes successful delivery.

## API compatibility

- `GET /api/v1/channels/drafts/:draftId/evidence?expectedRevision=<revision>`
  requires the exact saved draft revision and current connection review. It
  returns at most twenty immutable receipts and an optional current test. A
  revision conflict requires refresh; history alone does not authorize activation.
- Telegram owner-reference discovery accepts either a draft ID and numeric
  revision or a connection ID and opaque revision. Credentials resolve only at
  the Gateway. The legacy token/env discovery API remains validated for existing
  callers. First-party UI callers use owner references.
- An active Telegram webhook is never deleted for discovery, unless a draft-based
  request sets `clearWebhook: true`, which calls `deleteWebhook` once and keeps
  pending updates. Configured, accepted-ingress and pairing destinations remain
  usable candidates; unavailable update polling is explained, and a 409 from
  `getUpdates` is reported as `updatesConflict`. Discovery grants no access and
  selects no default.
- A draft-based discovery request can carry a one-time `setupCode`. The result's
  `codeSender` is the latest private-chat, non-bot sender whose `/start <code>`
  (or bare code) message matches exactly. `updatesTruncated` marks a full page of
  100 updates, so the sender may be further back. The code finds a sender; it
  grants nothing until the setup page saves that sender to the draft.
- A draft-based request that sets `skipWaiting: true` (the setup page's **Clear
  waiting messages** click) first calls `getUpdates` with `offset=-1&limit=1&timeout=0`,
  once, when no webhook is active. Telegram then forgets every update before the
  newest, and the usual look follows, so a hi sent after it is found. Discovery
  never acknowledges updates otherwise. It is refused for a draft that belongs to
  a connection (an edit or key change), whose poller owns the queue, and the
  connection source rejects the field. A 409 is reported as `updatesConflict`
  and nothing is skipped. Nothing GoatCitadel would have processed is lost: a
  connection's first poll skips whatever is already waiting.
- Telegram pairing list/approve/revoke APIs expose bounded public identities and
  require the current connection revision for writes. Approval and revocation
  update both pairing and sender authorization under one connection CAS. Existing
  pairing records gain no silent permissions; already accepted work is retained.
- Slack OAuth start requires an authenticated operator, workspace, draft and
  current revision. Attempts bind the server installation and any current
  connection revision, expire and consume callbacks once. Exact attempt status
  returns public install identity/scopes. Unbound starts return actionable errors.
- Slack callback completion stages credentials in temporary custody. It neither
  activates a connection nor replaces an existing install. Adoption explicitly
  updates the bound draft, invalidates old test proof and requires the normal
  validation and Change Plan activation flow. Cancel, expiry, interrupted
  exchange recovery and draft discard clean up task-owned temporary custody.
- Public draft PATCH and advanced edits retain Gateway-authored Slack install
  receipt fields and reject fabricated, replaced or cleared receipt metadata.
- The compatibility shared-client name `startSlackOAuth` now requires the same
  binding input. Availability-only status remains a read-only compatibility API.

SQLite migration 252 and PostgreSQL migration 198 append the evidence and OAuth
attempt tables, immutable evidence guards and OAuth binding/CAS guards. No existing
active account, legacy target format or historical pairing is bulk-rewritten.
Deploy backend contracts and migrations before UI callers. Use the documented
offline backup/recovery path for rollback rather than rewriting migration history.

## Verification and external acceptance

Focused contract, storage, Gateway and UI tests precede locked typechecks and the
channel runtime, parity, revisions, storage migration, accessibility, visual and
documentation lanes. Browser proof uses disposable runtime data and test-owned
processes; it does not change installed accounts or operate another agent's stack.

Live Telegram/Discord/Slack/WhatsApp acceptance remains a separate operator-designated
sandbox pass. Check approved and rejected senders, linked replies, approvals,
attachments, scheduled delivery, reconnect and duplicate events. For every result,
record the connection revision, provider receipt, timestamp and any deferred or
unknown outcome. Automated test doubles and browser preparation are not evidence
that this external acceptance passed.
