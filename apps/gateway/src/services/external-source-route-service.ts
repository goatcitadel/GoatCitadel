import type {
  ExternalSourceCatalogListInput,
  ExternalSourceCreateInput,
  ExternalSourceDetailResponse,
  ExternalSourceListResponse,
  ExternalSourcePage,
  ExternalSourceScanInput,
  ExternalSourceScanRecord,
  ExternalSourceUpdateInput,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
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
}

export class ExternalSourceRouteService implements ExternalSourceRoutePort {
  public constructor(private readonly service: ExternalSourceService) {}

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
}

type ExternalSourceRouteStorage = Pick<
  Storage,
  "externalSourceConfigs" | "externalSourceScans" | "workspacePathBridgeSnapshots" | "workspaces"
>;

export function createExternalSourceRouteService(
  storage: ExternalSourceRouteStorage,
  pathVerifier: ExternalSourcePathVerifierPort,
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
  return new ExternalSourceRouteService(
    new ExternalSourceService({
      configs: storage.externalSourceConfigs,
      scans: storage.externalSourceScans,
      pathSnapshots: storage.workspacePathBridgeSnapshots,
      pathVerifier,
      workspaces: storage.workspaces,
      scanner,
    }),
  );
}
