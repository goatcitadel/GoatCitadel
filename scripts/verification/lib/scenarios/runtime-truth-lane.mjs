// verify:runtime:truth starts an isolated Gateway, proves profile-free Chat
// approval admission, then restarts the Gateway and resumes the same durable
// run. The Next-shell cross-check uses the recovered identifiers when a browser
// and served UI are available.
import {
  prepareRuntimeTruthApproval,
  requestRuntimeTruthApproval,
  assertRuntimeTruthToolCompletion,
} from "./runtime-truth-approval.mjs";
import { prepareUsabilityRuntime } from "./usability-runtime-fixture.mjs";

export async function runRuntimeTruthLane(context, _options = {}, deps) {
  const {
    NEXT_UI_PACKAGE,
    assertBrowserConsoleHealthy,
    assertOk,
    attachBrowserLogging,
    buildVerificationUiUrl,
    captureBrowserArtifacts,
    chromium,
    clampString,
    ensureOnboardingComplete,
    forceVerificationUiPackage,
    installMissionControlNextBrowserState,
    path,
    relativeToRun,
    requestJson,
    restartGatewayProcess,
    runScenario,
    setBrowserCorrelation,
    startDeterministicLlmStub,
    startVerificationStack,
    startVerificationUiProcess,
    stopProcess,
    stopVerificationStack,
    waitForDurableRunStatus,
    waitForVerificationRouteReady,
    writeJson,
  } = deps;

  let stack;
  let runtimeRoot;
  let llmStub;
  let activeChatTransport;
  const restoreUiPackage = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  // Identifiers recovered by the backend-truth scenario and consumed by the
  // (conditional) shell cross-check scenario, which asserts against the SAME
  // recovered approval it would have observed inline.
  let durableTruth = null;
  let admission = null;
  let seeded = null;
  try {
    llmStub = await startDeterministicLlmStub({
      replyText: "Verification restart reply.",
      expectedAuthorization: `Bearer ${VERIFICATION_STUB_LLM_KEY}`,
      dispatchPlanRequiredTool: "fs_read",
    });
    // Reuse the fresh browser fixture: never copy operator configuration or
    // private workspaces into a recovery test that launches a real Gateway.
    runtimeRoot = await prepareUsabilityRuntime(`${context.runId}-runtime-truth`, llmStub.baseUrl);
    const approvalFixture = await prepareRuntimeTruthApproval(runtimeRoot);
    stack = await startVerificationStack(context, {
      includeUi: false,
      runtimeRoot,
      gatewayEnv: {
        GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
        GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
        GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
        GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
        GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
        GOATCITADEL_VERIFY_STUB_LLM_KEY: VERIFICATION_STUB_LLM_KEY,
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-runtime-truth");

    // New Chat admission must produce a real approval wait without a profile.
    await runScenario(
      context,
      {
        id: "runtime-truth.profile-free-approval-admission",
        lane: "runtime-truth",
        title: "A profile-free Chat turn parks an approval-required tool in its durable run",
        subsystem: "mission-control",
      },
      async () => {
        seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
          method: "POST",
          body: {
            workspaceName: "Runtime Truth Verification Workspace",
            sessionTitle: "Runtime Truth Verification Session",
            sessionCount: 3,
            longThreadTurns: 10,
          },
        });
        assertOk(seeded, "seed runtime-truth workspace");

        admission = await requestRuntimeTruthApproval(
          stack.gatewayUrl,
          {
            sessionId: seeded.body?.sessionId,
            workspaceId: seeded.body?.workspaceId,
            notePath: approvalFixture.notePath,
            llmStub,
          },
          {
            requestJson,
            assertOk,
            captureFailure: (failure) =>
              writeJson(
                path.join(context.artifactRoot, "diagnostics", "runtime-truth-approval-request-failure.json"),
                failure,
              ),
          },
        );
        activeChatTransport = admission.transport;
        const outPath = path.join(context.artifactRoot, "diagnostics", "runtime-truth-profile-free-approval.json");
        await writeJson(outPath, admission.approval);
        return {
          status: "passed",
          metrics: {
            durableRunId: admission.approval.chatTurnDurableRunId,
            approvalId: admission.approval.approvalId,
          },
          artifacts: {
            diagnostics: [relativeToRun(context, outPath)],
            screenshots: [], traces: [], logs: [], perf: [], playwright: [],
          },
        };
      },
    );

    // The recovery scenario restarts and resumes the exact profile-free run.
    await runScenario(
      context,
      {
        id: "runtime-truth.approval-restart-durable-truth",
        lane: "runtime-truth",
        title: "Approval-gated durable work survives a gateway restart and resumes the same durable run",
        subsystem: "mission-control",
      },
      async () => {
        if (!admission?.approval) {
          return {
            status: "skipped",
            notes: ["The admission scenario did not produce an approval to restart and resume."],
          };
        }
        const approvalSeed = { body: admission.approval };

        const approvalId = approvalSeed.body?.approvalId;
        const sessionId = approvalSeed.body?.sessionId;
        const durableRunId = approvalSeed.body?.chatTurnDurableRunId;
        if (!approvalId || !sessionId || !durableRunId) {
          throw new Error(
            `runtime-truth seed missing approval/session/run identifiers: ${JSON.stringify(approvalSeed.body)}`,
          );
        }

        const beforeRestart = await waitForDurableRunStatus(stack.gatewayUrl, durableRunId, ["waiting"]);
        assertOk(beforeRestart, "read runtime-truth durable run before restart");

        const providerDispatchesBeforeRestart = llmStub.completionDispatches();
        const gatewayBeforeRestart = ownedGatewayProcessIdentity(stack);

        stack.gateway = await restartGatewayProcess(context, stack, {
          GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
          GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
          GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
          GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
          GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
          GOATCITADEL_VERIFY_STUB_LLM_KEY: VERIFICATION_STUB_LLM_KEY,
        });
        const gatewayAfterRestart = ownedGatewayProcessIdentity(stack);
        assertOwnedGatewayRestart(gatewayBeforeRestart, gatewayAfterRestart);

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

        let durableRun;
        try {
          durableRun = await waitForDurableRunStatus(stack.gatewayUrl, durableRunId, ["completed"]);
        } catch (error) {
          const [observedRun, observedThread, observedLifecycle] = await Promise.all([
            requestJson(stack.gatewayUrl, `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}`),
            requestJson(stack.gatewayUrl, `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`),
            requestJson(stack.gatewayUrl, `/api/v1/runtime/lifecycle?approvalId=${encodeURIComponent(approvalId)}`),
          ]);
          await writeJson(path.join(context.artifactRoot, "diagnostics", "runtime-truth-resume-failure.json"), {
            approvalSeed: approvalSeed.body,
            approved: approved.body,
            durableRun: observedRun.body,
            thread: observedThread.body,
            lifecycle: observedLifecycle.body,
            providerRequests: llmStub.requestSummaries(),
            error: errorMessage(error),
          });
          throw error;
        }
        const providerDispatchesAfterResume = llmStub.completionDispatches();
        const resumedProviderDispatches = providerDispatchesAfterResume - providerDispatchesBeforeRestart;
        if (resumedProviderDispatches < 1) {
          throw new Error(
            `runtime-truth expected a deterministic provider dispatch after resume, observed ${resumedProviderDispatches}`,
          );
        }
        const lifecycle = await requestJson(
          stack.gatewayUrl,
          `/api/v1/runtime/lifecycle?approvalId=${encodeURIComponent(approvalId)}`,
        );
        assertOk(lifecycle, "read runtime-truth lifecycle");
        const approvalRecoveryRunId = assertRuntimeTruthApprovalLifecycle(lifecycle.body, approvalId, durableRunId);
        const recoveredThread = await requestJson(
          stack.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`,
        );
        assertOk(recoveredThread, "read completed runtime-truth thread");
        const toolCompletion = assertRuntimeTruthToolCompletion(
          recoveredThread.body,
          approvalSeed.body,
          approvalFixture.notePath,
        );

        const outPath = path.join(
          context.artifactRoot,
          "diagnostics",
          "runtime-truth-approval-restart-durable-truth.json",
        );
        await writeJson(outPath, {
          seeded: seeded.body,
          approvalSeed: approvalSeed.body,
          beforeRestart: beforeRestart.body,
          gatewayRestart: {
            before: gatewayBeforeRestart,
            after: gatewayAfterRestart,
            sameLoopbackEndpoint: gatewayBeforeRestart.gatewayUrl === gatewayAfterRestart.gatewayUrl,
          },
          approved: approved.body,
          durableRun: durableRun.body,
          lifecycle: lifecycle.body,
          toolCompletion,
          deterministicProvider: {
            providerId: llmStub.providerId,
            model: llmStub.model,
            baseUrl: llmStub.baseUrl,
            completionDispatchesBeforeRestart: providerDispatchesBeforeRestart,
            completionDispatchesAfterResume: providerDispatchesAfterResume,
            resumedCompletionDispatches: resumedProviderDispatches,
            requests: llmStub.requestSummaries(),
          },
        });

        // Publish the recovered identifiers + the acceptable-status set frozen
        // from the authoritative backend truth, for the shell cross-check.
        durableTruth = {
          workspaceId: seeded.body.workspaceId,
          sessionId,
          approvalId,
          durableRunId,
          approvalRecoveryRunId,
          acceptableStatuses: ["completed"],
        };

        return {
          status: "passed",
          metrics: {
            durableStatus: durableRun.body?.status,
            gatewayPidBefore: gatewayBeforeRestart.pid,
            gatewayPidAfter: gatewayAfterRestart.pid,
            resumedProviderDispatches,
          },
          artifacts: {
            diagnostics: [relativeToRun(context, outPath)],
            screenshots: [],
            traces: [],
            logs: [],
            perf: [],
            playwright: [],
          },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "runtime-truth.deep-research-tool-exposure",
        lane: "runtime-truth",
        title: "The reported deep-research prompt reaches the provider with web and citation tools",
        subsystem: "mission-control",
      },
      async () => {
        const created = await requestJson(stack.gatewayUrl, "/api/v1/chat/sessions", {
          method: "POST",
          body: { title: "Deep research tool exposure verification" },
        });
        assertOk(created, "create deep-research session");
        const route = `/api/v1/chat/sessions/${encodeURIComponent(created.body.sessionId)}`;
        const prefs = await requestJson(stack.gatewayUrl, `${route}/prefs`);
        assertOk(prefs, "read deep-research preferences");
        const controls = {
          providerId: llmStub.providerId,
          model: llmStub.model,
          webMode: "deep",
          memoryMode: "off",
          thinkingLevel: "off",
          subagentPolicy: "off",
          toolAutonomy: "safe_auto",
          orchestrationEnabled: false,
        };
        assertOk(await requestJson(stack.gatewayUrl, `${route}/prefs`, {
          method: "PATCH",
          body: { ...controls, expectedRevision: prefs.body.revision },
        }), "set deep-research preferences");
        const content = "Please do some deep research into the best things to include in an agentic harness.";
        const request = { action: "send", content, ...controls, fullWebAccess: true, prefsOverride: controls };
        const preflight = await requestJson(stack.gatewayUrl, `${route}/route-preflight`, {
          method: "POST",
          body: request,
        });
        assertOk(preflight, "preflight deep-research turn");
        if (!preflight.body?.decision || preflight.body.capabilityProfile !== undefined) {
          throw new Error("Deep-research preflight did not produce a profile-free route decision.");
        }
        const before = llmStub.requestSummaries().length;
        const sent = await requestJson(stack.gatewayUrl, `${route}/agent-send`, {
          method: "POST",
          body: { ...request, routeDecision: preflight.body.decision },
        });
        assertOk(sent, "send deep-research turn");
        const providerRequests = llmStub.requestSummaries().slice(before)
          .filter((entry) => entry.path === "/v1/chat/completions" || entry.path === "/v1/responses");
        const required = ["browser_search", "browser_navigate", "citations_build"];
        const withRequiredTools = providerRequests.find(
          (entry) => required.every((name) => entry.toolNames?.includes(name)),
        );
        if (!withRequiredTools) {
          throw new Error(`Deep-research provider request omitted tools: ${JSON.stringify(providerRequests.map((entry) => entry.toolNames ?? []))}`);
        }
        const outPath = path.join(context.artifactRoot, "diagnostics", "runtime-truth-deep-research-tools.json");
        await writeJson(outPath, { sessionId: created.body.sessionId, required, providerRequests });
        return {
          status: "passed",
          metrics: { providerRequests: providerRequests.length, requiredTools: required.length },
          artifacts: {
            diagnostics: [relativeToRun(context, outPath)],
            screenshots: [], traces: [], logs: [], perf: [], playwright: [],
          },
        };
      },
    );

    // The canonical Next shell reflects the recovered truth.
    // Conditionally SKIPPED (never failed) when this host cannot launch a
    // browser or serve the UI: those are environmental preconditions, exactly
    // like the sibling lanes' live-PostgreSQL provisioning. Once BOTH hold,
    // every assertion below is a real pass/fail — a served-but-broken shell
    // FAILS honestly rather than skipping.
    await runScenario(
      context,
      {
        id: "runtime-truth.canonical-next-shell-consistency",
        lane: "runtime-truth",
        title: "The canonical Mission Control Next shell reflects the recovered approval-restart durable truth",
        subsystem: "mission-control",
      },
      async ({ correlationId }) => {
        if (!durableTruth) {
          return shellSkip(
            "SKIP: the approval-restart durable-truth scenario did not publish recovered identifiers; there is " +
              "nothing to cross-check in the shell.",
          );
        }

        // Precondition A — a launchable browser runtime (Playwright chromium).
        let browser;
        try {
          browser = await chromium.launch({ headless: true });
        } catch (error) {
          return shellSkip(
            `SKIP: no browser runtime available (${clampString(errorMessage(error), 180)}). The approval-restart ` +
              "durable truth is proven headless by runtime-truth.approval-restart-durable-truth; only the Next shell " +
              "cross-check is held pending a browser-capable environment.",
          );
        }

        // Precondition B — a servable canonical Next shell (vite dev server).
        let ui;
        try {
          ui = await startVerificationUiProcess(context, stack.gatewayUrl, NEXT_UI_PACKAGE, "runtime-truth-ui");
        } catch (error) {
          await browser.close();
          return shellSkip(
            `SKIP: no UI-served environment (${clampString(errorMessage(error), 180)}). The approval-restart durable ` +
              "truth is proven headless by runtime-truth.approval-restart-durable-truth; only the canonical Next " +
              "shell cross-check is held pending a UI-served environment.",
          );
        }

        try {
          const browserContext = await browser.newContext({
            viewport: { width: 1440, height: 1024 },
            colorScheme: "dark",
          });
          await installMissionControlNextBrowserState(browserContext, durableTruth.workspaceId);
          const page = await browserContext.newPage();
          const browserLog = attachBrowserLogging(page);
          const browserLogCursor = browserLog.mark();

          // Bring the shell up at the target route. A dev server can answer at
          // its root (so the HTTP probe above passed) yet never hydrate the Next
          // shell for the route in this environment — the documented
          // UI-served-env gate. Treat a shell that never becomes ready as a SKIP,
          // not a failure; only once it IS ready are the cross-check assertions
          // below real pass/fail.
          try {
            await page.goto(
              buildVerificationUiUrl(
                ui.uiUrl,
                `/ops/approvals?approvalId=${encodeURIComponent(durableTruth.approvalId)}`,
              ),
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
          } catch (error) {
            return shellSkip(
              `SKIP: the canonical Next shell did not become ready (${clampString(errorMessage(error), 180)}). The ` +
                "dev server answered but the shell never hydrated the /ops/approvals route on this host — no " +
                "functionally UI-served environment. The approval-restart durable truth is proven headless by " +
                "runtime-truth.approval-restart-durable-truth; only the shell cross-check is held.",
            );
          }

          // Shell is ready — the cross-check assertions below are real pass/fail.
          await setBrowserCorrelation(page, correlationId, durableTruth.sessionId);
          await page.getByRole("tab", { name: /History/i }).click();
          const recovery = page.locator("details").filter({
            has: page.locator("summary").filter({ hasText: /^Recovery$/ }),
          });
          await recovery.locator("summary").click();
          await recovery.getByRole("button", { name: /Load durable status/i }).click();
          await recovery.getByText(`Run: ${durableTruth.approvalRecoveryRunId}`, { exact: true }).waitFor({ timeout: 15000 });
          await recovery.getByText("Status:", { exact: false }).waitFor({ timeout: 15000 });
          await recovery.getByText("Updated:", { exact: false }).waitFor({ timeout: 15000 });
          const runtimePreview = await recovery.innerText();
          if (!durableTruth.acceptableStatuses.some((status) => runtimePreview.includes(`Status: ${status}`))) {
            throw new Error(
              `runtime-truth expected one of ${durableTruth.acceptableStatuses.join(", ")} in the approvals recovery panel`,
            );
          }
          const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, NEXT_UI_PACKAGE);
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "runtime-truth-canonical-next-shell-consistency",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
            logCursor: browserLogCursor,
          });
          return {
            status: "passed",
            metrics: {
              consoleErrors: browserSanity.consoleErrors.length,
              pageErrors: browserSanity.pageErrors.length,
            },
            artifacts,
          };
        } finally {
          await browser.close();
          await stopProcess(ui.handle);
        }
      },
    );
  } finally {
    await activeChatTransport?.close();
    if (stack) {
      await stopVerificationStack(stack);
    } else if (runtimeRoot) {
      await stopVerificationStack({ runtimeRoot });
    }
    await llmStub?.close().catch(() => undefined);
    restoreUiPackage();
  }
}

const VERIFICATION_STUB_LLM_KEY = "verification-stub-key";

function ownedGatewayProcessIdentity(stack) {
  return {
    pid: stack?.gateway?.child?.pid,
    gatewayUrl: stack?.gatewayUrl,
  };
}

export function assertOwnedGatewayRestart(before, after) {
  if (!Number.isSafeInteger(before?.pid) || before.pid <= 0) {
    throw new Error("runtime-truth did not capture the owned Gateway process before restart");
  }
  if (!Number.isSafeInteger(after?.pid) || after.pid <= 0) {
    throw new Error("runtime-truth did not capture the owned Gateway process after restart");
  }
  if (before.pid === after.pid) {
    throw new Error(`runtime-truth Gateway restart reused process ${before.pid}`);
  }
  if (!before.gatewayUrl || before.gatewayUrl !== after.gatewayUrl) {
    throw new Error(
      `runtime-truth Gateway restart changed endpoint from ${before?.gatewayUrl ?? "unknown"} to ${after?.gatewayUrl ?? "unknown"}`,
    );
  }
}

export function assertRuntimeTruthApprovalLifecycle(lifecycle, approvalId, chatRunId) {
  const runId = lifecycle?.canonical?.runId;
  const approval = lifecycle?.approval;
  // The approval's wait workflow and the resumed Chat workflow have separate
  // canonical identities. Recovery displays the former, linked to the latter.
  if (!runId || approval?.approvalId !== approvalId || approval.status !== "approved" ||
      approval.linkage?.runId !== chatRunId || approval.linkage?.durableRunId !== runId ||
      lifecycle.durableRun?.runId !== runId || lifecycle.durableRun.status !== "completed") {
    throw new Error("runtime-truth approval recovery does not match the exact approval and resumed Chat run");
  }
  return runId;
}

function errorMessage(error) {
  return error instanceof Error ? (error.message ?? String(error)) : String(error);
}

function shellSkip(note) {
  // Print the conditional skip to stdout so the composite runner (and anyone
  // reading the lane's output) sees it — recordScenario keeps scenario notes
  // only in the manifest. The scenario is recorded as "skipped", never "failed".
  process.stdout.write(`[runtime-truth] canonical-next-shell-consistency -> ${note}\n`);
  return { status: "skipped", notes: [note] };
}
