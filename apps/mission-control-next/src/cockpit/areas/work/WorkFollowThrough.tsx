import { ChatFollowThroughControl } from "../chat/ChatFollowThroughControl";
import { Section } from "../../ui/Section";

export function WorkFollowThrough({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }) {
  return (
    <Section title="Conversation follow-through">
      <ChatFollowThroughControl sessionId={sessionId} workspaceId={workspaceId} />
    </Section>
  );
}
