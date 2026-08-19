#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRunContext, finalizeRunContext, runScenario } from "./verification/lib/shared.mjs";
import { requestJson, startVerificationStack, stopVerificationStack } from "./verification/lib/runtime.mjs";
import { startDeterministicLlmStub } from "./verification/lib/scenarios/deterministic-llm-stub.mjs";

async function main() {
  const context = await createRunContext("install-smoke", {
    profile: "local",
  });

  let stack;
  let llmStub;
  let manifest = null;

  try {
    stack = await startVerificationStack(context, {
      includeUi: true,
      gatewayPort: 0,
      uiPort: 0,
      gatewayEnv: {
        GOATCITADEL_AUTH_MODE: "none",
        GOATCITADEL_DISABLE_SECRET_STORE: "true",
        GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
      },
    });

    // Saving a provider credential runs a live model-catalog check before the
    // owner is promoted, so the smoke key needs a catalog it can actually
    // reach. This loopback stub keeps that check deterministic and offline.
    llmStub = await startDeterministicLlmStub();

    await runScenario(
      context,
      {
        id: "install.gateway.health",
        lane: "install-smoke",
        title: "Gateway health endpoint responds",
        subsystem: "gateway",
      },
      async () => {
        const response = await requestJson(stack.gatewayUrl, "/health");
        return {
          status: response.ok && response.body?.status === "ok" ? "passed" : "failed",
          error: response.ok ? undefined : JSON.stringify(response.body),
          metrics: {
            statusCode: response.status,
          },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "install.gateway.startup",
        lane: "install-smoke",
        title: "Startup endpoint responds on the isolated stack",
        subsystem: "gateway",
      },
      async () => {
        const response = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/startup");
        return {
          status: response.ok ? "passed" : "failed",
          error: response.ok ? undefined : JSON.stringify(response.body),
          metrics: {
            statusCode: response.status,
          },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "install.gateway.bootstrap",
        lane: "install-smoke",
        title: "Bootstrap onboarding persists an env-backed provider secret on first run",
        subsystem: "gateway",
      },
      async () => {
        const currentState = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/state");
        const expectedRevision = resolveOnboardingRevision(currentState);
        const response = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/bootstrap", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "install-smoke-bootstrap-1",
          },
          body: {
            expectedRevision,
            defaultToolProfile: "minimal",
            budgetMode: "balanced",
            networkAllowlist: ["127.0.0.1", "localhost"],
            llm: {
              activeProviderId: "openai",
              activeModel: "gpt-5",
              upsertProvider: {
                providerId: "openai",
                apiKeyEnv: "OPENAI_API_KEY",
                baseUrl: llmStub.baseUrl,
              },
            },
            markComplete: true,
            completedBy: "install-smoke",
          },
        });
        if (!response.ok) {
          return {
            status: "failed",
            error: JSON.stringify({ bootstrap: response.body }),
            metrics: {
              bootstrapStatusCode: response.status,
              secretStatusCode: 0,
              wroteEnvFile: false,
              completed: false,
            },
          };
        }
        const secretRevision = resolveOnboardingRevision({
          ok: response.ok,
          status: response.status,
          body: response.body?.state,
        });
        const secretResponse = await requestJson(stack.gatewayUrl, "/api/v1/secrets/providers/openai", {
          method: "POST",
          body: {
            apiKey: "sk-install-smoke-value",
            expectedRevision: secretRevision,
            storage: "env",
            envVar: "OPENAI_API_KEY",
          },
        });
        const envFile = await readFile(`${stack.runtimeRoot}/.env`, "utf8").catch(() => "");
        const wroteEnvFile = /OPENAI_API_KEY=\"sk-install-smoke-value\"/.test(envFile);
        return {
          status: secretResponse.ok && wroteEnvFile ? "passed" : "failed",
          error: secretResponse.ok ? undefined : JSON.stringify({ secret: secretResponse.body }),
          metrics: {
            bootstrapStatusCode: response.status,
            secretStatusCode: secretResponse.status,
            wroteEnvFile,
            completed: response.body?.state?.completed === true,
          },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "install.gateway.status",
        lane: "install-smoke",
        title: "Verification status endpoint reports runtime metadata",
        subsystem: "gateway",
      },
      async () => {
        const response = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/status");
        const providers = Array.isArray(response.body?.providers) ? response.body.providers : [];
        const activeProvider = providers.find((provider) => provider.active);
        return {
          status: response.ok ? "passed" : "failed",
          error: response.ok ? undefined : JSON.stringify(response.body),
          providerId: activeProvider?.providerId,
          modelId: response.body?.activeModel,
          metrics: {
            statusCode: response.status,
            providerCount: providers.length,
            configuredProviderCount: providers.filter((provider) => provider.hasSecret).length,
            activeProviderConfigured: Boolean(activeProvider?.hasSecret),
          },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "install.provider.smoke-path",
        lane: "install-smoke",
        title: "Configured-provider smoke evidence path is explicit",
        subsystem: "providers",
      },
      async () => {
        const statusResponse = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/status");
        const providers = Array.isArray(statusResponse.body?.providers) ? statusResponse.body.providers : [];
        const activeProvider = providers.find((provider) => provider.active);
        const shouldExercise = process.env.GOATCITADEL_VERIFY_INSTALL_LIVE_PROVIDER === "1";
        if (shouldExercise && activeProvider) {
          const exercise = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/provider-exercise", {
            method: "POST",
            body: {
              providerId: activeProvider.providerId,
              model: statusResponse.body?.activeModel || activeProvider.defaultModel,
              scenario: "simple",
            },
          });
          return {
            status: exercise.ok && exercise.body?.ok ? "passed" : "failed",
            providerId: activeProvider.providerId,
            modelId: exercise.body?.model,
            error: exercise.body?.ok ? undefined : (exercise.body?.error ?? JSON.stringify(exercise.body)),
            notes: exercise.body?.ok ? ["Provider smoke passed with live model evidence."] : [],
            metrics: {
              statusCode: exercise.status,
              elapsedMs: exercise.body?.elapsedMs ?? 0,
              returnedModel: exercise.body?.model ?? null,
              usage: exercise.body?.usage ?? null,
              providerSmokeState: exercise.body?.ok ? "passed_with_evidence" : "failed_with_evidence",
              liveProviderExercise: true,
            },
          };
        }
        const activeProviderConfigured = Boolean(activeProvider?.hasSecret);
        return {
          status: statusResponse.ok && activeProvider ? "passed" : "failed",
          providerId: activeProvider?.providerId,
          modelId: statusResponse.body?.activeModel,
          error: statusResponse.ok ? undefined : JSON.stringify(statusResponse.body),
          notes: [
            activeProviderConfigured
              ? "Provider is configured and smoke-ready; live provider smoke was not exercised."
              : "Provider smoke path is visible, but active provider credentials are not configured.",
            "Set GOATCITADEL_VERIFY_INSTALL_LIVE_PROVIDER=1 with real credentials to produce provider smoke pass/fail evidence.",
          ],
          metrics: {
            statusCode: statusResponse.status,
            liveProviderExercise: false,
            activeProviderConfigured,
            providerSmokeState: activeProviderConfigured ? "smoke_ready" : "configured_only",
          },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "install.gateway.demo-first-outcome",
        lane: "install-smoke",
        title: "Safe demo bootstrap creates a canonical Chat, project, and governed task anchors",
        subsystem: "gateway",
      },
      async () => {
        const bootstrap = await requestJson(stack.gatewayUrl, "/api/v1/demo/bootstrap", {
          method: "POST",
          body: {},
        });
        const state = await requestJson(stack.gatewayUrl, "/api/v1/demo/state");
        const sessions = Array.isArray(bootstrap.body?.sessions) ? bootstrap.body.sessions : [];
        const modes = new Set(sessions.map((session) => session.mode));
        const hasFirstRunAnchors =
          Boolean(bootstrap.body?.workspace) &&
          Boolean(bootstrap.body?.project) &&
          sessions.length === 1 &&
          modes.has("chat") &&
          !modes.has("cowork") &&
          !modes.has("code") &&
          Array.isArray(bootstrap.body?.tasks) &&
          bootstrap.body.tasks.length >= 2 &&
          state.body?.status === "ready";
        return {
          status: bootstrap.ok && state.ok && hasFirstRunAnchors ? "passed" : "failed",
          error:
            bootstrap.ok && state.ok ? undefined : JSON.stringify({ bootstrap: bootstrap.body, state: state.body }),
          notes: bootstrap.body?.notes ?? [],
          metrics: {
            bootstrapStatusCode: bootstrap.status,
            stateStatusCode: state.status,
            sessionCount: sessions.length,
            taskCount: Array.isArray(bootstrap.body?.tasks) ? bootstrap.body.tasks.length : 0,
            hasWorkspace: Boolean(bootstrap.body?.workspace),
            hasProject: Boolean(bootstrap.body?.project),
            hasChat: modes.has("chat"),
            legacyPrimarySurfaceCount: sessions.filter(
              (session) => session.mode === "cowork" || session.mode === "code",
            ).length,
          },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "install.ui.dev-server",
        lane: "install-smoke",
        title: "Mission Control dev server serves the shell entrypoint",
        subsystem: "ui",
      },
      async () => {
        const { response, text: html } = await fetchTextWithRetry(`${stack.uiUrl}/`);
        const hasRootMount = html.includes('id="root"');
        const hasViteClient = html.includes("/@vite/client");
        return {
          status: response.ok && hasRootMount && hasViteClient ? "passed" : "failed",
          error: response.ok ? undefined : `Unexpected UI response from ${stack.uiUrl}/`,
          metrics: {
            statusCode: response.status,
            hasRootMount,
            hasViteClient,
          },
        };
      },
    );

    manifest = await finalizeRunContext(context);
  } catch (error) {
    manifest = await finalizeRunContext(context, "failed").catch(() => null);
    throw error;
  } finally {
    await stopVerificationStack(stack).catch(() => undefined);
    await llmStub?.close().catch(() => undefined);
  }

  console.log("GoatCitadel install smoke");
  console.log(`Status: ${manifest?.status ?? "failed"}`);
  console.log(`Artifacts: ${context.artifactRoot}`);
  console.log("Checks:");
  for (const scenario of manifest?.scenarios ?? []) {
    console.log(`- [${scenario.status.toUpperCase()}] ${scenario.title}`);
  }

  if (manifest?.status !== "passed") {
    process.exitCode = 1;
  }
}

export function resolveOnboardingRevision(response) {
  const revision = response?.body?.settings?.revision;
  if (!response?.ok || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(
      `Install smoke could not resolve the current onboarding revision (status ${String(response?.status ?? "unknown")}).`,
    );
  }
  return revision;
}

export async function fetchTextWithRetry(url, { attempts = 8, delayMs = 250, fetchImpl = globalThis.fetch } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      const text = await response.text();
      if (response.ok || attempt === attempts) {
        return { response, text };
      }
      lastError = new Error(`UI smoke request returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("UI smoke request failed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
