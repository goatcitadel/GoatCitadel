#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { chromium } from "playwright";
import { Storage } from "@goatcitadel/storage";
import { resolveUiTarget } from "../../../scripts/lib/ui-target.mjs";
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

  const gateway = await startProcess("gateway", [pnpmCommand(), "--dir", repoRoot, "dev:gateway"], {
    GOATCITADEL_ROOT_DIR: runtimeRoot,
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(gatewayPort),
    GOATCITADEL_AUTH_MODE: "none",
    GOATCITADEL_ALLOWED_ORIGINS: `${uiUrl},http://localhost:${uiPort}`,
    GOATCITADEL_DATABASE_DRIVER: "sqlite",
    GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
    GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "false",
  });
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
      VITE_GATEWAY_URL: gatewayUrl,
    },
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

async function prepareRuntimeRoot() {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(stagedOutputDir, { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "data"), { recursive: true });
  await fs.cp(path.join(repoRoot, "config"), path.join(runtimeRoot, "config"), { recursive: true });
  await materializeCopiedConfigExamples();
  if (existsSync(path.join(repoRoot, "skills"))) {
    await fs.cp(path.join(repoRoot, "skills"), path.join(runtimeRoot, "skills"), { recursive: true });
  }
  if (existsSync(path.join(repoRoot, "workspaces", "default"))) {
    await fs.cp(path.join(repoRoot, "workspaces", "default"), path.join(runtimeRoot, "workspaces", "default"), {
      recursive: true,
    });
  }
  await forceScreenshotRuntimeAuthModeNone();
}

async function materializeCopiedConfigExamples() {
  const configDir = path.join(runtimeRoot, "config");
  const managedConfigs = [
    "assistant.config.json",
    "tool-policy.json",
    "budgets.json",
    "llm-providers.json",
    "cron-jobs.json",
    "goatcitadel.json",
    "private-beta.profile.json",
  ];

  for (const filename of managedConfigs) {
    const actualPath = path.join(configDir, filename);
    if (existsSync(actualPath)) {
      continue;
    }
    const examplePath = path.join(configDir, filename.replace(/\.json$/u, ".example.json"));
    if (!existsSync(examplePath)) {
      continue;
    }
    await fs.copyFile(examplePath, actualPath);
  }
}

async function forceScreenshotRuntimeAuthModeNone() {
  await patchJson(path.join(runtimeRoot, "config", "assistant.config.json"), (config) => {
    config.assistant ??= {};
    config.assistant.auth ??= {};
    config.assistant.auth.mode = "none";
    config.assistant.auth.allowLoopbackBypass = true;
    return config;
  });

  await patchJson(path.join(runtimeRoot, "config", "goatcitadel.json"), (config) => {
    config.assistant ??= {};
    config.assistant.auth ??= {};
    config.assistant.auth.mode = "none";
    config.assistant.auth.allowLoopbackBypass = true;
    return config;
  });
}

