import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  briefInstructions,
  briefSkillName,
  gradeBriefPair,
  gradeWeeklyBrief,
  weeklyBriefCases,
} from "../../verification/lib/assistant-parity/weekly-brief-pilot.mjs";

const workspaceId = "default";
const captureMarker = "WORKFLOW_SKILL_CAPTURE_V1 ";
const syntheticSource =
  "Write a weekly project brief. Status: build passed. Risk: missing approval. Next: Jess checks approval on Friday.";

export async function installedSkillCapture(runtime, fixture) {
  const { api, send, waitForTurn, restart, withNative } = runtime;
  const { poll, evidence, model, modelDigest, serverVersion } = fixture;
  const take = (page, name) => page.screenshot({ path: path.join(evidence, `skill-${name}.png`) });
  const receiptFor = (chat, turn, scope = workspaceId) =>
    api(
      `${chat.route}/turns/${encodeURIComponent(turn.turnId)}/learning-receipt?workspaceId=${encodeURIComponent(scope)}`,
    );
  const isCallable = async (runtimeSkillId, scope = workspaceId) => {
    const catalog = await api(`/api/v1/capabilities/catalog?scope=callable&workspaceId=${encodeURIComponent(scope)}`);
    return catalog.items.some((entry) => entry.skillId === runtimeSkillId && entry.callable);
  };
  async function applyReviewedPlan(plan, candidateRoute, versionId, expectedState) {
    const planRoute = `/api/v1/change-plans/${encodeURIComponent(plan.planId)}`;
    assert.equal(plan.origin.workspaceId, workspaceId);
    const context = {
      workspaceId,
      ...(plan.origin.sessionId && { sessionId: plan.origin.sessionId }),
      ...(plan.origin.turnId && { turnId: plan.origin.turnId }),
    };
    const respond = ({ revision, requiredAction }) =>
      api(`${planRoute}/responses`, "POST", {
        ...context,
        expectedRevision: revision,
        actionId: requiredAction.actionId,
        actionNonce: requiredAction.actionNonce,
        values: {},
      });
    const read = () => api(`${planRoute}?${new URLSearchParams(context)}`);
    const review = await read();
    assert.equal(review.requiredAction?.kind, "artifact_review");
    assert.equal(review.request.versionId, versionId);
    assert.equal(review.target?.resourceId, decodeURIComponent(candidateRoute.split("/").at(-1)));
    const confirm = await respond(review);
    assert.equal(confirm.status, "awaiting_confirmation");
    const waiting = await api(`${planRoute}/confirmations`, "POST", {
      ...context,
      expectedRevision: confirm.revision,
      actionNonce: confirm.requiredAction.actionNonce,
    });
    assert.equal(waiting.status, "awaiting_approval");
    assert.equal(waiting.approvalRefs.length, 1);
    const approvalRoute = `/api/v1/approvals/${encodeURIComponent(waiting.approvalRefs[0])}`;
    const approval = await api(`${approvalRoute}?workspaceId=${workspaceId}`);
    assert.equal(approval.kind, "capability.lifecycle");
    assert.equal(approval.status, "pending");
    await api(`${approvalRoute}/resolve`, "POST", { decision: "approve" });
    await poll(
      async () =>
        (await api(candidateRoute)).versions.some(
          (version) => version.versionId === versionId && version.lifecycleState === expectedState,
        ),
      `the reviewed skill version to become ${expectedState}`,
      30_000,
    );
    assert.equal((await respond(waiting)).status, "completed");
    return { planId: plan.planId, approvalId: approval.approvalId };
  }

  const approved = await withNative(async (page) => {
    const press = (name, root = page) => root.getByRole("button", { name, exact: true });
    let stage = "complete the source workflow";
    const rejectedRequests = [];
    page.on("response", async (response) => {
      const route = new URL(response.url()).pathname;
      if (response.status() < 400 || !/\/(route-preflight|agent-send|skill-captures)\b/u.test(route)) return;
      const reply = await response.json().catch(() => ({}));
      rejectedRequests.push({ status: response.status(), route, error: reply.error });
    });
    try {
      const chat = await send("Weekly project brief capture", syntheticSource, page);
      const sourceTurn = await waitForTurn(chat, "completed");
      const sourceArticle = page.locator(`[data-turn-id="${sourceTurn.turnId}"]`);
      stage = "open and prepare skill capture";
      await press("More message actions", sourceArticle).click();
      await page.getByRole("menuitem", { name: "Save as skill…", exact: true }).click();
      const summary = sourceArticle.locator("summary").filter({ hasText: /^Save as skill$/ });
      await summary.waitFor();
      await poll(
        () => summary.evaluate((element) => document.activeElement === element),
        "focus on skill capture review",
        10_000,
      );
      await sourceArticle
        .getByLabel(/What should the skill preserve/)
        .fill(
          "Use Status, Risks and Next steps headings. Keep the owner and date. Omit canceled work such as the logo redesign.",
        );
      const [prepared] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname.endsWith("/skill-captures/prepare"),
        ),
        press("Prepare skill draft", sourceArticle).click(),
      ]);
      assert.equal(prepared.status(), 200);
      const { prompt } = await prepared.json();
      assert.ok(prompt.startsWith(captureMarker));
      await page.getByRole("region", { name: "Review captured workflow" }).waitFor();
      stage = "generate, review, and stage the draft";
      await press("Send").click();
      const draft = await waitForTurn({ ...chat, content: prompt }, "completed");
      assert.equal(draft.assistantMessage?.content.trim(), briefInstructions.trim());
      const draftArticle = page.locator(`[data-turn-id="${draft.turnId}"]`);
      const reviewDraft = draftArticle.getByText("Review skill draft", { exact: true });
      await reviewDraft.click();
      await reviewDraft.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await take(page, "draft-review");
      const [staged] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname.endsWith("/skill-captures/stage"),
        ),
        press("Save reviewed candidate", draftArticle).click(),
      ]);
      assert.equal(staged.status(), 200);
      const capture = await staged.json();
      assert.equal(capture.activationPerformed, false);
      assert.equal(capture.behavioralValidation, "not_run");
      const candidateRoute = `/api/v1/capabilities/candidates/${encodeURIComponent(capture.candidateId)}`;
      const runtimeSkillId = `extra:reviewed-${createHash("sha256").update(capture.candidateId).digest("hex").slice(0, 12)}`;
      assert.equal(await isCallable(runtimeSkillId), false);
      const artifactReview = await api(
        `${candidateRoute}/versions/${encodeURIComponent(capture.versionId)}/review?workspaceId=${workspaceId}`,
      );
      assert.ok(JSON.stringify(artifactReview).includes(briefSkillName));
      stage = "review and approve the exact candidate version";
      const [planResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/change-plans",
        ),
        press("Review activation", draftArticle).click(),
      ]);
      assert.ok(planResponse.ok());
      const plan = await planResponse.json();
      const activation = await applyReviewedPlan(plan, candidateRoute, capture.versionId, "approved");
      assert.equal(await isCallable(runtimeSkillId), true);
      stage = "display the applied version in fresh Chat";
      const fresh = await send("Use the reviewed skill", `Write a ${briefSkillName}. ${syntheticSource}`, page);
      const freshTurn = await waitForTurn(fresh, "completed");
      const used = await poll(
        async () => {
          const receipt = await receiptFor(fresh, freshTurn);
          return receipt.usedSources.find(
            (source) => source.ref === runtimeSkillId && source.skillVersion?.versionId === capture.versionId,
          );
        },
        "the exact approved skill version on a successful dispatch",
        30_000,
      );
      const learning = page.getByText("Memory and learning", { exact: true }).last();
      await learning.click();
      await page.getByText(/^Included in this turn/).click();
      await page.getByRole("link", { name: used.skillVersion.name, exact: true }).waitFor();
      assert.equal(
        await page.getByRole("link", { name: used.skillVersion.name, exact: true }).getAttribute("href"),
        used.href,
      );
      await take(page, "applied-version");
      await page.getByRole("link", { name: used.skillVersion.name, exact: true }).click();
      await page.waitForURL((url) => url.pathname.startsWith("/library/candidate_skill/"));
      return {
        capture,
        candidateRoute,
        runtimeSkillId,
        activation,
        sourceTurnId: sourceTurn.turnId,
        draftTurnId: draft.turnId,
        appliedTurnId: freshTurn.turnId,
        appliedSessionId: fresh.id,
        appliedVersion: used.skillVersion,
      };
    } catch (error) {
      await take(page, "failure").catch(() => undefined);
      const diagnostic = rejectedRequests.length ? ` ${JSON.stringify(rejectedRequests.at(-1))}` : "";
      throw new Error(`${stage}: ${error.message}${diagnostic}`, { cause: error });
    }
  });
  await writeFile(path.join(evidence, "skill-capture-native.json"), JSON.stringify(approved, null, 2));

  async function compareSkillReuse() {
    const control = await api("/api/v1/workspaces", "POST", { name: "Weekly brief untrained control" });
    assert.ok(control.workspaceId && control.workspaceId !== workspaceId);
    assert.equal(await isCallable(approved.runtimeSkillId, control.workspaceId), false);
    async function runArm(task, condition) {
      const scope = condition === "enabled" ? workspaceId : control.workspaceId;
      const prompt = `$${approved.runtimeSkillId}\nWrite a weekly project brief using these notes only.\n\n${task.input}`;
      try {
        const chat = await send(`Held-out brief ${task.id} ${condition}`, prompt, undefined, {
          providerId: "ollama",
          model,
          workspaceId: scope,
        });
        const turn = await waitForTurn(chat, "completed");
        assert.equal(turn.trace.model, model);
        const usageRoute = `/api/v1/ops/workspaces/${encodeURIComponent(scope)}/model-usage?sessionId=${encodeURIComponent(chat.id)}&turnId=${encodeURIComponent(turn.turnId)}`;
        const dispatch = await poll(
          async () =>
            (await api(usageRoute)).items.find(
              (event) =>
                event.effectiveProviderId === "ollama" &&
                event.dispatchedModelId === model &&
                event.transportStatus === "accepted" &&
                event.terminalOutcome === "succeeded",
            ),
          "confirmation that the pinned Ollama model produced a response",
          15_000,
        );
        const readSkill = async () => (await receiptFor(chat, turn, scope)).usedSources.find(
          (source) => source.ref === approved.runtimeSkillId,
        );
        const usedSkill = condition === "enabled"
          ? await poll(async () => {
            const source = await readSkill();
            return source?.skillVersion && source;
          }, `the applied skill receipt for ${task.id}`, 15_000).catch(() => readSkill())
          : await readSkill();
        const answer = turn.assistantMessage?.content ?? "";
        return {
          status: "completed",
          score: gradeWeeklyBrief(answer, task),
          answer,
          modelUsageEventId: dispatch.eventId,
          skillApplied: Boolean(usedSkill),
          versionId: usedSkill?.skillVersion?.versionId,
          turnId: turn.turnId,
          toolCalls: turn.toolRuns?.map((tool) => tool.toolName) ?? [],
          userCorrections: 0,
        };
      } catch (error) {
        return { status: "unverified", error: error.message };
      }
    }
    const pairs = [];
    for (const [index, task] of weeklyBriefCases.entries()) {
      const order = index % 2 === 0 ? ["disabled", "enabled"] : ["enabled", "disabled"];
      const outcomes = {};
      for (const condition of order) {
        outcomes[condition] = await runArm(task, condition);
      }
      const valid = outcomes.disabled.status === "completed" && outcomes.enabled.status === "completed"
        && !outcomes.disabled.skillApplied && outcomes.enabled.versionId === approved.capture.versionId;
      pairs.push({
        id: task.id,
        notes: task.input,
        order,
        valid,
        ...outcomes,
        ...(valid && gradeBriefPair(outcomes.disabled.score, outcomes.enabled.score)),
      });
      await writeFile(path.join(evidence, "skill-reuse-progress.json"), JSON.stringify({ pairs }, null, 2));
    }
    const validPairs = pairs.filter((pair) => pair.valid);
    const improved = validPairs.filter((pair) => pair.improved).length;
    const regressions = validPairs.filter((pair) => pair.regression).length;
    const benchmark = {
      provider: "ollama",
      serverVersion,
      model,
      modelDigest,
      validPairs: validPairs.length,
      improved,
      regressions,
      gatePassed: validPairs.length === weeklyBriefCases.length && improved >= 4 && regressions === 0,
      pairs,
    };
    await writeFile(path.join(evidence, "skill-reuse-benchmark.json"), JSON.stringify(benchmark, null, 2));
    return benchmark;
  }

  const benchmark = fixture.lifecycleOnly ? undefined : await compareSkillReuse();
  const detail = await api(approved.candidateRoute);
  const requested = await api(`${approved.candidateRoute}/revoke`, "POST", {
    expectedRevision: detail.revision,
    versionId: approved.capture.versionId,
  });
  const revocation = await applyReviewedPlan(
    requested.changePlan,
    approved.candidateRoute,
    approved.capture.versionId,
    "revoked",
  );
  await restart();
  assert.equal(await isCallable(approved.runtimeSkillId), false);
  const priorReceipt = await receiptFor(
    { route: `/api/v1/chat/sessions/${encodeURIComponent(approved.appliedSessionId)}` },
    { turnId: approved.appliedTurnId },
  );
  assert.equal(
    priorReceipt.usedSources.find((source) => source.ref === approved.runtimeSkillId)?.skillVersion?.versionId,
    approved.capture.versionId,
    "Revocation changed the version shown on a historical turn",
  );
  const fresh = await send("Revoked skill stays absent", `Write a ${briefSkillName}. ${syntheticSource}`);
  const freshTurn = await waitForTurn(fresh, "completed");
  assert.ok(!(await receiptFor(fresh, freshTurn)).usedSources.some((source) => source.ref === approved.runtimeSkillId));
  return {
    ...approved,
    revocation,
    revokedAfterRestartTurnId: freshTurn.turnId,
    benchmark,
  };
}
