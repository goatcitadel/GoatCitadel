import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatRoutedContextInspection,
  ExternalSessionAttachmentListResponse,
  ExternalSessionAttachmentResponse,
  ExternalSourceDetailResponse,
  ExternalSourceImportApplyResponse,
  ExternalSourceImportPlanResponse,
  ExternalSourcePage,
  ExternalSourceScanRecord,
  RoutingPreflightResult,
  WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import {
  SYNTHETIC_CODEX_PRODUCER_VERSION,
  SYNTHETIC_CODEX_ROLLOUT_JSONL,
  SYNTHETIC_SESSION_ID,
} from "./services/external-source-adapters/fixtures/synthetic-fixtures.js";
import { buildApp } from "./app.js";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiRequest,
  type FakeOpenAiResponse,
  type FakeOpenAiServer,
} from "./test/fake-openai-server.js";

const TOKEN = "external-source-closure-token-1234567890";
const SECOND_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const SYNTHETIC_TRANSCRIPT_TEXT = "Synthetic Codex user-visible request.";
const ENV_KEYS = [
  "GATEWAY_HOST",
  "NODE_ENV",
  "GOATCITADEL_ALLOWED_ORIGINS",
  "GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS",
  "GOATCITADEL_AUTH_MODE",
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_ROOT_DIR",
] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];
let fakeProvider: FakeOpenAiServer | undefined;

// Content-only provider stub: a fixed reply for both transports so the real
// Chat turn completes deterministically without entering a tool-call loop.
function contentOnlyProviderHandler(request: FakeOpenAiRequest): FakeOpenAiResponse {
  if (request.method === "GET" && request.path === "/v1/models") {
    return { body: { data: [{ id: "fake-chat", object: "model", owned_by: "goatcitadel-test" }] } };
  }
  const body = (request.body ?? {}) as Record<string, unknown>;
  const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
  if (body.stream === true) {
    return {
      sseFrames: [
        JSON.stringify({
          id: "closure-stream",
          choices: [{ index: 0, delta: { content: "Rollout received." }, finish_reason: "stop" }],
          usage,
        }),
        "[DONE]",
      ],
    };
  }
  return {
    body: {
      id: "closure-chat-response",
      object: "chat.completion",
      model: typeof body.model === "string" ? body.model : "fake-chat",
      choices: [{ index: 0, message: { role: "assistant", content: "Rollout received." }, finish_reason: "stop" }],
      usage,
    },
  };
}