async function patchJson(filePath, mutate) {
  const raw = await fs.readFile(filePath, "utf8");
  const next = mutate(JSON.parse(raw));
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function startProcess(name, commandArgs, extraEnv) {
  const [cmd, ...args] = commandArgs;
  const stdoutPath = path.join(tmpDir, `${name}.stdout.log`);
  const stderrPath = path.join(tmpDir, `${name}.stderr.log`);
  const stdout = createWriteStream(stdoutPath, { flags: "w" });
  const stderr = createWriteStream(stderrPath, { flags: "w" });
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
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

async function seedDemoData() {
  const workspaceSlug = `release-demo-${randomUUID().slice(0, 6)}`;
  const onboarding = await postJson("/api/v1/onboarding/bootstrap", {
    defaultToolProfile: "research",
    budgetMode: "balanced",
    networkAllowlist: ["api.z.ai", "discord.com", "slack.com", "api.github.com"],
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
  });

  const workspace = await postJson("/api/v1/workspaces", {
    name: "Release Demo",
    description: "Sanitized workspace used for README and gallery screenshots.",
    slug: workspaceSlug,
  });

  const project = await postJson("/api/v1/chat/projects", {
    workspaceId: workspace.workspaceId,
    name: "Release readiness",
    description: "Public-share project container for the sanitized Mission Control gallery.",
    workspacePath: "workspace/demo/release-readiness",
    color: "#22d3ee",
  });

  await putJson(`/api/v1/workspaces/${encodeURIComponent(workspace.workspaceId)}/guidance/goatcitadel`, {
    content: [
      "# Release Demo Guidance",
      "",
      "- Favor concise operator updates.",
      "- Keep outputs practical and auditable.",
      "- Avoid hidden side effects.",
    ].join("\n"),
  });

  const session = await postJson("/api/v1/chat/sessions", {
    workspaceId: workspace.workspaceId,
    projectId: project.projectId,
    title: "1.0 release prep",
    mode: "chat",
  });

  const coworkSession = await postJson("/api/v1/chat/sessions", {
    workspaceId: workspace.workspaceId,
    projectId: project.projectId,
    title: "Launch supervision plan",
    mode: "cowork",
  });

  const codeSession = await postJson("/api/v1/chat/sessions", {
    workspaceId: workspace.workspaceId,
    projectId: project.projectId,
    title: "Installer proof checklist",
    mode: "code",
  });

  await seedChatMessages(session.sessionId, "chat");
  await seedChatMessages(coworkSession.sessionId, "cowork");
  await seedChatMessages(codeSession.sessionId, "code");

  await postJson("/api/v1/tasks", {
    workspaceId: workspace.workspaceId,
    title: "Validate installer-first release flow",
    description: "Clone path second, installer path first, and record any friction.",
    priority: "high",
    status: "review",
  }).then(async (task) => {
    await postJson(
      `/api/v1/tasks/${encodeURIComponent(task.taskId)}/activities?workspaceId=${encodeURIComponent(workspace.workspaceId)}`,
      {
        workspaceId: workspace.workspaceId,
        activityType: "comment",
        message: "Checklist trimmed to the highest-signal release flows.",
        agentId: "operator",
      },
    );
    await postJson(
      `/api/v1/tasks/${encodeURIComponent(task.taskId)}/deliverables?workspaceId=${encodeURIComponent(workspace.workspaceId)}`,
      {
        workspaceId: workspace.workspaceId,
        deliverableType: "artifact",
        title: "Readiness checklist",
        path: "workspace/demo/release-checklist.md",
        description: "Public-share gate review notes.",
      },
    );
  });

  await postJson("/api/v1/cron/jobs", {
    jobId: `release_readiness_digest_${workspaceSlug}`,
    name: "1.0 readiness digest",
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

  await postJson("/api/v1/approvals", {
    kind: "tool.invoke",
    riskLevel: "danger",
    payload: {
      toolName: "browser.navigate",
      target: "https://discord.com/developers/applications",
    },
    preview: {
      summary: "Open Discord developer portal to continue setup.",
    },
  });

  await postJson("/api/v1/agents", {
    roleId: "release-shepherd",
    name: "Release Shepherd",
    title: "Beta Launch Coordinator",
    summary: "Tracks readiness, docs drift, and announcement blockers.",
    specialties: ["release review", "docs", "handoffs"],
    defaultTools: ["fs.read", "fs.list", "browser.search"],
    aliases: ["shepherd"],
  });

  await postJson("/api/v1/knowledge/memory/write", {
    namespace: "release",
    title: "1.0 launch rule",
    content: "Manual testing starts only after install docs, installers, and validation gates are green.",
    tags: ["release", "policy"],
    source: "release-demo",
    metadata: { workspaceId: workspace.workspaceId, fixture: "public-screenshot" },
    sessionId: session.sessionId,
  });

  await postJson("/api/v1/knowledge/memory/write", {
    namespace: "integrations",
    title: "Discord rollout order",
    content:
      "Discord is the first external channel for 1.0 launch validation, with Slack second after sandbox validation.",
    tags: ["channels", "discord"],
    source: "release-demo",
    metadata: { workspaceId: workspace.workspaceId, fixture: "public-screenshot" },
    sessionId: session.sessionId,
  });

  await postJson("/api/v1/memory/context/compose", {
    scope: "chat",
    prompt: "Summarize the 1.0 launch posture and install priorities.",
    sessionId: session.sessionId,
    workspace: workspace.workspaceId,
    maxContextTokens: 1200,
  });

  await postJson("/api/v1/files/upload", {
    relativePath: "workspace/demo/release-checklist.md",
    content: [
      "# 1.0 Release Checklist",
      "",
      "- Installer-first README",
      "- Manual clone path verified",
      "- Screenshots regenerated from demo data",
    ].join("\n"),
  });

  await postJson("/api/v1/files/upload", {
    relativePath: "workspace/demo/discord-setup-notes.md",
    content: [
      "# Discord Setup Notes",
      "",
      "1. Create the application.",
      "2. Add the bot user.",
      "3. Copy the token into DISCORD_BOT_TOKEN.",
    ].join("\n"),
  });

  await postJson("/api/v1/prompt-packs/import", {
    name: "1.0 Sanity Pack",
    sourceLabel: "public-share-demo",
    content: [
      "[TEST-01] Install flow clarity",
      "Explain the fastest safe Windows install path in four steps.",
      "",
      "[TEST-02] Channel safety posture",
      "Recommend the best first external channel for beta and explain why.",
    ].join("\n"),
  });

  return {
    onboarding,
    workspaceId: workspace.workspaceId,
    projectId: project.projectId,
    sessionId: session.sessionId,
    coworkSessionId: coworkSession.sessionId,
    codeSessionId: codeSession.sessionId,
  };
}

async function seedChatMessages(sessionId, mode) {
  const storage = new Storage({
    dbPath: path.join(runtimeRoot, "data", "index.db"),
    transcriptsDir: path.join(runtimeRoot, "data", "transcripts"),
    auditDir: path.join(runtimeRoot, "data", "audit"),
  });
  try {
    const copy = {
      chat: {
        user: "Give me a tight 1.0 readiness summary before I share the repo.",
        assistant: [
          "Installer path is primary, manual clone is secondary, and the current release gate is green.",
          "Next move is a clean laptop install from GitHub plus Discord sandbox validation.",
        ].join(" "),
        actorId: "goatherder",
      },
      cowork: {
        user: "Plan the public launch review and keep approval checkpoints visible.",
        assistant: [
          "I split the review into install proof, provider setup, surface walkthrough, and external-channel validation.",
          "Three approvals are waiting so risky setup steps stay operator-owned.",
        ].join(" "),
        actorId: "release-shepherd",
      },
      code: {
        user: "Review the installer proof checklist and tell me what code path owns it.",
        assistant: [
          "The launcher and desktop packaging proof start in scripts/packaging and bin/goatcitadel.mjs.",
          "The next safe code action is a targeted verify:desktop run after any installer-touching patch.",
        ].join(" "),
        actorId: "coder",
      },
    }[mode] ?? {
      user: "Summarize the current workspace state.",
      assistant: "The release demo workspace is ready for review.",
      actorId: "goatherder",
    };
    const baseTime = Date.now() - 10 * 60 * 1000;
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const turnId = randomUUID();
    const userTimestamp = new Date(baseTime).toISOString();
    const assistantTimestamp = new Date(baseTime + 45_000).toISOString();
    storage.chatMessages.upsertMany([
      {
        messageId: userMessageId,
        sessionId,
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: copy.user,
        timestamp: userTimestamp,
      },
      {
        messageId: assistantMessageId,
        sessionId,
        role: "assistant",
        actorType: "agent",
        actorId: copy.actorId,
        content: copy.assistant,
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
      status: "completed",
      // Cowork/Code are retained session compatibility values; current turns
      // are rendered and governed through the canonical Chat surface.
      mode: "chat",
      model: "public-screenshot-seed",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: userTimestamp,
      finishedAt: assistantTimestamp,
    });
    storage.chatSessionBranchState.setActiveLeaf(sessionId, turnId);
  } finally {
    storage.close();
  }
}

async function captureScreenshots(activeWorkspaceId, screenshotTargets) {
  const browser = await chromium.launch({
    headless: true,
  });
  try {
    const context = await browser.newContext({
      viewport: {
        width: 1440,
        height: 1024,
      },
      colorScheme: "dark",
      deviceScaleFactor: 1,
    });
    await context.addInitScript(
      ({ workspaceId }) => {
        window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", workspaceId);
        window.localStorage.setItem("goatcitadel.ui.mode.v1", "simple");
        window.localStorage.setItem("goatcitadel.ui.technical_details.v1", "false");
        window.localStorage.setItem("goatcitadel.notifications.toasts.v1", "false");
        window.localStorage.setItem("goatcitadel.notifications.sound_mode.v1", "off");
      },
      { workspaceId: activeWorkspaceId },
    );

    const page = await context.newPage();
    for (const target of screenshotTargets) {
      const targetUrl = new URL(target.href, uiUrl).toString();
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(target.settleMs);
      if (target.readySelector) {
        await page.waitForSelector(target.readySelector, {
          state: "visible",
          timeout: 20_000,
        });
        await page.waitForTimeout(750);
      }
      if (target.readyText) {
        await page.waitForFunction(
          (text) => document.body?.innerText.toLowerCase().includes(text.toLowerCase()),
          target.readyText,
          { timeout: 20_000 },
        );
      }
      if (typeof target.scrollY === "number") {
        await page.evaluate((scrollY) => window.scrollTo(0, scrollY), target.scrollY);
        await page.waitForTimeout(500);
      } else {
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page.addStyleTag({
        content: ".notification-stack { display: none !important; }",
      });
      if (target.screenshotSelector) {
        await page.locator(target.screenshotSelector).screenshot({
          path: path.join(stagedOutputDir, target.file),
        });
      } else {
        await page.screenshot({
          path: path.join(stagedOutputDir, target.file),
        });
      }
    }
    await context.close();
  } finally {
    await browser.close();
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
      <p>Regenerated from a sanitized 1.0 demo runtime. Folder: <code>docs/screenshots/${escapeHtml(uiTarget.screenshotDirName)}</code></p>
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

async function putJson(route, body) {
  return requestJson(route, {
    method: "PUT",
    body,
  });
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
