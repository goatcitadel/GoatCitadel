import type { CitadelVaultSnapshot } from "@goatcitadel/contracts";
import { NativeButton, NoticeBanner } from "../primitives";
import "./citadel-vault-review.css";

export function CitadelVaultReview({ snapshot, loading, onAccept, onReload }: { snapshot: CitadelVaultSnapshot | null; loading: boolean; onAccept: () => void; onReload: () => void }) {
  return <section className="mc-next-citadel-vault-review" aria-label="Current Vault review">
    <NoticeBanner tone="warning" message="The Vault changed. Review its current names and update times before retrying. Your draft is retained." />
    {snapshot ? <>
      <h3>Current Vault metadata</h3>
      <p>{snapshot.record?.name ?? snapshot.citadelId} · {snapshot.record?.lifecycleStatus ?? "No profile"}</p>
      {snapshot.items.length ? <ul>{snapshot.items.map((item) => <li key={item.secretId}><strong>{item.secretName}</strong><span>Updated {item.updatedAt}</span></li>)}</ul> : <p>No secrets stored.</p>}
      <NativeButton variant="outline" onClick={onAccept} disabled={loading || snapshot.record?.lifecycleStatus === "archived"}>Use current Vault review</NativeButton>
    </> : <><p>{loading ? "Loading current metadata…" : "Reload the current metadata to continue. Your draft is retained."}</p><NativeButton variant="outline" disabled={loading} onClick={onReload}>Reload Vault review</NativeButton></>}
  </section>;
}
