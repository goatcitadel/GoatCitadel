import path from "node:path";
import { chromium } from "playwright";
import {
  clampString,
  maybeParseBool,
  maybeParseInt,
  repoRoot,
  runCommand,
  runScenario,
  sanitizeFilePart,
  writeJson,
  writeText,
} from "./shared.mjs";
import {
  delay,
  requestJson,
  startVerificationStack,
  stopVerificationStack,
} from "./runtime.mjs";

const PROVIDER_SCENARIOS = ["simple", "stream", "structured", "tools"];
const UNSUPPORTED_PROVIDER_SCENARIOS = {
  perplexity: ["tools"],
};
const TAB_ROUTES = [
  { tab: "dashboard", title: "Dashboard" },
  { tab: "chat", title: "Chat Workspace" },
  { tab: "promptLab", title: "Prompt Lab" },
  { tab: "approvals", title: "Approvals" },
  { tab: "settings", title: "Settings" },
  { tab: "workspaces", title: "Workspaces" },
  { tab: "integrations", title: "Integrations" },
  { tab: "mcp", title: "MCP" },
];

export async function runFastLane(context) {
  const commands = [
    { id: "fast.typecheck", title: "Root typecheck", args: ["typecheck"] },
    { id: "fast.test", title: "Root tests", args: ["test"] },
    { id: "fast.smoke", title: "Gateway smoke", args: ["smoke"] },
    { id: "fast.build", title: "Root build", args: ["build"] },
    { id: "fast.docs", title: "Docs checks", args: ["docs:check"] },
  ];

  for (const command of commands) {
    await runScenario(context, {
      id: command.id,
      lane: "fast",
      title: command.title,
      subsystem: "fast",
    }, async () => {
      const result = await runCommand(pnpmCommand(), command.args, {
        cwd: repoRoot,
        artifactRoot: path.join(context.artifactRoot, "diagnostics"),
        logName: command.id,
      });
      return {
        status: result.code === 0 ? "passed" : "failed",
        error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
        metrics: {
          exitCode: result.code,
          durationMs: result.durationMs,
        },
        artifacts: {
          diagnostics: [],
          screenshots: [],
          traces: [],
          logs: [
            relativeToRun(context, result.stdoutPath),
            relativeToRun(context, result.stderrPath),
          ],
          perf: [],
          playwright: [],
        },
      };
    });
  }
}