describe("HX-407 C4 external source closure composition", { timeout: 180_000 }, () => {
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await fakeProvider?.close();
    fakeProvider = undefined;
  });

  it("drives register→scan→plan→apply→attach→send→knowledge-approval→recovered snapshot end-to-end without the proof gate", async () => {
    fakeProvider = await startFakeOpenAiCompatibleServer(contentOnlyProviderHandler);
    const configRoot = configureGateway(fakeProvider.baseUrl);
    const sourceRoot = createSyntheticCodexRoot(configRoot);
    const app = await buildApp();
    try {
      // --- Library half: verified root → registration → sealed scan → page ---
      const verifiedResponse = await app.inject({
        method: "POST",
        url: "/api/v1/ops/workspace-path-bridges/resolve",
        headers: mutationHeaders("closure-path-verify-1"),
        payload: {
          verificationId: "closure-binding-1",
          workspaceId: "default",
          inputPath: sourceRoot,
          inputFlavor: "windows_native",
          targetFlavor: "windows_native",
          requireGitIdentity: false,
        },
      });
      expect(verifiedResponse.statusCode).toBe(200);
      const snapshot = verifiedResponse.json() as WorkspacePathBridgeSnapshotRecord;

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/library/external-sources",
        headers: mutationHeaders("closure-source-create-1"),
        payload: {
          workspaceId: "default",
          expectedWorkspaceRevision: 1,
          kind: "codex_sessions" as const,
          label: "Closure synthetic Codex sessions",
          canonicalRootPath: snapshot.canonicalHostPath!,
          pathBridgeSnapshotId: snapshot.snapshotId,
          pathBridgeSnapshotSha256: snapshot.snapshotSha256,
          inputFlavor: snapshot.inputFlavor,
          targetFlavor: snapshot.targetFlavor,
          requireGitIdentity: false,
          acceptedProducerVersions: [SYNTHETIC_CODEX_PRODUCER_VERSION],
        },
      });
      expect(createResponse.statusCode).toBe(201);
      const source = (createResponse.json() as ExternalSourceDetailResponse).source;

      const scanResponse = await app.inject({
        method: "POST",
        url: `/api/v1/library/external-sources/${encodeURIComponent(source.sourceId)}/scans`,
        headers: mutationHeaders("closure-source-scan-1"),
        payload: { workspaceId: "default", expectedRevision: 1 },
      });
      expect(scanResponse.statusCode).toBe(201);
      const scan = scanResponse.json() as ExternalSourceScanRecord;
      expect(scan.status).toBe("sealed");
      expect(scan.supportedItemCount).toBe(2);

      const pageResponse = await app.inject({
        method: "GET",
        url: `/api/v1/library/external-sources/${encodeURIComponent(source.sourceId)}/items?workspaceId=default&scanId=${encodeURIComponent(scan.scanId)}&dispositions=supported`,
        headers: operatorHeaders(),
      });
      expect(pageResponse.statusCode).toBe(200);
      const page = pageResponse.json() as ExternalSourcePage;
      expect(page.items).toHaveLength(2);

      // --- Import: dry-run plan → retry-safe apply with real staged bytes ---
      const planResponse = await app.inject({
        method: "POST",
        url: "/api/v1/library/external-source-import-plans",
        headers: mutationHeaders("closure-plan-1"),
        payload: {
          workspaceId: "default",
          sourceId: source.sourceId,
          scanId: scan.scanId,
          selectedItemIds: page.items.map((item) => item.itemId),
          expectedRevision: 1,
        },
      });
      expect(planResponse.statusCode).toBe(201);
      const plan = planResponse.json() as ExternalSourceImportPlanResponse;
      expect(plan.plan.blockerCodes).toEqual([]);

      const applyResponse = await app.inject({
        method: "POST",
        url: "/api/v1/library/external-source-imports",
        headers: mutationHeaders("closure-apply-1"),
        payload: {
          workspaceId: "default",
          planId: plan.plan.planId,
          expectedPlanSha256: plan.plan.planSha256,
          idempotencyKey: plan.idempotencyKey,
        },
      });
      expect(applyResponse.statusCode).toBe(201);
      const applied = applyResponse.json() as ExternalSourceImportApplyResponse;
      expect(applied.applyDisposition).toBe("created");
      expect(applied.settlement).toMatchObject({ disposition: "applied" });
      const importId = applied.intent.importId;
      const firstItem = applied.items[0]!;

      // --- Chat half: session, durable incarnation reload, attach ---
      const sessionResponse = await app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions",
        headers: mutationHeaders("closure-session-1"),
        payload: { title: "Closure external source session" },
      });
      expect(sessionResponse.statusCode).toBe(201);
      const sessionId = (sessionResponse.json() as { sessionId: string }).sessionId;
      expect(sessionId).toBeTruthy();

      const emptyListResponse = await app.inject({
        method: "GET",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/external-source-attachments?workspaceId=default`,
        headers: operatorHeaders(),
      });
      expect(emptyListResponse.statusCode).toBe(200);
      expect(emptyListResponse.headers["cache-control"]).toBe("no-store");
      expect(emptyListResponse.headers["x-goatcitadel-execution-authority"]).toBe("none");
      const emptyList = emptyListResponse.json() as ExternalSessionAttachmentListResponse;
      expect(emptyList.items).toEqual([]);
      const sessionIncarnationId = emptyList.sessionIncarnationId!;
      expect(sessionIncarnationId).toBeTruthy();

      const attachBody = {
        workspaceId: "default",
        sessionId,
        expectedSessionIncarnationId: sessionIncarnationId,
        sourceId: source.sourceId,
        importId,
        itemId: firstItem.itemId,
      };
      const attachResponse = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/external-source-attachments`,
        headers: mutationHeaders("closure-attach-1"),
        payload: attachBody,
      });
      expect(attachResponse.statusCode).toBe(201);
      const attach = attachResponse.json() as ExternalSessionAttachmentResponse;
      expect(attach.attachment).toMatchObject({
        mode: "read_only_external",
        status: "attached",
        revision: 1,
        itemId: firstItem.itemId,
        normalizedArtifactSha256: firstItem.normalizedArtifactSha256,
      });

      const attachReplayResponse = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/external-source-attachments`,
        headers: mutationHeaders("closure-attach-replay-1"),
        payload: attachBody,
      });
      expect(attachReplayResponse.statusCode).toBe(200);
      expect(attachReplayResponse.json()).toMatchObject({ disposition: "replayed" });

      const listResponse = await app.inject({
        method: "GET",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/external-source-attachments?workspaceId=default`,
        headers: operatorHeaders(),
      });
      expect(listResponse.statusCode).toBe(200);
      const list = listResponse.json() as ExternalSessionAttachmentListResponse;
      expect(list.items).toHaveLength(1);
      // Durable reload truth stays content-free: no transcript bytes leave.
      expect(listResponse.body).not.toContain(SYNTHETIC_TRANSCRIPT_TEXT);
      expect(listResponse.body).not.toContain(sourceRoot);

      // Cross-workspace list masks as not_found without existence leak.
      const foreignList = await app.inject({
        method: "GET",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/external-source-attachments?workspaceId=other-workspace`,
        headers: operatorHeaders(),
      });
      expect(foreignList.statusCode).toBe(404);

      // --- HX-407 C4c: route-level send freezes the external ref end-to-end ---
      // The C1 contract's external_attachment kind crosses the widened
      // chat.messages gate as an identifier only; the C4a-composed resolver
      // loads the governed artifact bytes and the prep service freezes the
      // HX-307 snapshot entry with the full external provenance chain.
      const preflightResponse = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/route-preflight`,
        headers: mutationHeaders("closure-preflight-1"),
        payload: { action: "send", content: "Summarize the imported rollout.", subagentPolicy: "off" },
      });
      expect(preflightResponse.statusCode).toBe(200);
      const preflight = preflightResponse.json() as RoutingPreflightResult;
      expect(preflight.blockedReason).toBeUndefined();

      const externalContextRef = {
        kind: "external_attachment" as const,
        ref: attach.attachment.attachmentId,
        label: "Closure rollout transcript",
      };
      const sendResponse = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send`,
        headers: mutationHeaders("closure-send-1"),
        payload: {
          content: "Summarize the imported rollout.",
          providerId: preflight.decision.effectiveProviderId,
          model: preflight.decision.effectiveModel,
          contextRefs: [externalContextRef],
          // Routed context freezes the provider/model budget, which cannot be
          // delegated to subagents — the send boundary enforces policy off.
          subagentPolicy: "off",
          routeDecision: preflight.decision,
        },
      });
      expect(sendResponse.statusCode, sendResponse.body).toBe(200);
      const sent = sendResponse.json() as { turnId: string };
      expect(sent.turnId).toBeTruthy();

      // The frozen snapshot admitted the exact managed artifact bytes into
      // provider context: the transcript text reaches the provider request...
      const providerSawTranscript = fakeProvider!.requests.some(
        (item) => item.path === "/v1/chat/completions" && item.rawBody.includes(SYNTHETIC_TRANSCRIPT_TEXT),
      );
      expect(providerSawTranscript).toBe(true);

      // ...while the operator-facing inspection stays content-free and carries
      // the immutable external provenance chain (HX-307 snapshot entry).
      const inspectionResponse = await app.inject({
        method: "GET",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(sent.turnId)}/capability-profile?workspaceId=default`,
        headers: operatorHeaders(),
      });
      expect(inspectionResponse.statusCode, inspectionResponse.body).toBe(200);
      const inspection = inspectionResponse.json() as { routedContext?: ChatRoutedContextInspection };
      expect(inspection.routedContext).toBeDefined();
      const externalEntry = inspection.routedContext!.entries.find((entry) => entry.kind === "external_attachment");
      expect(externalEntry).toMatchObject({
        kind: "external_attachment",
        ref: attach.attachment.attachmentId,
        disposition: "included",
        externalProvenance: {
          sourceId: source.sourceId,
          importId,
          itemId: firstItem.itemId,
          attachmentId: attach.attachment.attachmentId,
          attachmentRevision: 1,
          normalizedArtifactSha256: firstItem.normalizedArtifactSha256,
        },
      });
      expect(inspectionResponse.body).not.toContain(SYNTHETIC_TRANSCRIPT_TEXT);

      // The UI drives the STREAMING send route; prove the same frozen-ref path
      // over SSE exactly as the browser does — a FRESH session whose first
      // turn is the streaming send (a same-session back-to-back send would
      // race the first turn's durable post-commit admission settlement).
      const streamSessionResponse = await app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions",
        headers: mutationHeaders("closure-session-2"),
        payload: { title: "Closure external source stream session" },
      });
      expect(streamSessionResponse.statusCode).toBe(201);
      const streamSessionId = (streamSessionResponse.json() as { sessionId: string }).sessionId;
      const streamListResponse = await app.inject({
        method: "GET",
        url: `/api/v1/chat/sessions/${encodeURIComponent(streamSessionId)}/external-source-attachments?workspaceId=default`,
        headers: operatorHeaders(),
      });
      expect(streamListResponse.statusCode).toBe(200);
      const streamIncarnationId = (streamListResponse.json() as ExternalSessionAttachmentListResponse)
        .sessionIncarnationId!;
      const streamAttachResponse = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(streamSessionId)}/external-source-attachments`,
        headers: mutationHeaders("closure-attach-stream-1"),
        payload: {
          workspaceId: "default",
          sessionId: streamSessionId,
          expectedSessionIncarnationId: streamIncarnationId,
          sourceId: source.sourceId,
          importId,
          itemId: firstItem.itemId,
        },
      });
      expect(streamAttachResponse.statusCode, streamAttachResponse.body).toBe(201);
      const streamAttachment = (streamAttachResponse.json() as ExternalSessionAttachmentResponse).attachment;
      const streamPreflightResponse = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(streamSessionId)}/route-preflight`,
        headers: mutationHeaders("closure-preflight-2"),
        payload: { action: "send", content: "Summarize the rollout again.", subagentPolicy: "off" },
      });
      expect(streamPreflightResponse.statusCode, streamPreflightResponse.body).toBe(200);
      const streamPreflight = streamPreflightResponse.json() as RoutingPreflightResult;
      const streamSendResponse = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(streamSessionId)}/agent-send/stream`,
        headers: mutationHeaders("closure-send-stream-1"),
        payload: {
          content: "Summarize the rollout again.",
          providerId: streamPreflight.decision.effectiveProviderId,
          model: streamPreflight.decision.effectiveModel,
          contextRefs: [
            { kind: "external_attachment" as const, ref: streamAttachment.attachmentId, label: "Stream rollout" },
          ],
          subagentPolicy: "off",
          routeDecision: streamPreflight.decision,
        },
      });
      expect(streamSendResponse.statusCode, streamSendResponse.body.slice(0, 2000)).toBe(200);
      expect(streamSendResponse.body, streamSendResponse.body.slice(-2000)).toContain("Rollout received.");
      expect(streamSendResponse.body).not.toContain(SYNTHETIC_TRANSCRIPT_TEXT);
      const streamErrorEvents = streamSendResponse.body
        .split("\n")
        .filter((line) => line.startsWith("data:") && line.includes('"type":"error"'));
      expect(streamErrorEvents, streamErrorEvents.join("\n")).toEqual([]);

      // --- Knowledge approval: request → operator approve → recovered effect ---
      const requestResponse = await app.inject({
        method: "POST",
        url: `/api/v1/library/external-source-imports/${encodeURIComponent(importId)}/knowledge-snapshot-requests`,
        headers: mutationHeaders("closure-knowledge-request-1"),
        payload: {
          workspaceId: "default",
          sessionId,
          expectedSessionIncarnationId: sessionIncarnationId,
          attachmentId: attach.attachment.attachmentId,
          importId,
          itemId: firstItem.itemId,
          expectedAttachmentRevision: 1,
        },
      });
      expect(requestResponse.statusCode).toBe(201);
      const receipt = requestResponse.json() as { approvalId: string; disposition: string; status: string };
      expect(receipt.disposition).toBe("created");
      expect(receipt.status).toBe("pending");
      expect(receipt.approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
      expect(requestResponse.body).not.toContain(SYNTHETIC_TRANSCRIPT_TEXT);

      const resolveResponse = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${encodeURIComponent(receipt.approvalId)}/resolve`,
        headers: mutationHeaders("closure-approve-1"),
        payload: { decision: "approve" },
      });
      expect(resolveResponse.statusCode).toBe(200);

      // The approval-resolution effects worker executes the recovered C2 apply;
      // the Journey read surface is the operator-visible completion evidence.
      const snapshotEvent = await pollForJourneyAction(app, "knowledge_snapshot_lifecycle", "snapshot_created");
      expect(snapshotEvent).toMatchObject({
        action: "snapshot_created",
        approvalId: receipt.approvalId,
      });
      const attachEvent = await pollForJourneyAction(app, "external_session_import", "attached_read_only");
      expect(attachEvent).toMatchObject({ action: "attached_read_only" });

      // --- Detach stays available and CAS-exact after the knowledge copy ---
      const detachResponse = await app.inject({
        method: "DELETE",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/external-source-attachments/${encodeURIComponent(attach.attachment.attachmentId)}`,
        headers: mutationHeaders("closure-detach-1"),
        payload: {
          workspaceId: "default",
          sessionId,
          attachmentId: attach.attachment.attachmentId,
          expectedRevision: 1,
          expectedSessionIncarnationId: sessionIncarnationId,
        },
      });
      expect(detachResponse.statusCode).toBe(200);
      expect(detachResponse.json()).toMatchObject({ disposition: "detached" });

      const staleIncarnation = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/external-source-attachments`,
        headers: mutationHeaders("closure-attach-stale-1"),
        payload: { ...attachBody, itemId: applied.items[1]!.itemId, expectedSessionIncarnationId: "incarnation-stale" },
      });
      expect(staleIncarnation.statusCode).toBe(409);
      expect(staleIncarnation.json()).toMatchObject({ code: "session_incarnation_stale" });
    } finally {
      await app.close();
    }
  });
});

