import path from "node:path";
import type {
  ExternalSourceCatalogListInput,
  ExternalSourceCreateInput,
  ExternalSourceDetailResponse,
  ExternalSourceImportApplyInput,
  ExternalSourceImportApplyResponse,
  ExternalSourceImportDetailResponse,
  ExternalSourceImportPlanInput,
  ExternalSourceImportPlanResponse,
  ExternalSourceListResponse,
  ExternalSourcePage,
  ExternalSourceScanInput,
  ExternalSourceScanRecord,
  ExternalSourceUpdateInput,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ExternalSourceArtifactStore } from "./external-source-artifact-store.js";
import {
  ExternalSourceImportService,
  type ExternalSourceImportRecoverySummary,
} from "./external-source-import-service.js";
import { ExternalSourcePlanStagingStore } from "./external-source-plan-staging-store.js";
import { ExternalSourceReader } from "./external-source-reader.js";
import { ExternalSourceScanService } from "./external-source-scan-service.js";
import {
  ExternalSourceService,
  StorageExternalSourceIdentityResolver,
  type ExternalSourcePathVerifierPort,
  type ExternalSourceRequestActor,
} from "./external-source-service.js";

export interface ExternalSourceRoutePort {
  create(
    input: ExternalSourceCreateInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceDetailResponse>;
  list(workspaceId: string, actor: ExternalSourceRequestActor): ExternalSourceListResponse;
  get(workspaceId: string, sourceId: string, actor: ExternalSourceRequestActor): ExternalSourceDetailResponse;
  update(
    sourceId: string,
    input: ExternalSourceUpdateInput,
    actor: ExternalSourceRequestActor,
  ): Promise<ExternalSourceDetailResponse>;
  scan(
    sourceId: string,
    input: ExternalSourceScanInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceScanRecord>;
  listCatalog(
    sourceId: string,
    input: ExternalSourceCatalogListInput,
    actor: ExternalSourceRequestActor,
  ): ExternalSourcePage;
  createImportPlan(
    input: ExternalSourceImportPlanInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportPlanResponse>;
  applyImport(
    input: ExternalSourceImportApplyInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportApplyResponse>;
  getImport(
    workspaceId: string,
    importId: string,
    actor: ExternalSourceRequestActor,
  ): ExternalSourceImportDetailResponse;
  recoverImports(signal: AbortSignal, limit?: number): Promise<ExternalSourceImportRecoverySummary>;
}

export class ExternalSourceRouteService implements ExternalSourceRoutePort {
  public constructor(
    private readonly service: ExternalSourceService,
    private readonly imports?: ExternalSourceImportService,
  ) {}

  public create(
    input: ExternalSourceCreateInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceDetailResponse> {
    return this.service.create(input, actor, signal);
  }

  public list(workspaceId: string, actor: ExternalSourceRequestActor): ExternalSourceListResponse {
    return this.service.list(workspaceId, actor);
  }

  public get(workspaceId: string, sourceId: string, actor: ExternalSourceRequestActor): ExternalSourceDetailResponse {
    return this.service.get(workspaceId, sourceId, actor);
  }

  public update(
    sourceId: string,
    input: ExternalSourceUpdateInput,
    actor: ExternalSourceRequestActor,
  ): Promise<ExternalSourceDetailResponse> {
    return this.service.update(sourceId, input, actor);
  }

  public scan(
    sourceId: string,
    input: ExternalSourceScanInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceScanRecord> {
    return this.service.scan(sourceId, input, actor, signal);
  }

  public listCatalog(
    sourceId: string,
    input: ExternalSourceCatalogListInput,
    actor: ExternalSourceRequestActor,
  ): ExternalSourcePage {
    return this.service.listCatalog(sourceId, input, actor);
  }

  public createImportPlan(
    input: ExternalSourceImportPlanInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportPlanResponse> {
    return this.requireImports().createPlan(input, actor, signal);
  }

  public applyImport(
    input: ExternalSourceImportApplyInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportApplyResponse> {
    return this.requireImports().apply(input, actor, signal);
  }

  public getImport(
    workspaceId: string,
    importId: string,
    actor: ExternalSourceRequestActor,
  ): ExternalSourceImportDetailResponse {
    return this.requireImports().get(workspaceId, importId, actor);
  }

  public recoverImports(signal: AbortSignal, limit?: number): Promise<ExternalSourceImportRecoverySummary> {
    return this.requireImports().recover(signal, limit);
  }

  private requireImports(): ExternalSourceImportService {
    if (!this.imports) throw new Error("External source import service is not composed.");
    return this.imports;
  }
}

type ExternalSourceRouteStorage = Pick<
  Storage,
  | "externalSourceConfigs"
  | "externalSourceImports"
  | "externalSourceScans"
  | "workspacePathBridgeSnapshots"
  | "workspaces"
>;

export function createExternalSourceRouteService(
  storage: ExternalSourceRouteStorage,
  pathVerifier: ExternalSourcePathVerifierPort,
  managedRootDir?: string,
): ExternalSourceRouteService {
  const identityResolver = new StorageExternalSourceIdentityResolver({
    configs: storage.externalSourceConfigs,
    pathSnapshots: storage.workspacePathBridgeSnapshots,
    pathVerifier,
  });
  const reader = new ExternalSourceReader({ identityResolver });
  const scanner = new ExternalSourceScanService({
    configs: storage.externalSourceConfigs,
    scans: storage.externalSourceScans,
    reader,
  });
  const sourceService = new ExternalSourceService({
    configs: storage.externalSourceConfigs,
    scans: storage.externalSourceScans,
    pathSnapshots: storage.workspacePathBridgeSnapshots,
    pathVerifier,
    workspaces: storage.workspaces,
    scanner,
  });
  if (!managedRootDir || !storage.externalSourceImports) return new ExternalSourceRouteService(sourceService);
  return new ExternalSourceRouteService(
    sourceService,
    new ExternalSourceImportService({
      configs: storage.externalSourceConfigs,
      scans: storage.externalSourceScans,
      imports: storage.externalSourceImports,
      workspaces: storage.workspaces,
      reader,
      staging: new ExternalSourcePlanStagingStore(path.join(managedRootDir, "staging")),
      artifacts: new ExternalSourceArtifactStore(path.join(managedRootDir, "artifacts")),
    }),
  );
}