export async function runDeepCoreLane(context, options = {}) {
  const stack = await startVerificationStack(context, {
    includeUi: true,
  });
  try {
    const statusResponse = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/status");
    await runScenario(context, {
      id: "core.control-plane.status",
      lane: "deep-core",
      title: "Verification control plane status",
      subsystem: "gateway",
    }, async () => ({
      status: statusResponse.ok ? "passed" : "failed",
      error: statusResponse.ok ? undefined : JSON.stringify(statusResponse.body),
      metrics: {
        providerCount: Array.isArray(statusResponse.body?.providers) ? statusResponse.body.providers.length : 0,
      },
      artifacts: {
        diagnostics: [],
        screenshots: [],
        traces: [],
        logs: [],
        perf: [],
        playwright: [],
      },
    }));

    const seedResponse = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
      method: "POST",
      body: {
        workspaceName: "Verification Core Workspace",
        sessionTitle: "Verification Core Session",
        sessionCount: 18,
        longThreadTurns: 60,
      },
    });
    if (!seedResponse.ok) {
      throw new Error(`verification seed failed: ${JSON.stringify(seedResponse.body)}`);
    }
    const onboardingStateResponse = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/state");
    const onboardingCompleted = Boolean(onboardingStateResponse.body?.completed);
    const shellLandingTab = onboardingCompleted ? "dashboard" : "onboarding";

    const browser = await chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext({
        viewport: { width: 1440, height: 1024 },
        colorScheme: "dark",
      });
      const page = await browserContext.newPage();
      const browserLog = attachBrowserLogging(page);

      await runScenario(context, {
        id: "core.browser.navigation",
        lane: "deep-core",
        title: "Mission Control core navigation",
        subsystem: "shell",
      }, async ({ correlationId }) => {
        const metrics = {};
        for (const target of TAB_ROUTES) {
          await page.goto(`${stack.uiUrl}/?tab=${encodeURIComponent(target.tab)}`, { waitUntil: "domcontentloaded" });
          await waitForMissionControlShell(page);
          await waitForTabReady(page, target.tab === "dashboard" ? shellLandingTab : target.tab);
          await page.waitForTimeout(800);
          metrics[target.tab] = "ok";
        }
        const artifacts = await captureBrowserArtifacts(context, {
          slug: "core-browser-navigation",
          page,
          browserLog,
          gatewayUrl: stack.gatewayUrl,
          correlationId,
        });
        return {
          status: "passed",
          notes: ["Core tabs rendered without immediate browser errors."],
          metrics,
          artifacts,
        };
      });

      await runScenario(context, {
        id: "core.browser.chat-thread",
        lane: "deep-core",
        title: "Seeded chat thread renders and remains inspectable",
        subsystem: "chat",
      }, async ({ correlationId }) => {
        await page.evaluate((workspaceId) => {
          window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", String(workspaceId));
        }, seedResponse.body.workspaceId);
        await page.goto(`${stack.uiUrl}/?tab=chat`, { waitUntil: "domcontentloaded" });
        await waitForMissionControlShell(page);
        await waitForTabReady(page, "chat");
        await setBrowserCorrelation(page, correlationId, seedResponse.body.sessionId);
        await page.getByRole("button", {
          name: String(seedResponse.body.sessionTitle ?? "Verification Core Session"),
          exact: true,
        }).click();
        await page.waitForTimeout(1000);
        await page.waitForSelector(".chat-v11-turn-surface", { timeout: 15000 });
        await page.getByText("Run details", { exact: true }).first().click();
        await page.waitForSelector(".chat-v11-turn-details[open]", { timeout: 10000 });
        const artifacts = await captureBrowserArtifacts(context, {
          slug: "core-chat-thread",
          page,
          browserLog,
          gatewayUrl: stack.gatewayUrl,
          correlationId,
        });
        return {
          status: "passed",
          notes: ["Seeded chat content rendered and turn details were inspectable."],
          metrics: {
            sessionCount: seedResponse.body.sessionIds.length,
          },
          artifacts,
        };
      });

      await runScenario(context, {
        id: "core.browser.command-palette",
        lane: "deep-core",
        title: "Command palette and diagnostics panel are reachable",
        subsystem: "shell",
      }, async ({ correlationId }) => {
        await page.goto(`${stack.uiUrl}/?tab=${encodeURIComponent(shellLandingTab)}`, { waitUntil: "domcontentloaded" });
        await waitForMissionControlShell(page);
        await waitForTabReady(page, shellLandingTab);
        await setBrowserCorrelation(page, correlationId);
        await page.getByRole("button", { name: "Command Palette" }).click();
        await page.getByPlaceholder("Type a page or action...").fill("chat");
        await page.waitForSelector("text=/Go to Chat Workspace/i", { timeout: 15000 });
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Diagnostics" }).click();
        await page.waitForSelector('[aria-label="Developer diagnostics"]', { timeout: 15000 });
        const artifacts = await captureBrowserArtifacts(context, {
          slug: "core-command-palette-diagnostics",
          page,
          browserLog,
          gatewayUrl: stack.gatewayUrl,
          correlationId,
        });
        return {
          status: "passed",
          notes: ["Command palette and diagnostics panel opened."],
          artifacts,
          metrics: {},
        };
      });

      await runScenario(context, {
        id: "core.browser.effects-and-perf",
        lane: "deep-core",
        title: "Effects switching and chat/dashboard perf smoke",
        subsystem: "core-browser",
      }, async ({ correlationId }) => {
        await page.goto(`${stack.uiUrl}/?tab=${encodeURIComponent(shellLandingTab)}`, { waitUntil: "domcontentloaded" });
        await waitForMissionControlShell(page);
        await waitForTabReady(page, shellLandingTab);
        await page.getByRole("button", { name: "Reduced" }).click();
        await page.waitForTimeout(400);
        const dashboardPerf = await measureLongTaskProfile(page, async () => {
          await page.evaluate(async () => {
            for (let index = 0; index < 8; index += 1) {
              window.scrollTo(0, index % 2 === 0 ? document.body.scrollHeight : 0);
              await new Promise((resolve) => setTimeout(resolve, 80));
            }
          });
        });
        await page.goto(`${stack.uiUrl}/?tab=chat`, { waitUntil: "domcontentloaded" });
        await waitForMissionControlShell(page);
        await waitForTabReady(page, "chat");
        const chatPerf = await measureLongTaskProfile(page, async () => {
          await page.evaluate(async () => {
            const rail = document.querySelector(".chat-v11-session-rail");
            const thread = document.querySelector(".chat-v11-thread-view");
            for (const element of [rail, thread]) {
              if (!(element instanceof HTMLElement)) {
                continue;
              }
              for (let index = 0; index < 5; index += 1) {
                element.scrollTop = element.scrollHeight;
                await new Promise((resolve) => setTimeout(resolve, 60));
                element.scrollTop = 0;
                await new Promise((resolve) => setTimeout(resolve, 60));
              }
            }
          });
        });
        const perfPath = path.join(context.artifactRoot, "perf", "core-browser-perf.json");
        await writeJson(perfPath, {
          dashboard: dashboardPerf,
          chat: chatPerf,
        });
        const artifacts = await captureBrowserArtifacts(context, {
          slug: "core-browser-perf",
          page,
          browserLog,
          gatewayUrl: stack.gatewayUrl,
          correlationId,
          extraPerfArtifacts: [perfPath],
        });
        return {
          status: dashboardPerf.longTaskCount > 12 || chatPerf.longTaskCount > 16 ? "degraded" : "passed",
          notes: ["Reduced effects mode and scroll smoke completed."],
          metrics: {
            dashboardLongTasks: dashboardPerf.longTaskCount,
            chatLongTasks: chatPerf.longTaskCount,
          },
          artifacts,
        };
      });

      await browserContext.close();
    } finally {
      await browser.close();
    }

    await runLiveProviderScenarios(context, stack.gatewayUrl);
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function runDeepEcosystemLane(context, options = {}) {
  const stack = await startVerificationStack(context, {
    includeUi: true,
  });
  try {
    await runScenario(context, {
      id: "ecosystem.doctor.audit",
      lane: "deep-ecosystem",
      title: "Doctor deep audit",
      subsystem: "ecosystem",
    }, async () => {
      const result = await runCommand(pnpmCommand(), ["doctor:audit"], {
        cwd: repoRoot,
        artifactRoot: path.join(context.artifactRoot, "diagnostics"),
        logName: "ecosystem-doctor-deep",
        env: {
          GOATCITADEL_GATEWAY_URL: stack.gatewayUrl,
          GOATCITADEL_ROOT_DIR: stack.runtimeRoot,
        },
      });
      return {
        status: result.code === 0 ? "passed" : "failed",
        error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
        artifacts: {
          diagnostics: [],
          screenshots: [],
          traces: [],
          logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
          perf: [],
          playwright: [],
        },
        metrics: {
          exitCode: result.code,
        },
      };
    });

    await runScenario(context, {
      id: "ecosystem.voice.runtime-status",
      lane: "deep-ecosystem",
      title: "Managed voice runtime status",
      subsystem: "voice",
    }, async () => {
      const response = await requestJson(stack.gatewayUrl, "/api/v1/voice/runtime");
      const diagnosticsPath = path.join(context.artifactRoot, "diagnostics", "voice-runtime-status.json");
      await writeJson(diagnosticsPath, response.body);
      return {
        status: response.ok ? "passed" : "failed",
        error: response.ok ? undefined : JSON.stringify(response.body),
        artifacts: {
          diagnostics: [relativeToRun(context, diagnosticsPath)],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
        },
        metrics: {
          installedModelCount: Array.isArray(response.body?.installedModels) ? response.body.installedModels.length : 0,
          runtimeReady: Boolean(response.body?.runtimeReady),
        },
      };
    });

    await runScenario(context, {
      id: "ecosystem.addons.arena",
      lane: "deep-ecosystem",
      title: "Arena add-on catalog and status",
      subsystem: "addons",
    }, async () => {
      const catalog = await requestJson(stack.gatewayUrl, "/api/v1/addons/catalog");
      const arenaEntry = Array.isArray(catalog.body?.items)
        ? catalog.body.items.find((item) => item.addonId === "arena")
        : undefined;
      let status = null;
      if (arenaEntry) {
        status = await requestJson(stack.gatewayUrl, "/api/v1/addons/arena/status");
      }
      const outPath = path.join(context.artifactRoot, "provider-results", "arena-status.json");
      await writeJson(outPath, {
        catalog: catalog.body,
        status: status?.body ?? null,
      });
      return {
        status: arenaEntry ? "passed" : "failed",
        error: arenaEntry ? undefined : "Arena add-on is missing from the catalog.",
        artifacts: {
          diagnostics: [relativeToRun(context, outPath)],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
        },
        metrics: {
          hasArenaCatalogEntry: Boolean(arenaEntry),
          launchUrlPresent: Boolean(status?.body?.launchUrl),
        },
      };
    });

    await runScenario(context, {
      id: "ecosystem.mesh.status",
      lane: "deep-ecosystem",
      title: "Mesh and onboarding readiness endpoints",
      subsystem: "ecosystem",
    }, async () => {
      const mesh = await requestJson(stack.gatewayUrl, "/api/v1/mesh/status");
      const onboarding = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/state");
      const outPath = path.join(context.artifactRoot, "diagnostics", "ecosystem-mesh-onboarding.json");
      await writeJson(outPath, {
        mesh: mesh.body,
        onboarding: onboarding.body,
      });
      return {
        status: mesh.ok && onboarding.ok ? "passed" : "failed",
        error: mesh.ok && onboarding.ok ? undefined : "Mesh or onboarding endpoint failed.",
        artifacts: {
          diagnostics: [relativeToRun(context, outPath)],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
        },
        metrics: {
          meshEnabled: Boolean(mesh.body?.enabled),
          onboardingComplete: Boolean(onboarding.body?.completed),
        },
      };
    });

    const browser = await chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext({
        viewport: { width: 1440, height: 1024 },
        colorScheme: "dark",
      });
      const page = await browserContext.newPage();
      const browserLog = attachBrowserLogging(page);

      await runScenario(context, {
        id: "ecosystem.office.route",
        lane: "deep-ecosystem",
        title: "Office route renders with reduced effects",
        subsystem: "office",
      }, async ({ correlationId }) => {
        await page.addInitScript(() => {
          window.localStorage.setItem("goatcitadel.ui.effects_mode.v1", "reduced");
        });
        await page.goto(`${stack.uiUrl}/?tab=office`, { waitUntil: "domcontentloaded" });
        await setBrowserCorrelation(page, correlationId);
        await page.waitForSelector(".office-stage-panel", { timeout: 25000 });
        await page.waitForTimeout(3500);
        const perf = await measureLongTaskProfile(page, async () => {
          await page.evaluate(async () => {
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise((resolve) => setTimeout(resolve, 120));
            window.scrollTo(0, 0);
            await new Promise((resolve) => setTimeout(resolve, 120));
          });
        });
        const perfPath = path.join(context.artifactRoot, "perf", "ecosystem-office-perf.json");
        await writeJson(perfPath, perf);
        const artifacts = await captureBrowserArtifacts(context, {
          slug: "ecosystem-office-route",
          page,
          browserLog,
          gatewayUrl: stack.gatewayUrl,
          correlationId,
          extraPerfArtifacts: [perfPath],
        });
        return {
          status: perf.longTaskCount > 16 ? "degraded" : "passed",
          metrics: {
            longTaskCount: perf.longTaskCount,
            maxLongTaskMs: perf.maxLongTaskMs,
          },
          notes: ["Office route rendered with reduced effects enabled."],
          artifacts,
        };
      });

      await browserContext.close();
    } finally {
      await browser.close();
    }
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function runSoakLane(context, options = {}) {
  const durationMs = maybeParseInt(options.durationMs ?? process.env.GOATCITADEL_VERIFY_SOAK_DURATION_MS, 7_200_000);
  const stack = await startVerificationStack(context, {
    includeUi: true,
  });
  try {
    const statusResponse = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/status");
    const configuredProviders = (statusResponse.body?.providers ?? []).filter((item) => item.hasSecret);
    const endAt = Date.now() + durationMs;
    let cycle = 0;
    while (Date.now() < endAt) {
      cycle += 1;
      await runScenario(context, {
        id: `soak.gateway.provider-cycle-${cycle}`,
        lane: "soak",
        title: `Provider soak cycle ${cycle}`,
        subsystem: "providers",
      }, async () => {
        for (const provider of configuredProviders) {
          const result = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/provider-exercise", {
            method: "POST",
            body: {
              providerId: provider.providerId,
              model: provider.defaultModel,
              scenario: "simple",
            },
          });
          if (!result.body?.ok) {
            return {
              status: "failed",
              providerId: provider.providerId,
              modelId: provider.defaultModel,
              error: result.body?.error ?? "provider soak failed",
              metrics: { cycle },
              artifacts: {
                diagnostics: [],
                screenshots: [],
                traces: [],
                logs: [],
                perf: [],
                playwright: [],
              },
            };
          }
        }
        return {
          status: configuredProviders.length > 0 ? "passed" : "not_configured",
          metrics: {
            cycle,
            configuredProviders: configuredProviders.length,
          },
          artifacts: {
            diagnostics: [],
            screenshots: [],
            traces: [],
            logs: [],
            perf: [],
            playwright: [],
          },
        };
      });

      await delay(1000);
    }
  } finally {
    await stopVerificationStack(stack);
  }
}

