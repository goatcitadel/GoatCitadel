import assert from "node:assert/strict";

const GRANTS = "/api/v1/capabilities/autonomy-grants";
const CONTEXTS = [
  ["chat", "Chat"],
  ["tools", "Direct tools"],
  ["mcp", "MCP"],
  ["cowork", "Legacy Cowork compatibility"],
  ["code", "Legacy Code compatibility"],
];

export function assertInertAutonomousGrant({ request, receipt, owner, prior, catalog }) {
  assert.deepEqual(receipt, owner, "Independent grant read did not match the owner receipt.");
  assert.ok(receipt.grantId && !prior.some((item) => item.grantId === receipt.grantId));
  assert.equal(receipt.status, "active");
  assert.deepEqual(request.surfaces, ["tools"]);
  assert.deepEqual(request.activationKinds, ["capability"]);
  assert.equal(request.maxRiskLevel, "safe");
  assert.equal(request.maxActivations, 1);
  assert.equal(request.budgetUsd, 0);
  assert.equal(request.toolPatterns.length, 1);
  assert.match(request.toolPatterns[0], /^verification\.inert-permission-tool\.[a-z0-9-]+$/);
  assert.equal(request.capabilityPatterns.length, 1);
  assert.match(request.capabilityPatterns[0], /^verification\.inert-permission-grant\.[a-z0-9-]+$/);
  assert.equal(
    catalog.some((item) => item.capabilityId === request.capabilityPatterns[0]),
    false,
  );
  assert.equal(
    catalog.some((item) => item.toolName === request.toolPatterns[0]),
    false,
  );
  for (const [key, value] of Object.entries(request)) assert.deepEqual(receipt[key], value, `Grant ${key} changed.`);
  assert.equal(receipt.usedActivations, 0);
  assert.equal(receipt.usedBudgetUsd, 0);
  assert.ok(receipt.workspaceId && receipt.workspaceId !== "*");
  assert.ok(Number.isFinite(Date.parse(receipt.createdAt)));
  assert.equal(receipt.updatedAt, receipt.createdAt);
  assert.ok(Date.parse(receipt.expiresAt) > Date.parse(receipt.createdAt));
}

export function assertAutonomousGrantRevocation({ before, request, receipt, owner }) {
  assert.deepEqual(request, { revokedBy: "operator", reason: "Revoked from Settings." });
  assert.deepEqual(receipt, owner, "Independent revoked grant read did not match the receipt.");
  assert.equal(receipt.status, "revoked");
  assert.equal(receipt.revokedBy, request.revokedBy);
  assert.equal(receipt.revocationReason, request.reason);
  assert.equal(receipt.updatedAt, receipt.revokedAt);
  assert.ok(Number.isFinite(Date.parse(receipt.revokedAt)));
  const policy = ({
    status: _status,
    updatedAt: _updated,
    revokedAt: _revoked,
    revokedBy: _actor,
    revocationReason: _reason,
    ...value
  }) => value;
  assert.deepEqual(policy(receipt), policy(before), "Revocation changed grant scope/policy/usage.");
  assert.equal(receipt.usedActivations, 0, "The fixture must not activate a capability.");
  assert.equal(receipt.usedBudgetUsd, 0);
}

export async function inspectPermissionContexts({ page, api, workspaceId, writes, capture }) {
  const full = page.getByRole("region", { name: "Chat permission profile", exact: true });
  const contextChoice = full.getByRole("combobox", { name: "Selection policy context", exact: true });
  await contextChoice.waitFor();
  assert.deepEqual(await contextChoice.locator("option").evaluateAll((nodes) => nodes.map((node) => node.value)), [
    "chat",
    "tools",
    "mcp",
    "all",
    "cowork",
    "code",
  ]);
  const count = writes.length;
  for (const context of ["tools", "mcp", "all", "cowork", "code", "chat"]) await contextChoice.selectOption(context);
  const evidence = full.getByRole("region", { name: "Effective policy contexts", exact: true });
  await evidence.getByText("Legacy compatibility policy contexts", { exact: true }).click();
  const snapshot = {};
  for (const [surface, label] of CONTEXTS) {
    const owner = await api(
      `/api/v1/tools/permission-profiles/effective?workspaceId=${encodeURIComponent(workspaceId)}&surface=${surface}`,
    );
    snapshot[surface] = owner;
    const row = evidence.getByRole("listitem").filter({ has: page.getByRole("heading", { name: label, exact: true }) });
    const id = owner.permissionProfileId ?? owner.permissionProfile?.profileId;
    const name = owner.permissionProfileLabel ?? owner.permissionProfile?.label;
    assert.ok(id && name, `${surface} effective owner omitted its profile binding.`);
    assert.ok((await row.innerText()).includes(`Profile: ${name}`));
    await row.getByText("Profile identity", { exact: true }).click();
    assert.ok((await row.innerText()).includes(id));
  }
  assert.match(await evidence.innerText(), /do not govern current Chat/);
  assert.equal(writes.length, count, "Inspecting context choices changed runtime policy.");
  await capture("effective-contexts", evidence);
  return snapshot;
}

