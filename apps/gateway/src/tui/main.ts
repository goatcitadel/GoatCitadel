/* eslint-disable no-console, max-lines -- TUI CLI entrypoint intentionally writes operator output to stdout. */
import process from "node:process";
import type { ChatCapabilityUpgradeSuggestion } from "@goatcitadel/contracts";
import { confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { renderDoctorReport, runDoctor as runSharedDoctor } from "../doctor/engine.js";
import { loadLocalEnvFile } from "../env-file.js";
import { TuiApiClient } from "./api-client.js";
import { TuiLiveFeed } from "./live-feed.js";
import { loadResolvedProfile, saveProfile, type TuiResolvedAuth } from "./profile.js";
import { renderBox, renderBulletList, renderKeyValueSummary, renderOperatorSection, renderSection } from "./render.js";
import { tuiTheme } from "./theme.js";

type HomeView =
  | "dashboard"
  | "chat"
  | "approvals"
  | "promptlab"
  | "memory"
  | "files"
  | "cron"
  | "improvement"
  | "sessions"
  | "costs"
  | "tools"
  | "tasks"
  | "skills"
  | "integrations"
  | "mesh"
  | "npu"
  | "system"
  | "onboarding"
  | "settings"
  | "exit";

const MANUAL_SESSION_ENTRY = "__manual_session__";
const MAX_TUI_SESSION_CHOICES = 14;

loadLocalEnvFile();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const resolved = await loadResolvedProfile({
    profileName: args.profile,
    gatewayOverride: args.gateway,
  });

  const auth = await resolveAuth(resolved.auth);
  const client = new TuiApiClient({
    baseUrl: resolved.profile.gatewayBaseUrl,
    auth,
    readOnly: args.readOnly,
  });
  const live = new TuiLiveFeed(client, resolved.profile.pollIntervalsMs?.activity ?? 2500);
  await live.start();

  if (args.doctor) {
    await runDoctor(client, resolved.profileName, resolved.filePath, auth, args);
    live.stop();
    return;
  }

  process.on("SIGINT", () => {
    live.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    live.stop();
    process.exit(0);
  });

  let current: HomeView = "dashboard";
  while (current !== "exit") {
    printHeader({
      profile: resolved.profileName,
      gateway: client.baseUrl,
      readOnly: client.readOnly,
      liveState: live.getState(),
      lastEventAt: live.getLastEvent()?.timestamp,
      liveNote: live.getLastError() ?? undefined,
    });

    try {
      if (current === "dashboard") {
        await viewDashboard(client);
      } else if (current === "chat") {
        await viewChat(client);
      } else if (current === "approvals") {
        await viewApprovals(client);
      } else if (current === "promptlab") {
        await viewPromptLab(client);
      } else if (current === "memory") {
        await viewMemoryLifecycle(client);
      } else if (current === "files") {
        await viewFiles(client);
      } else if (current === "cron") {
        await viewCron(client);
      } else if (current === "improvement") {
        await viewImprovement(client);
      } else if (current === "sessions") {
        await viewSessions(client);
      } else if (current === "costs") {
        await viewCosts(client);
      } else if (current === "tools") {
        await viewTools(client);
      } else if (current === "tasks") {
        await viewTasks(client);
      } else if (current === "skills") {
        await viewSkills(client);
      } else if (current === "integrations") {
        await viewIntegrations(client);
      } else if (current === "mesh") {
        await viewMesh(client);
      } else if (current === "npu") {
        await viewNpu(client);
      } else if (current === "system") {
        await viewSystem(client);
      } else if (current === "onboarding") {
        await viewOnboarding(client);
      } else if (current === "settings") {
        await viewSettings(client, resolved.filePath, resolved.profileName);
      }
    } catch (error) {
      console.error(chalk.red((error as Error).message));
      await pause();
    }

    current = await chooseNextView();
  }

  live.stop();
}

function parseArgs(argv: string[]): {
  profile?: string;
  gateway?: string;
  readOnly: boolean;
  doctor: boolean;
  deep: boolean;
  yes: boolean;
  json: boolean;
  auditOnly: boolean;
  noRepair: boolean;
} {
  let profile: string | undefined;
  let gateway: string | undefined;
  let readOnly = false;
  let doctor = false;
  let deep = false;
  let yes = false;
  let json = false;
  let auditOnly = false;
  let noRepair = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--profile") {
      profile = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--gateway") {
      gateway = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--read-only") {
      readOnly = true;
      continue;
    }
    if (value === "doctor" || value === "--doctor") {
      doctor = true;
      continue;
    }
    if (value === "--deep") {
      deep = true;
      continue;
    }
    if (value === "--yes" || value === "-y") {
      yes = true;
      continue;
    }
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--audit-only") {
      auditOnly = true;
      continue;
    }
    if (value === "--no-repair") {
      noRepair = true;
      continue;
    }
  }

  return { profile, gateway, readOnly, doctor, deep, yes, json, auditOnly, noRepair };
}

async function resolveAuth(auth: TuiResolvedAuth): Promise<TuiResolvedAuth> {
  if (auth.mode === "token" && !auth.token) {
    const token = await password({
      message: "Gateway token",
      mask: "*",
    });
    return {
      ...auth,
      token: token.trim(),
    };
  }
  if (auth.mode === "basic" && (!auth.username || !auth.password)) {
    const username = auth.username?.trim() || (await input({ message: "Gateway basic username" }));
    const pass = auth.password || (await password({ message: "Gateway basic password", mask: "*" }));
    return {
      ...auth,
      username: username.trim(),
      password: pass,
    };
  }
  return auth;
}