async function runLiveProviderScenarios(context, gatewayUrl) {
  const statusResponse = await requestJson(gatewayUrl, "/api/v1/dev/verification/status");
  const providers = Array.isArray(statusResponse.body?.providers) ? statusResponse.body.providers : [];
  for (const provider of providers) {
    if (!provider.hasSecret) {
      await runScenario(context, {
        id: `providers.${provider.providerId}.not-configured`,
        lane: "deep-core",
        title: `${provider.label} provider readiness`,
        subsystem: "providers",
      }, async () => ({
        status: "not_configured",
        providerId: provider.providerId,
        modelId: provider.defaultModel,
        notes: ["Provider is not configured in this environment."],
        artifacts: {
          diagnostics: [],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
        },
      }));
      continue;
    }

    const unsupportedScenarios = new Set(
      UNSUPPORTED_PROVIDER_SCENARIOS[provider.providerId] ?? [],
    );
    for (const scenario of PROVIDER_SCENARIOS) {
      await runScenario(context, {
        id: `providers.${provider.providerId}.${scenario}`,
        lane: "deep-core",
        title: `${provider.label} ${scenario} verification`,
        subsystem: "providers",
      }, async () => {
        if (unsupportedScenarios.has(scenario)) {
          return {
            status: "skipped",
            providerId: provider.providerId,
            modelId: provider.defaultModel,
            notes: ["Scenario skipped because this provider/model does not support that capability."],
            artifacts: {
              diagnostics: [],
              screenshots: [],
              traces: [],
              logs: [],
              perf: [],
              playwright: [],
            },
            metrics: {},
          };
        }
        const response = await requestJson(gatewayUrl, "/api/v1/dev/verification/provider-exercise", {
          method: "POST",
          body: {
            providerId: provider.providerId,
            model: provider.defaultModel,
            scenario,
          },
        });
        const resultPath = path.join(
          context.artifactRoot,
          "provider-results",
          `${sanitizeFilePart(provider.providerId)}-${sanitizeFilePart(scenario)}.json`,
        );
        await writeJson(resultPath, response.body);
        const status = deriveProviderStatus(response.body);
        return {
          status,
          providerId: provider.providerId,
          modelId: provider.defaultModel,
          error: response.body?.ok ? undefined : response.body?.error,
          notes: response.body?.ok ? [clampString(response.body.outputPreview ?? "", 240)] : [],
          artifacts: {
            diagnostics: [relativeToRun(context, resultPath)],
            screenshots: [],
            traces: [],
            logs: [],
            perf: [],
            playwright: [],
          },
          metrics: {
            elapsedMs: response.body?.elapsedMs ?? 0,
            chunkCount: response.body?.chunkCount ?? 0,
          },
        };
      });
    }
  }
}

