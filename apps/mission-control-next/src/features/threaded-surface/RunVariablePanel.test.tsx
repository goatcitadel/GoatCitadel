import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps, PropsWithChildren } from "react";
import { RUN_VARIABLE_SCHEMA_VERSION } from "@goatcitadel/contracts";

vi.mock("@goatcitadel/mission-control-shared/components/ui", () => ({
  Dialog: ({ children }: PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  DialogDescription: ({ children, ...props }: ComponentProps<"p">) => <p {...props}>{children}</p>,
  DialogFooter: ({ children, ...props }: ComponentProps<"footer">) => <footer {...props}>{children}</footer>,
  DialogHeader: ({ children, ...props }: ComponentProps<"header">) => <header {...props}>{children}</header>,
  DialogTitle: ({ children, ...props }: ComponentProps<"h2">) => <h2 {...props}>{children}</h2>,
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type={props.type ?? "button"} {...props} />
  ),
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { RunVariablePanel } from "./RunVariablePanel";

function collectText(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : collectText(child))).join(" ");
}

describe("RunVariablePanel", () => {
  it("renders typed accessible controls and applies only the reviewed preview", () => {
    const onValueChange = vi.fn();
    const onApply = vi.fn();
    const renderer: ReactTestRenderer = create(
      <RunVariablePanel
        panel={{
          open: true,
          title: "Launch brief",
          schema: {
            version: RUN_VARIABLE_SCHEMA_VERSION,
            fields: [
              { id: "topic", label: "Topic", type: "multiline", required: true },
              { id: "count", label: "Count", type: "number", minimum: 1, maximum: 5 },
              { id: "public", label: "Public", type: "boolean" },
              {
                id: "format",
                label: "Format",
                type: "select",
                options: [{ value: "brief", label: "Brief" }],
              },
            ],
          },
          values: { topic: "lease recovery", count: 2, public: false, format: "brief" },
          preview: "Explain lease recovery in a brief format.",
          error: null,
          onValueChange,
          onApply,
          onClose: vi.fn(),
        }}
      />,
    );
    expect(collectText(renderer.root)).toContain("Resolved prompt preview");
    expect(collectText(renderer.root)).toContain("Explain lease recovery in a brief format.");
    expect(renderer.root.findAllByType("textarea")).toHaveLength(1);
    expect(renderer.root.findAllByType("select")).toHaveLength(1);
    renderer.root.findByProps({ type: "checkbox" }).props.onChange({ currentTarget: { checked: true } });
    renderer.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    expect(onValueChange).toHaveBeenCalledWith("public", true);
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});
