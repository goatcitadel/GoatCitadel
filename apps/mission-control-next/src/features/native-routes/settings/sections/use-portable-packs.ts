import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CapabilityPackExportResponse,
  CapabilityPackManifest,
  CapabilityPackPreview,
  CapabilityPackStagedRecord,
} from "@goatcitadel/contracts";
import {
  exportCapabilityPack,
  fetchCapabilityPackPreview,
  fetchCapabilityPacks,
  fetchEvidenceEnvelopes,
  fetchLocalCapabilityPackPreview,
  fetchStagedCapabilityPacks,
  installCapabilityPack,
  installLocalCapabilityPack,
  materializeStagedCapabilityPack,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { nativeLoad, nativeLoadIssues, useAsyncLoad } from "../SettingsShared";
import {
  assertPackExport,
  assertPackMaterializationReadback,
  assertPackMaterializationReceipt,
  assertPackStageReadback,
  assertPackStageReceipt,
  isPackManifest,
  PACK_EVIDENCE_LIMIT,
  PACK_INPUT_LIMIT,
  parsePortablePack,
  requirePackPreview,
  samePackValue,
} from "./pack-evidence-binding";
import { beginPackAttempt, usePackAttempt } from "./pack-mutation-state";

export type PackReview = { generation: number } & (
  | { kind: "stage"; preview: CapabilityPackPreview; source?: string }
  | { kind: "record"; staged: CapabilityPackStagedRecord }
);
type PackView = { kind: "catalog"; packId: string } | { kind: "portable" } | null;
export function usePortablePacks(workspaceId: string) {
  const base = getGatewayApiBaseUrl(),
    scope = JSON.stringify([base, workspaceId]),
    key = JSON.stringify(["pack-evidence", base]);
  const live = useRef({ scope, binding: {}, mounted: true, generation: 0 });
  if (live.current.scope !== scope) {
    live.current.scope = scope;
    live.current.binding = {};
    live.current.generation++;
  }
  const binding = live.current.binding;
  const current = useCallback(
    () => live.current.mounted && live.current.binding === binding && getGatewayApiBaseUrl() === base,
    [base, binding],
  );
  useLayoutEffect(() => {
    const value = live.current;
    value.mounted = true;
    return () => {
      value.mounted = false;
      value.generation++;
    };
  }, [scope]);
  const [view, setView] = useState<PackView>(null),
    [preview, setPreview] = useState<CapabilityPackPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<PackReview | null>(null),
    [exported, setExported] = useState<CapabilityPackExportResponse | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const draft = useSessionDraft(`portable-pack:${scope}:import`, "", undefined, {
    label: "Portable pack",
    active: view?.kind === "portable",
  });
  const leave = useDraftLeave(),
    attempt = usePackAttempt(key),
    locked = attempt.phase !== "idle";
  const load = useCallback(async () => {
    const [packs, staged] = await Promise.all([
      nativeLoad(
        "Capability packs",
        fetchCapabilityPacks().then((result) => {
          if (
            !Array.isArray(result.items) ||
            result.items.some((item) => !isPackManifest(item) || item.provenance.source !== "bundled") ||
            new Set(result.items.map((item) => item.packId)).size !== result.items.length
          )
            throw new Error("The bundled pack catalog is inconsistent.");
          return result;
        }),
        { items: [] as CapabilityPackManifest[] },
      ),
      nativeLoad("Staged capability packs", fetchStagedCapabilityPacks(), {
        items: [] as CapabilityPackStagedRecord[],
      }),
    ]);
    return { base, packs: packs.data.items, staged: staged.data.items, issues: nativeLoadIssues([packs, staged]) };
  }, [base]);
  const loaded = useAsyncLoad(load, [load]),
    data = loaded.data?.base === base ? loaded.data : null;
  const invalidate = () => {
    live.current.generation++;
    setReview(null);
    setExported(null);
    setExportBusy(false);
    setNotice(null);
  };
  useEffect(() => {
    setView(null);
    setPreview(null);
    setReview(null);
    setNotice(null);
    setExported(null);
    setPreviewBusy(false);
    setExportBusy(false);
  }, [scope]);
  const generation = live.current.generation;
  const valid = (captured: number) => current() && live.current.generation === captured;
  async function inspect(packId: string) {
    if (!current()) return;
    invalidate();
    const captured = live.current.generation;
    setView({ kind: "catalog", packId });
    setPreview(null);
    setPreviewBusy(true);
    try {
      const result = requirePackPreview(await fetchCapabilityPackPreview(packId), packId, "bundled");
      if (valid(captured)) setPreview(result);
    } catch {
      if (valid(captured)) setNotice("The exact pack preview could not be read. Refresh before reviewing a change.");
    } finally {
      if (valid(captured)) setPreviewBusy(false);
    }
  }
  function setSource(source: string) {
    if (!current()) return;
    invalidate();
    setPreview(null);
    setPreviewBusy(false);
    draft.setValue(source);
  }
  async function importFile(file: File) {
    if (!current() || view?.kind !== "portable") return;
    invalidate();
    const captured = live.current.generation;
    if (file.size > PACK_INPUT_LIMIT) {
      setNotice("Choose a JSON file no larger than 512,000 bytes.");
      return;
    }
    try {
      const value = await file.text();
      if (valid(captured)) setSource(value);
    } catch {
      if (valid(captured)) setNotice("The selected file could not be read.");
    }
  }
  async function previewLocal() {
    if (!current() || view?.kind !== "portable") return;
    invalidate();
    const captured = live.current.generation,
      source = draft.value;
    setPreview(null);
    setPreviewBusy(true);
    try {
      const input = parsePortablePack(source);
      const result = requirePackPreview(await fetchLocalCapabilityPackPreview(input), input.packId, "local_file");
      if (valid(captured)) setPreview(result);
    } catch {
      if (valid(captured))
        setNotice(
          "Portable preview unavailable. Check the manifest format, local_file provenance and bounded asset list.",
        );
    } finally {
      if (valid(captured)) setPreviewBusy(false);
    }
  }
  function open(next: PackView) {
    leave.request(
      () => {
        if (!current()) return;
        invalidate();
        setPreview(null);
        setPreviewBusy(false);
        setView(next);
        if (next?.kind === "catalog") void inspect(next.packId);
      },
      view?.kind === "portable" ? [draft.key] : [],
    );
  }
  function requestStage() {
    if (!current() || generation !== live.current.generation || !preview || previewBusy || locked) return;
    setReview({
      kind: "stage",
      preview: structuredClone(preview),
      generation,
      ...(view?.kind === "portable" ? { source: draft.value } : {}),
    });
  }
  function requestRecord(record: CapabilityPackStagedRecord) {
    if (
      !current() ||
      locked ||
      !record.evidenceEnvelopeId ||
      !record.stagedAssets.length ||
      !samePackValue(
        data?.staged.find((item) => item.evidenceEnvelopeId === record.evidenceEnvelopeId),
        record,
      )
    )
      return;
    setReview({ kind: "record", staged: structuredClone(record), generation });
  }
  async function confirm() {
    if (!review || !valid(review.generation) || locked) return false;
    const operation = beginPackAttempt(key);
    if (!operation) return false;
    const submitted = structuredClone(review),
      captured = review.generation;
    const requireInstallation = () => {
      if (getGatewayApiBaseUrl() !== base) throw new Error("Gateway installation changed.");
    };
    const readStaged = async () => {
      requireInstallation();
      const value = await fetchStagedCapabilityPacks();
      requireInstallation();
      return value.items;
    };
    const readEvidence = async () => {
      requireInstallation();
      const value = await fetchEvidenceEnvelopes({ limit: PACK_EVIDENCE_LIMIT });
      requireInstallation();
      return value.items;
    };
    try {
      const prior = await readStaged();
      if (!valid(captured)) return false;
      if (submitted.kind === "stage") {
        const input = submitted.source === undefined ? undefined : parsePortablePack(submitted.source);
        const fresh = input
          ? await fetchLocalCapabilityPackPreview(input)
          : await fetchCapabilityPackPreview(submitted.preview.manifest.packId);
        requireInstallation();
        if (!valid(captured)) return false;
        if (!samePackValue(fresh, submitted.preview))
          throw new Error("The pack preview changed. Review its current owner projection.");
        const receipt = await operation.write(
          () =>
            input
              ? installLocalCapabilityPack(input, { actorId: "operator" })
              : installCapabilityPack(submitted.preview.manifest.packId, { actorId: "operator" }),
          async (saved) => {
            assertPackStageReceipt(saved, submitted.preview, prior);
            const [staged, envelopes] = await Promise.all([readStaged(), readEvidence()]);
            assertPackStageReadback(saved, staged, envelopes);
          },
        );
        // A confirmed origin acknowledgement remains valid after navigation; newer source input is preserved.
        if (submitted.source !== undefined) draft.acceptSaved(submitted.source, undefined, submitted.source);
        if (valid(captured)) {
          setReview(null);
          setNotice(
            `${receipt.preview.manifest.name} staged and exact evidence confirmed. No capability was enabled or executed.`,
          );
        }
      } else {
        if (
          !samePackValue(
            prior.find((item) => item.evidenceEnvelopeId === submitted.staged.evidenceEnvelopeId),
            submitted.staged,
          )
        )
          throw new Error("The staged evidence changed or left the bounded owner list. Inspect the current record.");
        const receipt = await operation.write(
          () =>
            materializeStagedCapabilityPack(submitted.staged.evidenceEnvelopeId!, {
              actorId: "operator",
              confirmReview: true,
              assetIds: submitted.staged.stagedAssets.map((item) => item.assetId),
              note: "Operator recorded reviewed pack evidence from Settings.",
            }),
          async (saved) => {
            assertPackMaterializationReceipt(saved, submitted.staged);
            const [staged, envelopes] = await Promise.all([readStaged(), readEvidence()]);
            assertPackMaterializationReadback(saved, submitted.staged, staged, envelopes);
          },
        );
        if (valid(captured)) {
          setReview(null);
          setNotice(
            `Review evidence recorded for ${receipt.assets.length} assets. Callable state and runtime policy are unchanged.`,
          );
        }
      }
      if (valid(captured)) {
        try {
          await loaded.reload();
        } catch {
          /* Confirmed evidence remains settled; read errors are separate. */
        }
      }
      return true;
    } catch (error) {
      if (valid(captured)) {
        setReview(null);
        setNotice(error instanceof Error ? error.message : "Pack evidence could not be confirmed.");
      }
      return false;
    } finally {
      operation.finish();
    }
  }
  async function exportPreview() {
    if (!preview || !current() || exportBusy) return;
    const captured = live.current.generation,
      manifest = structuredClone(preview.manifest);
    setExportBusy(true);
    setExported(null);
    try {
      const value = await exportCapabilityPack(manifest.packId);
      assertPackExport(value, manifest);
      if (valid(captured)) setExported(value);
    } catch {
      if (valid(captured))
        setNotice("The current export could not be bound to this preview. A newer staged manifest may exist.");
    } finally {
      if (valid(captured)) setExportBusy(false);
    }
  }
  async function reload() {
    invalidate();
    setPreview(null);
    setPreviewBusy(false);
    await loaded.reload();
  }
  return {
    data,
    loading: loaded.loading,
    error: loaded.error,
    reload,
    workspaceId,
    view,
    open,
    preview,
    previewBusy,
    notice,
    draft,
    setSource,
    importFile,
    inputLimit: PACK_INPUT_LIMIT,
    previewLocal,
    requestStage,
    requestRecord,
    review: review && valid(review.generation) ? review : null,
    cancelReview: () => {
      live.current.generation++;
      setReview(null);
    },
    confirm,
    attempt,
    locked,
    exported,
    exportBusy,
    exportPreview,
    leave,
  };
}
export type PortablePacksOwner = ReturnType<typeof usePortablePacks>;
