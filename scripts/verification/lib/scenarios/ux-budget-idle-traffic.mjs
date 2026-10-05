import { mkdir } from "node:fs/promises";

/**
 * Rule 17 (cockpit W1): an idle cockpit tab listens instead of polling. These scenarios count the
 * Gateway requests a tab makes while idle, while another tab runs a Chat turn, and while Chat opens.
 * The event stream itself is excluded: it is one long-lived connection, not polling.
 */
export const IDLE_TRAFFIC_BUDGETS = Object.freeze({
  /** Target: an idle tab makes at most 6 requests a minute, whatever other tabs do. */
  idlePerTwoMinutes: 12,
  chatTurnElsewhere: 10,
  /** Target 20; if the first GitHub run measures more, this becomes the measured value + 2. */
  openChat: 20,
});
export const EVENT_STREAM_PATH = "/api/v1/events/stream";
const IDLE_WINDOW_MS = 120_000;
const SETTLE_MS = 10_000;
const AFTER_REPLY_MS = 15_000;
const OPEN_CHAT_WINDOW_MS = 3_500;
const VIEWPORT = { width: 1440, height: 900 };

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The path (never the query string, which may carry tokens) of a Gateway request worth counting, or
 * null for other origins and the event stream. A same-origin `/api/` request counts too, in case the
 * UI is served behind a proxy.
 */
export function gatewayRequestPath(url, gatewayOrigin, uiOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const gateway = originOf(gatewayOrigin);
  const ui = uiOrigin ? originOf(uiOrigin) : null;
  const counted =
    (gateway && parsed.origin === gateway) || (ui && parsed.origin === ui && parsed.pathname.startsWith("/api/"));
  if (!counted || parsed.pathname === EVENT_STREAM_PATH) return null;
  return parsed.pathname;
}

/** Records the page's Gateway request paths until `stop()`. */
export function countGatewayRequests(page, gatewayOrigin, { uiOrigin } = {}) {
  const paths = [];
  const record = (request) => {
    const counted = gatewayRequestPath(request.url(), gatewayOrigin, uiOrigin);
    if (counted) paths.push(counted);
  };
  page.on("request", record);
  return {
    stop() {
      page.off("request", record);
      return [...paths];
    },
  };
}

export function evaluateRequestBudget({ count, budget }) {
  return { count, budget, pass: count <= budget };
}

