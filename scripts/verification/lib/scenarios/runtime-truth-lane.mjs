export async function runRuntimeTruthLane(context, options = {}, deps) {
  const {
    NEXT_UI_PACKAGE,
    assertBrowserConsoleHealthy,
    assertOk,
    attachBrowserLogging,
    buildVerificationUiUrl,
    captureBrowserArtifacts,
    chromium,
    ensureOnboardingComplete,
    forceVerificationUiPackage,
    installMissionControlNextBrowserState,
    path,
    relativeToRun,
    requestJson,
    restartGatewayProcess,
    runScenario,
    setBrowserCorrelation,
    startVerificationStack,
    stopVerificationStack,
    waitForDurableRunStatus,
    waitForVerificationRouteReady,
    writeJson,
  } = deps;
  let stack;
  const restoreUiPackage = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    stack = await startVerificationStack(context, {
      includeUi: true,
      gatewayEnv: {
        GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
        GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
        GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
        GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-runtime-truth");

    await runScenario(
      context,
      {
        id: "runtime-truth.approval-restart-ui-consistency",
        lane: "runtime-truth",
        title: "Approval-gated durable work survives restart and the canonical next shell matches backend truth",
        subsystem: "mission-control",
      },
      async ({ correlationId }) => {
        const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
          method: "POST",
          body: {
            workspaceName: "Runtime Truth Verification Workspace",
            sessionTitle: "Runtime Truth Verification Session",
            sessionCount: 3,
            longThreadTurns: 10,
          },
        });
        assertOk(seeded, "seed runtime-truth workspace");

        const approvalSeed = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/chat-approval-scenario", {
          method: "POST",
          body: {
            sessionId: seeded.body?.sessionId,
            workspaceId: seeded.body?.workspaceId,
          },
        });
        assertOk(approvalSeed, "seed runtime-truth approval");

        const approvalId = approvalSeed.body?.approvalId;
        const sessionId = approvalSeed.body?.sessionId;
        const durableRunId = approvalSeed.body?.chatTurnDurableRunId;
        if (!approvalId || !sessionId || !durableRunId) {
          throw new Error(
            `runtime-truth seed missing approval/session/run identifiers: ${JSON.stringify(approvalSeed.body)}`,
          );
        }

        const beforeRestart = await requestJson(
          stack.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}`,
        );
        assertOk(beforeRestart, "read runtime-truth durable run before restart");

        stack.gateway = await restartGatewayProcess(context, stack, {
          GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
          GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
          GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
          GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
        });

        const approved = await requestJson(stack.gatewayUrl, "/api/v1/chat/tools/approve", {
          method: "POST",
          body: {
            sessionId,
            approvalId,
            allowScope: "once",
          },
        });
        assertOk(approved, "resume runtime-truth approval-gated turn");
        if (approved.body?.resumedRunId !== durableRunId) {
          throw new Error(
            `runtime-truth expected resumed run ${durableRunId}, got ${approved.body?.resumedRunId ?? "unknown"}`,
          );
        }

        const durableRun = await waitForDurableRunStatus(stack.gatewayUrl, durableRunId, ["running", "completed"]);
        const lifecycle = await requestJson(
          stack.gatewayUrl,
          `/api/v1/runtime/lifecycle?approvalId=${encodeURIComponent(approvalId)}`,
        );
        assertOk(lifecycle, "read runtime-truth lifecycle");

        const browser = await chromium.launch({ headless: true });
        try {
          const browserContext = await browser.newContext({
            viewport: { width: 1440, height: 1024 },
            colorScheme: "dark",
          });
          await installMissionControlNextBrowserState(browserContext, seeded.body.workspaceId);
          const page = await browserContext.newPage();
          const browserLog = attachBrowserLogging(page);
          const browserLogCursor = browserLog.mark();

          await page.goto(
            buildVerificationUiUrl(stack.uiUrl, `/ops/approvals?approvalId=${encodeURIComponent(approvalId)}`),
            { waitUntil: "domcontentloaded" },
          );
          await waitForVerificationRouteReady(
            page,
            {
              expectedArea: "ops",
              expectedSection: "approvals",
              readyText: "Approval queue",
            },
            NEXT_UI_PACKAGE,
          );
          await setBrowserCorrelation(page, correlationId, sessionId);
          await page.getByRole("tab", { name: /History/i }).click();
          await page.getByRole("button", { name: /Load durable status/i }).click();
          await page.getByText("Status:", { exact: false }).first().waitFor({ timeout: 15000 });
          await page.getByText("Updated:", { exact: false }).first().waitFor({ timeout: 15000 });
          const runtimePreview = await page.evaluate(() => document.body?.innerText ?? "");
          const acceptableStatuses = [...new Set([durableRun.body?.status, "running", "completed"].filter(Boolean))];
          if (!acceptableStatuses.some((status) => runtimePreview.includes(`Status: ${status}`))) {
            throw new Error(
              `runtime-truth expected one of ${acceptableStatuses.join(", ")} in the approvals recovery panel`,
            );
          }
          const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, NEXT_UI_PACKAGE);
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "runtime-truth-approval-restart-ui-consistency",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
            logCursor: browserLogCursor,
          });
          const outPath = path.join(
            context.artifactRoot,
            "diagnostics",
            "runtime-truth-approval-restart-ui-consistency.json",
          );
          await writeJson(outPath, {
            seeded: seeded.body,
            approvalSeed: approvalSeed.body,
            beforeRestart: beforeRestart.body,
            approved: approved.body,
            durableRun: durableRun.body,
            lifecycle: lifecycle.body,
          });
          return {
            status: "passed",
            metrics: {
              durableStatus: durableRun.body?.status,
              consoleErrors: browserSanity.consoleErrors.length,
              pageErrors: browserSanity.pageErrors.length,
            },
            artifacts: {
              ...artifacts,
              diagnostics: [...artifacts.diagnostics, relativeToRun(context, outPath)],
            },
          };
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    if (stack) {
      await stopVerificationStack(stack);
    }
    restoreUiPackage();
  }

}
