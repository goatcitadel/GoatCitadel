import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression coverage for CODEX_FINDING #15: the GET /api/v1/llm/config
// endpoint previously returned `provider.request` (Authorization headers,
// inline tokens, proxy auth) which device and companion bearer tokens
// could read. Two fixes apply:
//   1. `llm-service.ts:scrubProviderRequestSecrets` strips secret-bearing
//      fields before serialization (already verified by
//      llm-service.export-config.security.test.ts).
//   2. `route-access.ts` ROUTE_ACCESS_POLICIES gates the entire
//      `/api/v1/llm` prefix at operator level via the global
//      `installRouteAccessTracking` preHandler. `hasOperatorControlPlaneAccess`
//      rejects `device` and `companion` actor sources, so non-operator
//      bearers receive 403 before reaching the handler.
//
// This test pins both the policy entry and the operator-only check so a
// future refactor cannot silently relax either.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readSource(relative: string): string {
  return readFileSync(path.resolve(__dirname, relative), "utf8");
}

describe("/api/v1/llm route access (codex #15)", () => {
  it("declares the /api/v1/llm prefix as operator-only in ROUTE_ACCESS_POLICIES", () => {
    const source = readSource("./route-access.ts");
    expect(source).toMatch(/\{\s*prefix:\s*"\/api\/v1\/llm",\s*accessClass:\s*"operator"\s*\}/);
  });

  it("restricts hasOperatorControlPlaneAccess to token/basic/loopback (rejects device + companion)", () => {
    const auth = readSource("../plugins/auth.ts");
    // The function must NOT include "device" or "companion" in its accept list.
    const match = auth.match(/function hasOperatorControlPlaneAccess[\s\S]{0,600}?\}/);
    expect(match, "hasOperatorControlPlaneAccess not found in auth.ts").not.toBeNull();
    const body = match?.[0] ?? "";
    expect(body).toMatch(/"token"|'token'/);
    expect(body).toMatch(/"basic"|'basic'/);
    // The accept list explicitly does NOT include device or companion.
    expect(body).not.toMatch(/source === ['"]device['"]/);
    expect(body).not.toMatch(/source === ['"]companion['"]/);
  });

  it("installs the route-access tracking preHandler in app bootstrap", () => {
    const appSource = readSource("../app.ts");
    expect(appSource).toContain("installRouteAccessTracking(app);");
  });
});