/** Create only an inert, exact nonexistent capability pattern in the disposable workspace; never execute it. */
export async function revokeDisposableAutonomousGrant({ page, api, workspaceId, suffix, writes, capture, replyFor }) {
  const read = async () => (await api(`${GRANTS}?includeExpired=true`)).items;
  const prior = await read();
  const catalog = (await api("/api/v1/capabilities/catalog?scope=inspectable")).items;
  const request = {
    workspaceId,
    surfaces: ["tools"],
    maxRiskLevel: "safe",
    capabilityPatterns: [`verification.inert-permission-grant.${suffix}`],
    toolPatterns: [`verification.inert-permission-tool.${suffix}`],
    activationKinds: ["capability"],
    maxActivations: 1,
    budgetUsd: 0,
    grantor: "verification",
    reason: `Inert permission revocation ${suffix}`,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  assert.ok(Array.isArray(catalog));
  assert.equal(
    catalog.some((item) => item.capabilityId === request.capabilityPatterns[0]),
    false,
  );
  let created;
  try {
    created = await api(GRANTS, { method: "POST", body: request });
    assertInertAutonomousGrant({
      request,
      receipt: created,
      owner: (await read()).find((item) => item.grantId === created.grantId),
      prior,
      catalog,
    });
    const region = page.getByRole("region", { name: "Autonomous activation grants", exact: true });
    await region.getByRole("button", { name: "Refresh autonomous grants", exact: true }).click();
    const row = region
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: request.reason, exact: true }) });
    const review = row.getByRole("button", { name: `Review revocation of ${created.grantId}`, exact: true });
    await review.click();
    const dialog = page.getByRole("dialog", { name: "Revoke autonomous activation grant?", exact: true });
    await dialog.waitFor();
    for (const text of [created.grantId, workspaceId, request.capabilityPatterns[0], request.expiresAt])
      assert.ok((await dialog.innerText()).includes(text), `Revocation review omitted ${text}.`);
    assert.match(await dialog.innerText(), /no atomic revision precondition/);
    assert.match(await dialog.innerText(), /does not prove already-running work stopped/);
    await capture("autonomous-grant-review", dialog);
    const before = writes.length;
    await dialog.getByRole("button", { name: "Keep autonomous grant", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(writes.length, before);
    assert.deepEqual(
      (await read()).find((item) => item.grantId === created.grantId),
      created,
    );
    await review.click();
    await dialog.waitFor();
    const path = `${GRANTS}/${created.grantId}/revoke`;
    const result = await replyFor("POST", path, () =>
      dialog.getByRole("button", { name: "Revoke reviewed autonomous grant", exact: true }).click(),
    );
    const final = await read();
    assertAutonomousGrantRevocation({
      before: created,
      ...result,
      owner: final.find((item) => item.grantId === created.grantId),
    });
    await row
      .getByText("The Gateway confirmed this grant is revoked. Already-running work may continue.", { exact: true })
      .waitFor();
    assert.equal(await review.isDisabled(), true);
    for (const item of prior)
      assert.deepEqual(
        final.find((candidate) => candidate.grantId === item.grantId),
        item,
      );
    await capture("autonomous-grant-revoked", row);
    return { pathname: path, grantId: created.grantId };
  } finally {
    // Dispose only this scenario's exact grant if a browser assertion failed before revocation.
    if (created?.grantId && (await read()).find((item) => item.grantId === created.grantId)?.status === "active")
      await api(`${GRANTS}/${created.grantId}/revoke`, {
        method: "POST",
        body: { revokedBy: "verification", reason: "End disposable browser proof." },
      });
  }
}
