import type { ChatSessionWorkbenchTreeResponse } from "@goatcitadel/contracts";
import { Tree } from "react-arborist";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

interface WorkbenchFileTreeNode {
  id: string;
  path: string;
  name: string;
  kind: "file" | "directory";
  changed: boolean;
  children?: WorkbenchFileTreeNode[];
}

interface WorkbenchFileTreeProps {
  storageScopeKey: string;
  items: ChatSessionWorkbenchTreeResponse["items"];
  selectedPath?: string;
  expandedPaths: string[];
  onExpandedPathsChange: (nextPaths: string[]) => void;
  onSelectFile: (path: string) => void;
}

function buildWorkbenchTreeNodes(items: ChatSessionWorkbenchTreeResponse["items"]): WorkbenchFileTreeNode[] {
  const root: WorkbenchFileTreeNode[] = [];
  const stack: Array<{ depth: number; node: WorkbenchFileTreeNode }> = [];

  for (const item of items) {
    const node: WorkbenchFileTreeNode = {
      id: item.path,
      path: item.path,
      name: item.name,
      kind: item.kind,
      changed: item.changed,
      children: item.kind === "directory" ? [] : undefined,
    };

    while (stack.length > 0 && stack.at(-1)!.depth >= item.depth) {
      stack.pop();
    }

    const parent = stack.at(-1)?.node;
    if (parent?.children) {
      parent.children.push(node);
    } else {
      root.push(node);
    }

    if (item.kind === "directory") {
      stack.push({ depth: item.depth, node });
    }
  }

  return root;
}

function toOpenState(paths: string[]): Record<string, boolean> {
  return Object.fromEntries(paths.map((path) => [path, true]));
}

function nextExpandedPaths(current: string[], path: string): string[] {
  return current.includes(path)
    ? current.filter((item) => item !== path)
    : [...current, path].sort((left, right) => left.localeCompare(right));
}

function shouldRenderArborist(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (import.meta.env.MODE !== "test") {
    return true;
  }
  return Boolean(
    (globalThis as typeof globalThis & { __GOATCITADEL_TEST_ARBORIST_TREE?: boolean }).__GOATCITADEL_TEST_ARBORIST_TREE,
  );
}

export function WorkbenchFileTree({
  storageScopeKey,
  items,
  selectedPath,
  expandedPaths,
  onExpandedPathsChange,
  onSelectFile,
}: WorkbenchFileTreeProps) {
  const nodes = useMemo(() => buildWorkbenchTreeNodes(items), [items]);
  const [treeKey, setTreeKey] = useState(0);
  const treeHeight = Math.max(320, Math.min(680, Math.max(items.length, 8) * 30));

  useEffect(() => {
    setTreeKey((current) => current + 1);
  }, [storageScopeKey]);

  if (!shouldRenderArborist()) {
    return (
      <ul className="chat-code-workbench-tree" aria-label="Workbench file tree">
        {items
          .filter((item) => item.kind === "file")
          .map((item) => (
            <li key={item.path}>
              <button
                type="button"
                className={[
                  "gc-button",
                  "chat-code-workbench-tree-button",
                  selectedPath === item.path ? "active" : "",
                ].join(" ")}
                onClick={() => onSelectFile(item.path)}
              >
                <span>{item.name}</span>
                {item.changed ? <span className="token-chip">changed</span> : null}
              </button>
            </li>
          ))}
      </ul>
    );
  }

  return (
    <Tree<WorkbenchFileTreeNode>
      key={`${storageScopeKey}:${treeKey}`}
      data={nodes}
      width="100%"
      height={treeHeight}
      rowHeight={32}
      indent={18}
      selection={selectedPath}
      disableDrag
      disableMultiSelection
      initialOpenState={toOpenState(expandedPaths)}
      onToggle={(id) => onExpandedPathsChange(nextExpandedPaths(expandedPaths, id))}
      onActivate={(node) => {
        if (node.data.kind === "file") {
          onSelectFile(node.data.path);
        }
      }}
    >
      {({ node, style }) => (
        <button
          type="button"
          style={style as CSSProperties}
          className={[
            "chat-code-workbench-tree-node",
            node.data.kind === "directory" ? "directory" : "file",
            node.isSelected ? "selected" : "",
          ].join(" ")}
          onClick={(event) => {
            node.handleClick(event);
            if (node.data.kind === "directory") {
              node.toggle();
            }
          }}
        >
          <span className="chat-code-workbench-tree-node-label">
            {node.data.kind === "directory" ? (node.isOpen ? "▾" : "▸") : "•"} {node.data.name}
          </span>
          {node.data.changed ? <span className="token-chip">changed</span> : null}
        </button>
      )}
    </Tree>
  );
}
