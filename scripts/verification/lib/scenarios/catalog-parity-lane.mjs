import { createServer } from "node:http";

export async function runCatalogParityLane(context, _options = {}, deps) {
  const {
    assertOk,
    ensureOnboardingComplete,
    path,
    relativeToRun,
    requestJson,
    runScenario,
    startVerificationStack,
    stopVerificationStack,
    writeJson,
  } = deps;

  const fixture = await startCatalogParityFixtureServer();
  let stack;
  try {
    stack = await startVerificationStack(context, {
      includeUi: false,
      gatewayEnv: {
        GOATCITADEL_TRELLO_API_BASE_URL: fixture.baseUrl,
        GOATCITADEL_TENOR_API_BASE_URL: fixture.baseUrl,
        GOATCITADEL_GMAIL_API_BASE_URL: fixture.baseUrl,
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-catalog-parity");
    await runScenario(
      context,
      {
        id: "catalog-parity.visible-catalog-truth",
        lane: "catalog-parity",
        title: "Visible catalog entries stay on operator-ready maturity with no planned escape hatch",
        subsystem: "gateway",
      },
      async () => {
        const visibleCatalogKinds = ["channel", "model_provider", "productivity", "automation", "platform"];
        const visibleItems = [];
        for (const kind of visibleCatalogKinds) {
          const response = await requestJson(stack.gatewayUrl, `/api/v1/integrations/catalog?kind=${kind}`);
          assertOk(response, `fetch ${kind} integration catalog`);
          const items = Array.isArray(response.body?.items) ? response.body.items : [];
          visibleItems.push(...items);
        }

        const mandatoryVisibleIds = new Set([
          "model_provider.minimax",
          "model_provider.vercel",
          "model_provider.mistral",
          "model_provider.deepseek",
          "model_provider.perplexity",
          "model_provider.huggingface",
          "productivity.apple-notes",
          "productivity.apple-reminders",
          "productivity.things3",
          "productivity.bear",
          "productivity.trello",
          "automation.gmail",
          "automation.gif-search",
          "automation.peekaboo-screen",
          "automation.camera-photo-video",
          "platform.macos-menubar-voice",
          "platform.ios-canvas-camera-voice",
        ]);
        const runtimeActionCatalogIds = [
          "productivity.apple-notes",
          "productivity.apple-reminders",
          "productivity.things3",
          "productivity.bear",
          "productivity.trello",
          "automation.gmail",
          "automation.gif-search",
          "automation.peekaboo-screen",
          "automation.camera-photo-video",
          "platform.macos-menubar-voice",
          "platform.ios-canvas-camera-voice",
        ];
        const targetedEntries = visibleItems.filter((item) => mandatoryVisibleIds.has(item.catalogId));
        const plannedEntries = visibleItems.filter((item) => item.maturity === "planned");
        const nonOperatorReady = targetedEntries.filter(
          (item) => item.maturity !== "beta" && item.maturity !== "native",
        );
        const pluginVisible = targetedEntries.filter((item) => item.maturity === "plugin");
        const blockedWithoutSchema = targetedEntries.filter(
          (item) => !item.formSchema || !Array.isArray(item.formSchema.fields) || item.formSchema.fields.length === 0,
        );
        if (targetedEntries.length !== mandatoryVisibleIds.size) {
          throw new Error(
            `catalog parity expected ${mandatoryVisibleIds.size} mandatory visible entries, found ${targetedEntries.length}`,
          );
        }
        if (plannedEntries.length > 0) {
          throw new Error(
            `catalog parity found visible planned entries: ${plannedEntries.map((item) => item.catalogId).join(", ")}`,
          );
        }
        if (nonOperatorReady.length > 0) {
          throw new Error(
            `catalog parity found non-operator-ready entries: ${nonOperatorReady.map((item) => `${item.catalogId}:${item.maturity}`).join(", ")}`,
          );
        }
        if (pluginVisible.length > 0) {
          throw new Error(
            `catalog parity found visible plugin-backed entries: ${pluginVisible.map((item) => item.catalogId).join(", ")}`,
          );
        }
        if (targetedEntries.some((item) => item.runtimeAvailability !== "runnable")) {
          throw new Error(
            `catalog parity found non-runnable mandatory entries: ${targetedEntries
              .filter((item) => item.runtimeAvailability !== "runnable")
              .map((item) => item.catalogId)
              .join(", ")}`,
          );
        }
        if (blockedWithoutSchema.length > 0) {
          throw new Error(
            `catalog parity found mandatory entries without guided form schema: ${blockedWithoutSchema.map((item) => item.catalogId).join(", ")}`,
          );
        }
        const runtimeActionResults = [];
        for (const catalogId of runtimeActionCatalogIds) {
          const entry = targetedEntries.find((item) => item.catalogId === catalogId);
          if (!entry) {
            throw new Error(`catalog parity could not find runtime action entry ${catalogId}`);
          }
          const operatorAction = Array.isArray(entry.operatorActions) ? entry.operatorActions[0] : undefined;
          if (!operatorAction) {
            throw new Error(`catalog parity expected ${catalogId} to expose at least one operator action`);
          }
          const createdConnection = await requestJson(stack.gatewayUrl, "/api/v1/integrations/connections", {
            method: "POST",
            body: {
              catalogId,
              label: `${entry.label} Verification`,
              enabled: true,
              status: "connected",
              config: buildCatalogParityConnectionConfig(catalogId, fixture.baseUrl),
            },
          });
          assertOk(createdConnection, `create ${catalogId} verification connection`);
          const actionResult = await requestJson(
            stack.gatewayUrl,
            `/api/v1/integrations/connections/${encodeURIComponent(createdConnection.body?.connectionId ?? "")}/actions/${encodeURIComponent(operatorAction.actionId)}`,
            {
              method: "POST",
              body: {
                input: buildCatalogParityActionInput(catalogId, operatorAction.actionId),
              },
            },
          );
          assertOk(actionResult, `invoke ${catalogId}:${operatorAction.actionId}`);
          if (actionResult.body?.status !== "executed") {
            throw new Error(
              `catalog parity action ${catalogId}:${operatorAction.actionId} returned ${actionResult.body?.status ?? "unknown"}: ${JSON.stringify(actionResult.body)}`,
            );
          }
          runtimeActionResults.push({
            catalogId,
            actionId: operatorAction.actionId,
            status: actionResult.body?.status,
            message: actionResult.body?.message,
            output: actionResult.body?.output,
          });
        }
        const artifactPath = path.join(context.artifactRoot, "diagnostics", "catalog-parity-visible-catalog.json");
        await writeJson(artifactPath, {
          checkedAt: new Date().toISOString(),
          targetedEntries,
          visibleCatalogCount: visibleItems.length,
          runtimeActionResults,
        });
        return {
          status: "passed",
          metrics: {
            mandatoryVisibleCount: targetedEntries.length,
            runtimeActionProofCount: runtimeActionResults.length,
          },
          artifacts: {
            diagnostics: [relativeToRun(context, artifactPath)],
            screenshots: [],
            traces: [],
            logs: [],
            perf: [],
            playwright: [],
          },
        };
      },
    );
  } finally {
    if (stack) {
      await stopVerificationStack(stack);
    }
    await fixture.close();
  }
}

async function startCatalogParityFixtureServer() {
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const parsedBody = rawBody.trim() ? safeJsonParse(rawBody) : undefined;

    if (url.pathname === "/v1/integrations/actions" && method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          message: "fixture bridge ok",
          output: {
            catalogId: parsedBody?.catalogId,
            actionId: parsedBody?.actionId,
            input: parsedBody?.input ?? {},
          },
        }),
      );
      return;
    }
    if (url.pathname === "/1/members/me/boards" && method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: "board-1", name: "Verification Board", url: "https://trello.test/board-1" }]));
      return;
    }
    if (url.pathname === "/1/cards" && method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "card-1", name: "Verification Card", url: "https://trello.test/card-1" }));
      return;
    }
    if (url.pathname === "/v2/search" && method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            {
              id: "gif-1",
              content_description: "Happy goat",
              media_formats: {
                gif: {
                  url: "https://media.example.test/happy-goat.gif",
                },
              },
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages" && method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ messages: [{ id: "msg-1", threadId: "thread-1" }] }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages/send" && method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "sent-1" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found", path: url.pathname, method }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("catalog parity fixture server did not expose an address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
    },
  };
}

