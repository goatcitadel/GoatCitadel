import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useQuery } from "@tanstack/react-query";
import { fetchChatGeneratedArtifact } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { LibraryResourceDetail } from "./LibraryResourceDetail";
import { Button } from "../../ui/Button";
export function LibraryLinkedArtifact({
  artifactId,
  projectId,
  workspaceId,
  citadelId,
}: {
  artifactId: string;
  projectId?: string;
  workspaceId: string;
  citadelId: string;
}) {
  const access = useProjectAccess(JSON.stringify([workspaceId, citadelId]));
  const query = useQuery({
    queryKey: ["library", "linked-artifact", access.identity, workspaceId, citadelId, projectId, artifactId],
    queryFn: async () => {
      const { item } = await fetchChatGeneratedArtifact(artifactId, workspaceId, citadelId);
      if (
        !item ||
        item.artifactId !== artifactId ||
        item.workspaceId !== workspaceId ||
        (projectId && item.projectId !== projectId)
      )
        throw new Error("Artifact unavailable in this project and workspace.");
      return item;
    },
    retry: false,
    staleTime: 0,
  });
  return (
    <section aria-label="Linked project artifact" className="grid min-w-0 gap-3 rounded-lg border border-line p-3">
      <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
        Refresh linked artifact
      </Button>
      {query.isFetching ? (
        <p role="status">Reading linked artifact…</p>
      ) : query.error ? (
        <p role="alert">{describeApiError(query.error).summary}</p>
      ) : query.data ? (
        <LibraryResourceDetail
          resource={{ kind: "artifacts", item: query.data }}
          workspaceId={workspaceId}
          citadelId={citadelId}
        />
      ) : null}
    </section>
  );
}
