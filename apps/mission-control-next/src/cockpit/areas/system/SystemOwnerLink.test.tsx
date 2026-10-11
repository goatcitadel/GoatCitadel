// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SystemOwnerLink } from "./SystemOwnerLink";
import { CLASSIC_RUNTIME_INSPECT_PATH } from "./health-overview";
it("uses actual native owners, keeps the explicit Classic runtime fallback and the missing owner state", () => {
  const container = document.createElement("div"), root = createRoot(container);
  try {
    act(() => root.render(<><SystemOwnerLink href="/settings/local-ai#local-ai" scope="w">Review models</SystemOwnerLink><SystemOwnerLink href="/ops/runtime?workspaceId=w" scope="w">Review runtime</SystemOwnerLink><SystemOwnerLink href={`${CLASSIC_RUNTIME_INSPECT_PATH}&workspaceId=w#backups`} scope="w">Review backups</SystemOwnerLink><SystemOwnerLink href="/unknown" scope="w">Review unknown</SystemOwnerLink></>));
    const links = [...container.querySelectorAll("a")];
    expect(links[0]?.getAttribute("href")).toContain("/settings/local-ai");
    expect(links[0]?.getAttribute("href")).toContain("shell=cockpit");
    // `/ops/runtime` lands on System › Health natively now.
    expect(links[1]?.getAttribute("href")).toBe("/system?workspaceId=w&shell=cockpit");
    expect(links[1]?.textContent).toBe("Review runtime");
    // Detailed runtime controls and backup records still visit Classic when the link names it explicitly,
    // instead of pointing the Health page back at itself.
    expect(links[2]?.getAttribute("href")).toContain("/ops/runtime");
    expect(links[2]?.getAttribute("href")).toContain("workspaceId=w");
    expect(links[2]?.getAttribute("href")).toContain("shell=classic");
    expect(links[2]?.getAttribute("href")).toContain("#backups");
    expect(links[2]?.getAttribute("aria-label")).toBe("Review backups in Classic");
    expect(container.textContent).toContain("Source owner unavailable");
  } finally { act(() => root.unmount()); }
});
