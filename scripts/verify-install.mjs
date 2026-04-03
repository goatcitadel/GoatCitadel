#!/usr/bin/env node
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
      id: "install.gateway.status",
      lane: "install-smoke",
      title: "Verification status endpoint reports runtime metadata",
      subsystem: "gateway",
    }, async () => {
      const response = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/status");
      return {
        status: response.ok ? "passed" : "failed",
        error: response.ok ? undefined : JSON.stringify(response.body),
        metrics: {
          statusCode: response.status,
          providerCount: Array.isArray(response.body?.providers) ? response.body.providers.length : 0,
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
