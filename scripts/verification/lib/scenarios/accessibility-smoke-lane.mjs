const ACCESSIBILITY_SMOKE_SCENARIOS = [
  {
    id: "chat-working-context",
    title: "Chat Working Context accessibility",
    href: "/chat",
    viewport: { width: 1440, height: 1024 },
    route: {
      readySelector: '.mc-next-threaded-surface[data-mode="chat"]',
      expectedArea: "chat",
      expectedSection: "root",
    },
    async prepare(page) {
      const workingContext = page.getByText("Working Context", { exact: true });
      if (!(await workingContext.isVisible().catch(() => false))) {
        await page.getByRole("button", { name: "Context", exact: true }).click();
      }
      await workingContext.waitFor();
    },
  },
  {
    id: "ops-approvals",
    title: "Ops Approvals accessibility",
    href: "/ops/approvals",
    viewport: { width: 1440, height: 1024 },
    route: {
      readyText: "Approvals",
      expectedArea: "ops",
      expectedSection: "approvals",
    },
  },
  {
    id: "settings-permissions",
    title: "Settings Permissions accessibility",
    href: "/settings/permissions",
    viewport: { width: 1440, height: 1024 },
    route: {
      readyText: "Permission profiles",
      expectedArea: "settings",
      expectedSection: "permissions",
    },
  },
  {
    id: "mobile-chat-navigation",
    title: "Mobile Chat navigation accessibility",
    href: "/chat",
    viewport: { width: 390, height: 844 },
    route: {
      readySelector: '.mc-next-threaded-surface[data-mode="chat"]',
      expectedArea: "chat",
      expectedSection: "root",
    },
    async prepare(page) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByLabel("Active scope and commands").waitFor();
    },
  },
];

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