async function waitForMissionControlShell(page, timeoutMs = 30000) {
  await page.waitForFunction(() => {
    const shell = document.querySelector(".layout-shell");
    const accessGate = document.querySelector(".gateway-access-shell");
    return Boolean(shell) && !accessGate;
  }, { timeout: timeoutMs });
  await page.waitForSelector(".shell-topbar", { timeout: timeoutMs });
}

async function waitForTabReady(page, tab, timeoutMs = 30000) {
  switch (tab) {
    case "onboarding":
      await page.waitForSelector("text=Step 1: Gateway Access", { timeout: timeoutMs });
      break;
    case "dashboard":
      await page.waitForSelector(".dashboard-page", { timeout: timeoutMs });
      break;
    case "chat":
      await page.waitForSelector(".chat-v11", { timeout: timeoutMs });
      break;
    default:
      await page.waitForFunction(() => {
        const loading = document.querySelector(".shell-page-loading");
        return !loading;
      }, { timeout: timeoutMs });
      await page.waitForSelector(".shell-topbar", { timeout: timeoutMs });
      break;
  }
}

function deriveProviderStatus(payload) {
  if (payload?.ok) {
    return "passed";
  }
  const error = String(payload?.error ?? "").toLowerCase();
  if (/invalid api key|authentication failed|authentication_error|unauthorized|insufficient credits|payment required|no longer available to new users|provider is not configured|missing .*api key|authorized_error/.test(error)) {
    return "not_configured";
  }
  if (/unsupported|not supported|json_schema|tool_choice|tools are not available|response_format|unavailable now/.test(error)) {
    return "degraded";
  }
  if (/not found|404/.test(error)) {
    return "degraded";
  }
  return "failed";
}

