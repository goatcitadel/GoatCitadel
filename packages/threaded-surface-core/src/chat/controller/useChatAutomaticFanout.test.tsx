import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it } from "vitest";
import { useChatAutomaticFanout } from "./useChatAutomaticFanout";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("requires effective runtime availability and an exact current project grant before offering automatic fanout", async () => {
  const input = {
    workspaceId: "workspace-1",
    threadController: { selectedSession: { projectId: "project-1" } },
    sessionData: {
      settings: { chatFeatureAvailability: { automaticFanout: false } },
      projects: { items: [{ projectId: "project-1", workspaceId: "workspace-1", lifecycleStatus: "active" }] },
    },
    activationGrants: {
      autonomousActivationGrants: [
        {
          status: "active",
          workspaceId: "workspace-1",
          projectId: "project-1",
          activationKinds: ["subagent_fanout"],
          surfaces: ["chat"],
          maxRiskLevel: "caution",
          maxActivations: 3,
          usedActivations: 0,
          budgetUsd: 0.75,
          usedBudgetUsd: 0,
          expiresAt: "2099-01-01T00:00:00Z",
        },
      ],
    },
  };
  let value: ReturnType<typeof useChatAutomaticFanout>;
  function Harness() {
    value = useChatAutomaticFanout(input as Parameters<typeof useChatAutomaticFanout>[0]);
    return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(value!.automaticFanout.enabled).toBe(false);
  input.sessionData.settings = { chatFeatureAvailability: { automaticFanout: true } };
  await act(async () => renderer!.update(<Harness />));
  expect(value!.automaticFanout.enabled).toBe(true);
  input.activationGrants.autonomousActivationGrants = [
    { ...input.activationGrants.autonomousActivationGrants[0]!, projectId: "another-project" },
  ];
  await act(async () => renderer!.update(<Harness />));
  expect(value!.automaticFanout.enabled).toBe(false);
  input.activationGrants.autonomousActivationGrants = [
    { ...input.activationGrants.autonomousActivationGrants[0]!, projectId: "project-1", usedActivations: 3 },
  ];
  await act(async () => renderer!.update(<Harness />));
  expect(value!.automaticFanout.enabled).toBe(false);
  expect(value!.automaticFanout.unavailableReason).toContain("quota");
  await act(async () => renderer!.unmount());
});
