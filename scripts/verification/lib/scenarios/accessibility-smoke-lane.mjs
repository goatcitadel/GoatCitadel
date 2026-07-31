const ACCESSIBILITY_STUB_REPLY = "KEYBOARD_OK";
const ACCESSIBILITY_STUB_KEY = "verification-accessibility-smoke-stub-key";

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
      const opener = page.getByRole("button", { name: "Open navigation" });
      const drawer = page.getByLabel("Active scope and commands");
      await opener.click();
      await drawer.waitFor();
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden" });
      const restoredName = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      if (restoredName !== "Open navigation") {
        throw new Error(`mobile navigation did not restore focus to its opener (received ${restoredName ?? "none"})`);
      }
      await opener.click();
      await drawer.waitFor();
    },
  },
  {
    id: "mobile-chat-virtual-keyboard",
    title: "Mobile Chat virtual-keyboard geometry and composer focus",
    href: "/chat",
    viewport: { width: 390, height: 844 },
    colorScheme: "light",
    hasTouch: true,
    route: {
      readySelector: '.mc-next-threaded-surface[data-mode="chat"]',
      expectedArea: "chat",
      expectedSection: "root",
    },
    async prepare(page) {
      // Start from a clean provider-backed thread. The seeded accessibility
      // fixture intentionally contains a blocking approval, so measuring that
      // persisted thread would conflate blocker geometry with virtual-keyboard
      // behavior.
      await page.getByRole("button", { name: "Sessions", exact: true }).click();
      await page.getByRole("button", { name: "New thread", exact: true }).click();
      await page.getByLabel("Sessions", { exact: true }).waitFor({ state: "hidden" });
      await page.locator(".mc-next-composer-blocking-prompt").waitFor({ state: "hidden" });
      const composer = page.getByLabel("Message composer", { exact: true });
      await composer.waitFor({ state: "visible" });
      await composer.fill("Reply with exactly: KEYBOARD_OK");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByText(ACCESSIBILITY_STUB_REPLY, { exact: true }).waitFor();
      await composer.click();
      await page.setViewportSize({ width: 390, height: 500 });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(undefined))),
          ),
      );
      const layout = await page.evaluate(() => {
        const element = document.activeElement;
        const rect = element instanceof HTMLElement ? element.getBoundingClientRect() : null;
        return {
          activeLabel: element instanceof HTMLElement ? element.getAttribute("aria-label") : null,
          providerReplyVisible: document.body.textContent?.includes("KEYBOARD_OK") === true,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          composerRect: rect
            ? {
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                left: rect.left,
                width: rect.width,
                height: rect.height,
              }
            : null,
        };
      });
      assertVirtualKeyboardComposerVisible(layout);
      return layout;
    },
  },
  {
    id: "tablet-landscape-memory-reduced-motion",
    title: "Tablet landscape Memory reflow and reduced-motion accessibility",
    href: "/library/memory",
    viewport: { width: 1024, height: 768 },
    colorScheme: "light",
    reducedMotion: "reduce",
    hasTouch: true,
    route: {
      readyText: "Mission Control Next shell posture",
      expectedArea: "library",
      expectedSection: "memory",
    },
  },
  {
    id: "mobile-landscape-access-touch",
    title: "Mobile landscape Access reflow and touch-target accessibility",
    href: "/settings/access",
    viewport: { width: 844, height: 390 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    deviceScaleFactor: 2,
    hasTouch: true,
    route: {
      readyText: "Access",
      expectedArea: "settings",
      expectedSection: "access",
    },
  },
  {
    id: "chat-zoom-reflow",
    title: "Chat 200 percent zoom-equivalent reflow accessibility",
    href: "/chat",
    viewport: { width: 640, height: 800 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    route: {
      readySelector: '.mc-next-threaded-surface[data-mode="chat"]',
      expectedArea: "chat",
      expectedSection: "root",
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
    prepareVerificationRuntime,
    relativeToRun,
    runScenario,
    seedMissionControlNextFixture,
    setBrowserCorrelation,
    startBrowserTrace,
    startDeterministicLlmStub,
    startVerificationStack,
    stopVerificationStack,
    waitForVerificationRouteReady,
    writeDeterministicLlmProviderConfig,
    writeJson,
  } = deps;
  const restoreUiPackage = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  let stack;
  let runtimeRoot;
  let stub;
  try {
    stub = await startDeterministicLlmStub({
      replyText: ACCESSIBILITY_STUB_REPLY,
      expectedAuthorization: `Bearer ${ACCESSIBILITY_STUB_KEY}`,
    });
    runtimeRoot = await prepareVerificationRuntime(`${context.runId}-accessibility-smoke`);
    await writeDeterministicLlmProviderConfig(runtimeRoot, stub.baseUrl);
    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: true,
      processLogPrefix: options.processLogPrefix,
      gatewayEnvOmit: options.secretEnvKeys,
      uiEnvOmit: options.secretEnvKeys,
      gatewayEnv: {
        GOATCITADEL_AUTH_MODE: "token",
        GOATCITADEL_AUTH_TOKEN: "verification-accessibility-smoke-operator-token",
        GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
        GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
        GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
        GOATCITADEL_MESH_NODE_ID: "build-main",
        GOATCITADEL_VERIFY_STUB_LLM_KEY: ACCESSIBILITY_STUB_KEY,
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
              colorScheme: scenario.colorScheme ?? "dark",
              reducedMotion: scenario.reducedMotion ?? "no-preference",
              hasTouch: scenario.hasTouch ?? false,
              deviceScaleFactor: scenario.deviceScaleFactor ?? 1,
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
              const preparationEvidence = await scenario.prepare?.(page);
              await page.addScriptTag({ path: axeSourcePath });
              const axeReport = await auditPageAccessibility(page);
              const focusReport = await probeKeyboardFocus(page);
              const crossCuttingReport = await probeCrossCuttingAccessibility(page, {
                expectReducedMotion: scenario.reducedMotion === "reduce",
                expectTouchTargets: scenario.hasTouch === true,
              });
              const auditPayload = {
                scenarioId: scenario.id,
                href: scenario.href,
                viewport: scenario.viewport,
                effectiveViewport: {
                  width: crossCuttingReport.viewportWidth,
                  height: crossCuttingReport.viewportHeight,
                },
                preparationEvidence: preparationEvidence ?? null,
                axe: axeReport,
                keyboardFocus: focusReport,
                crossCutting: crossCuttingReport,
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
              if (!crossCuttingReport.passed) {
                throw new Error(
                  `cross-cutting accessibility contract failed: ${crossCuttingReport.failures.join("; ")}`,
                );
              }

              return {
                status: "passed",
                metrics: {
                  route: scenario.href,
                  viewportWidth: scenario.viewport.width,
                  effectiveViewportWidth: crossCuttingReport.viewportWidth,
                  effectiveViewportHeight: crossCuttingReport.viewportHeight,
                  axeViolations: axeReport.violations.length,
                  blockingAxeViolations: 0,
                  focusTargetsSampled: focusReport.observations.length,
                  horizontalOverflowPx: crossCuttingReport.horizontalOverflowPx,
                  undersizedTouchTargets: crossCuttingReport.undersizedTouchTargets.length,
                  semanticMainCount: crossCuttingReport.semanticMainCount,
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
    } else if (runtimeRoot) {
      await stopVerificationStack({ runtimeRoot });
    }
    await stub?.close().catch(() => undefined);
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

export async function probeCrossCuttingAccessibility(page, options = {}) {
  const measurements = await page.evaluate(({ expectReducedMotion, expectTouchTargets }) => {
    const root = document.documentElement;
    const horizontalOverflowPx = Math.max(0, root.scrollWidth - root.clientWidth);
    const semanticMainCount = document.querySelectorAll("main").length;
    const headingCount = document.querySelectorAll("h1").length;
    const liveRegions = Array.from(document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).map(
      (element) => ({
        role: element.getAttribute("role") || "region",
        politeness: element.getAttribute("aria-live") || "implicit",
        name:
          element.getAttribute("aria-label")?.trim() ||
          element.getAttribute("title")?.trim() ||
          element.textContent?.trim().replace(/\s+/g, " ").slice(0, 160) ||
          "",
      }),
    );
    const liveRegionCount = liveRegions.length;
    const screenReaderSignalCount = liveRegions.filter((region) => region.name.length > 0).length;
    const reducedMotionMatches = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const unexpectedMotion = expectReducedMotion
      ? document
          .getAnimations()
          .map((animation) => ({
            playState: animation.playState,
            duration: Number(animation.effect?.getTiming().duration ?? 0),
            iterations: Number(animation.effect?.getTiming().iterations ?? 1),
          }))
          .filter(
            (animation) =>
              animation.playState === "running" &&
              (animation.duration > 250 || !Number.isFinite(animation.iterations) || animation.iterations > 1),
          )
      : [];
    const touchTargets = expectTouchTargets
      ? Array.from(
          document.querySelectorAll(
            'a[href], button, input, select, summary, textarea, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])',
          ),
        )
          .filter((element) => element instanceof HTMLElement && !element.hasAttribute("disabled"))
          .map((element) => {
            const associatedLabels =
              "labels" in element && element.labels
                ? Array.from(element.labels).filter((label) => label instanceof HTMLElement)
                : [];
            const targets = [element, ...associatedLabels];
            const target = targets
              .map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
              .sort((left, right) => right.rect.width * right.rect.height - left.rect.width * left.rect.height)[0];
            const rect = target?.rect ?? element.getBoundingClientRect();
            return {
              name:
                element.getAttribute("aria-label")?.trim() ||
                associatedLabels
                  .map((label) => label.textContent?.trim() ?? "")
                  .filter(Boolean)
                  .join(" ") ||
                element.getAttribute("title")?.trim() ||
                element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
                element.tagName.toLowerCase(),
              // Keep sub-pixel measurements intact. Rounding 23.5px up to
              // 24px would turn an undersized native control into a pass.
              width: rect.width,
              height: rect.height,
              visible:
                rect.width > 0 &&
                rect.height > 0 &&
                rect.bottom > 0 &&
                rect.right > 0 &&
                rect.top < window.innerHeight &&
                rect.left < window.innerWidth,
            };
          })
      : [];
    const regionLandmarkNames = Array.from(
      document.querySelectorAll(
        '[role="region"], section[aria-label], section[aria-labelledby], aside[aria-label], aside[aria-labelledby]',
      ),
    )
      .map((element) => {
        const labelledBy = element.getAttribute("aria-labelledby");
        const labelledByText = labelledBy
          ? labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
              .filter(Boolean)
              .join(" ")
          : "";
        return (element.getAttribute("aria-label")?.trim() || labelledByText).replace(/\s+/g, " ");
      })
      .filter(Boolean);
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      horizontalOverflowPx,
      semanticMainCount,
      headingCount,
      liveRegionCount,
      liveRegions,
      screenReaderSignalCount,
      reducedMotionMatches,
      unexpectedMotion,
      touchTargets,
      regionLandmarkNames,
    };
  }, options);

  return buildCrossCuttingAccessibilityReport(measurements, options);
}

export function assertVirtualKeyboardComposerVisible(layout) {
  if (layout?.providerReplyVisible !== true) {
    throw new Error("virtual-keyboard scenario did not prove the deterministic provider-backed turn");
  }
  if (layout?.activeLabel !== "Message composer") {
    throw new Error(`virtual-keyboard resize lost composer focus (received ${layout?.activeLabel ?? "none"})`);
  }
  if (
    !Number.isFinite(layout?.viewportWidth) ||
    !Number.isFinite(layout?.viewportHeight) ||
    layout.viewportWidth <= 0 ||
    layout.viewportHeight <= 0
  ) {
    throw new Error("virtual-keyboard resize did not retain a valid effective viewport");
  }
  const rect = layout.composerRect;
  if (
    !rect ||
    ![rect.top, rect.right, rect.bottom, rect.left, rect.width, rect.height].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error("virtual-keyboard resize left the composer without visible geometry");
  }
  if (
    rect.left < -2 ||
    rect.right > layout.viewportWidth + 2 ||
    rect.top < -2 ||
    rect.bottom > layout.viewportHeight + 2
  ) {
    throw new Error(
      `virtual-keyboard resize obscured the composer (${rect.left},${rect.top})-(${rect.right},${rect.bottom}) inside ${layout.viewportWidth}x${layout.viewportHeight}`,
    );
  }
}

export function buildCrossCuttingAccessibilityReport(measurements, options = {}) {
  const undersizedTouchTargets = options.expectTouchTargets
    ? measurements.touchTargets.filter((target) => isUndersizedTouchTarget(target))
    : [];
  const regionNameCounts = new Map();
  for (const name of measurements.regionLandmarkNames) {
    const normalizedName = name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    const current = regionNameCounts.get(normalizedName);
    regionNameCounts.set(normalizedName, {
      name: current?.name ?? name,
      count: (current?.count ?? 0) + 1,
    });
  }
  const duplicateRegionLandmarkNames = [...regionNameCounts.values()]
    .filter((entry) => entry.count > 1)
    .sort((left, right) => left.name.localeCompare(right.name));
  const failures = [];
  if (measurements.horizontalOverflowPx > 2)
    failures.push(`document overflows horizontally by ${measurements.horizontalOverflowPx}px`);
  if (measurements.semanticMainCount !== 1)
    failures.push(`expected one main landmark, received ${measurements.semanticMainCount}`);
  if (measurements.headingCount < 1) failures.push("no level-one heading is present");
  if (measurements.liveRegionCount < 1) failures.push("no live status or alert region is present");
  if (measurements.screenReaderSignalCount < 1)
    failures.push("no live status or alert region exposes an operator-readable announcement");
  if (options.expectReducedMotion && !measurements.reducedMotionMatches)
    failures.push("reduced-motion media query is not active");
  if (measurements.unexpectedMotion.length > 0)
    failures.push(`${measurements.unexpectedMotion.length} long/repeating animation(s) remain active`);
  if (undersizedTouchTargets.length > 0) {
    failures.push(`${undersizedTouchTargets.length} touch target(s) are smaller than 24px in width or height`);
  }
  if (duplicateRegionLandmarkNames.length > 0) {
    failures.push(
      `region landmark names must be unique: ${duplicateRegionLandmarkNames
        .map((entry) => `"${entry.name}" appears ${entry.count} times`)
        .join(", ")}`,
    );
  }
  return {
    ...measurements,
    passed: failures.length === 0,
    failures,
    undersizedTouchTargets,
    duplicateRegionLandmarkNames,
  };
}

export function isUndersizedTouchTarget(target, minimumSize = 24) {
  return target.visible && (target.width < minimumSize || target.height < minimumSize);
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