function attachBrowserLogging(page) {
  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      timestamp: new Date().toISOString(),
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push({
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    });
  });
  return {
    getSnapshot: () => ({
      consoleMessages: [...consoleMessages],
      pageErrors: [...pageErrors],
    }),
  };
}

async function setBrowserCorrelation(page, correlationId, sessionId) {
  await page.evaluate(({ correlationId: value, sessionId: activeSessionId }) => {
    window.__goatcitadelDevDiagnostics?.setCorrelationId(value);
    if (activeSessionId) {
      window.__goatcitadelDevDiagnostics?.setChatSessionId(activeSessionId);
    }
  }, { correlationId, sessionId });
}

async function captureBrowserArtifacts(context, input) {
  const screenshotPath = path.join(context.artifactRoot, "screenshots", `${input.slug}.png`);
  const browserDiagnosticsPath = path.join(context.artifactRoot, "diagnostics", `${input.slug}-browser.json`);
  const gatewayDiagnosticsPath = path.join(context.artifactRoot, "diagnostics", `${input.slug}-gateway.json`);
  const consoleLogPath = path.join(context.artifactRoot, "playwright", `${input.slug}-console.json`);

  await input.page.screenshot({ path: screenshotPath, fullPage: false });
  const gatewayDiagnostics = await requestJson(
    input.gatewayUrl,
    `/api/v1/dev/verification/diagnostics-snapshot?limit=150${input.correlationId ? `&correlationId=${encodeURIComponent(input.correlationId)}` : ""}`,
  );
  await writeJson(gatewayDiagnosticsPath, gatewayDiagnostics.body);
  const browserBundle = await input.page.evaluate((gatewayItems) => {
    return window.__goatcitadelDevDiagnostics?.buildBundle(gatewayItems) ?? null;
  }, gatewayDiagnostics.body?.items ?? []);
  await writeJson(browserDiagnosticsPath, browserBundle);
  await writeJson(consoleLogPath, input.browserLog.getSnapshot());
  return {
    diagnostics: [relativeToRun(context, browserDiagnosticsPath), relativeToRun(context, gatewayDiagnosticsPath)],
    screenshots: [relativeToRun(context, screenshotPath)],
    traces: [],
    logs: [relativeToRun(context, consoleLogPath)],
    perf: (input.extraPerfArtifacts ?? []).map((item) => relativeToRun(context, item)),
    playwright: [relativeToRun(context, consoleLogPath)],
  };
}