function buildCatalogParityConnectionConfig(catalogId, fixtureBaseUrl) {
  switch (catalogId) {
    case "productivity.trello":
      return {
        apiKey: "trello-key",
        token: "trello-token",
        defaultListId: "list-123",
      };
    case "automation.gmail":
      return {
        accessToken: "gmail-token",
      };
    case "automation.gif-search":
      return {
        provider: "tenor",
        apiKey: "tenor-key",
      };
    case "platform.ios-canvas-camera-voice":
      return {
        bridgeUrl: fixtureBaseUrl,
        deviceId: "verification-ios-device",
      };
    default:
      return {
        bridgeUrl: fixtureBaseUrl,
        authToken: "fixture-bridge-token",
      };
  }
}

function buildCatalogParityActionInput(catalogId, actionId) {
  if (catalogId === "automation.gmail" && actionId === "write") {
    return {
      to: "ops@example.com",
      subject: "GoatCitadel operator check",
      bodyText: "This is a GoatCitadel Gmail operator check.",
    };
  }
  if (catalogId === "automation.gif-search" && actionId === "search") {
    return {
      query: "happy goat",
    };
  }
  if (catalogId === "platform.macos-menubar-voice" && actionId === "voice") {
    return {
      prompt: "Operator voice check",
    };
  }
  if (catalogId === "platform.ios-canvas-camera-voice" && actionId === "canvas") {
    return {
      content: "Operator canvas check",
    };
  }
  return {};
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
