#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { chromium } from "playwright";
import { Storage } from "@goatcitadel/storage";
import { resolveUiTarget } from "../../../scripts/lib/ui-target.mjs";
import { buildTestbenchEnvOmit } from "../../../scripts/testbench-runtime.mjs";
import { collectVerificationSecretEnvKeys } from "../../../scripts/verification/lib/scenarios/usability-coverage.mjs";
import {
  cockpitVisualDataSettled,
  cockpitVisualShellReady,
} from "../../../scripts/verification/lib/scenarios/cockpit-visual-readiness.mjs";
import { resolvePublicScreenshotTargets } from "./mission-control-screenshot-targets.mjs";
import { publishStagedGallery } from "./screenshot-gallery-publisher.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const tmpDir = path.join(repoRoot, ".tmp", "public-share-screenshots");
const runtimeRoot = path.join(tmpDir, "runtime");
const uiTarget = resolveUiTarget(repoRoot, process.env);
const outputDir = path.join(repoRoot, "docs", "screenshots", uiTarget.screenshotDirName);
const stagedOutputDir = path.join(tmpDir, "gallery-staging");
const gatewayPort = 18787;
const uiPort = 15173;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const uiUrl = `http://127.0.0.1:${uiPort}`;
const DEFAULT_SCREENSHOT_SETTLE_MS = 1800;

async function main() {
  await prepareRuntimeRoot();
  const envOmit = await buildSandboxEnvOmit();

  const gateway = await startProcess(
    "gateway",
    [pnpmCommand(), "--dir", repoRoot, "dev:gateway"],
    {
      NODE_ENV: "development",
      // Keep schedule and timestamp copy independent of the capturing machine.
      TZ: "UTC",
      GOATCITADEL_ROOT_DIR: runtimeRoot,
      GOATCITADEL_HOME: path.join(runtimeRoot, "home"),
      GOATCITADEL_BACKUP_DIR: path.join(runtimeRoot, "backups"),
      // Points at a file that does not exist, so no operator .env is read or written.
      GOATCITADEL_LOCAL_ENV_FILE: path.join(runtimeRoot, ".env"),
      // The OS keychain is shared host state; the sandbox must never read or write operator credentials.
      GOATCITADEL_DISABLE_SECRET_STORE: "true",
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(gatewayPort),
      GOATCITADEL_AUTH_MODE: "none",
      GOATCITADEL_ALLOWED_ORIGINS: `${uiUrl},http://localhost:${uiPort}`,
      GOATCITADEL_DATABASE_DRIVER: "sqlite",
      GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
      GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "false",
      GOATCITADEL_LLAMACPP_AUTOSTART: "false",
      GOATCITADEL_LLAMACPP_ENABLED: "false",
      GOATCITADEL_NPU_AUTOSTART: "false",
      GOATCITADEL_NPU_ENABLED: "false",
      GOATCITADEL_RATE_LIMIT_ENABLED: "false",
      GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED: "true",
    },
    envOmit,
  );
  const ui = await startProcess(
    "ui",
    [
      pnpmCommand(),
      "--dir",
      repoRoot,
      "--filter",
      uiTarget.packageName,
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(uiPort),
    ],
    {
      NODE_ENV: "development",
      VITE_GATEWAY_URL: gatewayUrl,
    },
    envOmit,
  );

  try {
    await waitForHttp(`${gatewayUrl}/health`, "Gateway health");
    await waitForHttp(uiUrl, "Mission Control UI");
    const seed = await seedDemoData();
    const screenshotTargets = resolvePublicScreenshotTargets(seed).map((target) => ({
      ...target,
      settleMs: target.settleMs ?? DEFAULT_SCREENSHOT_SETTLE_MS,
    }));
    await captureScreenshots(seed.workspaceId, screenshotTargets);
    await writeGalleryIndex(screenshotTargets);
    await publishGallery(screenshotTargets);
  } finally {
    await stopProcess(ui);
    await stopProcess(gateway);
  }
}