export async function runAccessibilitySmokeLane(context, options = {}, deps) {
  const {
    NEXT_UI_PACKAGE,
    appendTraceArtifact,
    assertBrowserConsoleHealthy,
    attachBrowserLogging,
    auditPageAccessibility,
    axeSourcePath,
    buildVerificationUiUrl,
    captureBrowserArtifacts,
    chromium,
    ensureOnboardingComplete,
    forceVerificationUiPackage,
    installMissionControlNextBrowserState,
    path,
    probeKeyboardFocus,
    relativeToRun,
    runScenario,
    seedMissionControlNextFixture,
    setBrowserCorrelation,
    startBrowserTrace,
    startVerificationStack,
    stopVerificationStack,
    VERIFICATION_OPERATOR_AUTH_ENV,
    waitForVerificationRouteReady,
    writeJson,
  } = deps;
  const restoreUiPackage = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  let stack;
  try {
    stack = await startVerificationStack(context, {
      includeUi: true,
      gatewayEnv: {
        // Seeding the Mission Control Next fixture creates an operator-authenticated
        // Ops saved board. See VERIFICATION_OPERATOR_AUTH_ENV.
        ...VERIFICATION_OPERATOR_AUTH_ENV,
        GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
        GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
        GOATCITADEL_MESH_NODE_ID: "build-main",
      },
      uiEnv: {
        VITE_GOATCITADEL_VISUAL_REGRESSION_MODE: "true",
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-accessibility-smoke");
    const fixture = await seedMissionControlNextFixture(stack.gatewayUrl, { runtimeRoot: stack.runtimeRoot });
    const browser = await chromium.launch({ headless: true });
    try {
      for (const scenario of options.scenarios ?? ACCESSIBILITY_SMOKE_SCENARIOS) {
        await runScenario(
          context,
          {
            id: `accessibility-smoke.${scenario.id}`,
            lane: "accessibility-smoke",
            title: scenario.title,
            subsystem: "mission-control-accessibility",
          },
          async ({ correlationId }) => {
            const browserContext = await browser.newContext({
              viewport: scenario.viewport,
              colorScheme: "dark",
            });
            await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
            const page = await browserContext.newPage();
            const browserLog = attachBrowserLogging(page);
            const browserLogCursor = browserLog.mark();
            const artifactSlug = `accessibility-smoke-${scenario.id}`;
            const trace = await startBrowserTrace(context, { page, slug: artifactSlug });
            let artifacts;
            let accessibilityArtifact;
            try {
              await page.goto(buildVerificationUiUrl(stack.uiUrl, scenario.href), { waitUntil: "domcontentloaded" });
              await waitForVerificationRouteReady(page, scenario.route, NEXT_UI_PACKAGE);
              await setBrowserCorrelation(page, correlationId, fixture.sessionId);
              await scenario.prepare?.(page);
              await page.addScriptTag({ path: axeSourcePath });
              const axeReport = await auditPageAccessibility(page);
              const focusReport = await probeKeyboardFocus(page);
              const auditPayload = {
                scenarioId: scenario.id,
                href: scenario.href,
                viewport: scenario.viewport,
                axe: axeReport,
                keyboardFocus: focusReport,
              };
              const auditPath = path.join(context.artifactRoot, "diagnostics", `${artifactSlug}-accessibility.json`);
              await writeJson(auditPath, auditPayload);
              accessibilityArtifact = relativeToRun(context, auditPath);

              const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, NEXT_UI_PACKAGE);
              artifacts = appendDiagnosticArtifact(
                await captureBrowserArtifacts(context, {
                  slug: artifactSlug,
                  page,
                  browserLog,
                  gatewayUrl: stack.gatewayUrl,
                  correlationId,
                  logCursor: browserLogCursor,
                }),
                accessibilityArtifact,
              );

              const blockingViolations = axeReport.violations.filter((violation) =>
                BLOCKING_IMPACTS.has(violation.impact),
              );
              if (blockingViolations.length > 0) {
                throw new Error(formatAxeFailure(blockingViolations));
              }
              if (!focusReport.passed) {
                throw new Error(formatFocusFailure(focusReport));
              }

              return {
                status: "passed",
                metrics: {
                  route: scenario.href,
                  viewportWidth: scenario.viewport.width,
                  axeViolations: axeReport.violations.length,
                  blockingAxeViolations: 0,
                  focusTargetsSampled: focusReport.observations.length,
                  consoleErrors: browserSanity.consoleErrors.length,
                  pageErrors: browserSanity.pageErrors.length,
                },
                artifacts,
              };
            } catch (error) {
              artifacts ??= appendDiagnosticArtifact(
                await captureBrowserArtifacts(context, {
                  slug: `${artifactSlug}-failure`,
                  page,
                  browserLog,
                  gatewayUrl: stack.gatewayUrl,
                  correlationId,
                  logCursor: browserLogCursor,
                }),
                accessibilityArtifact,
              );
              const traceArtifact = await trace.retain().catch(() => null);
              return {
                status: "failed",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
                metrics: {
                  route: scenario.href,
                  viewportWidth: scenario.viewport.width,
                },
                artifacts: appendTraceArtifact(artifacts, traceArtifact),
              };
            } finally {
              await trace.discard().catch(() => undefined);
              await browserContext.close();
            }
          },
        );
      }
    } finally {
      await browser.close();
    }
  } finally {
    if (stack) {
      await stopVerificationStack(stack);
    }
    restoreUiPackage();
  }
}

export async function auditPageAccessibility(page) {
  return page.evaluate(async () => {
    if (!window.axe?.run) {
      throw new Error("axe-core did not initialize in the browser");
    }
    const results = await window.axe.run(document, {
      resultTypes: ["violations"],
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return {
      testEngine: results.testEngine,
      testEnvironment: results.testEnvironment,
      testRunner: results.testRunner,
      url: results.url,
      timestamp: results.timestamp,
      violations: results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? "unknown",
        tags: violation.tags,
        description: violation.description,
        help: violation.help,
        helpUrl: violation.helpUrl,
        nodes: violation.nodes.map((node) => ({
          impact: node.impact ?? "unknown",
          target: node.target,
          html: node.html,
          failureSummary: node.failureSummary,
        })),
      })),
    };
  });
}

export async function probeKeyboardFocus(page, steps = 8) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  const observations = [];
  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press("Tab");
    const observation = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || element === document.body) {
        return null;
      }
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelledByText = labelledBy
        ? labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
            .filter(Boolean)
            .join(" ")
        : "";
      const associatedLabel =
        "labels" in element && element.labels instanceof NodeList
          ? Array.from(element.labels)
              .map((label) => label.textContent?.trim() ?? "")
              .filter(Boolean)
              .join(" ")
          : "";
      const name =
        element.getAttribute("aria-label")?.trim() ||
        labelledByText ||
        associatedLabel ||
        element.getAttribute("alt")?.trim() ||
        element.getAttribute("title")?.trim() ||
        element.textContent?.trim().replace(/\s+/g, " ") ||
        "";
      const role =
        element.getAttribute("role") ||
        ({ A: "link", BUTTON: "button", INPUT: "input", SELECT: "select", TEXTAREA: "textbox" }[element.tagName] ??
          element.tagName.toLowerCase());
      const style = getComputedStyle(element);
      const focusVisible = element.matches(":focus-visible");
      const hasVisibleIndicator =
        focusVisible &&
        ((style.outlineStyle !== "none" && style.outlineWidth !== "0px") ||
          (style.boxShadow !== "none" && style.boxShadow !== "") ||
          style.textDecorationLine.includes("underline"));
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role,
        name,
        focusVisible,
        hasVisibleIndicator,
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
      };
    });
    if (observation) {
      observations.push(observation);
    }
  }
  const unnamedTargets = observations.filter((item) => item.name.length === 0);
  const focusIndicatorFound = observations.some((item) => item.inViewport && item.hasVisibleIndicator);
  return {
    passed: observations.length > 0 && unnamedTargets.length === 0 && focusIndicatorFound,
    observations,
    unnamedTargets,
    focusIndicatorFound,
  };
}

function appendDiagnosticArtifact(artifacts, diagnosticArtifact) {
  if (!diagnosticArtifact) {
    return artifacts;
  }
  return {
    ...artifacts,
    diagnostics: [...new Set([...(artifacts.diagnostics ?? []), diagnosticArtifact])],
  };
}

function formatAxeFailure(violations) {
  const summary = violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}, ${violation.nodes.length} node${violation.nodes.length === 1 ? "" : "s"})`,
    )
    .join(", ");
  return `axe-core found blocking accessibility violations: ${summary}`;
}

function formatFocusFailure(report) {
  const reasons = [];
  if (report.observations.length === 0) {
    reasons.push("no keyboard-focusable targets were reached");
  }
  if (report.unnamedTargets.length > 0) {
    reasons.push(`${report.unnamedTargets.length} sampled focus target(s) had no accessible name`);
  }
  if (!report.focusIndicatorFound) {
    reasons.push("no visible :focus-visible indicator was observed");
  }
  return `keyboard focus smoke failed: ${reasons.join("; ")}`;
}
