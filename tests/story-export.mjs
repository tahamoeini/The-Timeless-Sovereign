import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../frontend/src/storyExport.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { buildStoryExport } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const conversation = {
  conversation_id: "story-1",
  title: "داستان",
  turns: [{ role: "assistant", content: "متن داستان", model: "local", context_revision: 7,
    context_manifest: { included: [{ object: "private character knowledge" }] } }],
};
const before = JSON.stringify(conversation);
const privateExport = JSON.parse(JSON.stringify(buildStoryExport(conversation, "workspace-1", "branch-1", 8, false)));
assert.equal(privateExport.workspace_id, "workspace-1");
assert.equal(privateExport.branch_id, "branch-1");
assert.equal(privateExport.base_revision, 8);
assert.equal(privateExport.context_manifests_included, false);
assert.equal("context_manifest" in privateExport.conversation.turns[0], false);
assert.equal(privateExport.conversation.turns[0].content, "متن داستان");
assert.equal(privateExport.conversation.turns[0].context_revision, 7);
assert.equal(JSON.stringify(privateExport).includes("private character knowledge"), false);
const fullExport = buildStoryExport(conversation, "workspace-1", "branch-1", 8, true);
assert.deepEqual(fullExport.conversation.turns[0].context_manifest, conversation.turns[0].context_manifest);
assert.equal(JSON.stringify(conversation), before);
const withPrompt = { ...conversation, turns: [{ role: "user", content: "private user prompt" }, ...conversation.turns] };
const narrativeOnly = JSON.parse(JSON.stringify(buildStoryExport(withPrompt, "workspace-1", "branch-1", 8, false, false)));
assert.equal(narrativeOnly.user_prompts_included, false);
assert.equal(narrativeOnly.conversation.turns.length, 1);
assert.equal(JSON.stringify(narrativeOnly).includes("private user prompt"), false);
assert.equal(withPrompt.turns.length, 2);
console.log("Story export privacy, provenance, Unicode, and source preservation checks passed.");
