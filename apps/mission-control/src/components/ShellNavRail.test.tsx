import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

vi.mock("./ui/badge", () => ({
  Badge: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

vi.mock("./ui/button", () => ({
  Button: ({
    children,
    className,
    ...props
  }: {
    children?: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <button type="button" className={className} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("./ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("./ui/separator", () => ({
  Separator: ({ className }: { className?: string }) => <hr className={className} />,
}));

import { ShellNavRail } from "./ShellNavRail";

describe("ShellNavRail", () => {
  it("hides section labels in icon mode", () => {
    const markup = renderToStaticMarkup(
      <ShellNavRail
        route={{ space: "operate", page: "surface", surface: "chat" }}
        visiblePage="chat"
        navMode="icon"
        onSelectSpace={() => undefined}
        onSelectVisiblePage={() => undefined}
        onCycleNavMode={() => undefined}
      />,
    );

    expect(markup).not.toContain("Spaces");
    expect(markup).not.toContain("Modes");
    expect(markup).not.toContain("Queue");
    expect(markup).not.toContain("Operator rail");
  });
});