interface JourneyTimelineItem {
  action?: string;
  approvalId?: string;
  [key: string]: unknown;
}

async function pollForJourneyAction(
  app: Awaited<ReturnType<typeof buildApp>>,
  eventType: string,
  action: string,
): Promise<JourneyTimelineItem> {
  const deadline = Date.now() + 60_000;
  let lastBody = "";
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/journey/events?workspaceId=default&eventTypes=${encodeURIComponent(eventType)}`,
      headers: operatorHeaders(),
    });
    if (response.statusCode === 200) {
      lastBody = response.body;
      expect(response.body).not.toContain(SYNTHETIC_TRANSCRIPT_TEXT);
      const payload = response.json() as { items?: JourneyTimelineItem[] };
      const match = (payload.items ?? []).find((item) => item.action === action);
      if (match) return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Journey ${eventType}/${action} evidence did not appear in time. Last body: ${lastBody.slice(0, 800)}`,
  );
}

function configureGateway(providerBaseUrl: string): string {
  const root = createIsolatedConfigRoot(providerBaseUrl);
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.NODE_ENV = "test";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_ROOT_DIR = root;
  return root;
}

function createSyntheticCodexRoot(configRoot: string): string {
  const sourceRoot = path.resolve(configRoot, "workspace", "external-codex");
  const sessions = path.join(sourceRoot, "sessions", "2026", "07", "14");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, `rollout-2026-07-14T00-00-00-${SYNTHETIC_SESSION_ID}.jsonl`),
    SYNTHETIC_CODEX_ROLLOUT_JSONL,
    "utf8",
  );
  fs.writeFileSync(
    path.join(sessions, `rollout-2026-07-14T00-01-00-${SECOND_SESSION_ID}.jsonl`),
    SYNTHETIC_CODEX_ROLLOUT_JSONL.replaceAll(SYNTHETIC_SESSION_ID, SECOND_SESSION_ID),
    "utf8",
  );
  return sourceRoot;
}

function operatorHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

function mutationHeaders(idempotencyKey: string): Record<string, string> {
  return { ...operatorHeaders(), "idempotency-key": idempotencyKey };
}

function createIsolatedConfigRoot(providerBaseUrl: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-external-sources-closure-"));
  const repoRoot = findRepoRoot();
  fs.cpSync(path.join(repoRoot, "config"), path.join(root, "config"), { recursive: true });
  // Same hermetic provider wiring as turns.integration.test.ts: build the
  // unified config from the tracked example template (the runtime
  // config/goatcitadel.json is gitignored and synced at boot) and point the
  // active provider at the in-process fake so a real Chat send completes.
  const llmConfig = {
    activeProviderId: "fake-openai",
    activeModel: "fake-chat",
    providers: [
      {
        providerId: "fake-openai",
        label: "Fake OpenAI",
        baseUrl: providerBaseUrl,
        apiStyle: "openai-chat-completions",
        defaultModel: "fake-chat",
      },
    ],
  };
  const unifiedConfigPath = path.join(root, "config", "goatcitadel.json");
  const baseConfigPath = path.join(root, "config", "goatcitadel.example.json");
  const unifiedConfig = JSON.parse(fs.readFileSync(baseConfigPath, "utf8")) as Record<string, unknown>;
  unifiedConfig.llm = llmConfig;
  fs.writeFileSync(unifiedConfigPath, `${JSON.stringify(unifiedConfig, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(root, "config", "llm-providers.json"), `${JSON.stringify(llmConfig, null, 2)}\n`, "utf8");
  // Routed context freezes a token budget from TRUSTED model metadata; give the
  // fake provider a context window so the frozen route passes the budget gate.
  const metadataPath = path.join(root, "config", "llm-model-metadata.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { entries: Record<string, unknown> };
  metadata.entries["fake-openai/fake-chat"] = {
    contextWindow: 128_000,
    outputTokenLimit: 16_000,
    reasoning: { supportedEfforts: ["low", "medium", "high"] },
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  tempRoots.push(root);
  return root;
}

function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, "config", "goatcitadel.example.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Unable to locate GoatCitadel repository root.");
    current = parent;
  }
}
