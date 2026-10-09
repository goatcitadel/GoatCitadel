// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SystemOwnerLink } from "./SystemOwnerLink";
it("uses actual native health recovery owners, preserves unsupported runtime fallback and missing owner state", () => {
  const container = document.createElement("div"), root = createRoot(container);
  try {
    act(() => root.render(<><SystemOwnerLink href="/settings/local-ai#local-ai" scope="w">Review models</SystemOwnerLink><SystemOwnerLink href="/ops/runtime?workspaceId=w#backups" scope="w">Review backups</SystemOwnerLink><SystemOwnerLink href="/unknown" scope="w">Review unknown</SystemOwnerLink></>));
    const links = [...container.querySelectorAll("a")];
    expect(links[0]?.getAttribute("href")).toContain("/settings/local-ai");
    expect(links[0]?.getAttribute("href")).toContain("shell=cockpit");
    expect(links[1]?.getAttribute("href")).toContain("workspaceId=w");
    expect(links[1]?.getAttribute("href")).toContain("shell=classic");
    expect(links[1]?.getAttribute("href")).toContain("#backups");
    expect(container.textContent).toContain("Source owner unavailable");
  } finally { act(() => root.unmount()); }
});