/*
 * The public gallery must never show operator state, so the runtime is built from
 * shipped defaults only: the tracked example config and the git-tracked skills.
 * Local `config/*.json`, `.env`, workspace guidance, and untracked skills are never read.
 */
async function prepareRuntimeRoot() {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(stagedOutputDir, { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "data"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "home"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "backups"), { recursive: true });
  await writeShippedDefaultConfig();
  await copyTrackedSkills();
}

async function writeShippedDefaultConfig() {
  const configDir = path.join(runtimeRoot, "config");
  await fs.mkdir(configDir, { recursive: true });
  const config = JSON.parse(await fs.readFile(path.join(repoRoot, "config", "goatcitadel.example.json"), "utf8"));
  delete config.generation;
  config.cronJobs = { jobs: [] };
  config.assistant ??= {};
  config.assistant.auth = { ...config.assistant.auth, mode: "none", allowLoopbackBypass: true };
  await writeJson(path.join(configDir, "goatcitadel.json"), config);
  for (const [filename, section] of Object.entries({
    "assistant.config.json": "assistant",
    "tool-policy.json": "toolPolicy",
    "budgets.json": "budgets",
    "llm-providers.json": "llm",
    "cron-jobs.json": "cronJobs",
  })) {
    await writeJson(path.join(configDir, filename), config[section]);
  }
  await fs.copyFile(
    path.join(repoRoot, "config", "llm-model-metadata.json"),
    path.join(configDir, "llm-model-metadata.json"),
  );
}