async function measureLongTaskProfile(page, action) {
  await page.evaluate(() => {
    const bucket = {
      entries: [],
      unsupported: false,
      observer: null,
    };
    if (typeof PerformanceObserver === "undefined") {
      bucket.unsupported = true;
      window.__goatVerifyLongTaskBucket = bucket;
      return;
    }
    const observer = new PerformanceObserver((list) => {
      bucket.entries.push(...list.getEntries().map((entry) => ({
        name: entry.name,
        duration: entry.duration,
        startTime: entry.startTime,
      })));
    });
    observer.observe({ entryTypes: ["longtask"] });
    bucket.observer = observer;
    window.__goatVerifyLongTaskBucket = bucket;
  });
  const startedAt = Date.now();
  await action();
  await delay(500);
  const summary = await page.evaluate(() => {
    const bucket = window.__goatVerifyLongTaskBucket;
    if (!bucket) {
      return { unsupported: true, entries: [] };
    }
    bucket.observer?.disconnect?.();
    return {
      unsupported: Boolean(bucket.unsupported),
      entries: bucket.entries ?? [],
    };
  });
  const durations = summary.entries.map((item) => item.duration);
  return {
    unsupported: summary.unsupported,
    longTaskCount: durations.length,
    maxLongTaskMs: durations.length > 0 ? Math.max(...durations) : 0,
    totalLongTaskMs: durations.reduce((sum, value) => sum + value, 0),
    actionDurationMs: Date.now() - startedAt,
  };
}

function relativeToRun(context, filePath) {
  return path.relative(context.artifactRoot, filePath).replaceAll("\\", "/");
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
