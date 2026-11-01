/**
 * What the Tools panel calls each built-in tool: a short, plain label (P2-R45). The registry's own descriptions are
 * written for the model ("the immutable context snapshot", "write jail roots", "allowlisted hosts"), so the panel shows
 * these labels as ordinary copy and keeps the raw description in Technical details. This is presentation copy only: it
 * says nothing about a tool's risk, rules or state, which the Gateway decides.
 *
 * One label for every tool in `TOOL_GROUPS`, and none for a tool no group lists (tool-labels.test.ts). A tool added to
 * a group without a label fails that test, and until it has one the panel shows `UNKNOWN_TOOL_LABEL`.
 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  // Core
  "capabilities.search": "Find tools and skills",
  "skills.read": "Read a skill's instructions",
  "tool_artifact.read": "Read saved tool output",
  "change.request": "Ask to change your setup",
  "code_mode.request": "Ask to run code",
  "runtime.configure": "Ask to set up a search provider",
  "session.status": "Check the chat's status",
  "session.search": "Search this chat's history",
  "session.history": "Read earlier chat messages",
  "user_input.request": "Ask you a question",
  submit_work_result: "Report back, or ask for file access",
  "time.now": "Check the time",
  "context.list": "List the context for this turn",
  "context.grep": "Find text in this turn's context",
  "context.query": "Look up this turn's context",
  "context.read_range": "Read part of this turn's context",
  "mcp.invoke": "Use a connector's tool",

  // Files
  "fs.read": "Read a file",
  "fs.list": "List files in a folder",
  "fs.stat": "Look up file details",
  "fs.write": "Write a file",
  "fs.patch": "Edit part of a file",
  "fs.copy": "Copy a file",
  "fs.move": "Move or rename a file",
  "fs.delete": "Delete a file or folder",
  "file.read_range": "Read part of a file",
  "file.find": "Search inside files",
  "code.search": "Search code",
  "code.search_files": "Find files by name",

  // Shell and code
  "shell.exec": "Run a shell command",
  "shell.exec_background": "Start a command in the background",
  "tests.run": "Run the project's tests",
  "lint.run": "Check the project's code for problems",
  "build.run": "Build the project",

  // Git
  "git.status": "See which files changed",
  "git.diff": "Compare changes line by line",
  "git.add": "Stage files for a commit",
  "git.commit": "Commit staged changes",
  "git.branch.create": "Create a branch",
  "git.branch.switch": "Switch to a branch",
  "git.worktree.create": "Create a worktree",
  "git.worktree.remove": "Remove a worktree",

  // Web search
  "browser.search": "Search the web",
  "local_business.research": "Research a local business",
  "citations.build": "Build a list of sources to cite",

  // Web requests
  "http.get": "Fetch from a web address",
  "http.post": "Send data to a web address",

  // Browser
  "browser.navigate": "Open a page and read it",
  "browser.extract": "Read part of a page",
  "browser.screenshot": "Take a screenshot of a page",
  "browser.interact": "Click or type on a page",
  "browser.cookies.get": "Read the browser's cookies",
  "browser.cookies.set": "Set a browser cookie",
  "browser.cookies.clear": "Clear the browser's cookies",
  "browser.storage.get": "Read a page's stored data",
  "browser.storage.set": "Store data for a page",
  "browser.storage.clear": "Clear a page's stored data",
  "browser.context.configure": "Set the browser's location, language and sign-in",
  "browser.errand": "Do errands in GoatCitadel's own browser",

  // Memory
  "memory.read": "Read saved memory",
  "memory.search": "Search memory",
  "memory.write": "Save a memory note",
  "memory.upsert": "Add or update a memory note",

  // Documents
  "docs.ingest": "Add a document for searching",
  "docs.read_bytes": "Read a file as raw bytes",
  "docs.extract_text": "Extract text from a PDF or document",
  "docs.decompress": "Decompress data",
  "docs.search": "Search your documents",
  "embeddings.index": "Index documents by meaning",
  "embeddings.query": "Search documents by meaning",
  "artifacts.create": "Create a file from a template",
  "documents.create": "Create a document",
  "presentations.create": "Create a slide deck",
  "document.propose_patch": "Suggest an edit to a document",

  // Email and calendar
  "gmail.read": "Search your Gmail",
  "gmail.send": "Send a Gmail message",
  "smtp.send": "Send an email",
  "calendar.list": "List calendar events",
  "calendar.create_event": "Add a calendar event and invite people",

  // Messaging
  "notify.request": "Ask for your attention",
  "channel.send": "Send a chat message",
  "channel.react": "React to a chat message",
  "channel.unsend": "Unsend a chat message",
  "discord.send": "Send a Discord message",
  "discord.react": "React to a Discord message",
  "discord.unsend": "Unsend a Discord message",
  "line.send": "Send a LINE message",
  "mattermost.send": "Send a Mattermost message",
  "mattermost.react": "React to a Mattermost message",
  "mattermost.unsend": "Unsend a Mattermost message",
  "nextcloud-talk.send": "Send a Nextcloud Talk message",
  "nextcloud-talk.react": "React to a Nextcloud Talk message",
  "telegram.send": "Send a Telegram message",
  "telegram.react": "React to a Telegram message",
  "telegram.unsend": "Unsend a Telegram message",
  "whatsapp.send": "Send a WhatsApp message",
  "whatsapp.react": "React to a WhatsApp message",
  "slack.send": "Send a Slack message",
  "slack.react": "React to a Slack message",
  "slack.unsend": "Unsend a Slack message",
  "google-chat.send": "Send a Google Chat message",
  "teams.send": "Send a Microsoft Teams message",
  "zalo.send": "Send a Zalo message",

  // Webhooks
  "webhook.send": "Send data to a webhook",

  // Schedules
  "schedule.manage": "Manage the AI's scheduled work",

  // Subagents
  "agent.fanout": "Split a task across subagents",
};

/** What the panel says for a tool that has no label, so an ID never stands where a sentence should. */
export const UNKNOWN_TOOL_LABEL = "A tool GoatCitadel can use";

/** The plain label this map holds for a tool, or `undefined` for a name it doesn't hold. */
export function knownToolLabel(toolName: string): string | undefined {
  return Object.hasOwn(TOOL_LABELS, toolName) ? TOOL_LABELS[toolName] : undefined;
}

/** The plain label of a tool, or `UNKNOWN_TOOL_LABEL` for a name this map doesn't hold. Never the raw name. */
export function toolLabel(toolName: string): string {
  return knownToolLabel(toolName) ?? UNKNOWN_TOOL_LABEL;
}
