import {
  UX_BUDGET_ROUTE_SLUGS,
  COCKPIT_ROUTES,
  CHAT_VIEWPORTS,
  COPY_EXEMPT_SELECTOR,
  collectVisibleUiText,
  measureLayout,
  classicManifestEntry,
  readCapabilityOwnerText,
  TOAST_SETTLE_MS,
} from "./ux-budget-measurements.mjs";
import {
  evaluateChatBudget,
  evaluateHorizontalOverflow,
  evaluateRailReach,
  evaluateToastBudget,
  findRawCopyTokens,
  withoutOwnerText,
} from "../ux-budgets.mjs";
import { resolveReleaseSurfaceHref } from "../release-surface-manifest.mjs";

export async function runUxBudgetRoutes(environment) {
  const { context, options, enforcement, browser, stack, fixture, openRoute, deps } = environment;
  const {
    assertOk,
    auditPageAccessibility,
    axeSourcePath,
    buildVerificationUiUrl,
    installMissionControlNextBrowserState,
    requestJson,
    runScenario,
  } = deps;
  for (const slug of options.routeSlugs ?? UX_BUDGET_ROUTE_SLUGS) {
    await runScenario(
      context,
      {
        id: `ux-budgets.cold-load.${slug}`,
        lane: "ux-budgets",
        title: `Cold load ${slug}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const entry = classicManifestEntry(slug);
        const { browserContext, page } = await openRoute(
          { width: 1440, height: 900 },
          entry,
          resolveReleaseSurfaceHref(entry, {}, fixture),
        );
        try {
          const layout = await page.evaluate(measureLayout);
          const ownerText = await readCapabilityOwnerText({ gatewayUrl: stack.gatewayUrl, requestJson, assertOk });
          const visibleText = withoutOwnerText(
            await page.evaluate(collectVisibleUiText, COPY_EXEMPT_SELECTOR),
            ownerText,
          );
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const toasts = evaluateToastBudget(layout.toastCount);
          const overflow = evaluateHorizontalOverflow(layout);
          const rawCopy = findRawCopyTokens(visibleText);
          const rawContext =
            rawCopy.length > 0
              ? await page.evaluate(
                  (tokens) => {
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                    const found = [];
                    for (let node = walker.nextNode(); node && found.length < tokens.length; node = walker.nextNode()) {
                      for (const token of tokens) {
                        if (!node.textContent?.includes(token) || found.some((item) => item.token === token)) continue;
                        const parent = node.parentElement;
                        found.push({
                          token,
                          tag: parent?.tagName,
                          className: parent?.className,
                          text: parent?.textContent?.slice(0, 140),
                        });
                      }
                    }
                    return found;
                  },
                  [...new Set(rawCopy.map(({ token }) => token))].slice(0, 12),
                )
              : [];
          const problems = [
            !toasts.pass && `${toasts.count} toast(s) visible after cold load`,
            !overflow.pass && `document overflows by ${overflow.overflow}px`,
            rawCopy.length > 0 &&
              `raw copy (${rawCopy.length}): ${rawCopy
                .slice(0, 12)
                .map(({ kind, token }) => `${kind}=${token}`)
                .join(", ")}`,
            blockingAxe.length > 0 && `blocking accessibility: ${blockingAxe.map(({ id }) => id).join(", ")}`,
          ].filter(Boolean);
          if (problems.length > 0)
            throw new Error(`${slug}: ${problems.join("; ")}; contexts ${JSON.stringify(rawContext)}`);
          return { status: "passed", metrics: { toasts: toasts.count, overflow: overflow.overflow, blockingAxe: 0 } };
        } finally {
          await browserContext.close();
        }
      },
    );
  }

  const chatEntry = classicManifestEntry("chat");
  for (const { variant, viewport } of CHAT_VIEWPORTS) {
    await runScenario(
      context,
      {
        id: `ux-budgets.chat-space.${variant}`,
        lane: "ux-budgets",
        title: `Chat space ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const { browserContext, page } = await openRoute(
          viewport,
          chatEntry,
          `/chat?shell=classic&sessionId=${encodeURIComponent(fixture.sessionId)}`,
        );
        try {
          const layout = await page.evaluate(measureLayout);
          const chat = evaluateChatBudget(layout, variant);
          const rail = evaluateRailReach(layout);
          const problems = [
            !chat.pass && enforcement.chatBudget && `message area ${chat.ratio} < ${chat.threshold}`,
            !rail.pass && enforcement.railReach && `sidebar ends ${rail.gap}px above viewport bottom`,
          ].filter(Boolean);
          if (problems.length > 0) {
            throw new Error(`Chat ${variant}: ${problems.join("; ")}; heights ${JSON.stringify(layout.heights)}`);
          }
          return { status: "passed", metrics: { ratio: chat.ratio, threshold: chat.threshold, railGap: rail.gap } };
        } finally {
          await browserContext.close();
        }
      },
    );
  }

  for (const href of options.cockpitRoutes ?? COCKPIT_ROUTES) {
    const slug = href.replace(/[^a-z]+/gi, "-").replace(/^-|-$/g, "") || "root";
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit.${slug}`,
        lane: "ux-budgets",
        title: `Cockpit ${href}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const browserContext = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          colorScheme: "dark",
        });
        try {
          await browserContext.addInitScript(() => {
            window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          });
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
          const page = await browserContext.newPage();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, href), { waitUntil: "domcontentloaded" });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          await page.waitForTimeout(TOAST_SETTLE_MS);
          const toasts = evaluateToastBudget(await page.locator("[data-sonner-toast]").count());
          const overflow = evaluateHorizontalOverflow(await page.evaluate(measureLayout));
          const ownerText = await readCapabilityOwnerText({ gatewayUrl: stack.gatewayUrl, requestJson, assertOk });
          const rawCopy = findRawCopyTokens(
            withoutOwnerText(await page.evaluate(collectVisibleUiText, COPY_EXEMPT_SELECTOR), ownerText),
          );
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blockingAxe = axe.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
          );
          const problems = [
            !toasts.pass && `${toasts.count} toast(s) visible after cold load`,
            !overflow.pass && `document overflows by ${overflow.overflow}px`,
            rawCopy.length > 0 && `raw copy: ${rawCopy.map(({ token }) => token).join(", ")}`,
            blockingAxe.length > 0 && `blocking accessibility: ${blockingAxe.map(({ id }) => id).join(", ")}`,
          ].filter(Boolean);
          if (problems.length > 0) throw new Error(`Cockpit ${href}: ${problems.join("; ")}`);
          return { status: "passed", metrics: { toasts: toasts.count, overflow: overflow.overflow, blockingAxe: 0 } };
        } finally {
          await browserContext.close();
        }
      },
    );
  }
}
