import type { StoryConversation } from "./api";

export function buildStoryExport(conversation: StoryConversation, workspaceId: string, branchId: string, revision: number, includeContext: boolean, includeUserPrompts = true) {
  return {
    protocol: "lke.story-export.v1",
    exported_at: new Date().toISOString(),
    workspace_id: workspaceId,
    branch_id: branchId,
    base_revision: revision,
    context_manifests_included: includeContext,
    user_prompts_included: includeUserPrompts,
    conversation: {
      ...conversation,
      turns: conversation.turns.filter((turn) => includeUserPrompts || turn.role !== "user").map((turn) => ({
        ...turn,
        context_manifest: includeContext ? turn.context_manifest : undefined,
      })),
    },
  };
}