async function copyTrackedSkills() {
  const listed = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--", "skills"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.error || listed.status !== 0) {
    throw new Error(`Cannot list tracked skills with git: ${listed.error?.message ?? listed.stderr?.trim()}`);
  }
  for (const relativeFile of listed.stdout.split("\0").filter(Boolean)) {
    const source = path.join(repoRoot, relativeFile);
    if (!existsSync(source)) {
      continue;
    }
    const target = path.join(runtimeRoot, relativeFile);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Strips every GoatCitadel setting and secret the operator shell exports before the sandbox starts. */
async function buildSandboxEnvOmit() {
  return buildTestbenchEnvOmit(await collectVerificationSecretEnvKeys(path.join(repoRoot, "config")));
}

async function startProcess(name, commandArgs, extraEnv, omitEnv = []) {
  const [cmd, ...args] = commandArgs;
  const inheritedEnv = { ...process.env };
  for (const key of omitEnv) {
    delete inheritedEnv[key];
  }
  const stdoutPath = path.join(tmpDir, `${name}.stdout.log`);
  const stderrPath = path.join(tmpDir, `${name}.stderr.log`);
  const stdout = createWriteStream(stdoutPath, { flags: "w" });
  const stderr = createWriteStream(stderrPath, { flags: "w" });
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: {
      ...inheritedEnv,
      ...extraEnv,
    },
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logPipelines = Promise.all([pipeline(child.stdout, stdout), pipeline(child.stderr, stderr)]).catch((error) => {
    if (!stopping) {
      console.error(
        `[screenshots] ${name} log stream failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  let stopping = false;
  child.on("exit", (code) => {
    if (!stopping && code !== null && code !== 0) {
      console.error(`[screenshots] ${name} exited early with code ${code}`);
    }
  });
  return {
    child,
    stdoutPath,
    stderrPath,
    markStopping() {
      stopping = true;
    },
    async waitForLogs() {
      await logPipelines;
    },
  };
}

async function stopProcess(handle) {
  const { child } = handle;
  if (child.exitCode !== null) {
    await handle.waitForLogs?.();
    return;
  }
  handle.markStopping?.();
  if (process.platform === "win32") {
    spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "taskkill", "/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await waitForExit(child, 8000).catch(() => undefined);
    await handle.waitForLogs?.();
    return;
  }
  child.kill("SIGTERM");
  await waitForExit(child, 8000).catch(async () => {
    child.kill("SIGKILL");
    await waitForExit(child, 4000).catch(() => undefined);
  });
  await handle.waitForLogs?.();
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process exit timeout")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForHttp(url, label) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // keep waiting
    }
    await delay(1500);
  }
  throw new Error(`${label} did not become ready in time: ${url}`);
}

const ONBOARDING_RECONCILIATION_ATTEMPTS = 40;
const ONBOARDING_RECONCILIATION_RETRY_MS = 1500;

/*
 * Every record below is fictional demo content for the public gallery. The Gateway's own
 * `/api/v1/demo/bootstrap` provides the demo workspace, project, tasks, and a durable-backed
 * approval checkpoint; the transcript is written directly so no model is ever called.
 */
async function seedDemoData() {
  await bootstrapOnboarding();
  const demo = await postJson("/api/v1/demo/bootstrap", {});
  const workspaceId = demo.workspace.workspaceId;
  const projectId = demo.project.projectId;

  const session = await createDemoSession(workspaceId, projectId, "Lumen Notes 2.0 launch plan");
  await seedChatTranscript(session.sessionId, PRIMARY_TRANSCRIPT);
  for (const thread of SECONDARY_THREADS) {
    const secondary = await createDemoSession(workspaceId, thread.project ? projectId : undefined, thread.title);
    await seedChatTranscript(secondary.sessionId, thread.turns, thread.minutesAgo);
  }

  for (const task of DEMO_TASKS) {
    await postJson("/api/v1/tasks", { workspaceId, ...task });
  }

  await postJson("/api/v1/cron/jobs", {
    jobId: `launch_metrics_digest_${workspaceId.slice(-6)}`,
    name: "Launch metrics digest",
    schedule: "0 6 * * * UTC",
    enabled: true,
  });

  await postJson("/api/v1/integrations/connections", {
    catalogId: "channel.discord",
    label: "Discord Sandbox",
    enabled: true,
    status: "connected",
    config: {
      botTokenEnv: "DISCORD_BOT_TOKEN",
      defaultChannelId: "sandbox-channel",
    },
  });

  await postJson("/api/v1/mcp/servers", {
    label: "Filesystem MCP Demo",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "./workspace/demo"],
    enabled: true,
    category: "development",
    trustTier: "trusted",
    costTier: "free",
  });

  await postJson("/api/v1/agents", {
    roleId: "launch-shepherd",
    name: "Launch Shepherd",
    title: "Launch Coordinator",
    summary: "Tracks launch readiness, docs drift, and announcement blockers.",
    specialties: ["release review", "docs", "handoffs"],
    defaultTools: ["fs.read", "fs.list", "browser.search"],
    aliases: ["shepherd"],
  });

  await postJson("/api/v1/knowledge/memory/write", {
    namespace: "launch",
    title: "Launch rule",
    content: "Nothing is sent to customers until the announcement copy has an explicit operator approval.",
    tags: ["launch", "policy"],
    source: "release-demo",
    metadata: { workspaceId, fixture: "public-screenshot" },
    sessionId: session.sessionId,
  });

  await postJson("/api/v1/files/upload", {
    relativePath: "workspace/demo/launch-checklist.md",
    content: [
      "# Launch Checklist",
      "",
      "- Beta feedback triaged",
      "- Release notes reviewed",
      "- Pricing page merged",
    ].join("\n"),
  });

  await postJson("/api/v1/prompt-packs/import", {
    name: "Launch Sanity Pack",
    sourceLabel: "public-share-demo",
    content: [
      "[TEST-01] Launch plan clarity",
      "Break a product launch into workstreams and name every step that needs operator sign-off.",
      "",
      "[TEST-02] Safe outreach",
      "Draft an announcement outline without sending anything.",
    ].join("\n"),
  });

  return {
    workspaceId,
    projectId,
    sessionId: session.sessionId,
  };
}

/** Completes onboarding with a keyless demo provider once the fresh config generation has reconciled. */
async function bootstrapOnboarding() {
  for (let attempt = 1; attempt <= ONBOARDING_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const state = await requestJsonAllowingConflict("/api/v1/onboarding/state");
    const expectedRevision = state?.settings?.revision;
    if (state && Number.isInteger(expectedRevision) && expectedRevision > 0) {
      const result = await requestJsonAllowingConflict("/api/v1/onboarding/bootstrap", {
        method: "POST",
        body: {
          expectedRevision,
          budgetMode: "balanced",
          llm: {
            activeProviderId: "glm",
            activeModel: "glm-5",
            upsertProvider: {
              providerId: "glm",
              label: "GLM 5 Demo",
              baseUrl: "https://api.z.ai/api/paas/v4",
              defaultModel: "glm-5",
              apiKeyEnv: "GLM_API_KEY",
            },
          },
          markComplete: true,
          completedBy: "release-demo",
        },
      });
      if (result) {
        return result;
      }
    }
    await delay(ONBOARDING_RECONCILIATION_RETRY_MS);
  }
  throw new Error("Onboarding bootstrap did not settle; the config generation never finished reconciling.");
}

async function createDemoSession(workspaceId, projectId, title) {
  return postJson("/api/v1/chat/sessions", {
    workspaceId,
    ...(projectId ? { projectId } : {}),
    title,
    mode: "chat",
  });
}

const PRIMARY_TRANSCRIPT = [
  {
    user: "We're launching Lumen Notes 2.0 in three weeks. Break the launch into workstreams and tell me what needs my sign-off.",
    assistant: [
      "Here's the launch split into four workstreams. Anything that writes outside this workspace or contacts people waits for your approval.",
      "",
      "| Workstream | Owner | Needs your sign-off |",
      "| --- | --- | --- |",
      "| Release notes and docs | Writer | Final copy before publishing |",
      "| Beta feedback triage | Researcher | None, read-only |",
      "| Pricing page update | Coder | Merge to `main` |",
      "| Announcement email | Personal Assistant | Sending to the customer list |",
      "",
      "**Suggested order:** triage beta feedback first. It feeds the release notes and may change the pricing copy.",
      "",
      "I added a planning task to the Work board and left one checkpoint in your Inbox.",
    ].join("\n"),
    actorId: "goatherder",
  },
  {
    user: "Draft the announcement email outline, but don't send anything.",
    assistant: [
      "Outline only. Nothing will be sent.",
      "",
      "1. **Subject:** Lumen Notes 2.0: offline sync and shared notebooks",
      "2. **Hook:** one sentence on the most-requested feature, offline sync",
      "3. **What's new:** three bullets, each tied to a beta quote",
      "4. **Upgrade path:** existing notes migrate automatically",
      "5. **Call to action:** try a shared notebook",
      "",
      "When you're ready, I'll prepare it as a mail draft. Sending needs one explicit approval.",
    ].join("\n"),
    actorId: "goatherder",
  },
];

const SECONDARY_THREADS = [
  {
    title: "Summarize beta feedback",
    project: true,
    minutesAgo: 95,
    turns: [
      {
        user: "Group the beta feedback by theme.",
        assistant: "Offline sync leads with 41% of comments, followed by sharing and search speed.",
        actorId: "researcher",
      },
    ],
  },
  {
    title: "Fix flaky offline-sync test",
    project: true,
    minutesAgo: 180,
    turns: [
      {
        user: "Why does the offline-sync test fail on CI only?",
        assistant: "The test waits on wall-clock time. A fake timer makes it deterministic.",
        actorId: "coder",
      },
    ],
  },
  {
    title: "Weekly metrics digest",
    project: false,
    minutesAgo: 1440,
    turns: [
      {
        user: "Summarize this week's signups and churn.",
        assistant: "Signups rose 12% week over week; churn held flat at 2.1%.",
        actorId: "goatherder",
      },
    ],
  },
];

const DEMO_TASKS = [
  {
    title: "Update pricing page copy",
    description: "Reflect the new shared-notebook tier.",
    priority: "high",
    status: "in_progress",
  },
  {
    title: "Publish release notes",
    description: "Waiting on final copy review.",
    priority: "normal",
    status: "review",
  },
  {
    title: "Fix flaky offline-sync test",
    description: "Replace the wall-clock wait with fake timers.",
    priority: "normal",
    status: "blocked",
  },
];

async function seedChatTranscript(sessionId, turns, minutesAgo = 12) {
  const storage = new Storage({
    dbPath: path.join(runtimeRoot, "data", "index.db"),
    transcriptsDir: path.join(runtimeRoot, "data", "transcripts"),
    auditDir: path.join(runtimeRoot, "data", "audit"),
  });
  try {
    let parentTurnId;
    let timestamp = Date.now() - minutesAgo * 60 * 1000;
    for (const turn of turns) {
      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      const turnId = randomUUID();
      const userTimestamp = new Date(timestamp).toISOString();
      const assistantTimestamp = new Date(timestamp + 40_000).toISOString();
      timestamp += 3 * 60 * 1000;
      storage.chatMessages.upsertMany([
        {
          messageId: userMessageId,
          sessionId,
          role: "user",
          actorType: "user",
          actorId: "operator",
          sourceAuthority: "operator",
          content: turn.user,
          timestamp: userTimestamp,
        },
        {
          messageId: assistantMessageId,
          sessionId,
          role: "assistant",
          actorType: "agent",
          actorId: turn.actorId,
          sourceAuthority: "agent_proposed",
          content: turn.assistant,
          timestamp: assistantTimestamp,
          tokenInput: 412,
          tokenOutput: 188,
          costUsd: 0.0042,
        },
      ]);
      storage.chatTurnTraces.create({
        turnId,
        sessionId,
        userMessageId,
        assistantMessageId,
        ...(parentTurnId ? { parentTurnId, branchKind: "append" } : {}),
        status: "completed",
        mode: "chat",
        // Marks the seeded transcript honestly: no model produced these answers.
        model: "public-screenshot-seed",
        webMode: "auto",
        memoryMode: "auto",
        thinkingLevel: "standard",
        startedAt: userTimestamp,
        finishedAt: assistantTimestamp,
      });
      parentTurnId = turnId;
    }
    if (parentTurnId) {
      storage.chatSessionBranchState.setActiveLeaf(sessionId, parentTurnId);
    }
  } finally {
    storage.close();
  }
}

async function captureScreenshots(activeWorkspaceId, screenshotTargets) {
  const browser = await chromium.launch({
    headless: true,
  });
  try {
    for (const theme of new Set(screenshotTargets.map((target) => target.theme))) {
      const context = await browser.newContext({
        viewport: {
          width: 1440,
          height: 900,
        },
        colorScheme: theme,
        deviceScaleFactor: 1,
        locale: "en-US",
        timezoneId: "UTC",
      });
      await context.addInitScript(
        ({ workspaceId, uiTheme }) => {
          window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", workspaceId);
          window.localStorage.setItem("goatcitadel.ui.theme.v1", uiTheme);
          window.localStorage.setItem("goatcitadel.ui.mode.v1", "simple");
          window.localStorage.setItem("goatcitadel.ui.technical_details.v1", "false");
          window.localStorage.setItem("goatcitadel.notifications.toasts.v1", "false");
          window.localStorage.setItem("goatcitadel.notifications.sound_mode.v1", "off");
        },
        { workspaceId: activeWorkspaceId, uiTheme: theme },
      );

      const page = await context.newPage();
      // A fresh profile applies the saved workspace only from its second navigation.
      await page.goto(new URL("/chat?shell=cockpit", uiUrl).toString(), { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(DEFAULT_SCREENSHOT_SETTLE_MS);
      for (const target of screenshotTargets.filter((candidate) => candidate.theme === theme)) {
        await captureTarget(page, target);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function captureTarget(page, target) {
  const targetUrl = new URL(target.href, uiUrl);
  await page.goto(targetUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    cockpitVisualShellReady,
    { pathname: targetUrl.pathname, theme: target.theme, fullscreen: target.fullscreen === true },
    { timeout: 60_000 },
  );
  if (target.readySelector) {
    await page.locator(target.readySelector).first().waitFor({ state: "visible", timeout: 20_000 });
  }
  if (target.readyText) {
    await page.waitForFunction(
      (text) => document.body?.innerText.toLowerCase().includes(text.toLowerCase()),
      target.readyText,
      { timeout: 20_000 },
    );
  }
  await page.waitForFunction(cockpitVisualDataSettled, undefined, { timeout: 20_000 });
  await page.waitForTimeout(target.settleMs);
  if (typeof target.scrollY === "number") {
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), target.scrollY);
    await page.waitForTimeout(500);
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.addStyleTag({
    content: ".notification-stack { display: none !important; }",
  });
  const outputPath = path.join(stagedOutputDir, target.file);
  if (target.screenshotSelector) {
    await page.locator(target.screenshotSelector).screenshot({ path: outputPath });
  } else {
    await page.screenshot({ path: outputPath });
  }
}

async function writeGalleryIndex(screenshotTargets) {
  const cards = screenshotTargets
    .map((target) =>
      [
        `        <section class="card">`,
        `          <h2>${escapeHtml(target.title)}</h2>`,
        `          <p>${escapeHtml(target.description)}</p>`,
        `          <img src="./${target.file}" alt="${escapeHtml(target.title)} screenshot" />`,
        `        </section>`,
      ].join("\n"),
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," />
    <title>GoatCitadel Mission Control Screenshots</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", Arial, sans-serif;
        background: #071113;
        color: #d7f8ff;
      }
      .wrap {
        max-width: 1320px;
        margin: 0 auto;
        padding: 24px;
      }
      h1 {
        margin: 0 0 10px;
        color: #7de7f7;
      }
      p {
        color: #9fcbd4;
      }
      .grid {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      }
      .card {
        border: 1px solid #1c5260;
        border-radius: 8px;
        background: #0c1c22;
        padding: 12px;
      }
      .card h2 {
        margin: 0 0 6px;
        font-size: 17px;
        color: #b7f8ff;
      }
      .card p {
        min-height: 44px;
        margin: 0 0 10px;
        font-size: 14px;
        line-height: 1.45;
      }
      img {
        width: 100%;
        height: auto;
        display: block;
        border-radius: 6px;
        border: 1px solid #1c5260;
      }
      code {
        background: rgba(255, 255, 255, 0.06);
        padding: 2px 6px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <h1>GoatCitadel ${escapeHtml(uiTarget.displayName)} Screenshots</h1>
      <p>Cockpit layout, regenerated from a sanitized demo runtime built from shipped defaults. All records are fictional demo content. Folder: <code>docs/screenshots/${escapeHtml(uiTarget.screenshotDirName)}</code></p>
      <div class="grid">
${cards}
      </div>
    </main>
  </body>
</html>
`;
  await fs.writeFile(path.join(stagedOutputDir, "index.html"), html, "utf8");
}

async function publishGallery(screenshotTargets) {
  await publishStagedGallery({
    stagedOutputDir,
    outputDir,
    backupDir: path.join(tmpDir, "gallery-published-backup"),
    expectedFiles: ["index.html", ...screenshotTargets.map((target) => target.file)],
  });
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function postJson(route, body) {
  return requestJson(route, {
    method: "POST",
    body,
  });
}

/** Returns null on a config-generation reconciliation conflict so the caller can retry. */
async function requestJsonAllowingConflict(route, init = {}) {
  try {
    return await requestJson(route, init);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(`Request failed 409 ${route}:`) &&
      error.message.includes("STATE_CONFLICT")
    ) {
      return null;
    }
    throw error;
  }
}

async function requestJson(route, init = {}) {
  const response = await fetch(`${gatewayUrl}${route}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(init.method && init.method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed ${response.status} ${route}: ${text}`);
  }
  return response.json();
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
