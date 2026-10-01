import { useId } from "react";
import { Eye, EyeOff, KeyRound, Lock, Trash2 } from "lucide-react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { DetailInspector } from "../../../components/DetailInspector";

import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";
import { useCitadelVaultEditor } from "./use-citadel-vault-editor";
import { CitadelVaultReview } from "./CitadelVaultReview";
import "./citadel-confirmation.css";

/**
 * The Vault (spec §13 MVP). Secrets are sealed with AES-256-GCM under a per-Citadel
 * master key held in the OS keychain; the plaintext is never persisted. The list
 * shows names only — revealing a value is an explicit, per-secret action.
 */
export function CitadelVaultRoutePage({
  route,
  activeWorkspaceId,
  activeWorkspaceName,
  activeCitadelId = activeWorkspaceId,
  activeCitadelName = activeWorkspaceName,
}: NativeRoutePagesProps) {
  const nameId = useId();
  const valueId = useId();
  const editor = useCitadelVaultEditor(activeCitadelId);
  const {
    vault,
    formOpen,
    secretDraft,
    draft,
    setDraft,
    pendingStore,
    pendingDelete,
    revealed,
    revealErrors,
    busy,
    reviewRequired,
    canStore,
    items,
    selectedSecret,
    clearReveals,
    closeDetails,
    leave,
    save,
    store,
    remove,
    reveal,
  } = editor;
  const currentReview = reviewRequired ? (
    <CitadelVaultReview
      snapshot={vault.snapshot}
      loading={vault.loading}
      onReload={() => void editor.refresh()}
      onAccept={editor.acceptReview}
    />
  ) : null;

  return (
    <NativePageFrame
      icon={KeyRound}
      area="library"
      kicker={routeKicker(route)}
      title="Vault"
      description={`Secrets for ${activeCitadelName}, sealed at rest under a per-Citadel key in your OS keychain. Names are listed; values are revealed only on request.`}
      loading={vault.loading && !vault.snapshot && !reviewRequired}
      error={!vault.snapshot && !reviewRequired ? vault.error : null}
      onRetry={() => void editor.refresh()}
    >
      {!formOpen ? currentReview : null}
      {vault.error && !formOpen ? <NoticeBanner tone="error" message={vault.error} /> : null}
      {vault.snapshot?.record?.lifecycleStatus === "archived" ? (
        <NoticeBanner tone="warning" message="Restore this Citadel before changing its Vault." />
      ) : null}
      <div className="mc-next-settings-button-row">
        <NativeButton disabled={busy || !vault.snapshot} onClick={editor.openForm}>
          Store secret{secretDraft.isDirty ? " · Unsaved" : ""}
        </NativeButton>
      </div>
      <NativeGrid className="mc-next-calm-directory">
        <NativeCard
          title="Stored secrets"
          subtitle="The plaintext is never persisted — only the sealed envelope."
          stats={[{ label: "Secrets", value: vault.snapshot ? String(items.length) : "Unavailable" }]}
        >
          {!vault.snapshot ? (
            <p>Vault metadata is unavailable.</p>
          ) : items.length === 0 ? (
            <EmptyState size="compact" title="No secrets stored yet." />
          ) : (
            <ul className="mc-next-vault-list">
              {items.map((secret) => (
                <li key={secret.secretId} className="mc-next-vault-item">
                  <div className="mc-next-vault-item-head">
                    <NativeButton variant="ghost" onClick={() => editor.inspect(secret.secretId)}>
                      {secret.secretName}
                    </NativeButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </NativeCard>

        <DetailInspector
          open={formOpen}
          title="Store a secret"
          subtitle={secretDraft.isDirty ? "Unsaved changes" : undefined}
          onClose={closeDetails}
        >
          {currentReview}
          {vault.error ? <NoticeBanner tone="error" message={vault.error} /> : null}
          <label className="mc-next-mason-field" htmlFor={nameId}>
            <span>Name</span>
            <input
              id={nameId}
              className="mc-next-settings-input"
              value={draft.name}
              placeholder="stripe-secret-key"
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="mc-next-mason-field" htmlFor={valueId}>
            <span>Value</span>
            <input
              id={valueId}
              type="password"
              className="mc-next-settings-input"
              value={draft.value}
              placeholder="sk-live-…"
              onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))}
            />
          </label>
          <NativeButton
            variant="default"
            disabled={!canStore || draft.name.trim().length === 0 || draft.value.length === 0}
            onClick={() => void store()}
          >
            <Lock size={16} />
            {busy ? "Sealing…" : "Seal & store"}
          </NativeButton>
        </DetailInspector>
      </NativeGrid>

      {leave.dialog}
      <DetailInspector
        open={Boolean(selectedSecret)}
        title={selectedSecret?.secretName ?? "Secret"}
        subtitle="Vault value · hides after 30 seconds or closing"
        onClose={closeDetails}
      >
        {selectedSecret ? (
          <>
            <dl className="mc-next-native-facts">
              {Object.entries(selectedSecret).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                  <dd>{String(value ?? "Unavailable")}</dd>
                </div>
              ))}
            </dl>
            <div className="mc-next-settings-button-row">
              <NativeButton
                onClick={() =>
                  revealed[selectedSecret.secretId] === undefined
                    ? void reveal(selectedSecret.secretId)
                    : clearReveals()
                }
              >
                {revealed[selectedSecret.secretId] === undefined ? (
                  <>
                    <Eye size={16} /> Reveal
                  </>
                ) : (
                  <>
                    <EyeOff size={16} /> Hide
                  </>
                )}
              </NativeButton>
              <NativeButton
                disabled={!vault.ready || reviewRequired}
                variant="destructive"
                aria-label={`Delete ${selectedSecret.secretName}`}
                onClick={editor.reviewDelete}
              >
                <Trash2 size={16} />
                Delete secret
              </NativeButton>
            </div>
            {revealed[selectedSecret.secretId] !== undefined ? (
              <code className="mc-next-vault-value">{revealed[selectedSecret.secretId]}</code>
            ) : null}
            {revealErrors[selectedSecret.secretId] ? (
              <NoticeBanner tone="error" message={revealErrors[selectedSecret.secretId]} />
            ) : null}
          </>
        ) : null}
      </DetailInspector>
      <ConfirmModal
        className="mc-next-citadel-confirmation"
        pending={busy}
        open={pendingDelete !== null}
        danger
        title="Delete secret?"
        message={`Delete "${pendingDelete?.name}"? This permanently removes the stored secret and cannot be undone.`}
        confirmLabel="Delete"
        onCancel={editor.cancelDelete}
        onConfirm={() => {
          void remove();
        }}
      />

      <ConfirmModal
        className="mc-next-citadel-confirmation"
        open={pendingStore !== null}
        danger
        pending={busy}
        title="Replace secret?"
        message={`Replace "${pendingStore?.draft.name.trim()}" with the value you entered? The previous value cannot be recovered.`}
        confirmLabel="Replace secret"
        onCancel={editor.cancelStore}
        onConfirm={() => {
          if (pendingStore) void save(pendingStore.draft, pendingStore.revision);
        }}
      />
      <p className="mc-next-citadel-footnote">
        <Lock size={12} aria-hidden="true" />
        AES-256-GCM, sealed under a per-Citadel key in your OS keychain. Per-Chamber keys and rotation are the deferred
        follow-on.
      </p>
    </NativePageFrame>
  );
}
