import { expect, it } from "vitest";
import { defaultToolGrantExpiry } from "../../../features/native-routes/settings/helpers/permission-helpers";
it("new grant expiry defaults to one hour", () => {
  const start = Date.now();
  expect(Date.parse(defaultToolGrantExpiry()) - start).toBeGreaterThanOrEqual(3_599_000);
  expect(Date.parse(defaultToolGrantExpiry()) - start).toBeLessThanOrEqual(3_601_000);
});
