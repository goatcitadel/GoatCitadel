import { TechnicalDetails } from "../../ui/TechnicalDetails";
import type { CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";

export function CitadelAccessReview({
  snapshot,
  onAccept,
}: {
  snapshot: CitadelAccessSnapshot | null;
  onAccept: () => void;
}) {
  if (!snapshot)
    return (
      <p role="alert" className="text-sm text-status-waiting">
        Refresh to retrieve the current rules. Your draft is retained.
      </p>
    );
  const groups = [
    { label: "Council", items: snapshot.council.map((item) => item.agentId) },
    {
      label: "Wards",
      items: snapshot.wards.map((item) => `${item.name}: ${item.actionPattern} · ${humanizeToken(item.effect)}`),
    },
    {
      label: "Passages",
      items: snapshot.passages.map(
        (item) =>
          `${item.sourceChamberId ?? "All Chambers"} → ${item.destinationCitadelId}: ${item.allowedFields.join(", ") || "No fields"}; expires ${item.expiresAt ?? "never"}`,
      ),
    },
    { label: "Members", items: snapshot.members.map((item) => `${item.subjectId}: ${item.role}`) },
    {
      label: "Integration grants",
      items: snapshot.integrations.map(
        (item) =>
          `${item.provider} (${item.account ?? "Default account"}): ${item.mode} · ${item.capabilities.join(", ") || "No capabilities"}; expires ${item.expiresAt ?? "never"}`,
      ),
    },
  ];
  return (
    <section
      aria-label="Current Citadel access review"
      className="space-y-3 rounded-md border border-status-waiting/40 bg-sunken p-3 text-sm text-fg-secondary"
    >
      <h4 className="font-medium text-fg">Current access rules</h4>
      <p role="status">The reviewed rules changed. Inspect the current owner before retrying.</p>
      <p>
        {snapshot.structure.record?.name ?? snapshot.citadelId} ·{" "}
        {snapshot.structure.record?.lifecycleStatus ?? "No profile"}
      </p>
      <p>{snapshot.structure.charter?.purpose ?? "No Charter"}</p>
      <p>
        Policy:{" "}
        {snapshot.structure.charter
          ? `${humanizeToken(snapshot.structure.charter.riskPosture)} · ${humanizeToken(snapshot.structure.charter.modelPolicyDefault)}`
          : "Default posture"}
      </p>
      <details>
        <summary className="cursor-pointer">Chambers and access rules</summary>
        <p className="mt-2 break-words">
          {snapshot.structure.chambers
            .map((item) => `${item.name} (${item.sensitivity}${item.sealed ? ", sealed" : ""})`)
            .join("; ") || "No Chambers"}
        </p>
        {groups.map(({ label, items }) => (
          <div key={label} className="mt-3">
            <h5 className="font-medium">
              {label} · {items.length}
            </h5>
            {items.length ? (
              <ul className="max-h-48 space-y-1 overflow-y-auto break-words">
                {items.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            ) : (
              <p>None</p>
            )}
          </div>
        ))}
      </details>
      <TechnicalDetails><p className="break-all font-mono text-xs">Version: {snapshot.revision}</p></TechnicalDetails>
      <Button disabled={snapshot.structure.record?.lifecycleStatus === "archived"} onClick={onAccept}>
        Use current access review
      </Button>
    </section>
  );
}
