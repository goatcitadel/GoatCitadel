import type { ChatPlanningMode } from "@goatcitadel/contracts";

export function ChatPlanningPill({
  planningMode,
  effectiveToolAutonomy,
}: {
  planningMode: ChatPlanningMode | undefined;
  effectiveToolAutonomy?: "safe_auto" | "manual";
}) {
  if (planningMode !== "advisory") {
    return null;
  }
  return (
    <span
      className="chat-v11-planning-pill"
      title={
        effectiveToolAutonomy === "manual"
          ? "Planning mode is advisory. This turn is in plan/spec mode and manual tool approval is enforced."
          : "Planning mode is advisory. Chat turns stay in plan/spec mode until you switch it off."
      }
    >
      {effectiveToolAutonomy === "manual" ? "Planning mode · manual tools" : "Planning mode"}
    </span>
  );
}