async function runDoctor(
  client: TuiApiClient,
  profileName: string,
  profilePath: string,
  auth: TuiResolvedAuth,
  args: {
    readOnly: boolean;
    deep: boolean;
    yes: boolean;
    json: boolean;
    auditOnly: boolean;
    noRepair: boolean;
  },
): Promise<void> {
  const spinner = ora("Running doctor checks...").start();
  try {
    const report = await runSharedDoctor({
      gatewayBaseUrl: client.baseUrl,
      profileName,
      profilePath,
      readOnly: args.readOnly,
      deep: args.deep,
      yes: args.yes,
      auditOnly: args.auditOnly,
      noRepair: args.noRepair,
      authToken: auth.token,
      authMode: auth.mode,
      promptConfirm: async (message: string) =>
        confirm({
          message,
          default: false,
        }),
    });
    spinner.stop();
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(chalk.bold("\nGoatCitadel TUI Doctor\n"));
      console.log(renderDoctorReport(report));
    }
    process.exitCode = report.summary.exitCode;
  } catch (error) {
    spinner.fail(`Doctor failed: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}

function printHeader(input: {
  profile: string;
  gateway: string;
  readOnly: boolean;
  liveState: string;
  lastEventAt?: string;
  liveNote?: string;
}): void {
  console.clear();
  console.log(
    renderSection("GoatCitadel Terminal Mission Control", "Operator console for local-first runtime control."),
  );
  console.log(
    renderKeyValueSummary([
      { key: "Profile", value: input.profile },
      { key: "Gateway", value: input.gateway },
      { key: "Live", value: input.liveState },
      { key: "Mode", value: input.readOnly ? "read-only" : "read+safe-write" },
      { key: "Last event", value: input.lastEventAt ? new Date(input.lastEventAt).toLocaleString() : "none yet" },
      ...(input.liveNote ? [{ key: "Feed note", value: summarizeText(input.liveNote, 100) }] : []),
    ]),
  );
  console.log("");
}

async function chooseNextView(): Promise<HomeView> {
  return await select<HomeView>({
    message: "Navigate",
    choices: [
      { name: "Dashboard", value: "dashboard" },
      { name: "Chat", value: "chat" },
      { name: "Approvals", value: "approvals" },
      { name: "Prompt Lab", value: "promptlab" },
      { name: "Memory", value: "memory" },
      { name: "Files", value: "files" },
      { name: "Cron", value: "cron" },
      { name: "Improvement", value: "improvement" },
      { name: "Sessions", value: "sessions" },
      { name: "Costs", value: "costs" },
      { name: "Tools", value: "tools" },
      { name: "Tasks", value: "tasks" },
      { name: "Skills", value: "skills" },
      { name: "Integrations", value: "integrations" },
      { name: "Mesh", value: "mesh" },
      { name: "NPU", value: "npu" },
      { name: "System", value: "system" },
      { name: "Onboarding", value: "onboarding" },
      { name: "Settings", value: "settings" },
      { name: "Exit", value: "exit" },
    ],
  });
}

async function viewDashboard(client: TuiApiClient): Promise<void> {
  const spinner = ora("Loading dashboard...").start();
  const [state, diagnostics, meetStatus] = await Promise.all([
    client.dashboard(),
    client.devDiagnostics(6).catch(() => ({ items: [] })),
    client.googleMeetPrerequisites().catch(() => null),
  ]);
  spinner.stop();
  const sessions = state.sessions ?? [];
  const taskStatusCounts = state.taskStatusCounts ?? [];
  const recentEvents = state.recentEvents ?? [];
  const runtimeDiagnostics = diagnostics.items.filter((item) => item.runtimeKind || item.runtimeStatus);

  console.log(renderSection("Dashboard", "Fast health snapshot before you dive into a view."));
  console.log(
    renderBox(
      "Current state",
      [
        `Timestamp: ${state.timestamp}`,
        `Sessions: ${sessions.length}`,
        `Pending approvals: ${state.pendingApprovals}`,
        `Active subagents: ${state.activeSubagents}`,
        `Daily cost (USD): ${Number(state.dailyCostUsd ?? 0).toFixed(4)}`,
      ],
      "info",
    ),
  );
  console.log(
    renderBox(
      "Task status",
      taskStatusCounts.length > 0
        ? taskStatusCounts.map((item) => `${toText(item.status) || "unknown"}: ${Number(item.count ?? 0)}`)
        : ["No task counters reported."],
      taskStatusCounts.length > 0 ? "info" : "warning",
    ),
  );
  console.log(
    renderBox(
      "Recent events",
      recentEvents.length > 0
        ? recentEvents
            .slice(0, 8)
            .map(
              (event) =>
                `${formatTimestamp(toText(event.timestamp))} · ${toText(event.eventType)} · ${toText(event.source)}`,
            )
        : ["No recent realtime events reported."],
      recentEvents.length > 0 ? "info" : "warning",
    ),
  );
  console.log(
    renderOperatorSection({
      id: "activity",
      title: "Activity",
      lines: recentEvents
        .slice(0, 5)
        .map(
          (event) =>
            `${formatTimestamp(toText(event.timestamp))} · ${toText(event.eventType)} · ${toText(event.source)}`,
        ),
      contentBearing: recentEvents.length > 0,
    }),
  );
  console.log(
    renderOperatorSection({
      id: "diagnostics",
      title: "Diagnostics",
      lines: runtimeDiagnostics
        .slice(0, 5)
        .map(
          (event) =>
            `${event.runtimeStatus ?? event.level} · ${event.runtimeKind ?? event.category} · ${event.message}`,
        ),
      contentBearing: runtimeDiagnostics.length > 0,
    }),
  );
  console.log(
    renderOperatorSection({
      id: "voice_meeting",
      title: "Voice / meeting",
      lines: meetStatus
        ? [
            `Google Meet: ${meetStatus.state} · ${meetStatus.provider}`,
            ...(meetStatus.failureReason ? [`Blocked reason: ${meetStatus.failureReason}`] : []),
            ...meetStatus.prerequisites.map(
              (item) => `${item.ready ? "ready" : "blocked"} · ${item.id}: ${item.message}`,
            ),
          ]
        : [],
      contentBearing: Boolean(meetStatus),
    }),
  );
  await pause();
}

async function viewChat(client: TuiApiClient): Promise<void> {
  const [sessions, runtimeLlm] = await Promise.all([
    client.listChatSessions({ limit: 60, view: "active" }),
    client.fetchLlmConfig().catch(() => null),
  ]);
  console.log(
    renderSection("Chat Workspace", "Start from an existing session or create one. Project creation is optional."),
  );
  if (runtimeLlm) {
    console.log(
      renderBox(
        "Runtime model",
        [
          `Active provider: ${runtimeLlm.activeProviderId}`,
          `Active model: ${runtimeLlm.activeModel}`,
          "New chats fall back to this runtime selection when session prefs are blank.",
        ],
        "info",
      ),
    );
  }
  const sessionItems = sessions.items ?? [];
  if (sessionItems.length > 0) {
    console.log(
      renderBox(
        "Active sessions",
        sessionItems
          .slice(0, MAX_TUI_SESSION_CHOICES)
          .map((session, index) => `${index + 1}. ${formatSessionSummary(session)}`),
        "info",
      ),
    );
    if (sessionItems.length > MAX_TUI_SESSION_CHOICES) {
      console.log(tuiTheme.muted(`Showing ${MAX_TUI_SESSION_CHOICES} of ${sessionItems.length} active sessions.`));
    }
  } else {
    console.log(renderBox("Active sessions", ["No active chat sessions."], "warning"));
  }

  const action = await select({
    message: "Chat action",
    choices: [
      { name: "Back", value: "back" },
      { name: "New chat", value: "create" },
      { name: "Open session", value: "open" },
      { name: "Patch session prefs", value: "prefs" },
    ],
  });
  if (action === "back") {
    return;
  }

  let sessionId: string;
  if (action === "create") {
    const title = await input({ message: "Session title (optional)" });
    const created = await client.createChatSession({ title: title.trim() || undefined });
    sessionId = toText(created.sessionId);
    console.log(
      renderBox(
        "Session created",
        [`Session ID: ${sessionId}`, "You can chat immediately. Creating a separate project is optional."],
        "success",
      ),
    );
  } else {
    sessionId = await chooseSessionId(
      sessionItems,
      action === "prefs" ? "Choose session to patch" : "Choose session to open",
    );
  }
  if (!sessionId) {
    await pause();
    return;
  }

  if (action === "prefs") {
    const mode = await select<"chat" | "cowork" | "code">({
      message: "Mode",
      choices: [
        { name: "chat", value: "chat" },
        { name: "cowork", value: "cowork" },
        { name: "code", value: "code" },
      ],
    });
    const webMode = await select<"auto" | "off" | "quick" | "deep">({
      message: "Web mode",
      choices: [
        { name: "auto", value: "auto" },
        { name: "off", value: "off" },
        { name: "quick", value: "quick" },
        { name: "deep", value: "deep" },
      ],
    });
    const memoryMode = await select<"auto" | "on" | "off">({
      message: "Memory mode",
      choices: [
        { name: "auto", value: "auto" },
        { name: "on", value: "on" },
        { name: "off", value: "off" },
      ],
    });
    const thinkingLevel = await select<"off" | "minimal" | "standard" | "extended" | "deep">({
      message: "Thinking level",
      choices: [
        { name: "off", value: "off" },
        { name: "minimal", value: "minimal" },
        { name: "standard", value: "standard" },
        { name: "extended", value: "extended" },
        { name: "deep", value: "deep" },
      ],
    });
    const speedMode = await select<"standard" | "fast">({
      message: "Speed mode",
      choices: [
        { name: "standard", value: "standard" },
        { name: "fast", value: "fast" },
      ],
    });
    const subagentPolicy = await select<"off" | "ask_when_useful" | "auto_when_useful">({
      message: "Subagent policy",
      choices: [
        { name: "off", value: "off" },
        { name: "ask when useful", value: "ask_when_useful" },
        { name: "auto when useful", value: "auto_when_useful" },
      ],
    });
    const confirmed = await confirm({ message: `Patch prefs for ${sessionId}?`, default: false });
    if (!confirmed) {
      return;
    }
    const patched = await client.patchChatPrefs(sessionId, {
      mode,
      webMode,
      memoryMode,
      thinkingLevel,
      speedMode,
      subagentPolicy,
    });
    console.log(
      renderBox(
        "Session prefs updated",
        [
          `Session: ${sessionId}`,
          `Mode: ${toText(patched.mode ?? mode)}`,
          `Web: ${toText(patched.webMode ?? webMode)}`,
          `Memory: ${toText(patched.memoryMode ?? memoryMode)}`,
          `Thinking: ${toText(patched.thinkingLevel ?? thinkingLevel)}`,
          `Speed: ${toText(patched.speedMode ?? speedMode)}`,
          `Subagents: ${toText(patched.subagentPolicy ?? subagentPolicy)}`,
        ],
        "success",
      ),
    );
    await pause();
    return;
  }

  const messages = await client.listChatMessages(sessionId, 30);
  const messageItems = messages.items ?? [];
  if (messageItems.length > 0) {
    console.log(
      renderBox(
        `Recent messages for ${sessionId}`,
        messageItems
          .slice(-8)
          .map(
            (msg) =>
              `${toText(msg.role) || "unknown"} · ${formatTimestamp(toText(msg.createdAt))} · ${summarizeText(toText(msg.content), 140)}`,
          ),
        "info",
      ),
    );
  }

  const content = (await input({ message: "Message (blank to return)" })).trim();
  if (!content) {
    return;
  }

  let mode: "chat" | "cowork" | "code" = "chat";
  let webMode: "auto" | "off" | "quick" | "deep" = "auto";
  let memoryMode: "auto" | "on" | "off" = "auto";
  let thinkingLevel: "off" | "minimal" | "standard" | "extended" | "deep" = "standard";
  let speedMode: "standard" | "fast" = "standard";
  let subagentPolicy: "off" | "ask_when_useful" | "auto_when_useful" = "ask_when_useful";
  let agentMode = true;

  const sendStyle = await select({
    message: "Send style",
    choices: [
      {
        name: "Quick send (chat/auto/standard)",
        value: "quick",
        description: "Send immediately with sensible defaults.",
      },
      {
        name: "Configure options",
        value: "configure",
        description: "Choose mode, web, memory, thinking, speed, subagents, and agent path before sending.",
      },
    ],
  });
  if (sendStyle === "configure") {
    mode = await select<"chat" | "cowork" | "code">({
      message: "Send mode",
      choices: [
        { name: "chat", value: "chat" },
        { name: "cowork", value: "cowork" },
        { name: "code", value: "code" },
      ],
    });
    webMode = await select<"auto" | "off" | "quick" | "deep">({
      message: "Web mode",
      choices: [
        { name: "auto", value: "auto" },
        { name: "off", value: "off" },
        { name: "quick", value: "quick" },
        { name: "deep", value: "deep" },
      ],
    });
    memoryMode = await select<"auto" | "on" | "off">({
      message: "Memory mode",
      choices: [
        { name: "auto", value: "auto" },
        { name: "on", value: "on" },
        { name: "off", value: "off" },
      ],
    });
    thinkingLevel = await select<"off" | "minimal" | "standard" | "extended" | "deep">({
      message: "Thinking level",
      choices: [
        { name: "off", value: "off" },
        { name: "minimal", value: "minimal" },
        { name: "standard", value: "standard" },
        { name: "extended", value: "extended" },
        { name: "deep", value: "deep" },
      ],
    });
    speedMode = await select<"standard" | "fast">({
      message: "Speed mode",
      choices: [
        { name: "standard", value: "standard" },
        { name: "fast", value: "fast" },
      ],
    });
    subagentPolicy = await select<"off" | "ask_when_useful" | "auto_when_useful">({
      message: "Subagent policy",
      choices: [
        { name: "off", value: "off" },
        { name: "ask when useful", value: "ask_when_useful" },
        { name: "auto when useful", value: "auto_when_useful" },
      ],
    });
    agentMode = await confirm({
      message: "Use agent-send stream (tools/delegation path)?",
      default: true,
    });
  }

  console.log(
    renderBox(
      "Request",
      [
        `Session: ${sessionId}`,
        `Mode: ${mode} / web ${webMode} / memory ${memoryMode} / thinking ${thinkingLevel} / speed ${speedMode}`,
        `Subagents: ${subagentPolicy}`,
        `Agent path: ${agentMode ? "enabled" : "off"}`,
        `Prompt: ${content}`,
      ],
      "info",
    ),
  );
  console.log(tuiTheme.heading("\nAssistant response"));
  let done = false;
  let renderedAny = false;
  let capabilitySuggestions: ChatCapabilityUpgradeSuggestion[] = [];
  for await (const event of client.streamChatMessage(sessionId, {
    content,
    mode,
    webMode,
    memoryMode,
    thinkingLevel,
    speedMode,
    subagentPolicy,
    agentMode,
  })) {
    const type = toText(event.type);
    if (type === "delta") {
      const delta = toText(event.delta);
      if (delta) {
        process.stdout.write(delta);
        renderedAny = true;
      }
      continue;
    }
    if (type === "message_done") {
      const full = toText(event.content);
      if (!renderedAny && full) {
        process.stdout.write(full);
      }
      process.stdout.write("\n");
      continue;
    }
    if (type === "tool_start") {
      const toolRun = asRecord(event.toolRun);
      console.log(
        renderBox("Tool start", [`Tool: ${toText(toolRun.toolName)}`, `Status: ${toText(toolRun.status)}`], "info"),
      );
      continue;
    }
    if (type === "tool_result") {
      const toolRun = asRecord(event.toolRun);
      console.log(
        renderBox("Tool result", [`Tool: ${toText(toolRun.toolName)}`, `Status: ${toText(toolRun.status)}`], "success"),
      );
      continue;
    }
    if (type === "trace_update") {
      const trace = asRecord(event.trace);
      const routing = asRecord(trace.routing);
      const note = toText(routing.fallbackReason);
      const rawSuggestions = trace.capabilityUpgradeSuggestions;
      const suggestions = Array.isArray(rawSuggestions) ? (rawSuggestions as ChatCapabilityUpgradeSuggestion[]) : [];
      if (suggestions.length > 0) {
        capabilitySuggestions = suggestions;
      }
      if (note) {
        console.log(renderBox("Routing note", [note], "warning"));
      }
      continue;
    }
    if (type === "capability_upgrade_suggestion") {
      const rawSuggestions = event.capabilityUpgradeSuggestions;
      const suggestions = Array.isArray(rawSuggestions) ? (rawSuggestions as ChatCapabilityUpgradeSuggestion[]) : [];
      if (suggestions.length > 0) {
        capabilitySuggestions = suggestions;
      }
      continue;
    }
    if (type === "approval_required") {
      const approval = asRecord(event.approval);
      console.log(
        renderBox(
          "Approval required",
          [
            `Approval ID: ${toText(approval.approvalId)}`,
            `Tool: ${toText(approval.toolName) || "unknown"}`,
            `Reason: ${toText(approval.reason) || "Review before continuing."}`,
          ],
          "warning",
        ),
      );
      continue;
    }
    if (type === "error") {
      console.log(renderBox("Error", [toText(event.error)], "danger"));
      continue;
    }
    if (type === "done") {
      done = true;
      break;
    }
  }
  if (!done) {
    console.log(renderBox("Stream note", ["Stream ended without an explicit done event."], "warning"));
  }
  if (capabilitySuggestions.length > 0) {
    await handleCapabilitySuggestions(client, capabilitySuggestions);
  }
  await pause();
}

async function viewPromptLab(client: TuiApiClient): Promise<void> {
  const packs = await client.listPromptPacks(80);
  console.log(chalk.bold("Prompt Packs"));
  const packItems = packs.items ?? [];
  if (packItems.length === 0) {
    console.log("No prompt packs available.");
    await pause();
    return;
  }
  console.table(
    packItems.map((pack) => ({
      packId: toText(pack.packId),
      label: toText(pack.label),
      version: toText(pack.version),
      tests: Number(pack.testCount ?? 0),
      updatedAt: toText(pack.updatedAt),
    })),
  );

  const action = await select({
    message: "Prompt Lab action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Run single test", value: "run-test" },
      { name: "Run benchmark", value: "benchmark" },
      { name: "Benchmark status", value: "benchmark-status" },
      { name: "Report summary", value: "report" },
      { name: "Replay regression run", value: "replay-run" },
      { name: "Replay regression status", value: "replay-status" },
      { name: "Capability trends", value: "trends" },
    ],
  });
  if (action === "back") {
    return;
  }

  if (action === "benchmark-status") {
    const benchmarkRunId = (await input({ message: "Benchmark run ID" })).trim();
    if (!benchmarkRunId) {
      return;
    }
    const status = await client.getPromptPackBenchmark(benchmarkRunId);
    console.log(JSON.stringify(status, null, 2));
    await pause();
    return;
  }
  if (action === "replay-status") {
    const runId = (await input({ message: "Replay regression run ID" })).trim();
    if (!runId) {
      return;
    }
    const status = await client.getPromptPackReplayRegression(runId);
    console.log(JSON.stringify(status, null, 2));
    await pause();
    return;
  }

  const packId = (await input({ message: "Pack ID" })).trim();
  if (!packId) {
    return;
  }

  if (action === "run-test") {
    const tests = await client.listPromptPackTests(packId, 200);
    console.table(
      tests.items.map((test) => ({
        testId: toText(test.testId),
        code: toText(test.code),
        category: toText(test.category),
        title: toText(test.title),
      })),
    );
    const testId = (await input({ message: "Test ID" })).trim();
    if (!testId) {
      return;
    }
    const sessionId = (await input({ message: "Session ID (optional)" })).trim();
    const run = await client.runPromptPackTest(packId, testId, {
      sessionId: sessionId || undefined,
    });
    console.log(JSON.stringify(run, null, 2));
    await pause();
    return;
  }

  if (action === "benchmark") {
    const testsCsv = (
      await input({
        message: "Test codes CSV (optional)",
      })
    ).trim();
    const launched = await client.runPromptPackBenchmark(packId, {
      testCodes: testsCsv
        ? testsCsv
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined,
    });
    console.log(JSON.stringify(launched, null, 2));
    await pause();
    return;
  }

  if (action === "report") {
    const report = await client.getPromptPackReport(packId);
    console.log(JSON.stringify(report, null, 2));
    await pause();
    return;
  }

  if (action === "replay-run") {
    const launched = await client.runPromptPackReplayRegression(packId, {});
    console.log(JSON.stringify(launched, null, 2));
    await pause();
    return;
  }

  const trends = await client.getPromptPackTrends(packId);
  console.log(JSON.stringify(trends, null, 2));
  await pause();
}

async function viewMemoryLifecycle(client: TuiApiClient): Promise<void> {
  const namespace = (await input({ message: "Namespace filter (optional)" })).trim();
  const query = (await input({ message: "Text query (optional)" })).trim();
  const status = await select<"active" | "forgotten" | "all">({
    message: "Status filter",
    choices: [
      { name: "active", value: "active" },
      { name: "forgotten", value: "forgotten" },
      { name: "all", value: "all" },
    ],
  });
  const list = await client.listMemoryItems({
    namespace: namespace || undefined,
    query: query || undefined,
    status,
    limit: 120,
  });

  console.log(chalk.bold("Memory Items"));
  const memoryItems = list.items ?? [];
  if (memoryItems.length === 0) {
    console.log("No memory items found.");
  } else {
    console.table(
      memoryItems.map((item) => ({
        itemId: toText(item.itemId),
        namespace: toText(item.namespace),
        title: toText(item.title),
        status: toText(item.status),
        pinned: Boolean(item.pinned),
        updatedAt: toText(item.updatedAt),
      })),
    );
  }

  const action = await select({
    message: "Memory action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Patch item", value: "patch" },
      { name: "Forget single item", value: "forget-one" },
      { name: "Forget many (criteria)", value: "forget-many" },
      { name: "View item history", value: "history" },
    ],
  });
  if (action === "back") {
    return;
  }

  if (action === "patch") {
    const itemId = (await input({ message: "Item ID" })).trim();
    if (!itemId) {
      return;
    }
    const title = await input({ message: "New title (optional)" });
    const content = await input({ message: "New content (optional)" });
    const setPinned = await confirm({ message: "Set pinned=true?", default: false });
    const clearTtl = await confirm({ message: "Clear TTL override?", default: false });
    const ttlRaw = clearTtl ? "" : (await input({ message: "TTL override seconds (optional)" })).trim();
    const ttlValue = ttlRaw ? Number(ttlRaw) : undefined;
    const patch: Record<string, unknown> = {};
    if (title.trim()) {
      patch.title = title.trim();
    }
    if (content.trim()) {
      patch.content = content.trim();
    }
    patch.pinned = setPinned;
    if (clearTtl) {
      patch.ttlOverrideSeconds = null;
    } else if (!Number.isNaN(ttlValue) && ttlValue && ttlValue > 0) {
      patch.ttlOverrideSeconds = ttlValue;
    }
    const confirmed = await confirm({ message: `Patch memory item ${itemId}?`, default: false });
    if (!confirmed) {
      return;
    }
    const updated = await client.patchMemoryItem(itemId, patch);
    console.log(JSON.stringify(updated, null, 2));
    await pause();
    return;
  }

  if (action === "forget-one") {
    const itemId = (await input({ message: "Item ID" })).trim();
    if (!itemId) {
      return;
    }
    const confirmed = await confirm({ message: `Forget ${itemId}?`, default: false });
    if (!confirmed) {
      return;
    }
    const result = await client.forgetMemoryItem(itemId);
    console.log(JSON.stringify(result, null, 2));
    await pause();
    return;
  }

  if (action === "forget-many") {
    const ids = (await input({ message: "Item IDs CSV (optional)" })).trim();
    const forgetNamespace = (await input({ message: "Namespace criterion (optional)" })).trim();
    const forgetQuery = (await input({ message: "Query criterion (optional)" })).trim();
    const confirmed = await confirm({
      message: "Forget all matching criteria? This cannot be undone.",
      default: false,
    });
    if (!confirmed) {
      return;
    }
    const result = await client.forgetMemory({
      itemIds: ids
        ? ids
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined,
      namespace: forgetNamespace || undefined,
      query: forgetQuery || undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    await pause();
    return;
  }

  const itemId = (await input({ message: "Item ID" })).trim();
  if (!itemId) {
    return;
  }
  const history = await client.listMemoryItemHistory(itemId, 80);
  console.table(
    history.items.map((entry) => ({
      eventId: toText(entry.eventId),
      action: toText(entry.action),
      actorId: toText(entry.actorId),
      createdAt: toText(entry.createdAt),
    })),
  );
  await pause();
}

async function viewFiles(client: TuiApiClient): Promise<void> {
  const dir = (await input({ message: "Directory", default: "." })).trim() || ".";
  const listed = await client.listFiles({ dir, limit: 250 });
  console.log(chalk.bold(`Files in ${dir}`));
  console.table(
    listed.items.map((item) => ({
      path: toText(item.relativePath),
      bytes: Number(item.size ?? 0),
      modifiedAt: toText(item.modifiedAt),
      directory: Boolean(item.directory),
    })),
  );

  const action = await select({
    message: "Files action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Read file", value: "read" },
      { name: "Write file", value: "write" },
    ],
  });
  if (action === "back") {
    return;
  }
  const pathInput = (await input({ message: "Relative path" })).trim();
  if (!pathInput) {
    return;
  }
  if (action === "read") {
    const downloaded = await client.downloadFile(pathInput);
    console.log(chalk.bold(`File: ${toText(downloaded.relativePath)} (${toText(downloaded.contentType)})`));
    console.log(String(downloaded.content ?? "").slice(0, 6_000));
    await pause();
    return;
  }

  const content = await input({ message: "File content" });
  const confirmed = await confirm({ message: `Write ${pathInput}?`, default: false });
  if (!confirmed) {
    return;
  }
  const written = await client.uploadFile(pathInput, content);
  console.log(JSON.stringify(written, null, 2));
  await pause();
}

async function viewCron(client: TuiApiClient): Promise<void> {
  const [jobs, queue] = await Promise.all([
    client.listCronJobs(),
    client.listCronReviewQueue(80).catch(() => ({ items: [] as Array<Record<string, unknown>> })),
  ]);
  console.log(chalk.bold("Cron Jobs"));
  console.table(
    jobs.items.map((job) => ({
      jobId: toText(job.jobId),
      name: toText(job.name),
      schedule: toText(job.schedule),
      enabled: Boolean(job.enabled),
      lastRunAt: toText(job.lastRunAt),
      lastStatus: toText(job.lastStatus),
    })),
  );
  const queueItems = queue.items ?? [];
  if (queueItems.length > 0) {
    console.log(chalk.bold("Review Queue"));
    console.table(
      queueItems.map((item) => ({
        itemId: toText(item.itemId),
        status: toText(item.status),
        severity: toText(item.severity),
        createdAt: toText(item.createdAt),
      })),
    );
  }

  const action = await select({
    message: "Cron action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Run job now", value: "run" },
      { name: "Start job", value: "start" },
      { name: "Pause job", value: "pause" },
      { name: "Delete job", value: "delete" },
      { name: "Retry review item", value: "retry-review" },
      { name: "Show run diff", value: "run-diff" },
    ],
  });
  if (action === "back") {
    return;
  }

  if (action === "retry-review") {
    const itemId = (await input({ message: "Review item ID" })).trim();
    if (!itemId) {
      return;
    }
    const confirmed = await confirm({ message: `Retry review item ${itemId}?`, default: false });
    if (!confirmed) {
      return;
    }
    const retried = await client.retryCronReviewItem(itemId);
    console.log(JSON.stringify(retried, null, 2));
    await pause();
    return;
  }

  if (action === "run-diff") {
    const runId = (await input({ message: "Run ID" })).trim();
    if (!runId) {
      return;
    }
    const diff = await client.getCronRunDiff(runId);
    console.log(JSON.stringify(diff, null, 2));
    await pause();
    return;
  }

  const jobId = (await input({ message: "Job ID" })).trim();
  if (!jobId) {
    return;
  }
  const confirmed = await confirm({ message: `Confirm ${action} on ${jobId}?`, default: false });
  if (!confirmed) {
    return;
  }
  const result =
    action === "run"
      ? await client.runCronJob(jobId)
      : action === "start"
        ? await client.startCronJob(jobId)
        : action === "pause"
          ? await client.pauseCronJob(jobId)
          : await client.deleteCronJob(jobId);
  console.log(JSON.stringify(result, null, 2));
  await pause();
}

async function viewImprovement(client: TuiApiClient): Promise<void> {
  const [reports, runs] = await Promise.all([client.listImprovementReports(20), client.listImprovementReplayRuns(30)]);

  console.log(chalk.bold("Improvement Reports"));
  console.table(
    reports.items.map((report) => ({
      reportId: toText(report.reportId),
      status: toText(report.status),
      createdAt: toText(report.createdAt),
      summary: toText(report.summary).slice(0, 70),
    })),
  );
  console.log(chalk.bold("Replay Runs"));
  console.table(
    runs.items.map((run) => ({
      runId: toText(run.runId),
      status: toText(run.status),
      startedAt: toText(run.startedAt),
      score: Number(run.score ?? 0),
    })),
  );

  const action = await select({
    message: "Improvement action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Run manual replay", value: "manual-run" },
      { name: "Show report detail", value: "report" },
      { name: "Show replay run detail", value: "run" },
      { name: "Create replay override draft", value: "draft" },
      { name: "Execute replay override", value: "execute" },
      { name: "Show replay diff", value: "diff" },
    ],
  });
  if (action === "back") {
    return;
  }

  if (action === "manual-run") {
    const sampleSizeRaw = (await input({ message: "Sample size (optional)" })).trim();
    const sampleSize = sampleSizeRaw ? Number(sampleSizeRaw) : undefined;
    const launched = await client.runImprovementReplay(sampleSize && !Number.isNaN(sampleSize) ? { sampleSize } : {});
    console.log(JSON.stringify(launched, null, 2));
    await pause();
    return;
  }

  if (action === "report") {
    const reportId = (await input({ message: "Report ID" })).trim();
    if (!reportId) {
      return;
    }
    const report = await client.getImprovementReport(reportId);
    console.log(JSON.stringify(report, null, 2));
    await pause();
    return;
  }

  if (action === "run") {
    const runId = (await input({ message: "Replay run ID" })).trim();
    if (!runId) {
      return;
    }
    const run = await client.getImprovementReplayRun(runId);
    console.log(JSON.stringify(run, null, 2));
    await pause();
    return;
  }

  if (action === "diff") {
    const replayRunId = (await input({ message: "Replay run ID for diff" })).trim();
    if (!replayRunId) {
      return;
    }
    const diff = await client.getReplayDiff(replayRunId);
    console.log(JSON.stringify(diff, null, 2));
    await pause();
    return;
  }

  const runId = (await input({ message: "Base run ID" })).trim();
  if (!runId) {
    return;
  }
  const overrideJson =
    (
      await input({
        message: "Overrides JSON array (blank for [])",
        default: "[]",
      })
    ).trim() || "[]";
  let overrides: Array<Record<string, unknown>>;
  try {
    overrides = JSON.parse(overrideJson) as Array<Record<string, unknown>>;
    if (!Array.isArray(overrides)) {
      throw new Error("Overrides must be an array");
    }
  } catch (error) {
    console.log(chalk.red(`Invalid override JSON: ${(error as Error).message}`));
    await pause();
    return;
  }
  const result =
    action === "draft"
      ? await client.createReplayDraft(runId, overrides)
      : await client.executeReplayOverride(runId, overrides);
  console.log(JSON.stringify(result, null, 2));
  await pause();
}

async function viewApprovals(client: TuiApiClient): Promise<void> {
  const status = await select({
    message: "Approval status filter",
    choices: [
      { name: "pending", value: "pending" },
      { name: "approved", value: "approved" },
      { name: "rejected", value: "rejected" },
      { name: "edited", value: "edited" },
    ],
  });

  const approvals = await client.listApprovals(status);
  console.log(chalk.bold(`Approvals (${status})`));
  const approvalItems = approvals.items ?? [];
  if (approvalItems.length === 0) {
    console.log("No approvals in this status.");
    await pause();
    return;
  }
  console.table(
    approvalItems.map((approval) => ({
      approvalId: approval.approvalId,
      kind: approval.kind,
      riskLevel: approval.riskLevel,
      status: approval.status,
      explanation: approval.explanationStatus,
      createdAt: approval.createdAt,
    })),
  );

  const selectedId = await input({
    message: "Enter approvalId to inspect/resolve (blank to return)",
  });
  if (!selectedId.trim()) {
    return;
  }

  const replay = await client.getApprovalReplay(selectedId.trim());
  console.log(chalk.bold("Approval Detail"));
  console.log(JSON.stringify(replay.approval, null, 2));
  const replayEvents = replay.events ?? [];
  if (replayEvents.length > 0) {
    console.log(chalk.bold("Replay Trail"));
    console.table(
      replayEvents.map((event) => ({
        timestamp: event.timestamp,
        eventType: event.eventType,
        actorId: event.actorId,
      })),
    );
  }

  if (replay.approval.status !== "pending") {
    await pause();
    return;
  }

  const action = await select<"approve" | "reject" | "skip">({
    message: "Resolve approval?",
    choices: [
      { name: "Approve", value: "approve" },
      { name: "Reject", value: "reject" },
      { name: "Leave pending", value: "skip" },
    ],
  });
  if (action === "skip") {
    return;
  }

  const confirmed = await confirm({
    message: `Confirm ${action} for ${replay.approval.approvalId}?`,
    default: false,
  });
  if (!confirmed) {
    return;
  }

  const result = await client.resolveApproval(replay.approval.approvalId, action);
  console.log(`Resolved: ${toText(result.approval?.status ?? action)}`);
  await pause();
}

async function viewSessions(client: TuiApiClient): Promise<void> {
  const sessions = await client.listSessions(100);
  console.log(chalk.bold("Sessions"));
  console.table(
    (sessions.items ?? []).map((session) => ({
      sessionId: session.sessionId,
      kind: session.kind,
      health: session.health,
      tokenTotal: session.tokenTotal,
      costUsdTotal: Number((session.costUsdTotal ?? 0).toFixed(4)),
      updatedAt: session.updatedAt,
    })),
  );
  await pause();
}

async function viewCosts(client: TuiApiClient): Promise<void> {
  const scope = await select<"day" | "session" | "agent" | "task">({
    message: "Cost scope",
    choices: [
      { name: "day", value: "day" },
      { name: "session", value: "session" },
      { name: "agent", value: "agent" },
      { name: "task", value: "task" },
    ],
  });
  const costs = await client.listCosts(scope);
  const qmd = await client.listMemoryQmdStats();
  console.log(chalk.bold(`Costs (${scope})`));
  console.table(
    (costs.items ?? []).map((item) => ({
      key: item.key,
      tokenTotal: item.tokenTotal,
      costUsd: Number((item.costUsd ?? 0).toFixed(4)),
    })),
  );
  console.log(
    `QMD: ${qmd.totalRuns ?? 0} runs, ${Number(qmd.savingsPercent ?? 0).toFixed(1)}% estimated savings ` +
      `(${qmd.originalTokenEstimate ?? 0} -> ${qmd.distilledTokenEstimate ?? 0})`,
  );

  const cheaper = await confirm({
    message: "Run cheaper recommendation?",
    default: false,
  });
  if (cheaper) {
    const res = await client.runCheaper();
    console.log(chalk.bold(`Mode: ${res.mode ?? "unchanged"}`));
    for (const action of Array.isArray(res.actions) ? res.actions : []) {
      console.log(`- ${action}`);
    }
  }
  await pause();
}

async function viewTools(client: TuiApiClient): Promise<void> {
  const [catalog, grants] = await Promise.all([client.toolsCatalog(), client.toolsListGrants({ limit: 500 })]);

  console.log(chalk.bold("Tool Catalog"));
  console.table(
    catalog.items.map((item) => ({
      toolName: item.toolName,
      category: item.category,
      risk: item.riskLevel,
      requiresApproval: item.requiresApproval,
      pack: item.pack,
    })),
  );

  console.log(chalk.bold("Tool Grants"));
  console.table(
    grants.items.map((grant) => ({
      grantId: grant.grantId,
      toolPattern: grant.toolPattern,
      decision: grant.decision,
      scope: `${grant.scope}:${grant.scopeRef}`,
      grantType: grant.grantType,
      expiresAt: grant.expiresAt ?? "",
      revokedAt: grant.revokedAt ?? "",
    })),
  );

  const action = await select({
    message: "Tools action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Evaluate access", value: "evaluate" },
      { name: "Create grant", value: "create-grant" },
      { name: "Revoke grant", value: "revoke-grant" },
      { name: "Invoke dry-run", value: "dry-run" },
    ],
  });

  if (action === "back") {
    return;
  }

  if (action === "evaluate") {
    const toolName = await input({ message: "Tool name" });
    const agentId = await input({ message: "Agent ID", default: "operator" });
    const sessionId = await input({ message: "Session ID", default: "demo-session" });
    const taskId = await input({ message: "Task ID (optional)" });
    const result = await client.toolsEvaluateAccess({
      toolName,
      agentId,
      sessionId,
      taskId: taskId.trim() || undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    await pause();
    return;
  }

  if (action === "create-grant") {
    const toolPattern = await input({ message: "Tool pattern", default: "fs.list" });
    const decision = await select<"allow" | "deny">({
      message: "Decision",
      choices: [
        { name: "allow", value: "allow" },
        { name: "deny", value: "deny" },
      ],
    });
    const scope = await select<"global" | "session" | "agent" | "task">({
      message: "Scope",
      choices: [
        { name: "global", value: "global" },
        { name: "session", value: "session" },
        { name: "agent", value: "agent" },
        { name: "task", value: "task" },
      ],
    });
    const scopeRef = scope === "global" ? "" : await input({ message: "Scope ref" });
    const grantType = await select<"one_time" | "ttl" | "persistent">({
      message: "Grant type",
      choices: [
        { name: "one_time", value: "one_time" },
        { name: "ttl", value: "ttl" },
        { name: "persistent", value: "persistent" },
      ],
    });
    const expiresAt = await input({ message: "Expires at ISO (optional)" });
    const createdBy = await input({ message: "Created by", default: "tui-operator" });
    const confirmed = await confirm({ message: "Create grant?", default: false });
    if (!confirmed) {
      return;
    }

    const created = await client.toolsCreateGrant({
      toolPattern,
      decision,
      scope,
      scopeRef: scope === "global" ? undefined : scopeRef.trim() || undefined,
      grantType,
      expiresAt: expiresAt.trim() || undefined,
      createdBy: createdBy.trim() || "tui-operator",
    });
    console.log(JSON.stringify(created, null, 2));
    await pause();
    return;
  }

  if (action === "revoke-grant") {
    const grantId = await input({ message: "Grant ID" });
    const confirmed = await confirm({ message: `Revoke grant ${grantId}?`, default: false });
    if (!confirmed) {
      return;
    }
    const result = await client.toolsRevokeGrant(grantId.trim());
    console.log(JSON.stringify(result, null, 2));
    await pause();
    return;
  }

  const toolName = await input({ message: "Tool name", default: "fs.list" });
  const argsRaw = await input({ message: "Args JSON", default: '{"path":"./workspace"}' });
  const agentId = await input({ message: "Agent ID", default: "operator" });
  const sessionId = await input({ message: "Session ID", default: "demo-session" });
  const taskId = await input({ message: "Task ID (optional)" });
  const parsedArgs = JSON.parse(argsRaw) as Record<string, unknown>;
  const result = await client.toolsInvoke({
    toolName,
    args: parsedArgs,
    agentId,
    sessionId,
    taskId: taskId.trim() || undefined,
    dryRun: true,
    consentContext: {
      source: "tui",
      operatorId: "tui-operator",
      reason: "tools dry-run",
    },
  });
  console.log(JSON.stringify(result, null, 2));
  await pause();
}

async function viewTasks(client: TuiApiClient): Promise<void> {
  const tasks = await client.listTasks();
  const items = tasks.items;
  console.log(chalk.bold("Tasks"));
  console.table(
    items.map((task) => ({
      taskId: String(task.taskId ?? ""),
      status: String(task.status ?? ""),
      priority: String(task.priority ?? ""),
      title: String(task.title ?? ""),
      assignedAgentId: String(task.assignedAgentId ?? ""),
      updatedAt: String(task.updatedAt ?? ""),
    })),
  );

  const action = await select({
    message: "Task action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Create task", value: "create" },
      { name: "Update task status", value: "update" },
      { name: "Add task activity", value: "activity" },
    ],
  });
  if (action === "back") {
    return;
  }

  if (action === "create") {
    const title = await input({ message: "Title" });
    const description = await input({ message: "Description (optional)" });
    const priority = await select<"low" | "normal" | "high" | "urgent">({
      message: "Priority",
      choices: [
        { name: "low", value: "low" },
        { name: "normal", value: "normal" },
        { name: "high", value: "high" },
        { name: "urgent", value: "urgent" },
      ],
    });
    const confirmed = await confirm({
      message: "Create task?",
      default: true,
    });
    if (!confirmed) {
      return;
    }
    const created = await client.createTask({
      title,
      description: description.trim() || undefined,
      priority,
    });
    console.log(`Created task ${created.taskId as string}`);
    await pause();
    return;
  }

  const taskId = await input({ message: "Task ID" });
  if (!taskId.trim()) {
    return;
  }

  if (action === "update") {
    const status = await select({
      message: "New status",
      choices: [
        { name: "planning", value: "planning" },
        { name: "inbox", value: "inbox" },
        { name: "assigned", value: "assigned" },
        { name: "in_progress", value: "in_progress" },
        { name: "testing", value: "testing" },
        { name: "review", value: "review" },
        { name: "done", value: "done" },
        { name: "blocked", value: "blocked" },
      ],
    });
    const confirmed = await confirm({
      message: `Set task ${taskId} to ${status}?`,
      default: false,
    });
    if (!confirmed) {
      return;
    }
    await client.updateTask(taskId.trim(), { status });
    console.log("Task updated.");
    await pause();
    return;
  }

  if (action === "activity") {
    const message = await input({ message: "Activity message" });
    const activityType = await select({
      message: "Activity type",
      choices: [
        { name: "comment", value: "comment" },
        { name: "updated", value: "updated" },
        { name: "status_changed", value: "status_changed" },
        { name: "file_created", value: "file_created" },
        { name: "spawned", value: "spawned" },
        { name: "completed", value: "completed" },
      ],
    });
    const confirmed = await confirm({
      message: "Append activity?",
      default: true,
    });
    if (!confirmed) {
      return;
    }
    await client.appendTaskActivity(taskId.trim(), {
      activityType,
      message,
      agentId: "tui-operator",
    });
    console.log("Task activity appended.");
    await pause();
  }
}

async function viewSkills(client: TuiApiClient): Promise<void> {
  const skills = await client.listSkills();
  console.log(chalk.bold("Skills"));
  console.table(
    skills.items.map((skill) => ({
      skillId: String(skill.skillId ?? ""),
      name: String(skill.name ?? ""),
      source: String(skill.source ?? ""),
      tools: Array.isArray(skill.declaredTools) ? skill.declaredTools.join(",") : "",
    })),
  );

  const action = await select({
    message: "Skill action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Reload skills", value: "reload" },
      { name: "Resolve activation", value: "resolve" },
    ],
  });
  if (action === "reload") {
    const result = await client.reloadSkills();
    console.log(`Reloaded ${(result.items ?? []).length} skills.`);
    await pause();
  } else if (action === "resolve") {
    const text = await input({ message: "Prompt text for activation resolution" });
    const decision = await client.resolveSkills(text);
    console.log(JSON.stringify(decision, null, 2));
    await pause();
  }
}

async function viewIntegrations(client: TuiApiClient): Promise<void> {
  const catalog = await client.integrationCatalog();
  const connections = await client.integrationConnections();
  console.log(chalk.bold("Integration Catalog"));
  console.table(
    catalog.items.map((entry) => ({
      catalogId: String(entry.catalogId ?? ""),
      kind: String(entry.kind ?? ""),
      key: String(entry.key ?? ""),
      maturity: String(entry.maturity ?? ""),
    })),
  );
  console.log(chalk.bold("Integration Connections"));
  console.table(
    connections.items.map((connection) => ({
      connectionId: String(connection.connectionId ?? ""),
      catalogId: String(connection.catalogId ?? ""),
      label: String(connection.label ?? ""),
      status: String(connection.status ?? ""),
      enabled: Boolean(connection.enabled),
    })),
  );

  const action = await select({
    message: "Integration action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Create connection", value: "create" },
      { name: "Toggle connection", value: "toggle" },
      { name: "Delete connection", value: "delete" },
    ],
  });
  if (action === "create") {
    const catalogId = await input({ message: "Catalog ID" });
    const label = await input({ message: "Label" });
    const confirmed = await confirm({ message: "Create integration connection?", default: true });
    if (!confirmed) {
      return;
    }
    await client.createIntegrationConnection({
      catalogId,
      label,
      enabled: true,
      status: "connected",
      config: {},
    });
    console.log("Connection created.");
    await pause();
    return;
  }

  const connectionId = await input({ message: "Connection ID" });
  if (!connectionId.trim()) {
    return;
  }
  if (action === "toggle") {
    const next = await select({
      message: "Set status",
      choices: [
        { name: "connected", value: "connected" },
        { name: "disconnected", value: "disconnected" },
        { name: "paused", value: "paused" },
        { name: "error", value: "error" },
      ],
    });
    const enabled = await confirm({ message: "Enabled?", default: next === "connected" });
    const confirmed = await confirm({ message: "Update connection?", default: false });
    if (!confirmed) {
      return;
    }
    await client.updateIntegrationConnection(connectionId.trim(), {
      status: next,
      enabled,
    });
    console.log("Connection updated.");
    await pause();
    return;
  }

  if (action === "delete") {
    const confirmed = await confirm({ message: `Delete connection ${connectionId}?`, default: false });
    if (!confirmed) {
      return;
    }
    await client.deleteIntegrationConnection(connectionId.trim());
    console.log("Connection deleted.");
    await pause();
  }
}

async function viewMesh(client: TuiApiClient): Promise<void> {
  const [status, nodes, leases, owners, offsets] = await Promise.all([
    client.meshStatus(),
    client.meshNodes(),
    client.meshLeases(),
    client.meshOwners(),
    client.meshReplicationOffsets(),
  ]);
  console.log(chalk.bold("Mesh Status"));
  console.log(JSON.stringify(status, null, 2));
  console.log(chalk.bold("Nodes"));
  console.table(nodes.items);
  console.log(chalk.bold("Leases"));
  console.table(leases.items);
  console.log(chalk.bold("Session Owners"));
  console.table(owners.items);
  console.log(chalk.bold("Replication Offsets"));
  console.table(offsets.items);

  const action = await select({
    message: "Mesh action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Acquire lease", value: "acquire" },
      { name: "Renew lease", value: "renew" },
      { name: "Release lease", value: "release" },
      { name: "Claim session owner", value: "claim" },
    ],
  });
  if (action === "back") {
    return;
  }

  if (action === "acquire") {
    const leaseKey = await input({ message: "Lease key" });
    const holderNodeId = await input({ message: "Holder node ID" });
    const ttlSeconds = Number(await input({ message: "TTL seconds", default: "30" }));
    const confirmed = await confirm({ message: "Acquire lease?", default: false });
    if (!confirmed) {
      return;
    }
    const result = await client.meshAcquireLease({ leaseKey, holderNodeId, ttlSeconds });
    console.log(JSON.stringify(result, null, 2));
    await pause();
    return;
  }

  if (action === "renew") {
    const leaseKey = await input({ message: "Lease key" });
    const holderNodeId = await input({ message: "Holder node ID" });
    const fencingToken = Number(await input({ message: "Fencing token" }));
    const ttlSeconds = Number(await input({ message: "TTL seconds", default: "30" }));
    const confirmed = await confirm({ message: "Renew lease?", default: false });
    if (!confirmed) {
      return;
    }
    const result = await client.meshRenewLease({ leaseKey, holderNodeId, fencingToken, ttlSeconds });
    console.log(JSON.stringify(result, null, 2));
    await pause();
    return;
  }

  if (action === "release") {
    const leaseKey = await input({ message: "Lease key" });
    const holderNodeId = await input({ message: "Holder node ID" });
    const fencingToken = Number(await input({ message: "Fencing token" }));
    const confirmed = await confirm({ message: "Release lease?", default: false });
    if (!confirmed) {
      return;
    }
    const result = await client.meshReleaseLease({ leaseKey, holderNodeId, fencingToken });
    console.log(JSON.stringify(result, null, 2));
    await pause();
    return;
  }

  if (action === "claim") {
    const sessionId = await input({ message: "Session ID" });
    const ownerNodeId = await input({ message: "Owner node ID" });
    const minEpoch = Number(await input({ message: "Min epoch", default: "0" }));
    const confirmed = await confirm({ message: "Claim session ownership?", default: false });
    if (!confirmed) {
      return;
    }
    const result = await client.meshClaimSession(sessionId, { ownerNodeId, minEpoch });
    console.log(JSON.stringify(result, null, 2));
    await pause();
  }
}

async function viewSystem(client: TuiApiClient): Promise<void> {
  const [vitals, settings, events] = await Promise.all([
    client.systemVitals(),
    client.runtimeSettings(),
    client.listEvents(20),
  ]);
  console.log(chalk.bold("System Vitals"));
  console.table([vitals]);
  console.log(chalk.bold("Runtime Settings"));
  console.log(JSON.stringify(settings, null, 2));
  console.log(chalk.bold("Recent Realtime Events"));
  console.table(
    events.items.map((item) => ({
      timestamp: item.timestamp,
      eventType: item.eventType,
      source: item.source,
    })),
  );
  await pause();
}

async function viewNpu(client: TuiApiClient): Promise<void> {
  const [status, models] = await Promise.all([client.npuStatus(), client.npuModels().catch(() => ({ items: [] }))]);

  console.log(chalk.bold("NPU Runtime"));
  console.log(JSON.stringify(status, null, 2));
  const npuModels = models.items ?? [];
  if (npuModels.length > 0) {
    console.log(chalk.bold("NPU Models"));
    console.table(
      npuModels.map((model) => ({
        modelId: model.modelId,
        family: model.family,
        source: model.source,
        default: model.default,
        enabled: model.enabled,
        requiresQnn: model.requiresQnn,
      })),
    );
  }

  const action = await select({
    message: "NPU action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Configure runtime", value: "configure" },
      { name: "Start runtime", value: "start" },
      { name: "Stop runtime", value: "stop" },
      { name: "Refresh status", value: "refresh" },
    ],
  });

  if (action === "back") {
    return;
  }

  if (action === "start") {
    const confirmed = await confirm({ message: "Start NPU sidecar runtime?", default: true });
    if (!confirmed) {
      return;
    }
    const result = await client.npuStart();
    console.log(JSON.stringify(result, null, 2));
    await pause();
    return;
  }

  if (action === "stop") {
    const confirmed = await confirm({ message: "Stop NPU sidecar runtime?", default: false });
    if (!confirmed) {
      return;
    }
    const result = await client.npuStop();
    console.log(JSON.stringify(result, null, 2));
    await pause();
    return;
  }

  if (action === "configure") {
    const settings = await client.runtimeSettings();
    const npu = (settings.npu ?? {}) as {
      enabled?: boolean;
      autoStart?: boolean;
      sidecarUrl?: string;
    };
    const enabled = await confirm({
      message: "Enable NPU runtime?",
      default: npu.enabled ?? false,
    });
    const autoStart = await confirm({
      message: "Auto-start NPU sidecar on gateway boot?",
      default: npu.autoStart ?? false,
    });
    const sidecarUrl = await input({
      message: "NPU sidecar URL",
      default: npu.sidecarUrl ?? "http://127.0.0.1:11440",
    });
    const confirmed = await confirm({
      message: "Apply NPU config update?",
      default: false,
    });
    if (!confirmed) {
      return;
    }
    const updated = await client.patchRuntimeSettings({
      npu: {
        enabled,
        autoStart,
        sidecarUrl,
      },
    });
    console.log(JSON.stringify(updated.npu ?? {}, null, 2));
    await pause();
    return;
  }

  const result = await client.npuRefresh();
  console.log(JSON.stringify(result, null, 2));
  await pause();
}

async function viewOnboarding(client: TuiApiClient): Promise<void> {
  const state = await client.onboardingState();
  const activeProviderId = state.settings?.llm?.activeProviderId?.trim();
  const providerProbe = activeProviderId
    ? await client
        .listLlmModels(activeProviderId)
        .then((result) => ({
          ok: true as const,
          items: result.items ?? [],
        }))
        .catch((error) => ({
          ok: false as const,
          message: (error as Error).message,
        }))
    : null;
  console.log(renderSection("Onboarding", "Configuration readiness for first-run setup and operator handoff."));
  console.log(
    renderBox(
      "Current state",
      [
        `Completed: ${state.completed ? "yes" : "no"}`,
        `Completed at: ${state.completedAt ? formatTimestamp(state.completedAt) : "not yet"}`,
        `Completed by: ${state.completedBy || "n/a"}`,
        `Provider: ${state.settings?.llm?.activeProviderId || "unset"} / ${state.settings?.llm?.activeModel || "unset"}`,
        `Runtime defaults: ${state.settings?.toolApprovalMode || "unset"} / ${state.settings?.budgetMode || "unset"}`,
      ],
      state.completed ? "success" : "warning",
    ),
  );
  console.log(
    renderBox(
      "Checklist",
      (state.checklist ?? []).length > 0
        ? state.checklist.map((item) => `${item.label}: ${item.status}${item.detail ? ` (${item.detail})` : ""}`)
        : ["No onboarding checklist items were returned."],
      "info",
    ),
  );
  if (providerProbe) {
    console.log(
      renderBox(
        "Provider probe",
        providerProbe.ok
          ? [
              `Provider ${activeProviderId} responded to live model discovery.`,
              `Models returned: ${providerProbe.items.length}`,
              providerProbe.items[0]?.id
                ? `First model: ${providerProbe.items[0].id}`
                : "The provider responded but returned no models.",
            ]
          : [
              `Provider ${activeProviderId} did not complete a live model lookup.`,
              summarizeText(providerProbe.message, 180),
            ],
        providerProbe.ok ? "success" : "warning",
      ),
    );
  }
  console.log(
    renderBox(
      "Readiness note",
      [
        "This checklist is configuration-based. It can read as complete even when a provider endpoint is currently unreachable.",
        "Run the guided onboarding wizard or `goat doctor --deep` before public testing if you need a live provider check.",
      ],
      "warning",
    ),
  );

  const action = await select({
    message: "Onboarding action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Mark complete", value: "complete" },
      { name: "Run quick bootstrap", value: "bootstrap" },
    ],
  });
  if (action === "complete") {
    const confirmed = await confirm({ message: "Mark onboarding complete?", default: false });
    if (!confirmed) {
      return;
    }
    const result = await client.onboardingComplete("tui-operator");
    console.log(
      renderBox(
        "Onboarding updated",
        [`Completed: ${result.state?.completed ? "yes" : "no"}`, "The onboarding marker was updated for this gateway."],
        "success",
      ),
    );
    await pause();
    return;
  }
  if (action === "bootstrap") {
    const toolApprovalMode = await select<"approve_all" | "approve_risky" | "bypass">({
      message: "Tool approval mode",
      choices: [
        { name: "Ask every time", value: "approve_all" },
        { name: "Ask for risky work", value: "approve_risky" },
        { name: "Bypass approval prompts", value: "bypass" },
      ],
    });
    const budgetMode = await select<"saver" | "balanced" | "power">({
      message: "Budget mode",
      choices: [
        { name: "saver", value: "saver" },
        { name: "balanced", value: "balanced" },
        { name: "power", value: "power" },
      ],
    });
    const confirmed = await confirm({ message: "Apply quick bootstrap?", default: false });
    if (!confirmed) {
      return;
    }
    const result = await client.onboardingBootstrap({
      toolApprovalMode,
      budgetMode,
      markComplete: false,
      completedBy: "tui-operator",
    });
    console.log(
      renderBox(
        "Bootstrap applied",
        [`Applied at: ${formatTimestamp(result.appliedAt)}`, `Approvals: ${toolApprovalMode}`, `Budget: ${budgetMode}`],
        "success",
      ),
    );
    await pause();
  }
}

async function viewSettings(client: TuiApiClient, profilePath: string, profileName: string): Promise<void> {
  const settings = await client.runtimeSettings();
  console.log(renderSection("Gateway Settings", "Current runtime configuration from the gateway."));
  console.log(
    renderKeyValueSummary(
      Object.entries(settings).map(([key, value]) => ({
        key,
        value: typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? ""),
      })),
    ),
  );

  const action = await select({
    message: "Settings action",
    choices: [
      { name: "Back", value: "back" },
      { name: "Set budget mode", value: "budget" },
      { name: "Set tool approval mode", value: "profile" },
      { name: "Save TUI local defaults", value: "save-local" },
    ],
  });
  if (action === "budget") {
    const budgetMode = await select({
      message: "Budget mode",
      choices: [
        { name: "saver", value: "saver" },
        { name: "balanced", value: "balanced" },
        { name: "power", value: "power" },
      ],
    });
    const confirmed = await confirm({ message: "Apply gateway budget mode update?", default: false });
    if (!confirmed) {
      return;
    }
    await client.patchRuntimeSettings({ budgetMode });
    console.log("Budget mode updated.");
    await pause();
    return;
  }

  if (action === "profile") {
    const toolApprovalMode = await select<"approve_all" | "approve_risky" | "bypass">({
      message: "Tool approval mode",
      choices: [
        { name: "Ask every time", value: "approve_all" },
        { name: "Ask for risky work", value: "approve_risky" },
        { name: "Bypass approval prompts", value: "bypass" },
      ],
    });
    const confirmed = await confirm({ message: "Apply gateway approval mode update?", default: false });
    if (!confirmed) {
      return;
    }
    await client.patchRuntimeSettings({ toolApprovalMode });
    console.log("Tool approval mode updated.");
    await pause();
    return;
  }

  if (action === "save-local") {
    const gatewayBaseUrl = await input({
      message: "Gateway URL",
      default: client.baseUrl,
    });
    const authMode = await select<"none" | "token" | "basic">({
      message: "Auth mode",
      choices: [
        { name: "none", value: "none" },
        { name: "token", value: "token" },
        { name: "basic", value: "basic" },
      ],
    });
    await saveProfile(profilePath, {
      gatewayBaseUrl,
      authMode,
      tokenQueryParam: "access_token",
      defaultScope: "operator",
      pollIntervalsMs: {
        dashboard: 5000,
        activity: 2500,
        approvals: 5000,
      },
      ui: {
        denseMode: false,
        confirmRiskyWrites: true,
        colorLevel: "auto",
      },
    });
    console.log(`Saved local profile "${profileName}" to ${profilePath}`);
    await pause();
  }
}

async function handleCapabilitySuggestions(
  client: TuiApiClient,
  suggestions: ChatCapabilityUpgradeSuggestion[],
): Promise<void> {
  console.log(
    renderBox(
      "Capability upgrade available",
      [
        "GoatCitadel found a likely capability upgrade for this request.",
        "Nothing is installed or enabled automatically. Every change still needs your approval.",
      ],
      "warning",
    ),
  );
  console.log(
    renderBulletList(
      suggestions.map((item) => `${item.title}${item.riskLevel ? ` (${item.riskLevel} risk)` : ""} - ${item.summary}`),
      "accent",
    ),
  );

  const selectedValue = await select<string>({
    message: "Capability follow-up",
    choices: [
      { name: "Not now", value: "skip" },
      ...suggestions.map((suggestion, index) => ({
        name: `${suggestion.title}${suggestion.riskLevel ? ` (${suggestion.riskLevel} risk)` : ""}`,
        value: String(index),
      })),
    ],
  });
  if (selectedValue === "skip") {
    return;
  }

  const suggestion = suggestions[Number(selectedValue)];
  if (!suggestion) {
    return;
  }

  console.log(
    renderBox(
      "Suggestion details",
      [
        suggestion.summary,
        suggestion.reason,
        `Recommended action: ${suggestion.recommendedAction}`,
        `Source: ${suggestion.sourceProvider ?? "installed/local"}`,
      ],
      suggestion.riskLevel === "high" ? "danger" : suggestion.riskLevel === "medium" ? "warning" : "info",
    ),
  );

  const followUpChoices = [
    { name: "Back", value: "back" },
    { name: "Show details only", value: "details" },
  ] as Array<{ name: string; value: string }>;
  if (suggestion.recommendedAction === "enable_skill") {
    followUpChoices.push({ name: "Enable skill now", value: "enable" });
  }
  if (suggestion.recommendedAction === "install_skill_disabled") {
    followUpChoices.push({ name: "Install disabled now", value: "install" });
  }
  if (suggestion.recommendedAction === "add_mcp_template") {
    followUpChoices.push({ name: "Add MCP template now", value: "mcp" });
  }
  if (suggestion.recommendedAction === "switch_tool_profile") {
    followUpChoices.push({ name: "Open Tool Access next", value: "tools" });
  }

  const next = await select<string>({
    message: "Choose action",
    choices: followUpChoices,
  });
  if (next === "back" || next === "details") {
    return;
  }

  if (next === "enable") {
    if (!suggestion.candidateId) {
      console.log(renderBox("Cannot enable", ["The installed skill ID is missing from this suggestion."], "danger"));
      return;
    }
    const updated = await client.updateSkillState(suggestion.candidateId, {
      state: "enabled",
      note: "Enabled from TUI capability suggestion.",
    });
    console.log(renderBox("Skill enabled", [`Skill ID: ${updated.skillId}`, "Retry your request now."], "success"));
    return;
  }

  if (next === "install") {
    if (!suggestion.sourceRef) {
      console.log(renderBox("Cannot install", ["The import source is missing from this suggestion."], "danger"));
      return;
    }
    const installed = await client.installSkillImport({
      sourceRef: suggestion.sourceRef,
      sourceProvider:
        suggestion.sourceProvider && suggestion.sourceProvider !== "mcp_template"
          ? suggestion.sourceProvider
          : undefined,
      confirmHighRisk: suggestion.riskLevel === "high",
    });
    console.log(
      renderBox(
        "Skill installed",
        [
          installed.installedSkillId
            ? `Installed ${installed.installedSkillId}.`
            : "Installed the suggested skill source.",
          "Imported skills stay disabled by default until you review and enable them.",
        ],
        "success",
      ),
    );
    return;
  }

  if (next === "mcp") {
    const templateId = suggestion.candidateId ?? suggestion.sourceRef;
    if (!templateId) {
      console.log(
        renderBox("Cannot add MCP template", ["The template identifier is missing from this suggestion."], "danger"),
      );
      return;
    }
    const templates = await client.fetchMcpTemplates();
    const template = templates.items.find((item) => item.templateId === templateId);
    if (!template) {
      console.log(renderBox("Cannot add MCP template", ["The suggested template is no longer available."], "danger"));
      return;
    }
    if (template.installed) {
      console.log(
        renderBox(
          "MCP template already added",
          [`${template.label} is already installed.`, "Open the MCP view to connect or tune its policy."],
          "info",
        ),
      );
      return;
    }
    await client.createMcpServer({
      label: template.label,
      transport: template.transport,
      command: template.command,
      args: template.args,
      url: template.url,
      authType: template.authType,
      enabled: template.enabledByDefault,
      category: template.category,
      trustTier: template.trustTier,
      costTier: template.costTier,
      policy: template.policy,
    });
    console.log(
      renderBox(
        "MCP template added",
        [`${template.label} was added to GoatCitadel.`, "Review trust, auth, and policy before first live use."],
        "success",
      ),
    );
    return;
  }

  if (next === "tools") {
    console.log(
      renderBox(
        "Tool Access hint",
        [
          "This capability is blocked by the current tool/profile policy.",
          "Open the Tool Access view next and adjust the profile or grants before retrying.",
        ],
        "warning",
      ),
    );
  }
}

async function pause(): Promise<void> {
  await input({ message: "Press Enter to continue" });
}

function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

async function chooseSessionId(sessionItems: Array<Record<string, unknown>>, message: string): Promise<string> {
  const available = sessionItems
    .map((session) => ({
      sessionId: toText(session.sessionId),
      summary: formatSessionSummary(session),
    }))
    .filter((session) => session.sessionId);

  if (available.length === 0) {
    return (await input({ message: "Session ID" })).trim();
  }

  const selected = await select<string>({
    message,
    choices: [
      ...available.slice(0, MAX_TUI_SESSION_CHOICES).map((session) => ({
        name: session.summary,
        value: session.sessionId,
      })),
      { name: "Enter session ID manually", value: MANUAL_SESSION_ENTRY },
    ],
  });

  if (selected === MANUAL_SESSION_ENTRY) {
    return (await input({ message: "Session ID" })).trim();
  }
  return selected.trim();
}

function formatSessionSummary(session: Record<string, unknown>): string {
  const sessionId = toText(session.sessionId) || "unknown";
  const title = toText(session.title) || "(untitled)";
  const kind = toText(session.kind) || "chat";
  const updatedAt = formatTimestamp(toText(session.updatedAt));
  return `${title} [${sessionId}] · ${kind} · updated ${updatedAt}`;
}

function formatTimestamp(value: string): string {
  if (!value) {
    return "unknown";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function summarizeText(value: string, limit = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact || "(empty)";
  }
  return `${compact.slice(0, limit - 3)}...`;
}

main().catch((error) => {
  console.error(chalk.red("Terminal Mission Control failed."));
  console.error(error);
  process.exitCode = 1;
});
