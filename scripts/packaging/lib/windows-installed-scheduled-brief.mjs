import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const timezone = "America/Los_Angeles";

export function verifyInstalledScheduledBrief({ api, restart, withNative }, fixture) {
  const { connectionId, topic, marker, sample, evidence, poll, readSubscriber } = fixture;
  const purpose = `Post the daily fixture brief ${marker}`;
  return withNative(async (page) => {
    const origin = new URL(page.url()).origin;
    const { sessionId } = await api("/api/v1/chat/sessions", "POST", { title: purpose, workspaceId: "default" });
    const chatRoute = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`;
    await page.goto(`${origin}/chat?shell=cockpit&sessionId=${encodeURIComponent(sessionId)}`);
    const button = (name, root = page) => root.getByRole("button", { name, exact: true });
    const settings = page.getByRole("group", { name: "Conversation execution settings" });
    await button("Inspect").click();
    await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    await settings.getByText("Memory, learning and follow-through", { exact: true }).click();
    await settings.getByText("Upcoming work and follow-ups", { exact: true }).click();
    await button("Set up follow-through", settings).click();
    const setup = page.getByRole("region", { name: "Set up follow-through" });
    await setup.getByLabel("Purpose", { exact: true }).fill(purpose);
    await setup.getByLabel("Reports to", { exact: true }).selectOption(connectionId);
    await setup.getByLabel("Frequency", { exact: true }).selectOption("daily");
    await setup.getByLabel("Timezone", { exact: true }).selectOption(timezone);
    await setup.getByLabel("Time", { exact: true }).fill("09:00");
    await button("Review follow-through", setup).click();
    await setup.getByText(`Every day at 09:00 ${timezone}`, { exact: true }).waitFor();
    await setup.getByText(`Protected runner ntfy · ${topic} · after every completed run`, { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, "scheduled-brief-review.png") });
    const [created] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === `${chatRoute}/follow-through/setup`,
      ),
      button("Create this follow-through", setup).click(),
    ]);
    assert.equal(created.status(), 201, "The reviewed native setup was rejected");
    const { jobId } = await created.json();
    assert.ok(jobId);
    const jobRoute = `/api/v1/cron/jobs/${encodeURIComponent(jobId)}`;
    const readJob = () => api(jobRoute);
    const job = await readJob();
    const { connectionRevision } = job.actionConfig.agentTurn.deliveryChannel;
    assert.ok(connectionRevision, "The reviewed destination did not retain its connection revision");
    const deliveryChannel = { channelKey: "ntfy", connectionId, connectionRevision, target: topic };
    assert.equal(job.schedule, `0 9 * * * ${timezone}`);
    assert.deepEqual(job.actionConfig.agentTurn.deliveryChannel, deliveryChannel);

    const workUrl = `${origin}/work/schedules?shell=cockpit&workspaceId=default&jobId=${encodeURIComponent(jobId)}`;
    await page.goto(workUrl);
    const editor = page.getByRole("region", { name: "Edit schedule" });
    const due = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 180_000);
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).format(due);
    await editor.getByLabel("Time", { exact: true }).fill(time);
    await button("Review schedule changes", editor).click();
    await button("Save schedule changes", page.getByRole("dialog")).click();
    const changed = await poll(async () => {
      const current = await readJob();
      return current.revision > job.revision && current;
    }, "the installed schedule edit to persist");
    assert.equal(changed.nextRunAt, due.toISOString());
    assert.deepEqual(changed.actionConfig.agentTurn.deliveryChannel, deliveryChannel);
    await restart();
    assert.ok(Date.now() < due.getTime(), "The Gateway did not restart before the scheduled occurrence");
    assert.equal((await readJob()).nextRunAt, due.toISOString());

    const readOccurrence = (runId) => api(`/api/v1/cron/runs/${encodeURIComponent(runId)}`);
    const waitForReceipt = async (previousRunId, trigger, deadline) => {
      const approvals = new Set();
      const run = await poll(
        async () => {
          const { items } = await api("/api/v1/approvals?status=pending");
          for (const item of items) {
            if (
              item.payload?.connectionId !== connectionId ||
              item.payload?.target !== topic ||
              item.payload?.message !== sample ||
              approvals.has(item.approvalId)
            )
              continue;
            const route = `/api/v1/approvals/${encodeURIComponent(item.approvalId)}`;
            assert.equal((await api(route)).preview?.toolName, "channel.send");
            await api(`${route}/resolve`, "POST", {
              decision: "approve",
              resolutionNote: "Synthetic scheduled brief for the runner topic",
            });
            approvals.add(item.approvalId);
          }
          const current = await readJob();
          if (!current.lastRunStatus || !current.lastRunId || current.lastRunId === previousRunId) return undefined;
          const occurrence = await readOccurrence(current.lastRunId);
          assert.equal(occurrence.canonical?.status, "completed", JSON.stringify(occurrence.failure));
          return occurrence;
        },
        `the ${trigger} scheduled-brief occurrence to settle`,
        deadline,
      );
      assert.equal(run.jobId, jobId);
      assert.equal(run.canonical.trigger, trigger);
      const outcome = JSON.parse(run.output);
      const receipt = (await readSubscriber()).find((item) => item.id === outcome.providerMessageId);
      assert.equal(receipt?.message, sample, "The independent ntfy subscriber did not see the canonical receipt");
      assert.ok(outcome.deliveryId);
      return {
        runId: run.runId,
        scheduledFor: run.canonical.scheduledFor,
        deliveryId: outcome.deliveryId,
        providerMessageId: receipt.id,
      };
    };
    const scheduled = await waitForReceipt(job.lastRunId, "scheduled_due", 330_000);
    assert.equal(scheduled.scheduledFor, due.toISOString());
    await page.goto(workUrl);
    await button("Run now").click();
    await button("Run schedule now", page.getByRole("dialog")).click();
    const manual = await waitForReceipt(scheduled.runId, "manual", 120_000);
    assert.notEqual(manual.providerMessageId, scheduled.providerMessageId);
    await button("Pause").click();
    await button("Pause schedule", page.getByRole("dialog")).click();
    await poll(async () => !(await readJob()).enabled, "the installed schedule to pause");
    await button("Run now").click();
    const [pausedRun] = await Promise.all([
      page.waitForResponse(
        (response) => response.request().method() === "POST" && new URL(response.url()).pathname === `${jobRoute}/run`,
      ),
      button("Run schedule now", page.getByRole("dialog")).click(),
    ]);
    assert.equal(pausedRun.status(), 400);
    assert.match((await pausedRun.json()).error, /paused/i);
    await page.goto(workUrl);
    // Cross a due minute while paused and verify no recurring occurrence was admitted.
    await editor.getByLabel("Frequency", { exact: true }).selectOption("custom");
    await editor.getByLabel("Schedule expression", { exact: true }).fill("* * * * *");
    const beforePauseEdit = await readJob();
    await button("Review schedule changes", editor).click();
    await button("Save schedule changes", page.getByRole("dialog")).click();
    await poll(async () => (await readJob()).revision > beforePauseEdit.revision, "the edited paused schedule");
    await delay(75_000);
    const paused = await readJob();
    assert.equal(paused.enabled, false);
    assert.equal(paused.lastRunId, manual.runId);
    assert.equal(paused.activeRunId, undefined);
    await page.screenshot({ path: path.join(evidence, "scheduled-brief-paused.png") });
    return {
      jobId,
      reviewedSchedule: job.schedule,
      deliveryChannel,
      restartedBeforeDue: true,
      scheduled,
      manual,
      pausedWithoutNewRun: true,
    };
  });
}
