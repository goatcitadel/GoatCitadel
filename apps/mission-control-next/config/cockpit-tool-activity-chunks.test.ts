import { expect, it } from "vitest";
import { createCockpitOutputChunkSelector } from "../vite.config";

const suffixes = [
  "/apps/mission-control-next/src/cockpit/areas/chat/ChatToolActivityBody.tsx",
  "/apps/mission-control-next/src/cockpit/areas/chat/ChatToolApprovalLine.tsx",
  "/packages/mission-control-shared/dist/components/chat/chat-tool-diff.js",
  "/apps/mission-control-next/src/cockpit/areas/chat/code-mode-request-copy.ts",
  "/apps/mission-control-next/src/cockpit/ui/RecordedErrorDetails.tsx",
  "/apps/mission-control-next/src/cockpit/areas/chat/chat-tool-run-change-stats.ts",
  "/apps/mission-control-next/src/cockpit/areas/chat/chat-tool-run-groups.ts",
  "/apps/mission-control-next/src/cockpit/areas/chat/ChatToolRunSummary.tsx",
];
const program = () => ({ type: "Program", body: [] });
function fixture() {
  const root = "C:/repo/src/cockpit-entry.tsx";
  const owners = suffixes.map((suffix) => "C:/repo" + suffix);
  const modules = new Map<string, { isIncluded: boolean | null; importedIds: string[]; ast?: unknown }>([
    [root, { isIncluded: true, importedIds: [], ast: program() }],
    ...owners.map(
      (id, index) =>
        [
          id,
          {
            isIncluded: true,
            importedIds:
              index === 0 ? owners.slice(1).filter((owner) => owner !== owners[2]) : index === 5 ? [owners[2]!] : [],
            ast: program(),
          },
        ] as const,
    ),
  ]);
  return {
    root,
    owners,
    modules,
    graph: { getModuleIds: () => modules.keys(), getModuleInfo: (id: string) => modules.get(id) ?? null },
  };
}

it("loads the observed tool-activity body and its small static helpers in one on-demand request", () => {
  const f = fixture(),
    select = createCockpitOutputChunkSelector();
  for (const owner of f.owners) expect(select(owner, f.graph)).toBe("ChatToolActivityBody");
  expect(select(f.root, f.graph)).toBe("cockpit-entry");
});

it("recognizes the same shared diff owner when the build resolves source instead of dist", () => {
  const f = fixture(),
    old = f.owners[2]!,
    source = old.replace("/dist/", "/src/").replace(/\.js$/u, ".ts");
  const info = f.modules.get(old)!;
  f.modules.delete(old);
  f.modules.set(source, info);
  f.owners[2] = source;
  f.modules.get(f.owners[5]!)!.importedIds = [source];
  const select = createCockpitOutputChunkSelector();
  for (const owner of f.owners) expect(select(owner, f.graph)).toBe("ChatToolActivityBody");
});

it.each(["missing", "unknown", "ast", "unrelated", "cold"])(
  "keeps automatic placement when the activity ownership is %s",
  (kind) => {
    const f = fixture(),
      owner = f.owners[1]!;
    if (kind === "missing") f.modules.delete(owner);
    if (kind === "unknown") f.modules.get(owner)!.isIncluded = null;
    if (kind === "ast") delete f.modules.get(owner)!.ast;
    if (kind === "unrelated") f.modules.get(f.owners[0]!)!.importedIds = [];
    if (kind === "cold") f.modules.get(f.root)!.importedIds = [owner];
    const select = createCockpitOutputChunkSelector();
    for (const candidate of f.owners) expect(select(candidate, f.graph)).not.toBe("ChatToolActivityBody");
  },
);
