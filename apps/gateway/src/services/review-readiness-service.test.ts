import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TaskActivityCreateInput,
  TaskCreateInput,
  TaskDeliverableCreateInput,
  TaskRecord,
  TaskUpdateInput,
} from "@goatcitadel/contracts";
import { ReviewReadinessService } from "./review-readiness-service.js";

describe("ReviewReadinessService", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports review findings idempotently into task records", () => {
    const tasks: TaskRecord[] = [];
    const activities: TaskActivityCreateInput[] = [];
    const deliverables: TaskDeliverableCreateInput[] = [];
    const service = new ReviewReadinessService({
      rootDir: process.cwd(),
      taskLifecycleService: {
        listTasks: vi.fn(() => tasks),
        createTask: vi.fn((input: TaskCreateInput) => {
          const task: TaskRecord = {
            taskId: `task-${tasks.length + 1}`,
            workspaceId: input.workspaceId,
            title: input.title,
            description: input.description,
            status: input.status ?? "inbox",
            priority: input.priority ?? "normal",
            createdBy: input.createdBy,
            createdAt: "2026-05-27T00:00:00.000Z",
            updatedAt: "2026-05-27T00:00:00.000Z",
          };
          tasks.push(task);
          return task;
        }),
        updateTask: vi.fn((taskId: string, input: TaskUpdateInput) => {
          const task = tasks.find((candidate) => candidate.taskId === taskId);
          if (!task) throw new Error("missing task");
          Object.assign(task, input);
          return task;
        }),
        appendTaskActivity: vi.fn((_taskId: string, input: TaskActivityCreateInput) => {
          activities.push(input);
          return {
            activityId: `activity-${activities.length}`,
            taskId: _taskId,
            activityType: input.activityType,
            message: input.message,
            metadata: input.metadata,
            createdAt: "2026-05-27T00:00:00.000Z",
          };
        }),
        appendTaskDeliverable: vi.fn((_taskId: string, input: TaskDeliverableCreateInput) => {
          deliverables.push(input);
          return {
            deliverableId: `deliverable-${deliverables.length}`,
            taskId: _taskId,
            deliverableType: input.deliverableType,
            title: input.title,
            path: input.path,
            description: input.description,
            createdAt: "2026-05-27T00:00:00.000Z",
          };
        }),
      },
    });

    const first = service.importFindings({
      actorId: "reviewer",
      findings: [
        {
          source: "external-review",
          component: "skills",
          title: "Missing catalog proof",
          files: ["skills/bundled/coding/SKILL.md"],
          priority: "high",
          evidenceRef: "artifact:review-1",
        },
      ],
    });
    const second = service.importFindings({
      actorId: "reviewer",
      findings: [
        {
          source: "external-review",
          component: "skills",
          title: "Missing catalog proof",
          files: ["skills/bundled/coding/SKILL.md"],
          priority: "urgent",
          evidenceRef: "artifact:review-1",
        },
      ],
    });

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.updated).toHaveLength(1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "review", priority: "urgent", createdBy: "review-readiness" });
    expect(activities.map((activity) => activity.activityType)).toEqual(["diagnostic", "diagnostic"]);
    expect(deliverables).toHaveLength(2);
  });

  it("recognizes skill catalog proof nested inside the fast verification manifest", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-review-readiness-"));
    tempDirs.push(rootDir);
    const artifactDir = path.join(rootDir, "artifacts", "verification", "2026-05-27T00-00-00Z-fast");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactDir, "manifest.json"),
      JSON.stringify({
        lane: "fast",
        status: "passed",
        scenarios: [{ id: "fast.skills-catalog", title: "Skill catalog coverage", status: "passed" }],
      }),
    );
    const service = new ReviewReadinessService({
      rootDir,
      taskLifecycleService: {
        listTasks: vi.fn(() => []),
        createTask: vi.fn(),
        updateTask: vi.fn(),
        appendTaskActivity: vi.fn(),
        appendTaskDeliverable: vi.fn(),
      } as never,
    });

    const readiness = service.getReadiness();
    expect(readiness.lanes.find((lane) => lane.lane === "skills-catalog")).toMatchObject({
      status: "current",
      artifactRef: path.join("artifacts", "verification", "2026-05-27T00-00-00Z-fast"),
    });
  });
});
