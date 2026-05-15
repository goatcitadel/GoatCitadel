import { describe, expect, it, vi } from "vitest";
import { TasksRouteService, type TasksRoutePort } from "./tasks-route-service.js";

describe("TasksRouteService", () => {
  it("delegates every task facade method with the original arguments", () => {
    const port = buildTaskPort();
    const service = new TasksRouteService(port);

    expect(service.listTasks(10, "in_progress", "cursor-1", "active", "workspace-1")).toEqual({
      delegated: "listTasks",
    });
    expect(service.createTask({ title: "Ship coverage", workspaceId: "workspace-1" })).toEqual({
      delegated: "createTask",
    });
    expect(service.getTask("task-1")).toEqual({ delegated: "getTask" });
    expect(service.listAgenticRuns({ workspaceId: "workspace-1", limit: 5 })).toEqual({
      delegated: "listAgenticRuns",
    });
    expect(service.getAgenticRunTree("run-1")).toEqual({ delegated: "getAgenticRunTree" });
    expect(service.invokeAgenticControl("run-1", { action: "pause" })).toEqual({
      delegated: "invokeAgenticControl",
    });
    expect(service.appendTaskDiagnostic("task-1", { code: "proof", severity: "info" })).toEqual({
      delegated: "appendTaskDiagnostic",
    });
    expect(service.updateTask("task-1", { status: "completed" })).toEqual({ delegated: "updateTask" });
    expect(service.softDeleteTask("task-1", "operator", "cleanup")).toEqual({ delegated: "softDeleteTask" });
    expect(service.hardDeleteTask("task-1")).toEqual({ delegated: "hardDeleteTask" });
    expect(service.restoreTask("task-1")).toEqual({ delegated: "restoreTask" });
    expect(service.listTaskActivities("task-1")).toEqual({ delegated: "listTaskActivities" });
    expect(service.appendTaskActivity("task-1", { activityType: "comment", message: "done" })).toEqual({
      delegated: "appendTaskActivity",
    });
    expect(service.listTaskDeliverables("task-1")).toEqual({ delegated: "listTaskDeliverables" });
    expect(service.appendTaskDeliverable("task-1", { deliverableType: "file", title: "Proof" })).toEqual({
      delegated: "appendTaskDeliverable",
    });
    expect(service.listTaskSubagents("task-1")).toEqual({ delegated: "listTaskSubagents" });
    expect(service.registerTaskSubagent("task-1", { agentSessionId: "agent-1" })).toEqual({
      delegated: "registerTaskSubagent",
    });
    expect(service.updateTaskSubagent("agent-1", { status: "completed" })).toEqual({
      delegated: "updateTaskSubagent",
    });

    expect(port.listTasks).toHaveBeenCalledWith(10, "in_progress", "cursor-1", "active", "workspace-1");
    expect(port.createTask).toHaveBeenCalledWith({ title: "Ship coverage", workspaceId: "workspace-1" });
    expect(port.getTask).toHaveBeenCalledWith("task-1");
    expect(port.listAgenticRuns).toHaveBeenCalledWith({ workspaceId: "workspace-1", limit: 5 });
    expect(port.getAgenticRunTree).toHaveBeenCalledWith("run-1");
    expect(port.invokeAgenticControl).toHaveBeenCalledWith("run-1", { action: "pause" });
    expect(port.appendTaskDiagnostic).toHaveBeenCalledWith("task-1", { code: "proof", severity: "info" });
    expect(port.updateTask).toHaveBeenCalledWith("task-1", { status: "completed" });
    expect(port.softDeleteTask).toHaveBeenCalledWith("task-1", "operator", "cleanup");
    expect(port.hardDeleteTask).toHaveBeenCalledWith("task-1");
    expect(port.restoreTask).toHaveBeenCalledWith("task-1");
    expect(port.listTaskActivities).toHaveBeenCalledWith("task-1");
    expect(port.appendTaskActivity).toHaveBeenCalledWith("task-1", { activityType: "comment", message: "done" });
    expect(port.listTaskDeliverables).toHaveBeenCalledWith("task-1");
    expect(port.appendTaskDeliverable).toHaveBeenCalledWith("task-1", { deliverableType: "file", title: "Proof" });
    expect(port.listTaskSubagents).toHaveBeenCalledWith("task-1");
    expect(port.registerTaskSubagent).toHaveBeenCalledWith("task-1", { agentSessionId: "agent-1" });
    expect(port.updateTaskSubagent).toHaveBeenCalledWith("agent-1", { status: "completed" });
  });
});

function buildTaskPort(): TasksRoutePort {
  return {
    appendTaskActivity: vi.fn(() => ({ delegated: "appendTaskActivity" })),
    appendTaskDeliverable: vi.fn(() => ({ delegated: "appendTaskDeliverable" })),
    appendTaskDiagnostic: vi.fn(() => ({ delegated: "appendTaskDiagnostic" })),
    createTask: vi.fn(() => ({ delegated: "createTask" })),
    getAgenticRunTree: vi.fn(() => ({ delegated: "getAgenticRunTree" })),
    getTask: vi.fn(() => ({ delegated: "getTask" })),
    hardDeleteTask: vi.fn(() => ({ delegated: "hardDeleteTask" })),
    invokeAgenticControl: vi.fn(() => ({ delegated: "invokeAgenticControl" })),
    listAgenticRuns: vi.fn(() => ({ delegated: "listAgenticRuns" })),
    listTaskActivities: vi.fn(() => ({ delegated: "listTaskActivities" })),
    listTaskDeliverables: vi.fn(() => ({ delegated: "listTaskDeliverables" })),
    listTaskSubagents: vi.fn(() => ({ delegated: "listTaskSubagents" })),
    listTasks: vi.fn(() => ({ delegated: "listTasks" })),
    registerTaskSubagent: vi.fn(() => ({ delegated: "registerTaskSubagent" })),
    restoreTask: vi.fn(() => ({ delegated: "restoreTask" })),
    softDeleteTask: vi.fn(() => ({ delegated: "softDeleteTask" })),
    updateTask: vi.fn(() => ({ delegated: "updateTask" })),
    updateTaskSubagent: vi.fn(() => ({ delegated: "updateTaskSubagent" })),
  } as unknown as TasksRoutePort;
}
