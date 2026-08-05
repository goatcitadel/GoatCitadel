import type {
  CuratorArchiveRequest,
  CuratorArchiveResponse,
  CuratorListArchivedResponse,
  CuratorPruneRequest,
  CuratorPruneResponse,
  CuratorRunRequest,
  CuratorRunResponse,
  CuratorStatusResponse,
} from "@goatcitadel/contracts";

export interface CuratorRoutePort {
  listCuratorStatus(): Promise<CuratorStatusResponse>;
  archiveCuratorSkill(input: CuratorArchiveRequest): Promise<CuratorArchiveResponse>;
  pruneCuratorSkill(input: CuratorPruneRequest): Promise<CuratorPruneResponse>;
  listCuratorArchived(): Promise<CuratorListArchivedResponse>;
  runCurator(input: CuratorRunRequest): Promise<CuratorRunResponse>;
}

export class CuratorRouteService {
  public constructor(private readonly deps: CuratorRoutePort) {}

  public listStatus(): Promise<CuratorStatusResponse> {
    return this.deps.listCuratorStatus();
  }

  public archive(input: CuratorArchiveRequest): Promise<CuratorArchiveResponse> {
    return this.deps.archiveCuratorSkill(input);
  }

  public prune(input: CuratorPruneRequest): Promise<CuratorPruneResponse> {
    return this.deps.pruneCuratorSkill(input);
  }

  public listArchived(): Promise<CuratorListArchivedResponse> {
    return this.deps.listCuratorArchived();
  }

  public run(input: CuratorRunRequest): Promise<CuratorRunResponse> {
    return this.deps.runCurator(input);
  }
}