export function countRequestsByPath(paths) {
  const counts = {};
  for (const requestPath of paths) counts[requestPath] = (counts[requestPath] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

async function waitForMoreText(page, text, before, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await page.getByText(text).count()) > before) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for another "${text}" reply.`);
}

export async function runUxBudgetIdleTraffic(environment) {
  const { context, browser, stack, fixture, deps } = environment;
  const {
    buildVerificationUiUrl,
    emptyArtifacts,
    installMissionControlNextBrowserState,
    path,
    relativeToRun,
    runScenario,
    writeJson,
  } = deps;
  const counterOptions = { uiOrigin: stack.uiUrl };

  async function newCockpitContext() {
    const browserContext = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark" });
    await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
    await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
    return browserContext;
  }

  async function openChat(page) {
    await page.goto(
      buildVerificationUiUrl(stack.uiUrl, `/chat?sessionId=${encodeURIComponent(fixture.sessionId)}&shell=cockpit`),
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForSelector('[aria-label="Messages"]', { timeout: 30_000 });
  }

  async function openInbox(page) {
    await page.goto(buildVerificationUiUrl(stack.uiUrl, "/inbox?shell=cockpit"), { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Inbox", level: 1 }).waitFor({ timeout: 30_000 });
  }

  /** Writes the evidence, then fails the scenario when any measurement is over its budget. */
  async function report(slug, measurements) {
    const diagnostics = path.join(context.artifactRoot, "diagnostics");
    await mkdir(diagnostics, { recursive: true });
    const outPath = path.join(diagnostics, `ux-budgets-idle-traffic-${slug}.json`);
    await writeJson(outPath, { scenario: `ux-budgets.idle-traffic.${slug}`, measurements });
    const over = Object.entries(measurements).filter(([, measurement]) => !measurement.pass);
    if (over.length)
      throw new Error(
        `Idle traffic ${slug}: ${over.map(([name, value]) => `${name} made ${value.count} requests (budget ${value.budget})`).join("; ")}`,
      );
    return {
      status: "passed",
      metrics: Object.fromEntries(Object.entries(measurements).map(([name, value]) => [name, value.count])),
      artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
    };
  }

  const measure = (paths, budget) => ({
    ...evaluateRequestBudget({ count: paths.length, budget }),
    paths: countRequestsByPath(paths),
  });

  await runScenario(
    context,
    {
      id: "ux-budgets.idle-traffic.two-tabs",
      lane: "ux-budgets",
      title: "Two idle cockpit tabs stay within their request budget",
      subsystem: "mission-control-ux",
    },
    async () => {
      const browserContext = await newCockpitContext();
      try {
        const chatPage = await browserContext.newPage();
        const inboxPage = await browserContext.newPage();
        await openChat(chatPage);
        await openInbox(inboxPage);
        await chatPage.waitForTimeout(SETTLE_MS);
        const chatCounter = countGatewayRequests(chatPage, stack.gatewayUrl, counterOptions);
        const inboxCounter = countGatewayRequests(inboxPage, stack.gatewayUrl, counterOptions);
        await chatPage.waitForTimeout(IDLE_WINDOW_MS);
        return await report("two-tabs", {
          chat: measure(chatCounter.stop(), IDLE_TRAFFIC_BUDGETS.idlePerTwoMinutes),
          inbox: measure(inboxCounter.stop(), IDLE_TRAFFIC_BUDGETS.idlePerTwoMinutes),
        });
      } finally {
        await browserContext.close();
      }
    },
  );

  await runScenario(
    context,
    {
      id: "ux-budgets.idle-traffic.chat-turn-elsewhere",
      lane: "ux-budgets",
      title: "An idle tab stays quiet while another tab runs a Chat turn",
      subsystem: "mission-control-ux",
    },
    async () => {
      const browserContext = await newCockpitContext();
      try {
        const chatPage = await browserContext.newPage();
        const inboxPage = await browserContext.newPage();
        await openChat(chatPage);
        await openInbox(inboxPage);
        await chatPage.waitForTimeout(SETTLE_MS);
        const replies = await chatPage.getByText("UX_BUDGET_OK").count();
        const inboxCounter = countGatewayRequests(inboxPage, stack.gatewayUrl, counterOptions);
        await chatPage.getByRole("textbox", { name: "Message", exact: true }).fill("Idle traffic check");
        await chatPage.getByRole("button", { name: "Send", exact: true }).click();
        await waitForMoreText(chatPage, "UX_BUDGET_OK", replies, 60_000);
        await chatPage.waitForTimeout(AFTER_REPLY_MS);
        return await report("chat-turn-elsewhere", {
          inbox: measure(inboxCounter.stop(), IDLE_TRAFFIC_BUDGETS.chatTurnElsewhere),
        });
      } finally {
        await browserContext.close();
      }
    },
  );

  await runScenario(
    context,
    {
      id: "ux-budgets.idle-traffic.open-chat",
      lane: "ux-budgets",
      title: "Opening Chat stays within its request budget",
      subsystem: "mission-control-ux",
    },
    async () => {
      const browserContext = await newCockpitContext();
      try {
        const page = await browserContext.newPage();
        const counter = countGatewayRequests(page, stack.gatewayUrl, counterOptions);
        const started = Date.now();
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/chat?shell=cockpit"), { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(Math.max(0, OPEN_CHAT_WINDOW_MS - (Date.now() - started)));
        return await report("open-chat", { openChat: measure(counter.stop(), IDLE_TRAFFIC_BUDGETS.openChat) });
      } finally {
        await browserContext.close();
      }
    },
  );
}
