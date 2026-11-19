import { describe, expect, it } from "vitest";
import { createPracticeSession } from "./practice-fixture.js";

const base = "http://127.0.0.1:8787/api/v1";
const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

describe("first-run tutorial fixture", () => {
  it.each(["approve", "reject"] as const)("settles %s once and clears the session", async (decision) => {
    const practice = createPracticeSession("http://127.0.0.1:8787");
    const send = base + "/chat/sessions/" + practice.sessionId + "/agent-send";
    const endpoint = decision === "approve" ? send + "/stream" : send;
    const resolve = base + "/approvals/" + practice.approvalId + "/resolve";
    expect((await practice.transport.fetch(endpoint, json({ content: "My private message" }))).status).toBe(422);
    const response = await practice.transport.fetch(endpoint, json({ content: practice.prompt }));
    expect(response.ok).toBe(true);
    if (decision === "reject") {
      expect(await response.json()).toMatchObject({
        userMessage: { content: practice.prompt },
        trace: { pendingApprovalSummary: { approvalId: practice.approvalId } },
      });
    }
    expect((await practice.transport.fetch(send + "/stream", json({ content: practice.prompt }))).status).toBe(409);
    expect((await practice.transport.fetch(base + "/chat/tool-grants", json({ duration: "8h" }))).ok).toBe(false);
    expect(practice.sample.decision).toBeNull();
    expect((await practice.transport.fetch(resolve, json({ decision }))).ok).toBe(true);
    expect((await practice.transport.fetch(resolve, json({ decision }))).status).toBe(409);
    const result = await (await practice.transport.fetch(base + "/chat/generated-artifacts")).json();
    expect(result.items[0].title).toBe(decision === "approve" ? "Offsite checklist" : "Example offsite checklist");
    practice.dispose();
    practice.dispose();
    expect(practice.sample.sent).toBe(false);
    expect((await practice.transport.fetch(base + "/inbox")).status).toBe(410);
  });
});
