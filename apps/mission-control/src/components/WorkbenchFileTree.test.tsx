import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchFileTree, buildWorkbenchTreeNodes, nextExpandedPaths, toOpenState } from "./WorkbenchFileTree";

vi.mock("react-arborist", () => ({
  Tree: ({ children, data, onActivate, onToggle }: any) => (
    <div data-testid="mock-tree">
      {data.map((node: any) => (
        <div key={node.id}>
          <button type="button" onClick={() => onToggle(node.id)}>
            toggle {node.name}
          </button>
          <button type="button" onClick={() => onActivate({ data: node })}>
            activate {node.name}
          </button>
          {children({
            node: {
              data: node,
              handleClick: vi.fn(),
              isOpen: node.path === "src",
              isSelected: node.path === "README.md",
              toggle: vi.fn(),
            },
            style: { paddingLeft: 4 },
          })}
        </div>
      ))}
    </div>
  ),
}));

const treeItems = [
  {
    path: "src",
    name: "src",
    kind: "directory",
    changed: false,
    depth: 0,
  },
  {
    path: "src/pages",
    name: "pages",
    kind: "directory",
    changed: true,
    depth: 1,
  },
  {
    path: "src/pages/App.tsx",
    name: "App.tsx",
    kind: "file",
    changed: true,
    depth: 2,
  },
  {
    path: "README.md",
    name: "README.md",
    kind: "file",
    changed: false,
    depth: 0,
  },
] as const;

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function instanceText(node: ReactTestInstance | string | number): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return node.children.map((child) => instanceText(child as ReactTestInstance | string | number)).join(" ");
}

describe("WorkbenchFileTree", () => {
  it("builds nested nodes and derives deterministic expanded path state", () => {
    const nodes = buildWorkbenchTreeNodes(treeItems as never);

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      path: "src",
      kind: "directory",
      children: [
        {
          path: "src/pages",
          kind: "directory",
          children: [{ path: "src/pages/App.tsx", kind: "file" }],
        },
      ],
    });
    expect(toOpenState(["src/pages", "src"])).toEqual({
      src: true,
      "src/pages": true,
    });
    expect(nextExpandedPaths(["src"], "src/pages")).toEqual(["src", "src/pages"]);
    expect(nextExpandedPaths(["src", "src/pages"], "src")).toEqual(["src/pages"]);
  });

  it("activates files in the Vitest fallback tree without exposing directories as file targets", () => {
    const onSelectFile = vi.fn();
    const renderer = create(
      <WorkbenchFileTree
        storageScopeKey="session-1"
        items={treeItems as never}
        selectedPath="src/pages/App.tsx"
        expandedPaths={["src"]}
        onExpandedPathsChange={vi.fn()}
        onSelectFile={onSelectFile}
      />,
    );

    expect(collectText(renderer.toJSON())).toContain("App.tsx");
    expect(collectText(renderer.toJSON())).toContain("README.md");
    expect(collectText(renderer.toJSON())).not.toContain("src pages");

    const appButton = renderer.root.findAllByType("button").find((button) => instanceText(button).includes("App.tsx"));
    expect(appButton).toBeDefined();

    act(() => {
      appButton?.props.onClick();
    });

    expect(onSelectFile).toHaveBeenCalledWith("src/pages/App.tsx");
  });

  it("wires the Arborist tree branch for production rendering", () => {
    const onSelectFile = vi.fn();
    const onExpandedPathsChange = vi.fn();
    const renderer = create(
      <WorkbenchFileTree
        unstableForceArboristForTest
        storageScopeKey="session-1"
        items={treeItems.map((item) => (item.path === "README.md" ? { ...item, changed: true } : item)) as never}
        selectedPath="README.md"
        expandedPaths={["src"]}
        onExpandedPathsChange={onExpandedPathsChange}
        onSelectFile={onSelectFile}
      />,
    );

    const buttons = renderer.root.findAllByType("button");
    const srcRow = buttons.find((button) => instanceText(button).includes("src"));
    expect(srcRow).toBeDefined();

    act(() => {
      srcRow?.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    });
    expect(onSelectFile).not.toHaveBeenCalledWith("src");
    expect(onExpandedPathsChange).not.toHaveBeenCalledWith(["src"]);

    const readmeActivate = buttons.find((button) =>
      instanceText(button).replace(/\s+/g, " ").includes("activate README.md"),
    );
    act(() => {
      readmeActivate?.props.onClick();
    });
    expect(onSelectFile).toHaveBeenCalledWith("README.md");

    const readmeRow = buttons.find((button) =>
      instanceText(button).replace(/\s+/g, " ").includes("• README.md changed"),
    );
    act(() => {
      readmeRow?.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    });

    const text = collectText(renderer.toJSON()).replace(/\s+/g, " ");
    expect(text).toContain("▾ src");
    expect(text).toContain("changed");
  });
});
