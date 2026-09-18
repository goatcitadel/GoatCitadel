import type { CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { NativeButton, NoticeBanner } from "../primitives";
import { humanizeEnumToken } from "../shared/native-helpers";
import "./citadel-access-review.css";

export function CitadelAccessReview({ snapshot, onAccept }: { snapshot: CitadelAccessSnapshot | null; onAccept: () => void }) {
  return <section className="mc-next-citadel-access-review" aria-label="Current Citadel access review">
    <NoticeBanner tone="warning" message="The reviewed rules changed. Review the current access rules before retrying." />
    {snapshot ? <>
      <h3>Current access rules</h3>
      <p>{snapshot.structure.record?.name ?? snapshot.citadelId} · {snapshot.structure.record?.lifecycleStatus ?? "No profile"}</p>
      <p>{snapshot.structure.charter?.purpose ?? "No Charter"}</p>
      <p>Policy: {snapshot.structure.charter ? `${humanizeEnumToken(snapshot.structure.charter.riskPosture)} · ${humanizeEnumToken(snapshot.structure.charter.modelPolicyDefault)}` : "Default posture"}</p>
      <p>Chambers: {snapshot.structure.chambers.map((item) => `${item.name} (${item.sensitivity}${item.sealed ? ", sealed" : ""})`).join("; ") || "None"}</p>
      <div className="mc-next-citadel-access-groups">{[
        { label: "Council", items: snapshot.council.map((item) => item.agentId) },
        { label: "Wards", items: snapshot.wards.map((item) => `${item.name}: ${item.actionPattern} · ${humanizeEnumToken(item.effect)}`) },
        { label: "Passages", items: snapshot.passages.map((item) => `${item.sourceChamberId ?? "All Chambers"} → ${item.destinationCitadelId}: ${item.allowedFields.join(", ") || "No fields"}; expires ${item.expiresAt ?? "never"}`) },
        { label: "Members", items: snapshot.members.map((item) => `${item.subjectId}: ${item.role}`) },
        { label: "Integration grants", items: snapshot.integrations.map((item) => `${item.provider} (${item.account ?? "Default account"}): ${item.mode} · ${item.capabilities.join(", ") || "No capabilities"}; expires ${item.expiresAt ?? "never"}`) },
      ].map(({ label, items }) => <div key={label}><h4>{label}</h4>{items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>None</p>}</div>)}</div>
      <NativeButton variant="outline" onClick={onAccept} disabled={snapshot.structure.record?.lifecycleStatus === "archived"}>Use current access review</NativeButton>
    </> : <p>Reload this page to retrieve a current review. Your draft is retained.</p>}
  </section>;
}
