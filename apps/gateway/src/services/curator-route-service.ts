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
  listCuratorStatus(): CuratorStatusResponse;
  archiveCuratorSkill(input: CuratorArchiveRequest): CuratorArchiveResponse;
  pruneCuratorSkill(input: CuratorPruneRequest): CuratorPruneResponse;
  listCuratorArchived(): CuratorListArchivedResponse;
  runCurator(input: CuratorRunRequest): Promise<CuratorRunResponse>;
}

export class CuratorRouteService {
  public constructor(private readonly deps: CuratorRoutePort) {}

  public listStatus(): CuratorStatusResponse {
    return this.deps.listCuratorStatus();
  }

  public archive(input: CuratorArchiveRequest): CuratorArchiveResponse {
    return this.deps.archiveCuratorSkill(input);
  }

  public prune(input: CuratorPruneRequest): CuratorPruneResponse {
    return this.deps.pruneCuratorSkill(input);
  }

  public listArchived(): CuratorListArchivedResponse {
    return this.deps.listCuratorArchived();
  }

  public run(input: CuratorRunRequest): Promise<CuratorRunResponse> {
    return this.deps.runCurator(input);
  }
}
