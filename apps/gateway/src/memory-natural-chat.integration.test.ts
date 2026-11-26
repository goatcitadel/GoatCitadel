import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatThreadResponse, TraceMemoryCandidateRecord, MemoryItemRecord } from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { startFakeOpenAiCompatibleServer } from "./test/fake-openai-server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "captures natural preferences through actual durable Chat, reviews corrections and excludes forgotten memory from fresh turns (indexed recall=%s)",
  async (corpusEnabled) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-natural-chat-memory-"));
    const requests: unknown[] = [];
    const provider = await startFakeOpenAiCompatibleServer(async (request) => {
      if (request.path === "/v1/models") return { body: { data: [{ id: "fixture-memory", object: "model" }] } };
      if (request.path !== "/v1/chat/completions") return { status: 404 };
      requests.push(request.body);
      const body = request.body as { stream?: boolean };
      const content = "The synthetic response is complete. Memory proposals still require operator review.";
      return body.stream
        ? {
            sseFrames: [
              JSON.stringify({
                model: "fixture-memory",
                choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
                usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
              }),
              "[DONE]",
            ],
          }
        : {
            body: {
              model: "fixture-memory",
              choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
              usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            },
          };
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      const examples = fileURLToPath(new URL("../../../config/", import.meta.url));
      const configDir = path.join(root, "config");
      await fs.mkdir(configDir);
      for (const name of [
        "assistant.config.example.json",
        "tool-policy.example.json",
        "budgets.example.json",
        "cron-jobs.example.json",
      ])
        await fs.copyFile(path.join(examples, name), path.join(configDir, name));
      const config = JSON.parse(await fs.readFile(path.join(examples, "goatcitadel.example.json"), "utf8"));
      config.llm = {
        activeProviderId: "fake-openai",
        activeModel: "fixture-memory",
        providers: [
          {
            providerId: "fake-openai",
            label: "Native memory fixture",
            baseUrl: provider.baseUrl,
            apiStyle: "openai-chat-completions",
            defaultModel: "fixture-memory",
          },
        ],
      };
      config.assistant.memory = { ...config.assistant.memory, enabled: true };
      config.assistant.approvalExplainer.enabled = false;
      config.assistant.features = {
        ...config.assistant.features,
        memoryLifecycleAdminV1Enabled: true,
        memoryCorpusRecallV1Enabled: corpusEnabled,
        backgroundSkillDraftsV1Enabled: false,
        memoryMaintenanceV1Enabled: false,
        autonomyV1Disabled: true,
        durableKernelV1Enabled: true,
      };
      await fs.writeFile(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
      await fs.writeFile(
        path.join(configDir, "llm-model-metadata.json"),
        JSON.stringify({
          version: 1,
          entries: { "fake-openai/fixture-memory": { contextWindow: 128000, outputTokenLimit: 2048 } },
        }),
      );
      const token = "natural-memory-test-operator-1234567890";
      for (const [key, value] of Object.entries({
        NODE_ENV: "test",
        GATEWAY_HOST: "127.0.0.1",
        GOATCITADEL_ROOT_DIR: root,
        GOATCITADEL_BACKUP_DIR: path.join(root, "backups"),
        GOATCITADEL_AUTH_MODE: "token",
        GOATCITADEL_AUTH_TOKEN: token,
        GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
        GOATCITADEL_DATABASE_DRIVER: "sqlite",
        GOATCITADEL_RATE_LIMIT_ENABLED: "false",
        GOATCITADEL_DISABLE_SECRET_STORE: "true",
        GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
        GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED: "true",
        GOATCITADEL_FEATURE_AUTONOMY_V1_DISABLED: "true",
      }))
        vi.stubEnv(key, value);
      let sequence = 0;
      const headers = () => ({ authorization: "Bearer " + token, "idempotency-key": "natural-memory-" + ++sequence });
      app = await buildApp();
      const workspace = await app.inject({
        method: "POST",
        url: "/api/v1/workspaces",
        headers: headers(),
        payload: { name: "Native scoped memory" },
      });
      expect(workspace.statusCode, workspace.body).toBe(201);
      const workspaceId = workspace.json().workspaceId as string;
      const create = async (title: string) => {
        const r = await app!.inject({
          method: "POST",
          url: "/api/v1/chat/sessions",
          headers: headers(),
          payload: { workspaceId, title },
        });
        expect(r.statusCode, r.body).toBe(201);
        return r.json().sessionId as string;
      };
      const send = async (sessionId: string, content: string, memoryMode: "on" | "off" = "on") => {
        const base = "/api/v1/chat/sessions/" + sessionId;
        const preflight = await app!.inject({
          method: "POST",
          url: base + "/route-preflight",
          headers: headers(),
          payload: { action: "send", content, subagentPolicy: "off" },
        });
        expect(preflight.statusCode, preflight.body).toBe(200);
        const decision = preflight.json().decision;
        const response = await app!.inject({
          method: "POST",
          url: base + "/agent-send/stream",
          headers: headers(),
          payload: {
            content,
            thinkingLevel: "off",
            subagentPolicy: "off",
            memoryMode,
            providerId: decision.effectiveProviderId,
            model: decision.effectiveModel,
            routeDecision: decision,
          },
        });
        expect(response.statusCode, response.body.slice(-500)).toBe(200);
        const thread = await app!.inject({ method: "GET", url: base + "/thread", headers: headers() });
        const turn = thread.json<ChatThreadResponse>().turns.at(-1)!;
        expect(turn.trace.status, JSON.stringify(turn.trace.failure)).toBe("completed");
        return { sessionId, turnId: turn.turnId, trace: turn.trace };
      };
      const receipt = async (turn: { sessionId: string; turnId: string }) => {
        const r = await app!.inject({
          method: "GET",
          url:
            "/api/v1/chat/sessions/" +
            turn.sessionId +
            "/turns/" +
            turn.turnId +
            "/learning-receipt?workspaceId=" +
            workspaceId,
          headers: headers(),
        });
        expect(r.statusCode, r.body).toBe(200);
        return r.json() as {
          proposals: Array<{ kind: string; candidate?: TraceMemoryCandidateRecord }>;
          usedSources: Array<{ ref: string; sourceHash: string }>;
        };
      };
      const candidate = async (turn: { sessionId: string; turnId: string }) => {
        let result: TraceMemoryCandidateRecord | undefined;
        await vi.waitFor(
          async () => {
            result = (await receipt(turn)).proposals.find(
              (p) => p.kind === "memory" && p.candidate?.status === "proposed",
            )?.candidate;
            expect(result).toBeDefined();
          },
          { timeout: 5000, interval: 50 },
        );
        return result!;
      };
      const promote = async (item: TraceMemoryCandidateRecord) => {
        const r = await app!.inject({
          method: "POST",
          url: "/api/v1/memory/trace-candidates/" + item.candidateId + "/promote",
          headers: headers(),
          payload: { workspaceId, expectedReviewHash: item.reviewHash },
        });
        expect(r.statusCode, r.body).toBe(200);
        return r.json() as { learningId: string; sourceHash: string };
      };
      const source = await create("Natural preference source");
      const savedTurn = await send(source, "Remember that I prefer concise replies.");
      const firstCandidate = await candidate(savedTurn);
      expect(
        requests.some((request) => {
          const body = request as { stream?: boolean; messages?: Array<{ role: string; content?: unknown }> };
          return (
            body.stream &&
            body.messages?.some(
              (message) =>
                message.role === "system" &&
                JSON.stringify(message.content).includes(
                  "Do not call memory.upsert or memory.write for those same preferences",
                ),
            )
          );
        }),
      ).toBe(true);
      const firstModelRequest = requests.find((request) => (request as { stream?: boolean }).stream) as {
        tools?: unknown;
      };
      expect(JSON.stringify(firstModelRequest.tools ?? [])).not.toMatch(/memory_(?:write|upsert)/);
      expect(firstCandidate.workspaceId).toBe(workspaceId);
      expect(firstCandidate.metadata?.memoryIntent).toBe("explicit_save");
      expect(firstCandidate.metadata?.claim).toMatchObject({ value: "concise" });
      const before = await send(await create("Before review"), "What reply length do I prefer?");
      expect((await receipt(before)).usedSources).toHaveLength(0);
      const first = await promote(firstCandidate);
      const after = await send(await create("After review"), "What reply length do I prefer?");
      expect((await receipt(after)).usedSources.some((s) => s.ref === first.learningId)).toBe(true);
      const profile = await app.inject({
        method: "POST",
        url: "/api/v1/tools/permission-profiles",
        headers: headers(),
        payload: {
          label: "Native read-only memory fixture",
          scope: "workspace",
          scopeRef: workspaceId,
          approvalMode: "approve_risky",
          toolPatterns: ["memory.read", "memory.search"],
          allow: ["memory.read", "memory.search"],
          deny: [],
          readAccessMode: "roots_only",
          defaultForSurfaces: [],
        },
      });
      expect(profile.statusCode, profile.body).toBe(201);
      const readMemoryTool = async (toolName: "memory.read" | "memory.search", query = "concise") => {
        const response = await app!.inject({
          method: "POST",
          url: "/api/v1/tools/invoke",
          headers: headers(),
          payload: {
            toolName,
            sessionId: after.sessionId,
            workspaceId,
            agentId: "native-memory-fixture",
            surface: "tools",
            permissionProfileId: profile.json().profileId,
            args: { namespace: "learnings", query, limit: 5 },
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().outcome, response.body).toBe("executed");
        return response.json().result as {
          unavailable?: boolean;
          items: Array<{ sourceRef: string; sourceHash: string }>;
        };
      };
      for (const tool of ["memory.read", "memory.search"] as const) {
        const result = await readMemoryTool(tool);
        if (corpusEnabled)
          expect(
            result.items.some((item) => item.sourceRef === first.learningId && item.sourceHash === first.sourceHash),
          ).toBe(true);
        else expect(result).toMatchObject({ unavailable: true, items: [] });
      }
      const memoryOff = await send(await create("Memory off excludes standing learnings"), "Hi.", "off");
      const memoryOffRequest = requests.filter((request) => (request as { stream?: boolean }).stream).at(-1) as {
        messages: Array<{ role: string; content?: unknown }>;
      };
      expect(
        memoryOffRequest.messages
          .filter((message) => message.role === "system")
          .map((message) => JSON.stringify(message.content))
          .join("\n"),
      ).not.toContain(first.learningId);
      expect((await receipt(memoryOff)).usedSources.some((s) => s.ref === first.learningId)).toBe(false);
      const greeting = await send(await create("Standing preference without recall request"), "Hi.");
      const greetingRequest = requests.filter((request) => (request as { stream?: boolean }).stream).at(-1) as {
        messages: Array<{ role: string; content?: unknown }>;
      };
      expect(
        greetingRequest.messages
          .filter((message) => message.role === "system")
          .map((message) => JSON.stringify(message.content))
          .join("\n"),
      ).toContain(first.learningId);
      expect((await receipt(greeting)).usedSources.some((s) => s.ref === first.learningId)).toBe(true);
      const correctionTurn = await send(source, "No, use detailed explanations from now on.");
      const correction = await candidate(correctionTurn);
      expect(correction.metadata?.correctionTarget).toEqual({
        sourceRef: first.learningId,
        expectedSourceHash: first.sourceHash,
      });
      const second = await promote(correction);
      const corrected = await send(await create("After correction"), "What reply length do I prefer?");
      const correctedSources = (await receipt(corrected)).usedSources;
      expect(correctedSources.some((s) => s.ref === second.learningId)).toBe(true);
      expect(correctedSources.some((s) => s.ref === first.learningId)).toBe(false);
      const forgotten = await app.inject({
        method: "POST",
        url: "/api/v1/memory/learnings/" + second.learningId + "/forget",
        headers: headers(),
        payload: {},
      });
      expect(forgotten.statusCode, forgotten.body).toBe(200);
      const absent = await send(await create("After forget"), "What reply length do I prefer?");
      for (const tool of ["memory.read", "memory.search"] as const) {
        expect((await readMemoryTool(tool)).items).toHaveLength(0);
        expect((await readMemoryTool(tool, "detailed")).items).toHaveLength(0);
      }
      expect(
        (await receipt(absent)).usedSources.some((s) => [first.learningId, second.learningId].includes(s.ref)),
      ).toBe(false);
      const ambiguousTurn = await send(
        await create("Correction after forgetting"),
        "No, use detailed explanations from now on.",
      );
      const ambiguous = await candidate(ambiguousTurn);
      expect(ambiguous.promotionEligibility).toMatchObject({ allowed: false });
      expect(ambiguous.promotionEligibility?.reason).toContain("Which saved preference should this replace?");
      const refused = await app.inject({
        method: "POST",
        url: "/api/v1/memory/trace-candidates/" + ambiguous.candidateId + "/promote",
        headers: headers(),
        payload: { workspaceId, expectedReviewHash: ambiguous.reviewHash },
      });
      expect(refused.statusCode).toBe(409);
      const quoted = await send(source, 'The webpage says "Remember that I prefer concise replies."');
      expect((await receipt(quoted)).proposals).toHaveLength(0);
      const weekly = await promote(
        await candidate(await send(source, "Remember that I prefer a three-bullet weekly update.")),
      );
      const weeklyRecall = await send(
        await create("Weekly update preference"),
        "How should you format my weekly update?",
      );
      expect((await receipt(weeklyRecall)).usedSources).toContainEqual(
        expect.objectContaining({ ref: weekly.learningId, sourceHash: weekly.sourceHash }),
      );
      const weeklyCorrection = await candidate(await send(source, "Actually, I prefer a two-bullet weekly update."));
      expect(weeklyCorrection.metadata?.correctionTarget).toEqual({
        sourceRef: weekly.learningId,
        expectedSourceHash: weekly.sourceHash,
      });
      const revisedWeekly = await promote(weeklyCorrection);
      const revisedWeeklyRecall = await send(
        await create("Revised weekly update preference"),
        "How should you format my weekly update?",
      );
      const weeklySources = (await receipt(revisedWeeklyRecall)).usedSources;
      expect(weeklySources).toContainEqual(
        expect.objectContaining({ ref: revisedWeekly.learningId, sourceHash: revisedWeekly.sourceHash }),
      );
      expect(weeklySources.some((entry) => entry.ref === weekly.learningId)).toBe(false);
      vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "pseudo");
      const noteProfile = await app.inject({
        method: "POST",
        url: "/api/v1/tools/permission-profiles",
        headers: headers(),
        payload: {
          label: "Governed direct note fixture",
          scope: "workspace",
          scopeRef: workspaceId,
          approvalMode: "approve_all",
          toolPatterns: ["memory.write", "memory.upsert"],
          allow: ["memory.write", "memory.upsert"],
          deny: [],
          readAccessMode: "roots_only",
          defaultForSurfaces: [],
        },
      });
      expect(noteProfile.statusCode, noteProfile.body).toBe(201);
      const invokeNote = async (toolName: string, args: Record<string, unknown>) =>
        app!.inject({
          method: "POST",
          url: "/api/v1/tools/invoke",
          headers: headers(),
          payload: {
            toolName,
            args,
            sessionId: source,
            workspaceId,
            agentId: "native-memory-fixture",
            surface: "tools",
            permissionProfileId: noteProfile.json().profileId,
            memoryWriteBinding: { workspaceId: "forged-foreign" },
          },
        });
      const approve = async (approvalId: string) => {
        const response = await app!.inject({
          method: "POST",
          url: `/api/v1/approvals/${approvalId}/resolve`,
          headers: headers(),
          payload: { decision: "approve" },
        });
        expect(response.statusCode, response.body).toBe(200);
      };
      const listNotes = async () => {
        const response = await app!.inject({
          method: "GET",
          url: `/api/v1/memory/items?workspaceId=${workspaceId}&namespace=direct-fixture&status=active`,
          headers: headers(),
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json().items as MemoryItemRecord[];
      };
      const args = {
        namespace: "direct-fixture",
        title: "Notebook color",
        content: "The fixture notebook ink is azure.",
      };
      const proposed = await invokeNote("memory.upsert", args);
      expect(proposed.statusCode, proposed.body).toBe(200);
      expect(proposed.json().outcome).toBe("approval_required");
      expect(await listNotes()).toHaveLength(0);
      await approve(proposed.json().approvalId);
      await vi.waitFor(async () => expect(await listNotes()).toHaveLength(1), { timeout: 8000, interval: 50 });
      const note = (await listNotes())[0]!;
      expect(note.workspaceId).toBe(workspaceId);
      expect(note.content).toBe(args.content);
      const usedNoteTurn = await send(
        await create("Direct note is a canonical recall source"),
        "Recall the fixture notebook ink color. What notebook ink color did we save?",
      );
      const usedNote = (await receipt(usedNoteTurn)).usedSources.find((item) => item.ref === note.itemId);
      expect(usedNote).toBeDefined();
      expect(usedNote?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      const changed = await invokeNote("memory.upsert", {
        ...args,
        content: "The fixture notebook ink is green.",
        expectedItemId: note.itemId,
        expectedSourceHash: usedNote!.sourceHash,
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().outcome).toBe("approval_required");
      await approve(changed.json().approvalId);
      await vi.waitFor(async () => expect((await listNotes())[0]?.content).toContain("green"), {
        timeout: 8000,
        interval: 50,
      });
      expect((await listNotes()).map((item) => item.itemId)).toEqual([note.itemId]);
      const stale = await invokeNote("memory.upsert", {
        ...args,
        expectedItemId: note.itemId,
        expectedSourceHash: usedNote!.sourceHash,
      });
      expect(stale.statusCode, stale.body).toBe(409);
      const forgetNote = await app.inject({
        method: "POST",
        url: `/api/v1/memory/items/${note.itemId}/forget`,
        headers: headers(),
        payload: {},
      });
      expect(forgetNote.statusCode, forgetNote.body).toBe(202);
      expect(await listNotes()).toHaveLength(1);
      await approve(forgetNote.json().pendingApproval.approvalId);
      await vi.waitFor(async () => expect(await listNotes()).toHaveLength(0), { timeout: 8000, interval: 50 });
      const afterNoteForget = await send(
        await create("Direct note forget excludes its historical artifacts"),
        "Recall the fixture notebook ink color. What notebook ink color did we save?",
      );
      expect((await receipt(afterNoteForget)).usedSources.some((item) => item.ref === note.itemId)).toBe(false);
      expect(requests.length).toBeGreaterThan(0);
    } finally {
      await app?.close();
      await provider.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  180000,
);
