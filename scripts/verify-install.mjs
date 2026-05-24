#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRunContext, finalizeRunContext, runScenario } from "./verification/lib/shared.mjs";
import { requestJson, startVerificationStack, stopVerificationStack } from "./verification/lib/runtime.mjs";

async function main() {
  const context = await createRunContext("install-smoke", {
    profile: "local",
  });

  let stack;
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

    await runScenario(context, {
      id: "install.gateway.health",
      lane: "install-smoke",
      title: "Gateway health endpoint responds",
      subsystem: "gateway",
    }, async () => {
      const response = await requestJson(stack.gatewayUrl, "/health");
      return {
        status: response.ok && response.body?.status === "ok" ? "passed" : "failed",
        error: response.ok ? undefined : JSON.stringify(response.body),
        metrics: {
          statusCode: response.status,
        },
      };
    });

    await runScenario(context, {
      id: "install.gateway.startup",
      lane: "install-smoke",
      title: "Startup endpoint responds on the isolated stack",
      subsystem: "gateway",
    }, async () => {
      const response = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/startup");
      return {
        status: response.ok ? "passed" : "failed",
        error: response.ok ? undefined : JSON.stringify(response.body),
        metrics: {
          statusCode: response.status,
        },
      };
    });

    await runScenario(context, {
      id: "install.gateway.bootstrap",
      lane: "install-smoke",
      title: "Bootstrap onboarding persists an env-backed provider secret on first run",
      subsystem: "gateway",
    }, async () => {
      const response = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/bootstrap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "install-smoke-bootstrap-1",
        },
        body: {
          defaultToolProfile: "minimal",
          budgetMode: "balanced",
          networkAllowlist: ["127.0.0.1", "localhost"],
          llm: {
            activeProviderId: "openai",
            activeModel: "gpt-5",
            upsertProvider: {
              providerId: "openai",
              apiKey: "sk-install-smoke-value",
              apiKeyEnv: "OPENAI_API_KEY",
              persistSecretToSecureStore: false,
            },
          },
          markComplete: true,
          completedBy: "install-smoke",
        },
      });
      const envFile = await readFile(`${stack.runtimeRoot}/.env`, "utf8").catch(() => "");
      return {
        status: response.ok && /OPENAI_API_KEY=\"sk-install-smoke-value\"/.test(envFile) ? "passed" : "failed",
        error: response.ok ? undefined : JSON.stringify(response.body),
        metrics: {
          statusCode: response.status,
          wroteEnvFile: /OPENAI_API_KEY=\"sk-install-smoke-value\"/.test(envFile),
          completed: response.body?.state?.completed === true,
        },
      };
    });

    await runScenario(context, {
      id: "install.gateway.status",
      lane: "install-smoke",
      title: "Verification status endpoint reports runtime metadata",
      subsystem: "gateway",
    }, async () => {
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
    });

    await runScenario(context, {
      id: "install.provider.smoke-path",
      lane: "install-smoke",
      title: "Configured-provider smoke evidence path is explicit",
      subsystem: "providers",
    }, async () => {
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
          modelId: exercise.body?.model ?? statusResponse.body?.activeModel,
          error: exercise.body?.ok ? undefined : exercise.body?.error ?? JSON.stringify(exercise.body),
          notes: exercise.body?.ok ? ["Provider smoke passed with live model evidence."] : [],
          metrics: {
            statusCode: exercise.status,
            elapsedMs: exercise.body?.elapsedMs ?? 0,
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
    });

    await runScenario(context, {
      id: "install.gateway.demo-first-outcome",
      lane: "install-smoke",
      title: "Safe demo bootstrap creates first-run Chat, Cowork, Code, and project anchors",
      subsystem: "gateway",
    }, async () => {
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
        modes.has("chat") &&
        modes.has("cowork") &&
        modes.has("code") &&
        Array.isArray(bootstrap.body?.tasks) &&
        bootstrap.body.tasks.length >= 2 &&
        state.body?.status === "ready";
      return {
        status: bootstrap.ok && state.ok && hasFirstRunAnchors ? "passed" : "failed",
        error: bootstrap.ok && state.ok ? undefined : JSON.stringify({ bootstrap: bootstrap.body, state: state.body }),
        notes: bootstrap.body?.notes ?? [],
        metrics: {
          bootstrapStatusCode: bootstrap.status,
          stateStatusCode: state.status,
          sessionCount: sessions.length,
          taskCount: Array.isArray(bootstrap.body?.tasks) ? bootstrap.body.tasks.length : 0,
          hasWorkspace: Boolean(bootstrap.body?.workspace),
          hasProject: Boolean(bootstrap.body?.project),
          hasChat: modes.has("chat"),
          hasCowork: modes.has("cowork"),
          hasCode: modes.has("code"),
        },
      };
    });

    await runScenario(context, {
      id: "install.ui.dev-server",
      lane: "install-smoke",
      title: "Mission Control dev server serves the shell entrypoint",
      subsystem: "ui",
    }, async () => {
      const response = await fetch(`${stack.uiUrl}/`, {
        redirect: "follow",
      });
      const html = await response.text();
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
    });

    manifest = await finalizeRunContext(context);
  } catch (error) {
    manifest = await finalizeRunContext(context, "failed").catch(() => null);
    throw error;
  } finally {
    await stopVerificationStack(stack).catch(() => undefined);
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
