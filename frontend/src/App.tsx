import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "./api";
import { buildStoryExport } from "./storyExport";
import { allocatedCreationPoints, balancedCharacterAllocation, randomizeCharacterAllocation } from "./storyCreation";
import type { CharacterCreationStat } from "./storyCreation";
import { defaultStoryMechanics, readStoryMechanics, StoryMechanicsEditor } from "./storyMechanics";
import { Branch, Claim, CodexModelOption, ContextManifest, downloadBackup, Entity, ExternalExchange, ExtractionBatch, ExtractionCandidate, JournalEvent, JournalEventVersion, newId, OllamaModelStatus, Relation, request, Revision, RuleEvaluation, RpgState, Scenario, ScenarioAssumption, ScenarioOption, Source, SourceDetails, StoryAbilityDefinition, StoryAdventure, StoryAdventureExportMode, StoryAdventureExportPreview, StoryAdventureExportSelection, StoryConversation, StoryConversationSummary, StoryGenerationResult, StoryHistoryPreview, StoryMapLocation, StoryMechanicsProfile, StoryMemory, StoryProvider, StoryStudioData, StoryThread, StoryWorld, TemporalQueryResult, Workspace } from "./api";

type Page = "story" | "knowledge" | "journal" | "scenario";
type Notice = { tone: "error" | "success" | "info"; text: string } | null;
const EXTERNAL_STORY_PROVIDERS: StoryProvider["id"][] = ["openai", "claude", "codex", "huggingface"];
type StoryWorldCover = { mime_type: "image/jpeg" | "image/png" | "image/webp"; data_base64: string; alt_text: string };
type StoryOpeningScene = { situation: string; hook: string };
type StoryWorldArchitectDraft = { public_lore: string; starting_location: string; locations: string[]; opening_scene: StoryOpeningScene };
type MnoLoreActivation = "always" | "keywords" | "disabled";
type MnoLorebookDraft = {
  index: number; title: string; type: string; content: string;
  activation: MnoLoreActivation; keywords: string[];
  originalActivation: MnoLoreActivation; originalKeywords: string[];
};
const HERO_PROFILE_FIELDS = [
  { key: "concept", label: "Character concept", maxLength: 200, rows: 2, placeholder: "A few words that capture the character." },
  { key: "background", label: "Background", maxLength: 4_000, rows: 3, placeholder: "Important history the hero already knows." },
  { key: "personality", label: "Personality", maxLength: 500, rows: 2, placeholder: "Traits and tendencies, not fixed decisions." },
  { key: "goal", label: "Current goal", maxLength: 400, rows: 2, placeholder: "What the hero is pursuing right now." },
  { key: "voice", label: "Voice", maxLength: 500, rows: 2, placeholder: "Speech style, vocabulary, or language preferences." },
] as const;
const HERO_IMPORTED_PROFILE_FIELDS = [
  { key: "age", label: "Age", maxLength: 4_000, rows: 1, placeholder: "Imported character age." },
  { key: "gender", label: "Gender", maxLength: 4_000, rows: 1, placeholder: "Imported character gender." },
  { key: "race", label: "Species or race", maxLength: 4_000, rows: 1, placeholder: "Imported species or race." },
  { key: "appearance", label: "Appearance", maxLength: 4_000, rows: 2, placeholder: "Imported appearance details." },
  { key: "job", label: "Occupation", maxLength: 4_000, rows: 1, placeholder: "Imported occupation." },
  { key: "persona", label: "Persona", maxLength: 4_000, rows: 2, placeholder: "Imported persona notes." },
  { key: "extra", label: "Additional details", maxLength: 4_000, rows: 2, placeholder: "Other imported character details." },
] as const;
type HeroProfileKey = typeof HERO_PROFILE_FIELDS[number]["key"] | typeof HERO_IMPORTED_PROFILE_FIELDS[number]["key"];
type HeroProfileDraft = Record<HeroProfileKey, string>;
const EMPTY_HERO_PROFILE: HeroProfileDraft = {
  concept: "", background: "", personality: "", goal: "", voice: "",
  age: "", gender: "", race: "", appearance: "", job: "", persona: "", extra: "",
};

function readHeroProfile(entity: Entity | null | undefined): HeroProfileDraft {
  const value = entity?.properties.character_profile;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_HERO_PROFILE };
  const profile = value as Record<string, unknown>;
  return Object.fromEntries([...HERO_PROFILE_FIELDS, ...HERO_IMPORTED_PROFILE_FIELDS].map(({ key }) => [
    key, typeof profile[key] === "string" ? profile[key] as string : "",
  ])) as HeroProfileDraft;
}

function buildHeroProfile(profile: HeroProfileDraft, includeImportedFields = false): Partial<HeroProfileDraft> {
  const fields = includeImportedFields
    ? [...HERO_PROFILE_FIELDS, ...HERO_IMPORTED_PROFILE_FIELDS]
    : HERO_PROFILE_FIELDS;
  return Object.fromEntries(fields.flatMap(({ key }) => {
    const value = profile[key].trim();
    return value ? [[key, value]] : [];
  })) as Partial<HeroProfileDraft>;
}

function heroProfileEntries(profile: HeroProfileDraft, imported = false) {
  const fields = imported ? HERO_IMPORTED_PROFILE_FIELDS : HERO_PROFILE_FIELDS;
  return fields.flatMap(({ key, label }) => {
    const value = profile[key].trim();
    return value ? [{ key, label, value }] : [];
  });
}

function readStoryOpeningScene(value: unknown): StoryOpeningScene {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { situation: "", hook: "" };
  const scene = value as Partial<StoryOpeningScene>;
  return {
    situation: typeof scene.situation === "string" ? scene.situation : "",
    hook: typeof scene.hook === "string" ? scene.hook : "",
  };
}

function parseStoryWorldLocations(value: string): string[] | null {
  const locations = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const keys = locations.map((item) => item.toLocaleLowerCase());
  return locations.length <= 100 && locations.every((item) => item.length <= 150)
    && new Set(keys).size === keys.length ? locations : null;
}

function readMnoLorebookDraft(content: Record<string, unknown> | undefined): MnoLorebookDraft[] {
  const source = content?.mno_source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  const rawEntries = (source as Record<string, unknown>).lorebook;
  if (!Array.isArray(rawEntries)) return [];
  const metadata = content?.mno_import;
  const rawRules = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).lorebook_rules : undefined;
  const rules = rawRules && typeof rawRules === "object" && !Array.isArray(rawRules)
    ? rawRules as Record<string, unknown> : {};
  return rawEntries.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    if (typeof entry.content !== "string" || !entry.content.trim()) return [];
    const originalActivation: MnoLoreActivation = entry.activation === "always" ? "always" : "keywords";
    const originalKeywords = Array.isArray(entry.keywords)
      ? entry.keywords.filter((keyword): keyword is string => typeof keyword === "string") : [];
    const rawRule = rules[String(index)];
    const rule = rawRule && typeof rawRule === "object" && !Array.isArray(rawRule)
      ? rawRule as Record<string, unknown> : {};
    const activation = rule.activation === "always" || rule.activation === "keywords" || rule.activation === "disabled"
      ? rule.activation : originalActivation;
    const keywords = Array.isArray(rule.keywords)
      ? rule.keywords.filter((keyword): keyword is string => typeof keyword === "string") : originalKeywords;
    return [{
      index,
      title: typeof entry.title === "string" && entry.title.trim() ? entry.title : "World reference",
      type: typeof entry.type === "string" && entry.type.trim() ? entry.type : "lore",
      content: entry.content,
      activation,
      keywords,
      originalActivation,
      originalKeywords,
    }];
  });
}

function buildMnoLorebookRules(entries: MnoLorebookDraft[]): Record<string, { activation: MnoLoreActivation; keywords: string[] }> {
  return Object.fromEntries(entries.flatMap((entry) => {
    const keywords = entry.keywords.map((keyword) => keyword.trim()).filter(Boolean);
    const originalKeywords = entry.originalKeywords.map((keyword) => keyword.trim()).filter(Boolean);
    const keywordsChanged = JSON.stringify(keywords) !== JSON.stringify(originalKeywords);
    return entry.activation !== entry.originalActivation || keywordsChanged
      ? [[String(entry.index), { activation: entry.activation, keywords }]] : [];
  }));
}

function humanizeImportedField(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toLocaleUpperCase());
}

function renderImportedProfileValue(value: unknown, depth = 0): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="muted">Not set</span>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth >= 3) return <span className="muted">Deeper nested detail omitted for readability</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">None</span>;
    return <ul className="story-profile-value-list">
      {value.slice(0, 20).map((item, index) => <li key={index}>{renderImportedProfileValue(item, depth + 1)}</li>)}
      {value.length > 20 && <li className="muted">{value.length - 20} more items</li>}
    </ul>;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return <span className="muted">No details</span>;
    return <dl className="story-npc-details story-npc-details-nested">
      {entries.slice(0, 20).map(([key, entryValue]) => <div key={key}>
        <dt>{humanizeImportedField(key)}</dt>
        <dd dir="auto">{renderImportedProfileValue(entryValue, depth + 1)}</dd>
      </div>)}
      {entries.length > 20 && <div><dt>More</dt><dd>{entries.length - 20} additional fields</dd></div>}
    </dl>;
  }
  return String(value);
}

function readStoryWorldCover(value: unknown): StoryWorldCover | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cover = value as Partial<StoryWorldCover>;
  return ["image/jpeg", "image/png", "image/webp"].includes(cover.mime_type || "") && typeof cover.data_base64 === "string"
    && typeof cover.alt_text === "string"
    ? cover as StoryWorldCover
    : null;
}

function storyWorldCoverUrl(cover: StoryWorldCover): string {
  return `data:${cover.mime_type};base64,${cover.data_base64}`;
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The cover image could not be read."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) reject(new Error("The cover image could not be encoded."));
      else resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function encodeStoryWorldCover(file: File): Promise<StoryWorldCover> {
  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, 960 / bitmap.width, 540 / bitmap.height);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare a cover image.");
    for (let resize = 0; resize < 9; resize += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = "#17201d";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.7, 0.58, 0.46]) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size <= 65_536) {
          const altText = file.name.replace(/\.[^.]+$/, "").slice(0, 300);
          return { mime_type: "image/jpeg", data_base64: await readBlobAsBase64(blob), alt_text: altText };
        }
      }
      scale *= 0.78;
    }
    throw new Error("Choose a simpler image; world covers are limited to 64 KiB after compression.");
  } finally {
    bitmap.close();
  }
}

function uniqueLibraryCopyName(sourceName: string, existingNames: string[]): string {
  const used = new Set(existingNames.map((name) => name.trim().toLocaleLowerCase()));
  let copyNumber = 1;
  while (true) {
    const suffix = copyNumber === 1 ? " (copy)" : ` (copy ${copyNumber})`;
    const candidate = `${sourceName.trim().slice(0, 200 - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
    copyNumber += 1;
  }
}

const NAV: { id: Page; title: string; icon: string; sub: string }[] = [
  { id: "story", title: "Play & create", icon: "✳", sub: "Stories, worlds, and heroes" },
  { id: "knowledge", title: "Knowledge Explorer", icon: "⌘", sub: "Sources and facts" },
  { id: "journal", title: "Journal & Memory", icon: "▤", sub: "Personal notes" },
  { id: "scenario", title: "What-if scenarios", icon: "◇", sub: "Compare choices safely" },
];

export default function App() {
  const [page, setPage] = useState<Page>("story");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [branches, setBranches] = useState<Branch[]>([{ branch_id: "main", parent_branch_id: null, parent_revision: null, base_revision: 0, head_revision: 0, created_at: new Date().toISOString() }]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [branchId, setBranchId] = useState("main");
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  const [dataEpoch, setDataEpoch] = useState(0);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>({ tone: "info", text: "Connecting to your private workspace…" });
  const selectedScope = JSON.stringify([workspaceId, branchId]);
  const selectedScopeRef = useRef(selectedScope);
  selectedScopeRef.current = selectedScope;
  const refreshRequest = useRef(0);
  const [loadedScope, setLoadedScope] = useState("");
  const [loadFailure, setLoadFailure] = useState<{ scope: string; message: string } | null>(null);

  const activeWorkspace = useMemo(() => workspaces.find((item) => item.workspace_id === workspaceId), [workspaces, workspaceId]);

  const refresh = useCallback(async (id = workspaceId, branch = branchId) => {
    if (!id) return;
    const requestNumber = ++refreshRequest.current;
    const requestedScope = JSON.stringify([id, branch]);
    if (requestedScope === selectedScopeRef.current) setLoadFailure(null);
    const [entityRows, relationRows, claimRows, sourceRows, branchRows, rev] = await Promise.all([
      request<Entity[]>(`/api/v1/workspaces/${encodeURIComponent(id)}/entities?branch_id=${encodeURIComponent(branch)}`),
      request<Relation[]>(`/api/v1/workspaces/${encodeURIComponent(id)}/relations?branch_id=${encodeURIComponent(branch)}`),
      request<Claim[]>(`/api/v1/workspaces/${encodeURIComponent(id)}/claims?branch_id=${encodeURIComponent(branch)}`),
      request<Source[]>(`/api/v1/workspaces/${encodeURIComponent(id)}/sources`),
      request<Branch[]>(`/api/v1/workspaces/${encodeURIComponent(id)}/branches`),
      request<{ revision: number }>(`/api/v1/workspaces/${encodeURIComponent(id)}/revision?branch_id=${encodeURIComponent(branch)}`),
    ]).catch((error: unknown) => {
      if (requestNumber === refreshRequest.current && requestedScope === selectedScopeRef.current) {
        setLoadFailure({ scope: requestedScope, message: error instanceof Error ? error.message : "The workspace could not be loaded." });
      }
      throw error;
    });
    if (requestNumber !== refreshRequest.current || requestedScope !== selectedScopeRef.current) return;
    setEntities(entityRows);
    setRelations(relationRows);
    setClaims(claimRows);
    setSources(sourceRows);
    setBranches(branchRows);
    setRevision(rev.revision);
    revisionRef.current = rev.revision;
    setLoadedScope(requestedScope);
  }, [workspaceId, branchId, query]);

  const load = useCallback(async () => {
    try {
      const rows = await request<Workspace[]>("/api/v1/workspaces");
      setWorkspaces(rows);
      const selected = rows.find((item) => item.workspace_id === workspaceId)?.workspace_id ?? rows[0]?.workspace_id ?? "";
      setWorkspaceId(selected);
      if (selected) await refresh(selected, branchId);
      setNotice({ tone: "success", text: "Your data stays on this device." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The local service is unavailable." });
    }
  }, [branchId, refresh, workspaceId]);

  useEffect(() => { void load(); }, []);
  useEffect(() => { if (workspaceId) void refresh().catch((error) => setNotice({ tone: "error", text: String(error) })); }, [workspaceId, branchId, refresh]);

  async function submit(event: FormEvent, action: () => Promise<void>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Something went wrong." }); }
    finally { setBusy(false); }
  }

  async function createWorkspace(event: FormEvent) {
    await submit(event, async () => {
      const name = workspaceName.trim();
      if (!name) return;
      const created = await request<Workspace & { branch_id: string }>("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ name }) });
      setWorkspaceName("");
      setWorkspaces((rows) => [...rows, { ...created, created_at: new Date().toISOString(), main_revision: 0 }]);
      setWorkspaceId(created.workspace_id);
      setBranches([{ branch_id: "main", parent_branch_id: null, parent_revision: null, base_revision: 0, head_revision: 0, created_at: new Date().toISOString() }]);
      setBranchId("main");
      revisionRef.current = 0;
      setRevision(0);
      setNotice({ tone: "success", text: `Created “${created.name}”.` });
    });
  }

  const runCommand = async (commandType: string, payload: Record<string, unknown>, reason: string) => {
    if (!workspaceId) throw new Error("Create or select a workspace first.");
    const result = await request<Record<string, unknown>>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/commands`, {
      method: "POST",
      body: JSON.stringify({ branch_id: branchId, expected_revision: revisionRef.current, idempotency_key: newId("cmd"), command_type: commandType, payload, reason }),
    });
    if (typeof result.revision === "number") {
      revisionRef.current = result.revision;
      setRevision(result.revision);
    }
    await refresh();
    return result;
  };

  const commitStoryCommand = async (commandType: string, payload: Record<string, unknown>, reason: string): Promise<Record<string, unknown>> => {
    if (busy) throw new Error("Another workspace change is already in progress.");
    setBusy(true);
    try {
      const result = await runCommand(commandType, payload, reason);
      const successText = commandType === "create_conversation"
        ? "Story started on this branch."
        : commandType === "add_belief"
          ? "Character knowledge saved to this branch."
          : commandType === "update_entity"
            ? "Character identity saved to this adventure only."
            : "Adventure state saved.";
      setNotice({ tone: "success", text: successText });
      return result;
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The change could not be saved." });
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const commitBranchCommand = async (targetBranchId: string, commandType: string, payload: Record<string, unknown>, reason: string): Promise<Record<string, unknown>> => {
    if (!workspaceId) throw new Error("Create or select a workspace first.");
    if (busy) throw new Error("Another workspace change is already in progress.");
    const branchRevision = branches.find((item) => item.branch_id === targetBranchId)?.head_revision;
    if (branchRevision === undefined) throw new Error("Refresh the workspace before changing this adventure.");
    setBusy(true);
    try {
      const result = await request<Record<string, unknown>>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/commands`, {
        method: "POST",
        body: JSON.stringify({ branch_id: targetBranchId, expected_revision: branchRevision, idempotency_key: newId("branch-cmd"), command_type: commandType, payload, reason }),
      });
      await refresh(workspaceId, branchId);
      setNotice({ tone: "success", text: "Adventure library changes saved." });
      return result;
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The adventure could not be updated." });
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const commitMainCommand = async (commandType: string, payload: Record<string, unknown>, reason: string): Promise<Record<string, unknown>> => {
    if (!workspaceId) throw new Error("Create or select a workspace first.");
    if (busy) throw new Error("Another workspace change is already in progress.");
    setBusy(true);
    try {
      const mainRevision = branches.find((item) => item.branch_id === "main")?.head_revision ?? 0;
      const result = await request<Record<string, unknown>>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/commands`, {
        method: "POST",
        body: JSON.stringify({ branch_id: "main", expected_revision: mainRevision, idempotency_key: newId("main-cmd"), command_type: commandType, payload, reason }),
      });
      if (typeof result.revision === "number" && branchId === "main") {
        revisionRef.current = result.revision;
        setRevision(result.revision);
      }
      await refresh();
      setNotice({ tone: "success", text: "Saved to the main world library." });
      return result;
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The world could not be saved." });
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const createStoryAdventure = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!workspaceId) throw new Error("Create or select a workspace first.");
    if (busy) throw new Error("Another workspace change is already in progress.");
    setBusy(true);
    try {
      const mainRevision = branches.find((item) => item.branch_id === "main")?.head_revision ?? 0;
      const created = await request<Record<string, unknown>>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures`, {
        method: "POST",
        body: JSON.stringify({ ...payload, expected_revision: mainRevision }),
      });
      const targetBranch = String(created.branch_id || (created.adventure as Record<string, unknown>)?.branch_id || payload.adventure_id);
      setBranchId(targetBranch);
      setNotice({ tone: "success", text: "Adventure started from a pinned world version." });
      return created;
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The adventure could not be started." });
      throw error;
    } finally {
      setBusy(false);
    }
  };

  async function commitDomainCommand(commandType: string, payload: Record<string, unknown>, reason: string, successText: string) {
    if (busy) throw new Error("Another workspace change is already in progress.");
    setBusy(true);
    try {
      await runCommand(commandType, payload, reason);
      setNotice({ tone: "success", text: successText });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The change could not be saved." });
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function addEntity(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const data = new FormData(form);
    await submit(event, async () => {
      await runCommand("create_entity", { entity_type: data.get("entity_type"), label: data.get("label"), properties: {} }, "Add a reviewed workspace item");
      form.reset();
      setNotice({ tone: "success", text: "Added to this branch." });
    });
  }

  async function addRelation(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const data = new FormData(form);
    await submit(event, async () => {
      await runCommand("add_relation", { source_entity_id: data.get("source"), target_entity_id: data.get("target"), relation_type: data.get("relation_type"), review_status: "proposed" }, "Propose a relationship for review");
      form.reset();
      setNotice({ tone: "success", text: "Relationship saved as a proposal." });
    });
  }

  async function addClaim(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const data = new FormData(form);
    await submit(event, async () => {
      const sourceId = String(data.get("source_id") || "");
      const quote = String(data.get("evidence_quote") || "").trim();
      let evidence: string[] = [];
      if (sourceId || quote) {
        if (!sourceId || !quote) throw new Error("Choose a source and enter an exact quote, or leave both blank.");
        const result = await runCommand("add_evidence", { source_id: sourceId, anchor: "manually selected quote", quote }, "Attach a source quote to a proposed claim");
        evidence = [String(result.evidence_id)];
      }
      await runCommand("add_claim", { subject_entity_id: data.get("subject"), predicate: data.get("predicate"), object_value: data.get("object_value"), evidence, visibility: "public", review_status: "proposed" }, "Propose a claim for review");
      form.reset();
      setNotice({ tone: "success", text: "Claim saved as a proposal." });
    });
  }

  async function importText(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const data = new FormData(form);
    await submit(event, async () => {
      const selected = data.get("file");
      const file = selected instanceof File && selected.name ? selected : null;
      if (file && file.size > 10 * 1024 * 1024) throw new Error("Text imports are limited to 10 MB.");
      if (file && !/\.(txt|md|markdown)$/i.test(file.name)) throw new Error("Choose a .txt or Markdown file.");
      let content: string;
      if (file) {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
        } catch {
          throw new Error("Text files must use UTF-8 encoding.");
        }
      } else {
        content = String(data.get("content") || "");
      }
      const displayName = file?.name || String(data.get("display_name") || "").trim();
      if (!displayName) throw new Error("Add a source title or choose a local text file.");
      if (!content.trim()) throw new Error("Add text content or choose a non-empty local text file.");
      if (content.includes("\0")) throw new Error("The selected file contains binary data. Choose a plain text or Markdown file.");
      if (new TextEncoder().encode(content).length > 10 * 1024 * 1024) throw new Error("Text imports are limited to 10 MB.");
      const mediaType = file && /\.(md|markdown)$/i.test(file.name) ? "text/markdown" : "text/plain";
      await runCommand("import_source", { display_name: displayName, content, media_type: mediaType }, "Import a local text source");
      form.reset();
      setNotice({ tone: "success", text: "Source is stored locally. No extraction has been run." });
    });
  }

  async function extractSource(sourceId: string, model: string) {
    if (busy) throw new Error("Another workspace change is already in progress.");
    if (!workspaceId) throw new Error("Create or select a workspace first.");
    setBusy(true);
    try {
      const result = await request<{ revision: number; idempotent_replay: boolean }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}/extract`,
        {
          method: "POST",
          body: JSON.stringify({
            branch_id: branchId,
            expected_revision: revisionRef.current,
            idempotency_key: newId("extract"),
            model,
          }),
        },
      );
      if (typeof result.revision === "number") {
        revisionRef.current = result.revision;
        setRevision(result.revision);
      }
      await refresh(workspaceId, branchId);
      setNotice({ tone: "success", text: result.idempotent_replay ? "Loaded the saved extraction batch." : "Source candidates are ready for review." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Source extraction failed." });
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function saveBackup() {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await downloadBackup();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `lorethra-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.lkebackup`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
      setNotice({ tone: "success", text: "Full local backup downloaded. Store the .lkebackup file somewhere safe." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Backup could not be created." });
    } finally {
      setBusy(false);
    }
  }

  async function rebuildSearch() {
    if (busy) return;
    setBusy(true);
    try {
      const rebuilt = await request<{ entities: number; sources: number }>("/api/v1/projections/search/rebuild", { method: "POST" });
      const entityLabel = rebuilt.entities === 1 ? "entity" : "entities";
      const sourceLabel = rebuilt.sources === 1 ? "source" : "sources";
      setNotice({
        tone: "success",
        text: `Search indexes rebuilt from ${rebuilt.entities} ${entityLabel} and ${rebuilt.sources} ${sourceLabel}. Canonical history was unchanged.`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Search indexes could not be rebuilt." });
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (!/\.lkebackup$/i.test(file.name)) {
      setNotice({ tone: "error", text: "Choose a Lorethra .lkebackup file." });
      input.value = "";
      return;
    }
    const confirmed = window.confirm(
      "Restoring replaces every workspace in this Lorethra installation with the selected backup. This cannot be undone from Lorethra. Download a backup of the current data first if you want to keep it. Continue?",
    );
    if (!confirmed) {
      input.value = "";
      return;
    }
    if (busy) return;
    setBusy(true);
    let restoreCompleted = false;
    try {
      const restored = await request<{
        manifest: { created_at: string; schema_version: number; database_size: number };
        workspaces: Workspace[];
      }>("/api/v1/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      restoreCompleted = true;
      const selected = restored.workspaces.find((workspace) => workspace.workspace_id === workspaceId)?.workspace_id
        || restored.workspaces[0]?.workspace_id
        || "";
      setWorkspaces(restored.workspaces);
      setWorkspaceId(selected);
      setBranchId("main");
      setPage("story");
      setDataEpoch((value) => value + 1);
      setNotice({ tone: "info", text: "Backup restored and integrity checks passed. Reloading the workspace…" });
      if (selected) {
        await refresh(selected, "main");
      } else {
        setBranches([]);
        setEntities([]);
        setRelations([]);
        setClaims([]);
        setSources([]);
        setRevision(0);
        revisionRef.current = 0;
      }
      const workspaceCount = restored.workspaces.length;
      const workspaceLabel = workspaceCount === 1 ? "workspace" : "workspaces";
      setNotice({
        tone: "success",
        text: `Restored ${workspaceCount} ${workspaceLabel} from ${new Date(restored.manifest.created_at).toLocaleString()}. Schema v${restored.manifest.schema_version} · ${restored.manifest.database_size.toLocaleString()} database bytes. Integrity and foreign-key checks passed.`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The local service could not refresh the workspace.";
      setNotice({
        tone: "error",
        text: restoreCompleted
          ? `Backup restored and verified, but the workspace could not be refreshed: ${detail}. Use Refresh to reload; you do not need to restore the backup again.`
          : detail,
      });
    } finally {
      setBusy(false);
      input.value = "";
    }
  }

  async function review(kind: "claim" | "relation", id: string, status: "accepted" | "rejected") {
    setBusy(true);
    try {
      await runCommand(kind === "claim" ? "review_claim" : "review_relation", { [`${kind}_id`]: id, review_status: status }, `User ${status} ${kind}`);
      setNotice({ tone: "success", text: `${kind === "claim" ? "Claim" : "Relationship"} ${status}.` });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Review failed." }); }
    finally { setBusy(false); }
  }

  async function reviewRule(id: string, status: "accepted" | "rejected") {
    if (busy) return;
    setBusy(true);
    try {
      await runCommand("review_rule", { rule_id: id, review_status: status }, `User ${status} rule`);
      setNotice({ tone: "success", text: `Rule ${status}.` });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Rule review failed." }); }
    finally { setBusy(false); }
  }

  async function reviewScenarioAssumption(scenarioId: string, optionId: string, assumptionId: string, version: number, status: "accepted" | "rejected") {
    if (busy) return;
    setBusy(true);
    try {
      await runCommand("review_scenario_assumption", {
        scenario_id: scenarioId, option_id: optionId, assumption_id: assumptionId,
        expected_version: version, review_status: status,
      }, `User ${status} scenario assumption`);
      setNotice({ tone: "success", text: `Scenario assumption ${status}.` });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Assumption review failed." }); }
    finally { setBusy(false); }
  }

  async function createScenario() {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const id = `scenario_${crypto.randomUUID().slice(0, 8)}`;
      await request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/branches`, {
        method: "POST", body: JSON.stringify({ branch_id: id, parent_branch_id: branchId, expected_revision: revisionRef.current, idempotency_key: newId("branch"), reason: "Explore a scenario without changing its parent" }),
      });
      setBranchId(id);
      setPage("scenario");
      setNotice({ tone: "success", text: "Created an isolated scenario snapshot." });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not create branch." }); }
    finally { setBusy(false); }
  }

  async function promoteScenarioBranch(sourceBranchId: string, sourceRevision: number, targetBranchId: string, targetRevision: number) {
    if (!workspaceId) throw new Error("Create or select a workspace first.");
    if (busy) throw new Error("Another workspace change is already in progress.");
    setBusy(true);
    try {
      await request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/commands`, {
        method: "POST",
        body: JSON.stringify({
          branch_id: targetBranchId,
          expected_revision: targetRevision,
          idempotency_key: newId("promote"),
          command_type: "promote_branch",
          payload: { source_branch_id: sourceBranchId, source_revision: sourceRevision },
          reason: `Promote reviewed branch ${sourceBranchId}`,
        }),
      });
      setBranchId(targetBranchId);
      await refresh(workspaceId, targetBranchId);
      setNotice({ tone: "success", text: `Promoted ${sourceBranchId} into ${targetBranchId}.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The branch could not be promoted." });
      throw error;
    } finally {
      setBusy(false);
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entityLabels = new Map(entities.map((entity) => [entity.entity_id, entity.label]));
  const visibleClaims = claims.filter((claim) => !normalizedQuery ||
    `${entityLabels.get(claim.subject_entity_id) || claim.subject_entity_id} ${claim.subject_entity_id} ${claim.predicate} ${claim.object_value}`
      .toLocaleLowerCase().includes(normalizedQuery));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">L</div><div><strong>Lorethra</strong><span>STORIES & WORLDS</span></div></div>
        <div className="workspace-label">YOUR SPACE</div>
        <select className="workspace-select" value={workspaceId} disabled={busy} onChange={(event) => { setWorkspaceId(event.target.value); setBranchId("main"); }} aria-label="Select workspace">
          <option value="">Choose your space</option>
          {workspaces.map((workspace) => <option key={workspace.workspace_id} value={workspace.workspace_id}>{workspace.name}</option>)}
        </select>
        <nav className="primary-nav" aria-label="Main navigation">
          {NAV.filter((item) => item.id === "story").map((item) => <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => setPage(item.id)}>
            <span className="nav-icon">{item.icon}</span><span><b>{item.title}</b><small>{item.sub}</small></span>
          </button>)}
        </nav>
        <details className="sidebar-more-tools" open={page !== "story"}>
          <summary>More tools <small>Knowledge, notes, and scenarios</small></summary>
          <nav aria-label="More tools">
            {NAV.filter((item) => item.id !== "story").map((item) => <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => setPage(item.id)}>
              <span className="nav-icon">{item.icon}</span><span><b>{item.title}</b><small>{item.sub}</small></span>
            </button>)}
          </nav>
        </details>
        <div className="sidebar-bottom"><span className="privacy-dot" />Saved on this device</div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>{activeWorkspace?.name || "Your stories and notes"}</span></div>
          <details className="project-options">
            <summary>More project options</summary>
            <div className="project-options-menu">
              <label>Current branch<select className="branch-select" aria-label="Select branch" value={branchId} disabled={busy} onChange={(event) => setBranchId(event.target.value)}>{branches.map((branch) => <option key={branch.branch_id} value={branch.branch_id}>{branch.branch_id === "main" ? "Main" : branch.branch_id}</option>)}</select></label>
              <span className="revision-chip">Revision {revision}</span>
              <button className="quiet-button" disabled={busy} onClick={() => void rebuildSearch()}>Repair search</button>
              <button className="quiet-button" disabled={busy || !workspaceId} onClick={() => void saveBackup()}>Make a backup</button>
              <button className="quiet-button" disabled={busy} onClick={() => restoreInputRef.current?.click()}>Restore a backup</button>
              <input ref={restoreInputRef} type="file" accept=".lkebackup,application/zip" hidden onChange={(event) => void restoreBackup(event)} />
              <button className="quiet-button" disabled={busy} onClick={() => void load()}>Refresh</button>
            </div>
          </details>
        </header>
        <div className="page-content">
          {notice && <div className={`notice ${notice.tone}`} role="status"><span>{notice.tone === "error" ? "!" : notice.tone === "success" ? "✓" : "·"}</span>{notice.text}<button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}

          {!workspaceId ? <section className="welcome-card">
            <div className="eyebrow">Welcome to Lorethra</div>
            <h1>Create your story space</h1>
            <p>Your adventures, worlds, and notes are saved on this device.</p>
            <form className="inline-create" onSubmit={createWorkspace}>
              <label className="field-label">Space name<input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="For example, My stories" aria-label="Space name" maxLength={200} /></label>
              <button className="primary-button" disabled={busy}>Create my space <span>↗</span></button>
            </form>
            <div className="welcome-points"><span><span className="privacy-dot" />Private to this device</span></div>
          </section> : loadedScope !== selectedScope ? <section className="panel" role="status">
            {loadFailure?.scope === selectedScope ? <>
              <h2>The selected workspace could not be loaded.</h2>
              <p>{loadFailure.message}</p>
              <button className="secondary-button" disabled={busy} onClick={() => void refresh().catch(() => {})}>Retry loading</button>
            </> : <p>Loading the selected workspace and branch…</p>}
          </section> : <>
            {page === "knowledge" && <KnowledgePage key={JSON.stringify([dataEpoch, workspaceId, branchId])}
              workspaceId={workspaceId} branchId={branchId} revision={revision} entities={entities} relations={relations} claims={visibleClaims} sources={sources} busy={busy} query={query} setQuery={setQuery}
              addEntity={addEntity} addRelation={addRelation} addClaim={addClaim} importText={importText} review={review} onExtract={extractSource} onCommit={commitDomainCommand}
            />}
          {page === "story" && <StoryPage key={JSON.stringify([dataEpoch, workspaceId, branchId])} entities={entities} claims={claims} workspaceId={workspaceId} branchId={branchId} revision={revision} busy={busy} onNavigate={setPage} onSelectBranch={setBranchId} onCommit={commitStoryCommand} onCommitBranch={commitBranchCommand} onMainCommit={commitMainCommand} onCreateAdventure={createStoryAdventure} onRevisionChange={(value) => { revisionRef.current = value; setRevision(value); }} onRefresh={() => refresh()} />}
            {page === "journal" && <JournalPage key={JSON.stringify([dataEpoch, workspaceId, branchId])} workspaceId={workspaceId} branchId={branchId} revision={revision} sources={sources} importText={importText} busy={busy} onCommit={commitDomainCommand} />}
            {page === "scenario" && <ScenarioPage key={JSON.stringify([dataEpoch, workspaceId, branchId])} workspaceId={workspaceId} branchId={branchId} branches={branches} revision={revision} entities={entities} relations={relations} claims={claims} sources={sources} busy={busy} onBranch={createScenario} onPromote={promoteScenarioBranch} onCommit={commitDomainCommand} onReviewRule={reviewRule} onReviewAssumption={reviewScenarioAssumption} />}
          </>}
        </div>
      </main>
    </div>
  );
}

function PageHeader({ kicker, title, summary, action }: { kicker: string; title: string; summary: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{kicker}</div><h1>{title}</h1><p>{summary}</p></div>{action}</div>;
}

function KnowledgePage(props: {
  workspaceId: string; branchId: string; revision: number; entities: Entity[]; relations: Relation[]; claims: Claim[]; sources: Source[]; busy: boolean; query: string; setQuery: (query: string) => void;
  addEntity: (event: FormEvent<HTMLFormElement>) => Promise<void>; addRelation: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  addClaim: (event: FormEvent<HTMLFormElement>) => Promise<void>; importText: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  review: (kind: "claim" | "relation", id: string, status: "accepted" | "rejected") => Promise<void>;
  onExtract: (sourceId: string, model: string) => Promise<void>;
  onCommit: (commandType: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<"map" | "matrix" | "records" | "history" | "evidence" | "extraction" | "review">("map");
  return <>
    <PageHeader kicker="Your knowledge space" title="Knowledge Explorer" summary="Build a source-backed map of people, ideas, events, and their relationships." />
    <div className="metric-row"><Metric value={props.entities.length} label="Concepts" icon="◉" /><Metric value={props.relations.length} label="Relationships" icon="⟷" /><Metric value={props.claims.length} label="Claims" icon="≋" /><Metric value={props.claims.filter((item) => item.review_status === "proposed").length + props.relations.filter((item) => item.review_status === "proposed").length} label="Needs review" icon="◷" accent /></div>
    <div className="toolbar knowledge-toolbar"><div className="tabs knowledge-tabs"><button className={tab === "map" ? "selected" : ""} onClick={() => setTab("map")}>Knowledge map</button><button className={tab === "matrix" ? "selected" : ""} onClick={() => setTab("matrix")}>Relationship matrix</button><button className={tab === "records" ? "selected" : ""} onClick={() => setTab("records")}>Edit records</button><button className={tab === "history" ? "selected" : ""} onClick={() => setTab("history")}>History</button><button className={tab === "evidence" ? "selected" : ""} onClick={() => setTab("evidence")}>Sources</button><button className={tab === "extraction" ? "selected" : ""} onClick={() => setTab("extraction")}>AI extraction</button><button className={tab === "review" ? "selected" : ""} onClick={() => setTab("review")}>Review</button></div><label className="search-box"><span>⌕</span><input value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="Search this workspace" aria-label="Search workspace" /></label></div>
    {tab === "map" && <div className="knowledge-grid"><section className="panel graph-panel"><div className="panel-heading"><div><h2>Concept map</h2><p>Accepted links and proposals share one editable source.</p></div><span className="panel-count">{props.entities.length} nodes</span></div><Graph entities={props.entities} relations={props.relations} /><div className="graph-legend"><span><i className="legend-node" />Concept</span><span><i className="legend-line" />Accepted relationship</span><span><i className="legend-line proposed" />Needs review</span></div></section>
      <div className="stacked-panels"><EntityForm busy={props.busy} onSubmit={props.addEntity} /><RelationForm entities={props.entities} busy={props.busy} onSubmit={props.addRelation} /></div></div>}
    {tab === "matrix" && <RelationMatrix entities={props.entities} relations={props.relations} />}
    {tab === "records" && <KnowledgeRecords entities={props.entities} relations={props.relations} claims={props.claims} query={props.query} busy={props.busy} onCommit={props.onCommit} />}
    {tab === "history" && <RevisionHistory workspaceId={props.workspaceId} branchId={props.branchId} />}
    {tab === "evidence" && <div className="knowledge-grid"><SourceForm busy={props.busy} onSubmit={props.importText} /><SourceResults workspaceId={props.workspaceId} query={props.query} /> </div>}
    {tab === "extraction" && <ExtractionReviewPanel workspaceId={props.workspaceId} branchId={props.branchId} revision={props.revision} entities={props.entities} sources={props.sources} busy={props.busy} onExtract={props.onExtract} onCommit={props.onCommit} />}
    {tab === "review" && <div className="review-list"><ReviewList claims={props.claims} relations={props.relations} review={props.review} busy={props.busy} /></div>}
    {tab !== "records" && <section className="panel claims-panel"><div className="panel-heading"><div><h2>Claims</h2><p>Epistemic confidence and review status are kept distinct.</p></div></div><ClaimForm entities={props.entities} sources={props.sources} busy={props.busy} onSubmit={props.addClaim} /><div className="claim-list">{props.claims.length ? props.claims.map((claim) => <div className="claim-row" key={claim.claim_id}><span className={`status-dot ${claim.review_status}`} /><div><strong>{props.entities.find((item) => item.entity_id === claim.subject_entity_id)?.label || claim.subject_entity_id} <span className="claim-predicate">{claim.predicate}</span> {claim.object_value}</strong><small>{claim.epistemic_status} · {claim.review_status} · {claim.visibility} · {claim.evidence.length} evidence</small></div>{claim.review_status === "proposed" && <button className="link-button" onClick={() => void props.review("claim", claim.claim_id, "accepted")} disabled={props.busy}>Review</button>}</div>) : <p className="empty-hint">No claims yet. Add a claim and review it before it becomes accepted knowledge.</p>}</div></section>}
  </>;
}

function KnowledgeRecords({ entities, relations, claims, query, busy, onCommit }: {
  entities: Entity[];
  relations: Relation[];
  claims: Claim[];
  query: string;
  busy: boolean;
  onCommit: (commandType: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
}) {
  const search = query.trim().toLocaleLowerCase();
  const entityById = new Map(entities.map((item) => [item.entity_id, item]));
  const visibleEntities = entities.filter((item) => !search || `${item.label} ${item.entity_type} ${JSON.stringify(item.properties)}`.toLocaleLowerCase().includes(search));
  const visibleRelations = relations.filter((item) => {
    const source = entityById.get(item.source_entity_id)?.label || item.source_entity_id;
    const target = entityById.get(item.target_entity_id)?.label || item.target_entity_id;
    return !search || `${source} ${target} ${item.relation_type} ${item.review_status} ${JSON.stringify(item.properties)}`.toLocaleLowerCase().includes(search);
  });
  const visibleClaims = claims.filter((item) => {
    const subject = entityById.get(item.subject_entity_id)?.label || item.subject_entity_id;
    return !search || `${subject} ${item.subject_entity_id} ${item.predicate} ${item.object_value} ${item.epistemic_status} ${item.review_status}`.toLocaleLowerCase().includes(search);
  });

  return <div className="knowledge-records">
    <section className="panel knowledge-record-panel">
      <div className="panel-heading"><div><h2>Concepts</h2><p>Correct names, types, and structured properties. Stable IDs remain unchanged.</p></div><span className="panel-count">{visibleEntities.length} shown</span></div>
      {visibleEntities.length ? visibleEntities.map((entity) => <EntityRecordEditor key={entity.entity_id} entity={entity} busy={busy} onCommit={onCommit} />)
        : <p className="empty-hint">No concepts match this search.</p>}
    </section>
    <section className="panel knowledge-record-panel">
      <div className="panel-heading"><div><h2>Relationships</h2><p>Correct endpoints, relationship type, or properties. A changed relationship returns to proposed review.</p></div><span className="panel-count">{visibleRelations.length} shown</span></div>
      {visibleRelations.length ? visibleRelations.map((relation) => <RelationRecordEditor key={relation.relation_id} relation={relation} entities={entities} entityById={entityById} busy={busy} onCommit={onCommit} />)
        : <p className="empty-hint">No relationships match this search.</p>}
    </section>
    <section className="panel knowledge-record-panel">
      <div className="panel-heading"><div><h2>Claims</h2><p>Correct the assertion or its epistemic context. Meaning changes return reviewed claims to proposed status.</p></div><span className="panel-count">{visibleClaims.length} shown</span></div>
      {visibleClaims.length ? visibleClaims.map((claim) => <ClaimRecordEditor key={claim.claim_id} claim={claim} entities={entities} entityById={entityById} busy={busy} onCommit={onCommit} />)
        : <p className="empty-hint">No claims match this search.</p>}
    </section>
  </div>;
}

function EntityRecordEditor({ entity, busy, onCommit }: {
  entity: Entity;
  busy: boolean;
  onCommit: (commandType: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let properties: unknown;
    try { properties = JSON.parse(String(data.get("properties") || "{}")); }
    catch { setError("Properties must be valid JSON."); return; }
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      setError("Properties must be a JSON object.");
      return;
    }
    try {
      await onCommit("update_entity", {
        entity_id: entity.entity_id,
        entity_type: String(data.get("entity_type") || ""),
        label: String(data.get("label") || ""),
        properties: properties as Record<string, unknown>,
      }, `Correct entity ${entity.label}`, "Entity correction saved.");
      setError("");
      setEditing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Entity correction failed."); }
  }

  return <article className="knowledge-record-row">
    <div className="knowledge-record-heading"><div><strong>{entity.label}</strong><small>{entity.entity_type} · updated at revision {entity.updated_revision}</small></div>
      <button type="button" className="link-button" disabled={busy} onClick={() => { setEditing((value) => !value); setError(""); }}>{editing ? "Cancel" : "Edit"}</button>
    </div>
    <details className="record-properties"><summary>Current properties</summary><pre>{JSON.stringify(entity.properties, null, 2)}</pre></details>
    {editing && <form className="record-edit-form" onSubmit={(event) => void save(event)}>
      <label>Display name<input name="label" required maxLength={500} defaultValue={entity.label} disabled={busy} /></label>
      <label>Type<input name="entity_type" required maxLength={100} defaultValue={entity.entity_type} disabled={busy} /></label>
      <label>Properties (JSON)<textarea name="properties" rows={5} maxLength={10000} defaultValue={JSON.stringify(entity.properties, null, 2)} disabled={busy} /></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="secondary-button" disabled={busy}>Save correction</button>
    </form>}
  </article>;
}

function RelationRecordEditor({ relation, entities, entityById, busy, onCommit }: {
  relation: Relation;
  entities: Entity[];
  entityById: Map<string, Entity>;
  busy: boolean;
  onCommit: (commandType: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const sourceLabel = entityById.get(relation.source_entity_id)?.label || relation.source_entity_id;
  const targetLabel = entityById.get(relation.target_entity_id)?.label || relation.target_entity_id;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let properties: unknown;
    try { properties = JSON.parse(String(data.get("properties") || "{}")); }
    catch { setError("Properties must be valid JSON."); return; }
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      setError("Properties must be a JSON object.");
      return;
    }
    try {
      await onCommit("update_relation", {
        relation_id: relation.relation_id,
        source_entity_id: String(data.get("source_entity_id") || ""),
        target_entity_id: String(data.get("target_entity_id") || ""),
        relation_type: String(data.get("relation_type") || ""),
        properties: properties as Record<string, unknown>,
      }, `Correct relationship ${sourceLabel} · ${relation.relation_type} · ${targetLabel}`, "Relationship correction saved for review.");
      setError("");
      setEditing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Relationship correction failed."); }
  }

  return <article className="knowledge-record-row">
    <div className="knowledge-record-heading"><div><strong>{sourceLabel} · {relation.relation_type} · {targetLabel}</strong><small>{relation.review_status} · relationship {relation.relation_id}</small></div>
      <button type="button" className="link-button" disabled={busy} onClick={() => { setEditing((value) => !value); setError(""); }}>{editing ? "Cancel" : "Edit"}</button>
    </div>
    <details className="record-properties"><summary>Current properties</summary><pre>{JSON.stringify(relation.properties, null, 2)}</pre></details>
    {editing && <form className="record-edit-form" onSubmit={(event) => void save(event)}>
      <label>From<select name="source_entity_id" required defaultValue={relation.source_entity_id} disabled={busy}>{entities.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label} · {item.entity_type} · {item.entity_id}</option>)}</select></label>
      <label>Relationship<input name="relation_type" required maxLength={100} defaultValue={relation.relation_type} disabled={busy} /></label>
      <label>To<select name="target_entity_id" required defaultValue={relation.target_entity_id} disabled={busy}>{entities.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label} · {item.entity_type} · {item.entity_id}</option>)}</select></label>
      <label>Properties (JSON)<textarea name="properties" rows={4} maxLength={10000} defaultValue={JSON.stringify(relation.properties, null, 2)} disabled={busy} /></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="secondary-button" disabled={busy || entities.length === 0}>Save correction</button>
    </form>}
  </article>;
}

function ClaimRecordEditor({ claim, entities, entityById, busy, onCommit }: {
  claim: Claim;
  entities: Entity[];
  entityById: Map<string, Entity>;
  busy: boolean;
  onCommit: (commandType: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const subjectLabel = entityById.get(claim.subject_entity_id)?.label || claim.subject_entity_id;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const narrativeOrder = Number(data.get("narrative_order"));
    if (!Number.isSafeInteger(narrativeOrder) || narrativeOrder < 0) {
      setError("Narrative order must be a non-negative whole number.");
      return;
    }
    try {
      await onCommit("update_claim", {
        claim_id: claim.claim_id,
        subject_entity_id: String(data.get("subject_entity_id") || ""),
        predicate: String(data.get("predicate") || ""),
        object_value: String(data.get("object_value") || ""),
        epistemic_status: String(data.get("epistemic_status") || "unknown"),
        visibility: String(data.get("visibility") || "public"),
        narrative_order: narrativeOrder,
      }, `Correct claim ${subjectLabel} · ${claim.predicate}`, "Claim correction saved as a proposal for review.");
      setError("");
      setEditing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Claim correction failed."); }
  }

  return <article className="knowledge-record-row">
    <div className="knowledge-record-heading"><div><strong>{subjectLabel} · {claim.predicate} · {claim.object_value}</strong><small>{claim.epistemic_status} · {claim.review_status} · {claim.visibility}</small></div>
      <button type="button" className="link-button" disabled={busy} onClick={() => { setEditing((value) => !value); setError(""); }}>{editing ? "Cancel" : "Edit"}</button>
    </div>
    {!!claim.evidence.length && <details className="record-properties"><summary>{claim.evidence.length} linked evidence record{claim.evidence.length === 1 ? "" : "s"}</summary><pre>{JSON.stringify(claim.evidence, null, 2)}</pre></details>}
    {editing && <form className="record-edit-form" onSubmit={(event) => void save(event)}>
      <label>Subject<select name="subject_entity_id" required defaultValue={claim.subject_entity_id} disabled={busy}>{entities.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label} · {item.entity_type} · {item.entity_id}</option>)}</select></label>
      <label>Predicate<input name="predicate" required maxLength={200} defaultValue={claim.predicate} disabled={busy} /></label>
      <label>Claimed value<textarea name="object_value" required maxLength={4000} rows={3} defaultValue={claim.object_value} disabled={busy} /></label>
      <label>Epistemic status<select name="epistemic_status" defaultValue={claim.epistemic_status} disabled={busy}><option value="unknown">Unknown</option><option value="believed">Believed</option><option value="known">Known</option><option value="contested">Contested</option></select></label>
      <label>Visibility<select name="visibility" defaultValue={claim.visibility} disabled={busy}><option value="public">Public</option><option value="actor_scoped">Actor scoped</option><option value="author_only">Author only</option></select></label>
      <label>Narrative order<input name="narrative_order" type="number" min="0" step="1" required defaultValue={claim.narrative_order} disabled={busy} /></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="secondary-button" disabled={busy || entities.length === 0}>Save correction</button>
    </form>}
  </article>;
}

function ExtractionReviewPanel({ workspaceId, branchId, revision, entities, sources, busy, onExtract, onCommit }: {
  workspaceId: string;
  branchId: string;
  revision: number;
  entities: Entity[];
  sources: Source[];
  busy: boolean;
  onExtract: (sourceId: string, model: string) => Promise<void>;
  onCommit: (commandType: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
}) {
  const [batches, setBatches] = useState<ExtractionBatch[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [selectedSourceId, setSelectedSourceId] = useState(sources[0]?.source_id || "");
  const [providerAvailable, setProviderAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [extracting, setExtracting] = useState(false);

  useEffect(() => {
    if (!sources.some((source) => source.source_id === selectedSourceId)) {
      setSelectedSourceId(sources[0]?.source_id || "");
    }
  }, [sources, selectedSourceId]);

  useEffect(() => {
    let active = true;
    request<OllamaModelStatus>("/api/v1/providers/ollama/models")
      .then((status) => {
        if (!active) return;
        setProviderAvailable(status.available);
        setModels(status.models);
        setModel((current) => status.models.includes(current) ? current : status.models[0] || "");
      })
      .catch(() => {
        if (active) {
          setProviderAvailable(false);
          setModels([]);
        }
      });
    return () => { active = false; };
  }, [workspaceId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    request<ExtractionBatch[]>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/extractions?branch_id=${encodeURIComponent(branchId)}`,
    ).then((rows) => {
      if (active) setBatches(rows);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Extraction history could not be loaded.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [workspaceId, branchId, revision]);

  async function runExtraction() {
    if (!selectedSourceId || !model || extracting || busy) return;
    setExtracting(true);
    setError("");
    try {
      await onExtract(selectedSourceId, model);
    } catch {
      // The shared workspace notice reports provider and command errors.
    } finally {
      setExtracting(false);
    }
  }

  async function reviewCandidate(candidate: ExtractionCandidate, payload: Record<string, unknown>, status: "accepted" | "rejected") {
    await onCommit(
      "review_extraction_candidate",
      payload,
      `User ${status} extracted ${candidate.kind}`,
      `Extraction ${candidate.kind} ${status}.`,
    );
  }

  const pendingCount = batches.reduce(
    (count, batch) => count + batch.candidates.filter((candidate) => candidate.review_status === "proposed").length,
    0,
  );

  return <div className="extraction-workspace">
    <section className="panel extraction-controls">
      <div className="panel-heading"><div><h2>Extract source candidates</h2><p>Local Ollama proposes source-grounded entities and claims. Nothing is accepted automatically.</p></div><span className="panel-count">{pendingCount} awaiting review</span></div>
      <div className="extraction-control-row">
        <label className="field-label">Source
          <select value={selectedSourceId} onChange={(event) => setSelectedSourceId(event.target.value)} disabled={!sources.length || busy || extracting}>
            <option value="">Choose a saved source</option>
            {sources.map((source) => <option key={source.source_id} value={source.source_id}>{source.display_name}</option>)}
          </select>
        </label>
        <label className="field-label">Local model
          <select value={model} onChange={(event) => setModel(event.target.value)} disabled={!models.length || busy || extracting}>
            <option value="">Choose an installed model</option>
            {models.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <button className="primary-button extraction-run" onClick={() => void runExtraction()} disabled={!providerAvailable || !selectedSourceId || !model || busy || extracting}>
          {extracting ? "Extracting…" : "Extract for review"} <span>↗</span>
        </button>
      </div>
      {!sources.length && <p className="empty-hint">Import a text or Markdown source before running extraction.</p>}
      {sources.length > 0 && !providerAvailable && <p className="inline-error">Ollama is not available on this device. Start the local Ollama service to extract candidates.</p>}
      {sources.length > 0 && providerAvailable && !models.length && <p className="empty-hint">Ollama is running, but no local model is installed yet.</p>}
      <small className="field-note">This pass supports text sources up to 24,000 characters. Each candidate must quote an exact span from its source.</small>
    </section>

    <section className="panel extraction-batches">
      <div className="panel-heading"><div><h2>Candidate review</h2><p>Review each item against its original quote. Accepting a claim also requires your entity, confidence, and visibility choices.</p></div><span className="panel-count">{batches.length} batches · {branchId}</span></div>
      {error && <p className="inline-error">{error}</p>}
      {loading ? <p className="empty-hint">Loading extraction history…</p>
        : batches.length ? batches.map((batch) => <article className="extraction-batch" key={batch.batch_id}>
          <div className="extraction-batch-heading"><div><strong>{batch.source_name}</strong><small>{batch.model} · revision {batch.created_revision} · {new Date(batch.created_at).toLocaleString()}</small></div><span>{batch.candidates.length} candidates</span></div>
          {batch.candidates.map((candidate) => <ExtractionCandidateCard key={candidate.candidate_id} candidate={candidate} entities={entities} busy={busy || extracting} onReview={reviewCandidate} />)}
          {!batch.candidates.length && <p className="empty-hint">The model found no grounded candidates in this source.</p>}
        </article>)
        : !error && <p className="empty-hint">No extraction batches on this branch. Choose a saved source above to create reviewable proposals.</p>}
    </section>
  </div>;
}

function ExtractionCandidateCard({ candidate, entities, busy, onReview }: {
  candidate: ExtractionCandidate;
  entities: Entity[];
  busy: boolean;
  onReview: (candidate: ExtractionCandidate, payload: Record<string, unknown>, status: "accepted" | "rejected") => Promise<void>;
}) {
  const matchingEntity = candidate.payload.subject_label
    ? entities.find((entity) => entity.label.trim().toLocaleLowerCase() === candidate.payload.subject_label?.trim().toLocaleLowerCase())
    : undefined;
  const [subjectEntityId, setSubjectEntityId] = useState(matchingEntity?.entity_id || "");
  const [epistemicStatus, setEpistemicStatus] = useState("unknown");
  const [visibility, setVisibility] = useState("public");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!entities.some((entity) => entity.entity_id === subjectEntityId)) {
      setSubjectEntityId(matchingEntity?.entity_id || "");
    }
  }, [entities, matchingEntity, subjectEntityId]);

  async function decide(status: "accepted" | "rejected") {
    setError("");
    const payload: Record<string, unknown> = { candidate_id: candidate.candidate_id, review_status: status };
    if (status === "accepted" && candidate.kind === "claim") {
      if (!subjectEntityId) {
        setError("Choose the entity this claim is about. Create or accept an entity candidate first if needed.");
        return;
      }
      payload.subject_entity_id = subjectEntityId;
      payload.epistemic_status = epistemicStatus;
      payload.visibility = visibility;
    }
    try {
      await onReview(candidate, payload, status);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Candidate review failed.");
    }
  }

  const isPending = candidate.review_status === "proposed";
  return <article className="extraction-candidate">
    <div className="extraction-candidate-title">
      <div><span className={`status-dot ${candidate.review_status}`} /><strong>{candidate.kind === "entity" ? candidate.payload.label : `${candidate.payload.subject_label} · ${candidate.payload.predicate} · ${candidate.payload.object_value}`}</strong></div>
      <span className={`extraction-status ${candidate.review_status}`}>{candidate.review_status}</span>
    </div>
    <small className="extraction-candidate-meta">{candidate.kind === "entity" ? candidate.payload.entity_type : "Claim proposal"} · source characters {candidate.payload.source_start}–{candidate.payload.source_end}</small>
    <blockquote>{candidate.payload.quote}</blockquote>
    {isPending && candidate.kind === "claim" && <div className="extraction-review-fields">
      <label className="field-label">Claim subject
        <select value={subjectEntityId} onChange={(event) => setSubjectEntityId(event.target.value)} disabled={busy}>
          <option value="">Choose an entity</option>
          {entities.map((entity) => <option key={entity.entity_id} value={entity.entity_id}>{entity.label} · {entity.entity_type}</option>)}
        </select>
      </label>
      <label className="field-label">Confidence
        <select value={epistemicStatus} onChange={(event) => setEpistemicStatus(event.target.value)} disabled={busy}>
          <option value="unknown">Unknown</option><option value="believed">Believed</option><option value="known">Known</option><option value="contested">Contested</option>
        </select>
      </label>
      <label className="field-label">Visibility
        <select value={visibility} onChange={(event) => setVisibility(event.target.value)} disabled={busy}>
          <option value="public">Public</option><option value="actor_scoped">Actor scoped</option><option value="author_only">Author only</option>
        </select>
      </label>
    </div>}
    {error && <p className="inline-error">{error}</p>}
    {isPending ? <div className="review-actions extraction-review-actions">
      <button onClick={() => void decide("rejected")} disabled={busy}>Reject</button>
      <button className="accept-button" onClick={() => void decide("accepted")} disabled={busy}>Accept reviewed item</button>
    </div> : candidate.canonical_record_id && <small className="extraction-canonical">Saved as {candidate.canonical_record_type} · {candidate.canonical_record_id}</small>}
  </article>;
}

function RevisionHistory({ workspaceId, branchId }: { workspaceId: string; branchId: string }) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    void request<Revision[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/revisions?branch_id=${encodeURIComponent(branchId)}`)
      .then((rows) => { if (active) { setRevisions(rows); setError(""); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "History could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, branchId]);

  const ordered = [...revisions].reverse();
  return <section className="panel history-panel">
    <div className="panel-heading"><div><h2>Revision history</h2><p>Every saved change is listed for the selected branch.</p></div><span className="panel-count">{revisions.length} revisions</span></div>
    {error && <p className="inline-error">{error}</p>}
    {loading ? <p className="empty-hint">Loading revision history…</p>
      : ordered.length ? <ol className="revision-list">{ordered.map((item) => <li className="revision-row" key={item.revision}>
        <span className="revision-marker" aria-hidden="true" />
        <div className="revision-copy">
          <div className="revision-heading"><strong>{item.reason}</strong><span>Revision {item.revision}</span></div>
          <small>{item.actor} · follows revision {item.parent_revision ?? "none"} · {new Date(item.created_at).toLocaleString()}</small>
          <details className="revision-detail"><summary>{item.event_type || "Command"} · inspect request and result</summary><pre>{JSON.stringify({ request: item.payload, result: item.result }, null, 2)}</pre></details>
        </div>
      </li>)}</ol>
      : !error && <p className="empty-hint">No saved changes on this branch yet.</p>}
  </section>;
}

function RelationMatrix({ entities, relations }: { entities: Entity[]; relations: Relation[] }) {
  const cells = new Map<string, Relation[]>();
  for (const relation of relations) {
    const key = `${relation.source_entity_id}\u0000${relation.target_entity_id}`;
    cells.set(key, [...(cells.get(key) || []), relation]);
  }

  return <section className="panel matrix-panel">
    <div className="panel-heading"><div><h2>Relationship matrix</h2><p>Rows point to columns. Each cell is generated from the same branch-scoped relationships as the concept map.</p></div><span className="panel-count">{relations.length} links</span></div>
    {entities.length === 0
      ? <p className="empty-hint">Add concepts to see their relationships here.</p>
      : <div className="matrix-scroll" role="region" aria-label="Relationship matrix" tabIndex={0}>
        <table className="relation-matrix">
          <caption className="visually-hidden">Directed relationships from each row concept to each column concept.</caption>
          <thead><tr><th scope="col">From / to</th>{entities.map((entity) => <th scope="col" key={entity.entity_id}>{entity.label}</th>)}</tr></thead>
          <tbody>{entities.map((source) => <tr key={source.entity_id}>
            <th scope="row">{source.label}</th>
            {entities.map((target) => {
              const links = cells.get(`${source.entity_id}\u0000${target.entity_id}`) || [];
              return <td key={target.entity_id} className={links.length ? "has-links" : ""}>
                {links.length
                  ? links.map((link) => <span className={`matrix-link ${link.review_status}`} key={link.relation_id} title={`${link.review_status} relationship`}>
                    {link.relation_type}<small>{link.review_status === "accepted" ? "Accepted" : "Needs review"}</small>
                  </span>)
                  : <span className="matrix-empty" aria-label="No relationship">—</span>}
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>}
  </section>;
}

function Metric({ value, label, icon, accent = false }: { value: number; label: string; icon: string; accent?: boolean }) {
  return <div className={`metric-card ${accent ? "metric-accent" : ""}`}><span className="metric-icon">{icon}</span><div><strong>{value.toString().padStart(2, "0")}</strong><small>{label}</small></div></div>;
}

function EntityForm({ busy, onSubmit }: { busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> }) {
  return <section className="panel compact-form"><div className="panel-heading"><div><h2>Add a concept</h2><p>People, places, ideas, or events</p></div></div><form onSubmit={onSubmit}><label>Display name<input name="label" required maxLength={500} placeholder="e.g. Aria" /></label><label>Type<select name="entity_type"><option value="character">Character</option><option value="person">Person</option><option value="place">Place</option><option value="concept">Concept</option><option value="event">Event</option><option value="organization">Organization</option></select></label><button className="primary-button full-button" disabled={busy}>Add concept <span>+</span></button></form></section>;
}

function RelationForm({ entities, busy, onSubmit }: { entities: Entity[]; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> }) {
  return <section className="panel compact-form"><div className="panel-heading"><div><h2>Connect concepts</h2><p>New relationships start as proposals</p></div></div><form onSubmit={onSubmit}><label>From<select name="source" required>{entities.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label}</option>)}</select></label><label>Relationship<input name="relation_type" required placeholder="trusts, located in…" /></label><label>To<select name="target" required>{entities.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label}</option>)}</select></label><button className="secondary-button full-button" disabled={busy || entities.length < 2}>Propose relationship <span>↗</span></button></form></section>;
}

function ClaimForm({ entities, sources, busy, onSubmit }: { entities: Entity[]; sources: Source[]; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> }) {
  return <form className="claim-form" onSubmit={onSubmit}><select name="subject" required aria-label="Claim subject">{entities.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label}</option>)}</select><input name="predicate" placeholder="relationship or property" required aria-label="Claim predicate" /><input name="object_value" placeholder="What is claimed?" required aria-label="Claim value" /><select name="source_id" aria-label="Evidence source"><option value="">No source evidence</option>{sources.map((source) => <option key={source.source_id} value={source.source_id}>{source.display_name}</option>)}</select><textarea name="evidence_quote" rows={2} placeholder="Exact quote from the selected source (optional)" aria-label="Evidence quote" /><button className="secondary-button" disabled={busy || entities.length === 0}>Propose claim <span>+</span></button></form>;
}

function SourceForm({ busy, onSubmit }: { busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> }) {
  return <section className="panel compact-form"><div className="panel-heading"><div><h2>Add a source</h2><p>Plain text or Markdown, stored in your workspace</p></div></div><form onSubmit={onSubmit}><label>Choose a local text file<input name="file" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" /></label><div className="form-divider">or paste text</div><label>Source title<input name="display_name" placeholder="e.g. Chapter one" /></label><label>Text content<textarea name="content" rows={8} placeholder="Paste a passage or a note…" /></label><button className="primary-button full-button" disabled={busy}>Save source locally <span>↗</span></button></form><small className="field-note">Text imports are limited to 10 MB. PDFs and Office files are not enabled yet.</small></section>;
}

function SourceResults({ workspaceId, query }: { workspaceId: string; query: string }) {
  const [sources, setSources] = useState<{ source_id: string; display_name: string; excerpt: string }[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!query.trim()) { setSources([]); setError(""); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void request<{ source_id: string; display_name: string; excerpt: string }[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sources?q=${encodeURIComponent(query)}`)
        .then((rows) => { if (active) { setSources(rows); setError(""); } })
        .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Source search failed."); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [workspaceId, query]);
  return <section className="panel"><div className="panel-heading"><div><h2>Imported sources</h2><p>Source text is preserved locally; extraction and review are separate steps.</p></div></div>
    {error && <p className="inline-error">{error}</p>}
    {!query.trim()
      ? <p className="empty-hint">Search above to find text in your imported sources. Current v0.1 stores plain text and Markdown.</p>
      : sources.length
        ? sources.map((source) => <article className="source-result" key={source.source_id}><strong>{source.display_name}</strong><small>{source.source_id}</small><p>{source.excerpt}</p></article>)
        : !error && <p className="empty-hint">No matching source passages.</p>}
  </section>;
}

function ReviewList({ claims, relations, review, busy }: { claims: Claim[]; relations: Relation[]; review: (kind: "claim" | "relation", id: string, status: "accepted" | "rejected") => Promise<void>; busy: boolean }) {
  const pendingClaims = claims.filter((item) => item.review_status === "proposed");
  const pendingRelations = relations.filter((item) => item.review_status === "proposed");
  return <section className="panel"><div className="panel-heading"><div><h2>Review proposals</h2><p>Nothing enters accepted knowledge until you choose.</p></div><span className="panel-count">{pendingClaims.length + pendingRelations.length} pending</span></div>
    {[...pendingClaims.map((item) => ({ kind: "claim" as const, id: item.claim_id, text: `${item.subject_entity_id} · ${item.predicate} · ${item.object_value}` })), ...pendingRelations.map((item) => ({ kind: "relation" as const, id: item.relation_id, text: `${item.source_entity_id} · ${item.relation_type} · ${item.target_entity_id}` }))].map((item) => <div className="review-row" key={item.id}><div><span className="status-dot proposed" /><strong>{item.text}</strong><small>{item.kind === "claim" ? "Claim" : "Relationship"} proposal</small></div><div className="review-actions"><button onClick={() => void review(item.kind, item.id, "rejected")} disabled={busy}>Reject</button><button className="accept-button" onClick={() => void review(item.kind, item.id, "accepted")} disabled={busy}>Accept</button></div></div>)}
    {pendingClaims.length + pendingRelations.length === 0 && <p className="empty-hint">You’re all caught up. New AI or user proposals will wait here for review.</p>}
  </section>;
}

function Graph({ entities, relations }: { entities: Entity[]; relations: Relation[] }) {
  const width = 640, height = 280, radius = 20;
  const positions = entities.slice(0, 24).map((entity, index, list) => {
    const angle = (index / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2;
    return { entity, x: width / 2 + Math.cos(angle) * Math.min(190, width * .29), y: height / 2 + Math.sin(angle) * Math.min(92, height * .34) };
  });
  const points = new Map(positions.map((point) => [point.entity.entity_id, point]));
  if (!positions.length) return <div className="graph-empty"><span>◉</span><strong>Your knowledge map starts here</strong><small>Add concepts and connect them to reveal your workspace structure.</small></div>;
  return <div className="graph-canvas"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Knowledge graph">
    {relations.map((edge) => { const from = points.get(edge.source_entity_id), to = points.get(edge.target_entity_id); if (!from || !to) return null; return <g key={edge.relation_id}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={edge.review_status === "accepted" ? "edge" : "edge proposed"} /><text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 6} className="edge-label">{edge.relation_type}</text></g>; })}
    {positions.map(({ entity, x, y }) => <g key={entity.entity_id}><circle cx={x} cy={y} r={radius} className="node-circle" /><text x={x} y={y + radius + 18} className="node-label">{entity.label.length > 18 ? `${entity.label.slice(0, 17)}…` : entity.label}</text></g>)}
  </svg></div>;
}

const STORY_WORLD_TEMPLATES = {
  narrative: { label: "Narrative", content: { stats: { courage: 0, insight: 0, empathy: 0 }, trackers: { resolve: { value: 6, max: 6 } }, starting_location: "" } },
  fantasy: { label: "Fantasy", content: { stats: { might: 0, agility: 0, insight: 0, presence: 0 }, trackers: { health: { value: 10, max: 10 } }, starting_location: "The Crossroads" } },
  space_sci_fi: { label: "Space sci-fi", content: { stats: { might: 0, agility: 0, insight: 0, presence: 0 }, trackers: { health: { value: 10, max: 10 }, oxygen: { value: 6, max: 6 } }, starting_location: "Orbital Station" } },
  cyberpunk: { label: "Cyberpunk", content: { stats: { might: 0, agility: 0, insight: 0, presence: 0 }, trackers: { health: { value: 10, max: 10 }, focus: { value: 6, max: 6 } }, starting_location: "The Neon District" } },
  modern: { label: "Modern", content: { stats: { might: 0, agility: 0, insight: 0, presence: 0 }, trackers: { health: { value: 10, max: 10 } }, starting_location: "Home" } },
  blank: { label: "Blank", content: { stats: { might: 0, agility: 0, insight: 0, presence: 0 }, trackers: { health: { value: 10, max: 10 } }, starting_location: "" } },
} as const;

const STORY_LIBRARY_PREVIEW_COUNT = 8;

function emptyStoryAbility(index: number): StoryAbilityDefinition {
  return {
    ability_id: `ability_${index}`, name: "", description: "", category: "", source: "",
    activation: "", deactivation: "", effects: [], costs: [], cooldown_turns: null,
    duration: null, range: null, magic_interactions: [], demonstrated_capabilities: [],
    confirmed_limitations: [], unresolved_aspects: [],
  };
}

function abilityTextList(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function abilityCostList(value: string): Array<{ resource: string; amount: number }> {
  if (!value.trim()) return [];
  return value.split(/\r?\n/).map((line) => {
    const [resource = "", amount = ""] = line.split("=");
    return { resource: resource.trim(), amount: /^\d+$/.test(amount.trim()) ? Number(amount.trim()) : Number.NaN };
  });
}

function trackerDefinitionsText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value).map(([name, tracker]) => {
    if (!tracker || typeof tracker !== "object" || !Number.isInteger((tracker as { value?: unknown }).value)
      || !Number.isInteger((tracker as { max?: unknown }).max)) return "";
    const current = (tracker as { value: number }).value;
    const maximum = (tracker as { max: number }).max;
    return `${name}=${current}/${maximum}`;
  }).filter(Boolean).join("\n");
}

function parseTrackerDefinitions(value: string): Record<string, { value: number; max: number }> | null {
  const trackers: Record<string, { value: number; max: number }> = {};
  const names = new Set<string>();
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 30) return null;
  for (const line of lines) {
    const match = /^(.+?)\s*=\s*(\d+)\s*\/\s*(\d+)$/.exec(line);
    if (!match) return null;
    const name = match[1].trim();
    const current = Number(match[2]);
    const maximum = Number(match[3]);
    const key = name.toLocaleLowerCase();
    if (!name || name.length > 60 || names.has(key) || maximum > 100_000 || current > maximum) return null;
    names.add(key);
    trackers[name] = { value: current, max: maximum };
  }
  return trackers;
}

type StoryCharacterCreation = {
  point_budget: number;
  allow_unspent_points: boolean;
  allow_below_baseline: boolean;
  stats: Record<string, Pick<CharacterCreationStat, "label" | "minimum" | "maximum" | "point_cost">>;
};

function defaultCharacterCreationStats(templateKey: string): CharacterCreationStat[] {
  const template = STORY_WORLD_TEMPLATES[templateKey as keyof typeof STORY_WORLD_TEMPLATES] || STORY_WORLD_TEMPLATES.fantasy;
  return Object.entries(template.content.stats).map(([key, baseline]) => ({
    key, label: key.replaceAll("_", " ").replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase()),
    baseline, minimum: baseline, maximum: 5, point_cost: 1,
  }));
}

function characterCreationFromContent(content: Record<string, unknown>): StoryCharacterCreation | null {
  const value = content.character_creation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const creation = value as Partial<StoryCharacterCreation>;
  if (!Number.isInteger(creation.point_budget) || typeof creation.allow_unspent_points !== "boolean"
    || typeof creation.allow_below_baseline !== "boolean" || !creation.stats || typeof creation.stats !== "object"
    || Array.isArray(creation.stats)) return null;
  return creation as StoryCharacterCreation;
}

function StoryPage({ entities, claims, workspaceId, branchId, revision, busy, onNavigate, onSelectBranch, onCommit, onCommitBranch, onMainCommit, onCreateAdventure, onRevisionChange, onRefresh }: {
  entities: Entity[];
  claims: Claim[];
  workspaceId: string;
  branchId: string;
  revision: number;
  busy: boolean;
  onNavigate: (page: Page) => void;
  onSelectBranch: (branchId: string) => void;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string) => Promise<Record<string, unknown>>;
  onCommitBranch: (branchId: string, command: string, payload: Record<string, unknown>, reason: string) => Promise<Record<string, unknown>>;
  onMainCommit: (command: string, payload: Record<string, unknown>, reason: string) => Promise<Record<string, unknown>>;
  onCreateAdventure: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onRevisionChange: (revision: number) => void;
  onRefresh: () => Promise<void>;
}) {
  const characters = entities.filter((item) => ["character", "person"].includes(item.entity_type));
  const [actor, setActor] = useState("");
  const [order, setOrder] = useState(0);
  const [context, setContext] = useState<ContextManifest | null>(null);
  const [contextExportNotice, setContextExportNotice] = useState("");
  const [memoryQuestion, setMemoryQuestion] = useState("");
  const [memoryAnswer, setMemoryAnswer] = useState<TemporalQueryResult | null>(null);
  const [memoryQueryError, setMemoryQueryError] = useState("");
  const [memoryQuerying, setMemoryQuerying] = useState(false);
  const [error, setError] = useState("");
  const [storyError, setStoryError] = useState("");
  const [conversations, setConversations] = useState<StoryConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [conversation, setConversation] = useState<StoryConversation | null>(null);
  const [storyProviders, setStoryProviders] = useState<StoryProvider[]>([]);
  const [externalProviderConsents, setExternalProviderConsents] = useState<StoryProvider["id"][]>(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem("lke.external-provider-consents") || "[]");
      return Array.isArray(saved) ? saved.filter((provider): provider is StoryProvider["id"] => EXTERNAL_STORY_PROVIDERS.includes(provider)) : [];
    } catch { return []; }
  });
  const [providerId, setProviderId] = useState<StoryProvider["id"]>(() => {
    try {
      const saved = window.localStorage.getItem("lke.story.provider");
      return saved === "openai" || saved === "claude" || saved === "codex" || saved === "huggingface" || saved === "huggingface_local" ? saved : "ollama";
    } catch { return "ollama"; }
  });
  const [model, setModel] = useState(() => {
    try { return window.localStorage.getItem("lke.story.model") || ""; } catch { return ""; }
  });
  const [codexModelOptions, setCodexModelOptions] = useState<CodexModelOption[]>([]);
  const [reasoningEffort, setReasoningEffort] = useState(() => {
    try { return window.localStorage.getItem("lke.story.reasoning-effort") || ""; } catch { return ""; }
  });
  const [usingCustomModel, setUsingCustomModel] = useState(false);
  const [modelDiscoveryBusy, setModelDiscoveryBusy] = useState(false);
  const [modelDiscoveryError, setModelDiscoveryError] = useState("");
  const [modelDiscoveryNotice, setModelDiscoveryNotice] = useState("");
  const [title, setTitle] = useState("");
  const [actorIsUserControlled, setActorIsUserControlled] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [exportIncludesContext, setExportIncludesContext] = useState(false);
  const [exportIncludesPrompts, setExportIncludesPrompts] = useState(true);
  const [worlds, setWorlds] = useState<StoryWorld[]>([]);
  const [adventures, setAdventures] = useState<StoryAdventure[]>([]);
  const [storyLibraryQuery, setStoryLibraryQuery] = useState("");
  const [storyLibraryFiltersOpen, setStoryLibraryFiltersOpen] = useState(false);
  const [storyLibrarySort, setStoryLibrarySort] = useState<"recent" | "name" | "created">("recent");
  const [storyAdventureStatusFilter, setStoryAdventureStatusFilter] = useState<"all" | "active" | "paused" | "complete" | "archived">("all");
  const [storyWorldFilter, setStoryWorldFilter] = useState("all");
  const [storyHeroFilter, setStoryHeroFilter] = useState("all");
  const [storyWorldStatusFilter, setStoryWorldStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [renamingAdventureId, setRenamingAdventureId] = useState("");
  const [renamingAdventureName, setRenamingAdventureName] = useState("");
  const [setupExpanded, setSetupExpanded] = useState(false);
  const [setupStep, setSetupStep] = useState<1 | 2 | 3>(1);
  const [showWorldCreation, setShowWorldCreation] = useState(false);
  const [worldCreationStep, setWorldCreationStep] = useState<1 | 2 | 3>(1);
  const [showHeroCreation, setShowHeroCreation] = useState(false);
  const [showHeroProfileEditor, setShowHeroProfileEditor] = useState(false);
  const [heroProfileDraft, setHeroProfileDraft] = useState<HeroProfileDraft>({ ...EMPTY_HERO_PROFILE });
  const [showAdventureHeroProfileEditor, setShowAdventureHeroProfileEditor] = useState(false);
  const [adventureHeroProfileDraft, setAdventureHeroProfileDraft] = useState<HeroProfileDraft>({ ...EMPTY_HERO_PROFILE });
  const [adventureHeroProfileError, setAdventureHeroProfileError] = useState("");
  const [mainCharacters, setMainCharacters] = useState<Entity[]>([]);
  const [adventureHeroId, setAdventureHeroId] = useState("");
  const [selectedWorldId, setSelectedWorldId] = useState("");
  const [selectedWorldDetail, setSelectedWorldDetail] = useState<{ world_id: string; name: string; latest_version: number; versions: { version: number; description: string; template_key: string; content: Record<string, unknown> }[] } | null>(null);
  const [editWorldLocations, setEditWorldLocations] = useState("");
  const [worldName, setWorldName] = useState("");
  const [worldPremise, setWorldPremise] = useState("");
  const [worldStartingLocation, setWorldStartingLocation] = useState("The Crossroads");
  const [worldLocations, setWorldLocations] = useState("");
  const [worldOpeningSituation, setWorldOpeningSituation] = useState("");
  const [worldOpeningHook, setWorldOpeningHook] = useState("");
  const [worldArchitectBrief, setWorldArchitectBrief] = useState("");
  const [worldArchitectModel, setWorldArchitectModel] = useState("");
  const [worldArchitectDraft, setWorldArchitectDraft] = useState<StoryWorldArchitectDraft | null>(null);
  const [worldArchitectBusy, setWorldArchitectBusy] = useState(false);
  const [worldArchitectMessage, setWorldArchitectMessage] = useState("");
  const [worldCover, setWorldCover] = useState<StoryWorldCover | null>(null);
  const [editWorldCover, setEditWorldCover] = useState<StoryWorldCover | null>(null);
  const [coverPreparing, setCoverPreparing] = useState(false);
  const [editWorldName, setEditWorldName] = useState("");
  const [editWorldDescription, setEditWorldDescription] = useState("");
  const [editWorldPremise, setEditWorldPremise] = useState("");
  const [editWorldStartingLocation, setEditWorldStartingLocation] = useState("");
  const [editWorldOpeningSituation, setEditWorldOpeningSituation] = useState("");
  const [editWorldOpeningHook, setEditWorldOpeningHook] = useState("");
  const [editMnoLorebook, setEditMnoLorebook] = useState<MnoLorebookDraft[]>([]);
  const [editMnoLorebookSearch, setEditMnoLorebookSearch] = useState("");
  const [editMnoLorebookVisibleCount, setEditMnoLorebookVisibleCount] = useState(20);
  const [worldTemplate, setWorldTemplate] = useState("fantasy");
  const [creationPointBudget, setCreationPointBudget] = useState(10);
  const [creationAllowUnspentPoints, setCreationAllowUnspentPoints] = useState(false);
  const [creationAllowBelowBaseline, setCreationAllowBelowBaseline] = useState(false);
  const [creationStatDefinitions, setCreationStatDefinitions] = useState<CharacterCreationStat[]>(() => defaultCharacterCreationStats("fantasy"));
  const [creationAbilities, setCreationAbilities] = useState<StoryAbilityDefinition[]>([]);
  const [creationMechanics, setCreationMechanics] = useState<StoryMechanicsProfile>(() => defaultStoryMechanics());
  const [creationTrackerText, setCreationTrackerText] = useState(() => trackerDefinitionsText(STORY_WORLD_TEMPLATES.fantasy.content.trackers));
  const [editMechanics, setEditMechanics] = useState<StoryMechanicsProfile>(() => defaultStoryMechanics());
  const [editTrackerText, setEditTrackerText] = useState("");
  const [creationError, setCreationError] = useState("");
  const [adventureAllocation, setAdventureAllocation] = useState<Record<string, number>>({});
  const [adventureAllocationMessage, setAdventureAllocationMessage] = useState("");
  const [adventureName, setAdventureName] = useState("");
  const [heroName, setHeroName] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [worldPackage, setWorldPackage] = useState<{ workspace: string; data: unknown; preview: { name: string; versions: number; provenance: { workspace_id: string; world_id: string }; source_id_conflict: boolean; source_format?: string; content_warning?: string | null; stat_count?: number; tracker_count?: number; lore_entry_count?: number; npc_template_count?: number; conversion_notes?: string[] } } | null>(null);
  const [worldExportMode, setWorldExportMode] = useState<"public_world" | "full_private_archive">("public_world");
  const [worldExportReview, setWorldExportReview] = useState<{
    workspaceId: string; worldId: string; revision: number; mode: "public_world" | "full_private_archive";
    preview: StoryAdventureExportPreview;
  } | null>(null);
  const [adventurePackage, setAdventurePackage] = useState<{ workspace: string; data: unknown; preview: { name: string; world_version: number; turns: number; memories: number; characters: number; images: number; provenance: { workspace_id: string; branch_id: string; adventure_id: string }; matching_world_id: string | null; world_import_required: boolean; source_world_id_conflict: boolean; entity_id_conflicts: { entity_id: string; label: string; existing_label: string }[]; source_format?: string; world_name?: string; message_count?: number; action_count?: number; npc_count?: number; image_count?: number; map_location_count?: number; memory_count?: number; context_excluded_message_count?: number; conversion_notes?: string[] } } | null>(null);
  const [adventureExportMode, setAdventureExportMode] = useState<StoryAdventureExportMode>("shareable_adventure");
  const [adventureExportSections, setAdventureExportSections] = useState<string[]>(["turn_ids", "check_ids", "mechanic_check_ids", "proposal_ids", "memory_ids", "thread_ids", "npc_entity_ids", "asset_ids", "location_ids"]);
  const [adventureExportReview, setAdventureExportReview] = useState<{
    workspaceId: string; branchId: string; adventureId: string; revision: number; mode: StoryAdventureExportMode;
    selection: StoryAdventureExportSelection | undefined; preview: StoryAdventureExportPreview;
  } | null>(null);
  const [rpgState, setRpgState] = useState<RpgState | null>(null);
  const [editableStats, setEditableStats] = useState<Record<string, number>>({});
  const [rpgError, setRpgError] = useState("");
  const [checkStat, setCheckStat] = useState("");
  const [checkSkill, setCheckSkill] = useState("");
  const [checkEncounter, setCheckEncounter] = useState("combat");
  const [checkDifficulty, setCheckDifficulty] = useState("standard");
  const [editableSkills, setEditableSkills] = useState<Record<string, number>>({});
  const [experienceAward, setExperienceAward] = useState(1);
  const [proposalOperation, setProposalOperation] = useState<"tracker_delta" | "set_location">("tracker_delta");
  const [proposalTracker, setProposalTracker] = useState("health");
  const [proposalDelta, setProposalDelta] = useState(-1);
  const [proposalLocation, setProposalLocation] = useState("");
  const [editingProposalId, setEditingProposalId] = useState("");
  const [editedProposalChanges, setEditedProposalChanges] = useState<RpgState["proposals"][number]["changes"]>([]);
  const [studioData, setStudioData] = useState<StoryStudioData | null>(null);
  const [activeWorldContent, setActiveWorldContent] = useState<Record<string, unknown> | null>(null);
  const [memoryNote, setMemoryNote] = useState("");
  const [memoryContextEnabled, setMemoryContextEnabled] = useState(true);
  const [memoryKnowledgeScope, setMemoryKnowledgeScope] = useState<StoryMemory["knowledge_scope"]>("shared");
  const [memoryImportance, setMemoryImportance] = useState(3);
  const [memoryKnownBy, setMemoryKnownBy] = useState<string[]>([]);
  const [situationDraft, setSituationDraft] = useState("");
  const [threadTitle, setThreadTitle] = useState("");
  const [threadDetail, setThreadDetail] = useState("");
  const [npcId, setNpcId] = useState("");
  const [editingTurnId, setEditingTurnId] = useState("");
  const [editedTurnText, setEditedTurnText] = useState("");
  const [showTurnHistory, setShowTurnHistory] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [assetData, setAssetData] = useState<Record<string, string>>({});
  const [assetError, setAssetError] = useState("");
  const storySelectionRequest = useRef(0);
  const pendingStoryRequest = useRef<{ fingerprint: string; body: string } | null>(null);
  const memoryQueryRequest = useRef(0);
  const generationAbort = useRef<AbortController | null>(null);
  const worldArchitectAbort = useRef<AbortController | null>(null);
  const memoryScopeRef = useRef("");
  const storyMounted = useRef(true);
  const storyProviderRef = useRef(providerId);
  const storyModelRef = useRef(model);
  storyProviderRef.current = providerId;
  storyModelRef.current = model;
  const selectedStoryProvider = storyProviders.find((provider) => provider.id === providerId);
  const storyProviderAvailable = selectedStoryProvider?.available ?? false;
  const models = selectedStoryProvider?.models ?? [];
  const selectedCodexModel = codexModelOptions.find((option) => option.model === model);
  const automaticCodexEffortSets = codexModelOptions
    .map((option) => option.supported_reasoning_efforts);
  const automaticCodexEfforts = automaticCodexEffortSets.length
    ? automaticCodexEffortSets[0].filter((effort) => automaticCodexEffortSets.every((options) => options.includes(effort)))
    : [];
  const availableCodexEfforts = model === "auto"
    ? automaticCodexEfforts
    : selectedCodexModel?.supported_reasoning_efforts ?? [];
  const effectiveCodexReasoningEffort = providerId === "codex" && availableCodexEfforts.includes(reasoningEffort)
    ? reasoningEffort
    : "";
  const localStoryProvider = storyProviders.find((provider) => provider.id === "ollama");
  const localStoryModels = localStoryProvider?.models ?? [];
  const selectedWorldArchitectModel = localStoryModels.includes(worldArchitectModel)
    ? worldArchitectModel
    : localStoryProvider?.default_model && localStoryModels.includes(localStoryProvider.default_model)
      ? localStoryProvider.default_model
      : localStoryModels[0] || "";
  function ensureExternalProviderConsent(requestedProvider: StoryProvider["id"]): boolean {
    if (!EXTERNAL_STORY_PROVIDERS.includes(requestedProvider) || externalProviderConsents.includes(requestedProvider)) return true;
    const selectedProvider = storyProviders.find((provider) => provider.id === requestedProvider);
    const providerLabel = selectedProvider?.label || requestedProvider;
    const accepted = window.confirm(
      `Send this request to ${providerLabel}? This sends your prompt, recent active story turns, approved public world and RPG details, public character-known facts, shared reviewed memories, and approved public NPC profiles. Author-only notes, private NPC profiles, actor-scoped facts, and non-shared memories are removed before the request. The provider may process or retain submitted data under its terms, and account charges may apply. Continue to save consent for ${providerLabel} on this device? You can revoke it here at any time.`,
    );
    if (!accepted) return false;
    const next = externalProviderConsents.includes(requestedProvider)
      ? externalProviderConsents
      : [...externalProviderConsents, requestedProvider];
    setExternalProviderConsents(next);
    try { window.localStorage.setItem("lke.external-provider-consents", JSON.stringify(next)); } catch { /* Per-request API consent remains required. */ }
    return true;
  }
  function revokeExternalProviderConsent(requestedProvider: StoryProvider["id"]) {
    const next = externalProviderConsents.filter((provider) => provider !== requestedProvider);
    setExternalProviderConsents(next);
    try { window.localStorage.setItem("lke.external-provider-consents", JSON.stringify(next)); } catch { /* Backend still requires explicit consent on each request. */ }
  }
  const knownModel = models.includes(model) || (providerId === "codex" && (model === "auto" || codexModelOptions.some((option) => option.model === model)));
  const customModel = providerId !== "codex" && (usingCustomModel || (!knownModel && Boolean(model)));
  function changeStoryModel(value: string) {
    if (value === "__custom__") {
      setUsingCustomModel(true);
      setModel("");
      return;
    }
    setUsingCustomModel(false);
    setModel(value);
    if (providerId === "codex" && reasoningEffort) {
      const nextEfforts = value === "auto"
        ? automaticCodexEfforts
        : codexModelOptions.find((option) => option.model === value)?.supported_reasoning_efforts ?? [];
      if (!nextEfforts.includes(reasoningEffort)) setReasoningEffort("");
    }
  }
  function codexReasoningControl(label: string, disabled = false) {
    if (providerId !== "codex") return null;
    if (!codexModelOptions.length) {
      return <p className="provider-note">{modelDiscoveryBusy ? "Loading Codex model choices…" : "Codex will use its model default until reasoning choices are available."}</p>;
    }
    if (!availableCodexEfforts.length) {
      return <p className="provider-note">{model === "auto" ? "Codex chooses the model and reasoning default. Choose a specific model to see its supported effort levels." : "This model does not list adjustable reasoning levels. Codex will use its default."}</p>;
    }
    return <label className="field-label">Reasoning effort<select aria-label={label} value={effectiveCodexReasoningEffort}
      disabled={disabled || !availableCodexEfforts.length}
      onChange={(event) => setReasoningEffort(event.target.value)}>
      <option value="">Automatic · model default</option>
      {availableCodexEfforts.map((effort) => <option key={effort} value={effort}>{effort === selectedCodexModel?.default_reasoning_effort ? `${effort} · model default` : effort}</option>)}
    </select><small className="field-note">Choose a level the selected model supports, or leave it on Automatic.</small></label>;
  }
  function changeStoryProvider(nextId: StoryProvider["id"]) {
    const next = storyProviders.find((provider) => provider.id === nextId);
    storyProviderRef.current = nextId;
    setProviderId(nextId);
    setUsingCustomModel(false);
    setModelDiscoveryError("");
    setModelDiscoveryNotice("");
    setModel(nextId === "codex" ? "auto" : next?.default_model || next?.models[0] || "");
    setReasoningEffort("");
    setStoryError("");
  }
  async function loadProviderModels(requestedProvider: StoryProvider["id"] = providerId) {
    setModelDiscoveryError("");
    setModelDiscoveryNotice("");
    setModelDiscoveryBusy(true);
    try {
      const response = await request<{ models: string[]; model_options?: CodexModelOption[] }>(`/api/v1/providers/story/${encodeURIComponent(requestedProvider)}/models`, { method: "POST" });
      if (storyMounted.current) setStoryProviders((providers) => providers.map((provider) => provider.id === requestedProvider ? { ...provider, models: response.models } : provider));
      if (storyMounted.current && requestedProvider === "codex") {
        const hasReasoningMetadata = Array.isArray(response.model_options);
        const options: CodexModelOption[] = Array.isArray(response.model_options) ? response.model_options : [];
        const discoveredModels = Array.isArray(response.models) ? response.models : [];
        setCodexModelOptions(options);
        if (!hasReasoningMetadata) {
          setModelDiscoveryNotice(discoveredModels.length
            ? "Lorethra received model names without reasoning details. Restart or update Lorethra to enable effort choices; Codex will use its default for now."
            : "Lorethra could not read Codex reasoning details. Restart or update Lorethra, then refresh the model list.");
        }
        if (storyProviderRef.current === "codex") {
          const currentModel = storyModelRef.current;
          if (hasReasoningMetadata) {
            setReasoningEffort((current) => {
              const optionSets = options.map((option) => option.supported_reasoning_efforts);
              const automaticEfforts = optionSets.length ? optionSets[0].filter((effort) => optionSets.every((supported) => supported.includes(effort))) : [];
              const selectedEfforts = currentModel === "auto" ? automaticEfforts : options.find((option) => option.model === currentModel)?.supported_reasoning_efforts ?? [];
              return selectedEfforts.includes(current) ? current : "";
            });
            if (currentModel !== "auto" && !discoveredModels.includes(currentModel)) setModel("auto");
          }
        }
      }
    } catch (error) {
      if (storyMounted.current && storyProviderRef.current === requestedProvider) setModelDiscoveryError(error instanceof Error ? error.message : "Models could not be loaded.");
    } finally {
      if (storyMounted.current) setModelDiscoveryBusy(false);
    }
  }
  const codexDiscoveryStarted = useRef(false);
  useEffect(() => {
    if (providerId !== "codex") {
      codexDiscoveryStarted.current = false;
      return;
    }
    if (storyProviderAvailable && !codexDiscoveryStarted.current) {
      codexDiscoveryStarted.current = true;
      void loadProviderModels("codex");
    }
  }, [providerId, storyProviderAvailable]);
  useEffect(() => {
    storyMounted.current = true;
    return () => {
      storyMounted.current = false;
      worldArchitectAbort.current?.abort();
    };
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem("lke.story.provider", providerId);
      window.localStorage.setItem("lke.story.model", model);
      window.localStorage.setItem("lke.story.reasoning-effort", reasoningEffort);
    } catch { /* Preferences are optional; canonical story data stays in SQLite. */ }
  }, [providerId, model, reasoningEffort]);
  useEffect(() => {
    let active = true;
    setSetupExpanded(false);
    setShowHeroProfileEditor(false);
    setHeroProfileDraft({ ...EMPTY_HERO_PROFILE });
    Promise.all([
      request<StoryWorld[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds`),
      request<StoryAdventure[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures`),
      request<Entity[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/entities?branch_id=main`),
    ]).then(([worldRows, adventureRows, characterRows]) => {
      if (!active) return;
      setWorlds(worldRows);
      setAdventures(adventureRows);
      const activeWorldRows = worldRows.filter((item) => !item.archived_at);
      setSetupStep(1);
      setShowWorldCreation(activeWorldRows.length === 0);
      setMainCharacters(characterRows.filter((item) => ["character", "person"].includes(item.entity_type)));
      setShowHeroCreation(!characterRows.some((item) => ["character", "person"].includes(item.entity_type)));
      setSelectedWorldId((current) => activeWorldRows.some((item) => item.world_id === current) ? current : activeWorldRows[0]?.world_id || "");
      setAdventureHeroId((current) => characterRows.some((item) => item.entity_id === current) ? current : characterRows.find((item) => ["character", "person"].includes(item.entity_type))?.entity_id || "");
    }).catch((loadError) => {
      if (active) setLibraryError(loadError instanceof Error ? loadError.message : "The world library could not be loaded.");
    });
    return () => { active = false; };
  }, [workspaceId]);
  useEffect(() => {
    if (!selectedWorldId) {
      setSelectedWorldDetail(null);
      setAdventureAllocation({});
      setEditMnoLorebook([]);
      setEditMnoLorebookSearch("");
      setEditMnoLorebookVisibleCount(20);
      return;
    }
    let active = true;
    request<{ world_id: string; name: string; latest_version: number; versions: { version: number; description: string; template_key: string; content: Record<string, unknown> }[] }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds/${encodeURIComponent(selectedWorldId)}`,
    ).then((detail) => {
      if (!active) return;
      const updatedLatest = detail.versions.find((item) => item.version === detail.latest_version);
      setSelectedWorldDetail(detail);
      const creation = updatedLatest ? characterCreationFromContent(updatedLatest.content) : null;
      const baselines = updatedLatest?.content.stats && typeof updatedLatest.content.stats === "object" && !Array.isArray(updatedLatest.content.stats)
        ? updatedLatest.content.stats as Record<string, number>
        : {};
      const allocationStats = creation
        ? Object.entries(creation.stats).map(([key, rule]) => ({
          key,
          ...rule,
          baseline: baselines[key],
          minimum: creation.allow_below_baseline ? rule.minimum : Math.max(rule.minimum, baselines[key]),
        }))
        : [];
      const balancedAllocation = creation
        ? balancedCharacterAllocation(allocationStats, creation.point_budget, creation.allow_unspent_points)
        : null;
      setAdventureAllocation(creation
        ? balancedAllocation || Object.fromEntries(Object.keys(creation.stats).map((key) => [key, baselines[key]]))
        : {});
      setAdventureAllocationMessage(creation
        ? balancedAllocation ? "Balanced starting attributes are ready. You can customize them before you start." : "Customize the attributes to meet this world's point rules before you start."
        : "");
      setEditWorldName(detail.name);
      setEditWorldDescription(updatedLatest?.description || "");
      setEditWorldPremise(typeof updatedLatest?.content.public_lore === "string" ? updatedLatest.content.public_lore : "");
      setEditWorldStartingLocation(typeof updatedLatest?.content.starting_location === "string" ? updatedLatest.content.starting_location : "");
      const openingScene = readStoryOpeningScene(updatedLatest?.content.opening_scene);
      setEditWorldOpeningSituation(openingScene.situation);
      setEditWorldOpeningHook(openingScene.hook);
      setEditWorldCover(readStoryWorldCover(updatedLatest?.content.cover_image));
      setEditWorldLocations(Array.isArray(updatedLatest?.content.locations) ? updatedLatest.content.locations.filter((value): value is string => typeof value === "string").join("\n") : "");
      setEditTrackerText(trackerDefinitionsText(updatedLatest?.content.trackers));
      setEditMechanics(readStoryMechanics(
        updatedLatest?.content.game_mechanics,
        updatedLatest?.template_key === "narrative" ? "narrative_only" : "d20",
      ));
      setEditMnoLorebook(readMnoLorebookDraft(updatedLatest?.content));
      setEditMnoLorebookSearch("");
      setEditMnoLorebookVisibleCount(20);
    }).catch((loadError) => {
      if (active) setLibraryError(loadError instanceof Error ? loadError.message : "The selected world could not be opened.");
    });
    return () => { active = false; };
  }, [selectedWorldId, workspaceId]);
  const activeAdventure = adventures.find((item) => item.branch_id === branchId && item.conversation_id === conversationId) || null;
  const activeAdventureHero = activeAdventure
    ? entities.find((item) => item.entity_id === activeAdventure.actor_entity_id)
    : undefined;
  const activeAdventureHeroProfile = readHeroProfile(activeAdventureHero);
  const activeAdventureHeroProfileEntries = heroProfileEntries(activeAdventureHeroProfile);
  const activeAdventureImportedProfileEntries = heroProfileEntries(activeAdventureHeroProfile, true);
  useEffect(() => {
    setShowAdventureHeroProfileEditor(false);
    setAdventureHeroProfileDraft({ ...EMPTY_HERO_PROFILE });
    setAdventureHeroProfileError("");
  }, [activeAdventure?.branch_id, activeAdventure?.actor_entity_id]);
  useEffect(() => {
    if (!activeAdventure) {
      setRpgState(null);
      setRpgError("");
      return;
    }
    let active = true;
    request<RpgState>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/${encodeURIComponent(activeAdventure.adventure_id)}/rpg?branch_id=${encodeURIComponent(branchId)}`)
      .then((state) => { if (active) setRpgState(state); })
      .catch((loadError) => { if (active) setRpgError(loadError instanceof Error ? loadError.message : "Adventure state could not be loaded."); });
    return () => { active = false; };
  }, [activeAdventure?.adventure_id, branchId, revision, workspaceId]);
  useEffect(() => {
    if (rpgState?.sheet) setEditableSkills(rpgState.sheet.skills);
    else setEditableSkills({});
  }, [rpgState?.sheet?.updated_revision, activeAdventure?.adventure_id]);
  useEffect(() => {
    const mechanics = rpgState?.mechanics;
    const sheet = rpgState?.sheet;
    if (!mechanics || !sheet) return;
    setCheckSkill((current) => mechanics.skills.some((skill) => skill.skill_id === current) ? current : "");
    setCheckStat((current) => Object.hasOwn(sheet.stats, current) ? current : Object.keys(sheet.stats)[0] || "");
    setCheckEncounter((current) => mechanics.encounter_types.some((item) => item.encounter_type === current)
      ? current : mechanics.encounter_types[0]?.encounter_type || "");
    setCheckDifficulty((current) => mechanics.difficulties.some((item) => item.difficulty_id === current)
      ? current : mechanics.difficulties[0]?.difficulty_id || "");
  }, [rpgState, branchId, workspaceId]);
  useEffect(() => {
    if (!activeAdventure) {
      setStudioData(null);
      setActiveWorldContent(null);
      return;
    }
    let active = true;
    Promise.all([
      request<StoryStudioData>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/${encodeURIComponent(activeAdventure.adventure_id)}/studio?branch_id=${encodeURIComponent(branchId)}`),
      request<{ versions: Array<{ version: number; content: Record<string, unknown> }> }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds/${encodeURIComponent(activeAdventure.world_id)}`),
    ]).then(([studio, world]) => {
      if (!active) return;
      setStudioData(studio);
      setActiveWorldContent(world.versions.find((version) => version.version === activeAdventure.world_version)?.content || null);
      const situation = studio.memories.memories.find((item) => item.kind === "situation");
      setSituationDraft(situation?.content || "");
      setNpcId((current) => current || studio.npcs[0]?.npc_entity_id || "");
    }).catch((loadError) => {
      if (active) setRpgError(loadError instanceof Error ? loadError.message : "Adventure panels could not be loaded.");
    });
    return () => { active = false; };
  }, [activeAdventure?.adventure_id, branchId, revision, workspaceId]);
  useEffect(() => {
    if (!activeAdventure || !studioData?.assets.length) {
      setAssetData({});
      return;
    }
    let active = true;
    Promise.all(studioData.assets.map(async (asset) => {
      const result = await request<{ data_base64: string; mime_type: string }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/${encodeURIComponent(activeAdventure.adventure_id)}/assets/${encodeURIComponent(asset.asset_id)}?branch_id=${encodeURIComponent(branchId)}`,
      );
      return [asset.asset_id, `data:${result.mime_type};base64,${result.data_base64}`] as const;
    })).then((pairs) => { if (active) setAssetData(Object.fromEntries(pairs)); }).catch((loadError) => { if (active) setAssetError(loadError instanceof Error ? loadError.message : "Attached images could not be loaded."); });
    return () => { active = false; };
  }, [activeAdventure?.adventure_id, branchId, studioData?.assets, workspaceId]);
  useEffect(() => {
    if (rpgState?.sheet) setEditableStats(rpgState.sheet.stats);
  }, [activeAdventure?.adventure_id, rpgState?.sheet?.updated_revision]);
  const selectedActor = conversation?.actor_entity_id || (characters.some((item) => item.entity_id === actor) ? actor : characters[0]?.entity_id || "");
  const activeCharacterCreation = activeWorldContent ? characterCreationFromContent(activeWorldContent) : null;
  const activeStatLabel = (key: string) => activeCharacterCreation?.stats[key]?.label || key;
  const memoryScope = JSON.stringify([workspaceId, branchId, selectedActor, order, model, revision]);
  memoryScopeRef.current = memoryScope;

  useEffect(() => {
    memoryQueryRequest.current += 1;
    setMemoryAnswer(null);
    setMemoryQueryError("");
    setMemoryQuerying(false);
  }, [workspaceId, branchId, selectedActor, order, model, revision]);

  async function loadConversations(preferredId?: string) {
    const rows = await request<StoryConversationSummary[]>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations?branch_id=${encodeURIComponent(branchId)}`,
    );
    setConversations(rows);
    const selectedId = preferredId || conversationId;
    const selected = rows.find((item) => item.conversation_id === selectedId) || rows[0];
    if (!selected) {
      setConversationId("");
      setConversation(null);
      return;
    }
    setConversationId(selected.conversation_id);
    const detail = await request<StoryConversation>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(selected.conversation_id)}?branch_id=${encodeURIComponent(branchId)}`,
    );
    setConversation(detail);
    setActor(detail.actor_entity_id);
    const lastTurn = detail.turns[detail.turns.length - 1];
    setOrder(lastTurn?.narrative_order || 0);
  }

  useEffect(() => {
    let active = true;
    setConversation(null);
    setConversationId("");
    setStoryError("");
    request<StoryConversationSummary[]>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations?branch_id=${encodeURIComponent(branchId)}`,
    ).then(async (rows) => {
      if (!active) return;
      setConversations(rows);
      const first = rows[0];
      if (!first) return;
      const detail = await request<StoryConversation>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(first.conversation_id)}?branch_id=${encodeURIComponent(branchId)}`,
      );
      if (active && storySelectionRequest.current === 0) {
        setConversationId(first.conversation_id);
        setConversation(detail);
        setActor(detail.actor_entity_id);
        const lastTurn = detail.turns[detail.turns.length - 1];
        setOrder(lastTurn?.narrative_order || 0);
      }
    }).catch((loadError) => {
      if (active) setStoryError(loadError instanceof Error ? loadError.message : "Stories could not be loaded.");
    });
    request<{ providers: StoryProvider[] }>("/api/v1/providers/story").then((status) => {
      if (!active) return;
      setStoryProviders(status.providers);
      const selected = status.providers.find((provider) => provider.id === providerId)
        || status.providers.find((provider) => provider.available)
        || status.providers[0];
      if (!selected) return;
      if (!status.providers.some((provider) => provider.id === providerId)) setProviderId(selected.id);
      setModel((current) => current || selected.default_model || selected.models[0] || (selected.id === "codex" ? "auto" : ""));
    }).catch(() => {
      if (active) setStoryProviders([]);
    });
    return () => { active = false; };
  }, [workspaceId, branchId]);

  async function preview() {
    setError("");
    setContextExportNotice("");
    try {
      setContext(await request<ContextManifest>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/context`, {
        method: "POST",
        body: JSON.stringify({ branch_id: branchId, actor_entity_id: selectedActor, as_of_narrative_order: order, token_budget: 4000 }),
      }));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Context could not be built.");
    }
  }

  async function queryCharacterMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (memoryQuerying || generating || busy || !selectedActor || !memoryQuestion.trim()) return;
    if (!ensureExternalProviderConsent(providerId)) {
      setMemoryQueryError("No memory data was sent. Your question is still here; choose a local provider or approve this provider first.");
      return;
    }
    const requestId = ++memoryQueryRequest.current;
    const requestScope = memoryScopeRef.current;
    setMemoryQuerying(true);
    setMemoryQueryError("");
    setMemoryAnswer(null);
    try {
      const result = await request<TemporalQueryResult>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/temporal-query`,
        {
          method: "POST",
          body: JSON.stringify({
            branch_id: branchId,
            actor_entity_id: selectedActor,
            expected_revision: revision,
            as_of_narrative_order: order,
            provider: providerId,
            external_provider_consent: EXTERNAL_STORY_PROVIDERS.includes(providerId) ? providerId : null,
            model: model || null,
            question: memoryQuestion.trim(),
          }),
        },
      );
      if (!storyMounted.current || requestId !== memoryQueryRequest.current || memoryScopeRef.current !== requestScope) return;
      setMemoryAnswer(result);
    } catch (queryError) {
      if (!storyMounted.current) return;
      if (queryError instanceof ApiError && queryError.status === 409) {
        try {
          await onRefresh();
        } catch {
          // Keep the conflict message useful even if refreshing the branch also fails.
        }
        if (storyMounted.current) setMemoryQueryError("The branch changed during this query. The answer was discarded; review the current story order and ask again.");
      } else if (requestId === memoryQueryRequest.current && memoryScopeRef.current === requestScope) {
        setMemoryQueryError(queryError instanceof Error ? queryError.message : "The character's memory could not be queried.");
      }
    } finally {
      if (storyMounted.current && requestId === memoryQueryRequest.current) setMemoryQuerying(false);
    }
  }

  function exportContext() {
    if (!context) return;
    const branchFilePart = branchId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "branch";
    const exportPackage = {
      protocol: "lke.context-export.v1",
      exported_at: new Date().toISOString(),
      workspace_id: context.workspace_id,
      branch_id: context.branch_id,
      base_revision: context.base_revision,
      context_manifest: context,
    };
    const file = new Blob([JSON.stringify(exportPackage, null, 2)], { type: "application/json;charset=utf-8" });
    const fileUrl = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = fileUrl;
    link.download = `lorethra-context-${branchFilePart}-r${context.base_revision}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
    setContextExportNotice("Context package saved. Review its facts and exclusions before sharing it.");
  }

  function exportStory() {
    if (!conversation) return;
    const exportPackage = buildStoryExport(conversation, workspaceId, branchId, revision, exportIncludesContext, exportIncludesPrompts);
    const file = new Blob([JSON.stringify(exportPackage, null, 2)], { type: "application/json;charset=utf-8" });
    const fileUrl = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = fileUrl;
    link.download = `lorethra-story-${conversation.conversation_id.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
  }

  async function startConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedActor) {
      setStoryError("Create a character before starting a story.");
      return;
    }
    setStoryError("");
    try {
      const created = await onCommit("create_conversation", {
        conversation_id: newId("story"),
        actor_entity_id: selectedActor,
        title: title.trim() || "Untitled story",
        actor_is_user_controlled: actorIsUserControlled,
      }, "Start a persistent story conversation");
      setTitle("");
      await loadConversations(String(created.conversation_id));
    } catch (createError) {
      setStoryError(createError instanceof Error ? createError.message : "The story could not be started.");
    }
  }

  async function selectConversation(id: string) {
    const requestNumber = ++storySelectionRequest.current;
    setConversationId(id);
    setConversation(null);
    setStoryError("");
    if (!id) return;
    try {
      const detail = await request<StoryConversation>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(id)}?branch_id=${encodeURIComponent(branchId)}`,
      );
      if (requestNumber !== storySelectionRequest.current) return;
      setConversation(detail);
      setActor(detail.actor_entity_id);
      const lastTurn = detail.turns[detail.turns.length - 1];
      setOrder(lastTurn?.narrative_order || 0);
    } catch (loadError) {
      if (requestNumber !== storySelectionRequest.current) return;
      setStoryError(loadError instanceof Error ? loadError.message : "The selected story could not be loaded.");
    }
  }

  async function generateStoryTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversation || generating || busy || !model || !storyProviderAvailable) return;
    if (!ensureExternalProviderConsent(providerId)) {
      setStoryError("No story data was sent. Your direction is still here; choose a local provider or approve this provider first.");
      return;
    }
    const fingerprint = JSON.stringify([workspaceId, branchId, conversation.conversation_id, providerId, model, effectiveCodexReasoningEffort, prompt, order]);
    if (pendingStoryRequest.current?.fingerprint !== fingerprint) {
      pendingStoryRequest.current = {
        fingerprint,
        body: JSON.stringify({
          branch_id: branchId,
          conversation_id: conversation.conversation_id,
          expected_revision: revision,
          idempotency_key: newId("story-turn"),
          provider: providerId,
          external_provider_consent: EXTERNAL_STORY_PROVIDERS.includes(providerId) ? providerId : null,
          model,
          ...(effectiveCodexReasoningEffort ? { reasoning_effort: effectiveCodexReasoningEffort } : {}),
          prompt,
          narrative_order: order,
        }),
      };
    }
    const requestBody = pendingStoryRequest.current.body;
    const controller = new AbortController();
    generationAbort.current = controller;
    setGenerating(true);
    setStoryError("");
    try {
      const generated = await request<StoryGenerationResult>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/generate`,
        {
          method: "POST",
          body: requestBody,
          signal: controller.signal,
        },
      );
      pendingStoryRequest.current = null;
      if (!storyMounted.current) return;
      setConversation(generated.conversation);
      setPrompt("");
      onRevisionChange(generated.revision);
      await onRefresh();
      if (!storyMounted.current) return;
      await loadConversations(generated.conversation_id);
    } catch (generationError) {
      if (!storyMounted.current) return;
      if (generationError instanceof DOMException && generationError.name === "AbortError") {
        setStoryError("Generation stopped. Your direction is still here, and no partial response was saved.");
        return;
      }
      if (generationError instanceof ApiError && generationError.status === 409) {
        pendingStoryRequest.current = null;
        setStoryError("This branch changed before the turn could be saved. Your prompt is preserved. Refreshing the branch; review it before continuing again.");
        try {
          await onRefresh();
        } catch (refreshError) {
          if (storyMounted.current) setStoryError(`Your prompt is preserved, but the branch could not be refreshed: ${refreshError instanceof Error ? refreshError.message : "Refresh failed."}`);
        }
        return;
      }
      setStoryError(generationError instanceof Error ? generationError.message : "The local model could not continue this story.");
    } finally {
      if (generationAbort.current === controller) generationAbort.current = null;
      setGenerating(false);
    }
  }

  function stopStoryGeneration() {
    generationAbort.current?.abort();
  }

  async function confirmStoryTurnChange(turn: StoryConversation["turns"][number], action: "edit" | "delete") {
    if (!conversation) return false;
    if (!activeAdventure) {
      return window.confirm(
        `${action === "delete" ? "Hide" : "Edit"} this turn? Later active turns will be superseded, and the full history will remain available.`,
      );
    }
    const query = new URLSearchParams({
      branch_id: branchId,
      conversation_id: conversation.conversation_id,
      turn_id: turn.turn_id,
      action,
    });
    const preview = await request<StoryHistoryPreview>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/${encodeURIComponent(activeAdventure.adventure_id)}/history-preview?${query}`,
    );
    const lines = [
      `${action === "delete" ? "Hide" : "Change"} this turn and replace or hide ${preview.turns_to_replace_or_hide} active turn${preview.turns_to_replace_or_hide === 1 ? "" : "s"}? Earlier versions remain in history.`,
    ];
    if (!preview.state_reconstructed) {
      lines.push("The saved RPG history is incomplete, so the preview cannot calculate the resulting character sheet.");
    } else if (preview.before && preview.after) {
      const trackerChanges = Object.keys({ ...preview.before.trackers, ...preview.after.trackers })
        .filter((key) => preview.before?.trackers[key]?.value !== preview.after?.trackers[key]?.value)
        .map((key) => `${key}: ${preview.before?.trackers[key]?.value ?? "?"} → ${preview.after?.trackers[key]?.value ?? "?"}`);
      const statChanges = Object.keys({ ...preview.before.stats, ...preview.after.stats })
        .filter((key) => preview.before?.stats[key] !== preview.after?.stats[key])
        .map((key) => `${key}: ${preview.before?.stats[key] ?? "?"} → ${preview.after?.stats[key] ?? "?"}`);
      if (trackerChanges.length || statChanges.length) {
        lines.push(`Character state: ${[...trackerChanges, ...statChanges].join(", ")}`);
      }
      if (preview.before.current_location !== preview.after.current_location) {
        lines.push(`Location: ${preview.before.current_location || "Unknown"} → ${preview.after.current_location || "Unknown"}`);
      }
    }
    if (preview.changed_npc_profiles.length) {
      lines.push(`${preview.changed_npc_profiles.length} NPC profile${preview.changed_npc_profiles.length === 1 ? "" : "s"} will be reconstructed from the remaining history.`);
    }
    if (preview.invalidated_proposals.length) {
      const effects = preview.invalidated_proposals.flatMap((proposal) => proposal.effects);
      lines.push(`${preview.invalidated_proposals.length} accepted state change${preview.invalidated_proposals.length === 1 ? "" : "s"} tied to the affected turns will be removed from current RPG state${effects.length ? ` (${effects.join(", ")})` : ""}.`);
    }
    return window.confirm(lines.join("\n\n"));
  }

  async function retryStoryTurn(turn: StoryConversation["turns"][number]) {
    if (!conversation || !activeAdventure || generating || busy || turn.role !== "assistant") return;
    if (!ensureExternalProviderConsent(providerId)) {
      setStoryError("No story data was sent. The saved turn is unchanged; choose a local provider or approve this provider first.");
      return;
    }
    try {
      if (!(await confirmStoryTurnChange(turn, "edit"))) return;
    } catch (previewError) {
      setStoryError(previewError instanceof Error ? previewError.message : "The history impact could not be previewed.");
      return;
    }
    const controller = new AbortController();
    generationAbort.current = controller;
    setGenerating(true);
    setStoryError("");
    try {
      const result = await request<StoryGenerationResult>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/retry`,
        { method: "POST", signal: controller.signal,
          body: JSON.stringify({ branch_id: branchId, conversation_id: conversation.conversation_id, turn_id: turn.turn_id, expected_revision: revision, idempotency_key: newId("retry-turn"), provider: providerId, external_provider_consent: EXTERNAL_STORY_PROVIDERS.includes(providerId) ? providerId : null, model, ...(effectiveCodexReasoningEffort ? { reasoning_effort: effectiveCodexReasoningEffort } : {}) }) },
      );
      setConversation(result.conversation);
      onRevisionChange(result.revision);
      await onRefresh();
      await loadConversations(result.conversation_id);
    } catch (retryError) {
      if (retryError instanceof DOMException && retryError.name === "AbortError") {
        setStoryError("Retry stopped. The saved turn and story history were left unchanged.");
      } else setStoryError(retryError instanceof Error ? retryError.message : "The turn could not be retried.");
    } finally {
      if (generationAbort.current === controller) generationAbort.current = null;
      setGenerating(false);
    }
  }

  async function saveTurnEdit(turn: StoryConversation["turns"][number]) {
    if (!conversation || !editedTurnText.trim()) return;
    try {
      if (!(await confirmStoryTurnChange(turn, "edit"))) return;
      await onCommit("edit_story_turn", {
        conversation_id: conversation.conversation_id, turn_id: turn.turn_id, action: "edit",
        content: editedTurnText.trim(),
      }, "Edit a saved story turn and preserve its prior versions");
      setEditingTurnId("");
      setEditedTurnText("");
      await selectConversation(conversation.conversation_id);
    } catch (editError) {
      setStoryError(editError instanceof Error ? editError.message : "The turn could not be edited.");
    }
  }

  async function deleteStoryTurn(turn: StoryConversation["turns"][number]) {
    if (!conversation) return;
    try {
      if (!(await confirmStoryTurnChange(turn, "delete"))) return;
      await onCommit("edit_story_turn", {
        conversation_id: conversation.conversation_id, turn_id: turn.turn_id, action: "delete",
      }, "Hide a story turn while retaining its full edit history");
      await selectConversation(conversation.conversation_id);
    } catch (deleteError) {
      setStoryError(deleteError instanceof Error ? deleteError.message : "The turn could not be hidden.");
    }
  }

  async function recordBelief(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError("");
    try {
      await onCommit("add_belief", {
        actor_entity_id: selectedActor,
        claim_id: data.get("claim_id"),
        stance: data.get("stance"),
        awareness_order: Number(data.get("awareness_order")),
      }, "Record a character's reviewed knowledge state");
      form.reset();
    } catch (beliefError) {
      setError(beliefError instanceof Error ? beliefError.message : "Knowledge could not be recorded.");
    }
  }

  function updateCreationStat(index: number, changes: Partial<CharacterCreationStat>) {
    const current = creationStatDefinitions[index];
    if (!current) return;
    setCreationStatDefinitions((definitions) => definitions.map((stat, itemIndex) => itemIndex === index ? { ...stat, ...changes } : stat));
    if (typeof changes.key === "string" && changes.key !== current.key) {
      setCreationMechanics((mechanics) => ({
        ...mechanics,
        skills: mechanics.skills.map((skill) => skill.attribute?.toLocaleLowerCase() === current.key.toLocaleLowerCase()
          ? { ...skill, attribute: changes.key! }
          : skill),
      }));
    }
    setCreationError("");
  }

  function addCreationStat() {
    if (creationStatDefinitions.length >= 20) return;
    let suffix = creationStatDefinitions.length + 1;
    let key = `attribute_${suffix}`;
    while (creationStatDefinitions.some((stat) => stat.key.toLocaleLowerCase() === key.toLocaleLowerCase())) {
      suffix += 1;
      key = `attribute_${suffix}`;
    }
    const stat = { key, label: `Attribute ${suffix}`, baseline: 0, minimum: 0, maximum: 5, point_cost: 1 };
    setCreationStatDefinitions((definitions) => [...definitions, stat]);
  }

  function removeCreationStat(index: number) {
    if (creationStatDefinitions.length <= 1) return;
    const removed = creationStatDefinitions[index];
    if (!removed) return;
    const remaining = creationStatDefinitions.filter((_, itemIndex) => itemIndex !== index);
    const fallback = remaining[0]?.key ?? null;
    setCreationStatDefinitions(remaining);
    setCreationMechanics((mechanics) => ({
      ...mechanics,
      skills: mechanics.skills.map((skill) => skill.attribute?.toLocaleLowerCase() === removed.key.toLocaleLowerCase()
        ? { ...skill, attribute: fallback }
        : skill),
    }));
    setCreationError("");
  }

  function updateCreationAbility(index: number, changes: Partial<StoryAbilityDefinition>) {
    setCreationAbilities((abilities) => abilities.map((ability, itemIndex) =>
      itemIndex === index ? { ...ability, ...changes } : ability));
    setCreationError("");
  }

  function addCreationAbility() {
    if (creationAbilities.length >= 50) return;
    let suffix = creationAbilities.length + 1;
    while (creationAbilities.some((ability) => ability.ability_id === `ability_${suffix}`)) suffix += 1;
    setCreationAbilities((abilities) => [...abilities, emptyStoryAbility(suffix)]);
  }

  function removeCreationAbility(index: number) {
    setCreationAbilities((abilities) => abilities.filter((_, itemIndex) => itemIndex !== index));
  }

  function resetAdventureAllocation() {
    if (!selectedSetupCreation) return;
    const balanced = balancedCharacterAllocation(
      selectedSetupStatDefinitions,
      selectedSetupCreation.point_budget,
      selectedSetupCreation.allow_unspent_points,
    );
    if (!balanced) {
      setAdventureAllocationMessage("This world has no valid balanced starting sheet. Adjust the attributes to meet its rules.");
      return;
    }
    setAdventureAllocation(balanced);
    setAdventureAllocationMessage("Balanced starting attributes restored.");
  }

  function randomizeAdventureAllocation() {
    if (!selectedSetupCreation) return;
    const randomized = randomizeCharacterAllocation(
      selectedSetupStatDefinitions,
      selectedSetupCreation.point_budget,
      selectedSetupCreation.allow_unspent_points,
    );
    if (!randomized) {
      setAdventureAllocationMessage("No allocation can spend this exact budget with the current stat costs and maximums.");
      return;
    }
    setAdventureAllocation(randomized);
    setAdventureAllocationMessage("A valid allocation was randomized. Review it before starting.");
  }

  async function refreshStoryLibrary(): Promise<{ worlds: StoryWorld[]; adventures: StoryAdventure[] }> {
    const [worldRows, adventureRows] = await Promise.all([
      request<StoryWorld[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds`),
      request<StoryAdventure[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures`),
    ]);
    setWorlds(worldRows);
    setAdventures(adventureRows);
    return { worlds: worldRows, adventures: adventureRows };
  }

  async function prepareWorldCover(file: File | undefined, edit: boolean) {
    if (!file) return;
    setCoverPreparing(true);
    setLibraryError("");
    try {
      const cover = await encodeStoryWorldCover(file);
      if (edit) setEditWorldCover(cover);
      else setWorldCover(cover);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The cover image could not be prepared.");
    } finally {
      setCoverPreparing(false);
    }
  }

  async function setWorldArchived(world: StoryWorld, archived: boolean) {
    setLibraryError("");
    try {
      await onMainCommit("set_story_world_archived", { world_id: world.world_id, archived }, archived ? "Archive a story world" : "Restore a story world");
      const library = await refreshStoryLibrary();
      const activeWorldRows = library.worlds.filter((item) => !item.archived_at);
      if (archived && selectedWorldId === world.world_id) {
        setSelectedWorldId(activeWorldRows[0]?.world_id || "");
        setShowWorldCreation(activeWorldRows.length === 0);
      }
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The world could not be updated.");
    }
  }

  async function duplicateWorld(world: StoryWorld) {
    setLibraryError("");
    try {
      const created = await onMainCommit("duplicate_story_world", {
        source_world_id: world.world_id,
        world_id: newId("world"),
        name: uniqueLibraryCopyName(world.name, worlds.map((item) => item.name)),
      }, `Duplicate world ${world.name} as a separate library entry`);
      await refreshStoryLibrary();
      setSelectedWorldId(String(created.world_id || ""));
      setSetupStep(1);
      setSetupExpanded(true);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The world could not be duplicated.");
    }
  }

  async function updateAdventureLibrary(item: StoryAdventure, updates: { name?: string; status?: StoryAdventure["status"]; archived?: boolean }) {
    setLibraryError("");
    try {
      await onCommitBranch(item.branch_id, "set_story_adventure_library_state", {
        adventure_id: item.adventure_id, ...updates,
      }, "Update adventure library details");
      await refreshStoryLibrary();
      if (updates.name && item.branch_id === branchId) await loadConversations(conversationId);
      setRenamingAdventureId("");
      setRenamingAdventureName("");
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The adventure could not be updated.");
    }
  }

  async function duplicateAdventure(item: StoryAdventure) {
    setLibraryError("");
    try {
      const packageData = await request<unknown>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/${encodeURIComponent(item.adventure_id)}/package?branch_id=${encodeURIComponent(item.branch_id)}&export_mode=full_private_archive&confirm_private=true`,
      );
      const mainRevision = await request<{ revision: number }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/revision?branch_id=main`,
      );
      const duplicateId = newId("adventure");
      await request<Record<string, unknown>>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/package-import`,
        { method: "POST", body: JSON.stringify({
          expected_revision: mainRevision.revision,
          idempotency_key: newId("duplicate-adventure"),
          adventure_id: duplicateId,
          name: uniqueLibraryCopyName(item.name, mainAdventures.map((adventure) => adventure.name)),
          package: packageData,
        }) },
      );
      await refreshStoryLibrary();
      onSelectBranch(duplicateId);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The adventure could not be duplicated.");
    }
  }

  async function generateWorldDraft() {
    if (worldArchitectAbort.current) return;
    const name = worldName.trim();
    const brief = worldArchitectBrief.trim();
    if (!name || !brief) {
      setCreationError("Enter a world name and a short creative brief before asking the local architect.");
      return;
    }
    if (!localStoryProvider?.available || !selectedWorldArchitectModel) {
      setCreationError("Choose an available local Ollama model to draft this world. You can still create it manually.");
      return;
    }
    setCreationError("");
    setWorldArchitectMessage("");
    setWorldArchitectDraft(null);
    const controller = new AbortController();
    worldArchitectAbort.current = controller;
    setWorldArchitectBusy(true);
    try {
      const response = await request<{ draft: StoryWorldArchitectDraft; saved: false }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds/draft`,
        {
          method: "POST",
          body: JSON.stringify({ name, template_key: worldTemplate, brief, model: selectedWorldArchitectModel }),
          signal: controller.signal,
        },
      );
      if (!storyMounted.current) return;
      setWorldArchitectDraft(response.draft);
      setWorldArchitectMessage("Local draft ready. Review it, then choose whether to use it in the editable world form.");
    } catch (error) {
      if (!storyMounted.current) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        setWorldArchitectMessage("Draft cancelled. No world data was saved.");
        return;
      }
      setCreationError(error instanceof Error ? error.message : "The local world draft could not be generated.");
    } finally {
      if (worldArchitectAbort.current === controller) worldArchitectAbort.current = null;
      if (storyMounted.current) setWorldArchitectBusy(false);
    }
  }

  function cancelWorldDraft() {
    if (!worldArchitectAbort.current) return;
    setWorldArchitectMessage("Stopping the local draft…");
    worldArchitectAbort.current.abort();
  }

  function applyWorldArchitectDraft() {
    if (!worldArchitectDraft) return;
    setWorldPremise(worldArchitectDraft.public_lore);
    setWorldStartingLocation(worldArchitectDraft.starting_location);
    const startingKey = worldArchitectDraft.starting_location.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    setWorldLocations(worldArchitectDraft.locations.filter((location) =>
      location.trim().replace(/\s+/g, " ").toLocaleLowerCase() !== startingKey,
    ).join("\n"));
    setWorldOpeningSituation(worldArchitectDraft.opening_scene.situation);
    setWorldOpeningHook(worldArchitectDraft.opening_scene.hook);
    setWorldArchitectDraft(null);
    setWorldArchitectMessage("Draft copied into the editable form. Review every field, then save the world to publish version 1.");
  }

  async function createWorld(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (worldArchitectBusy) return;
    const name = worldName.trim();
    if (!name) return;
    if (!creationWorldValid) {
      setCreationError("Check the stat names, baseline bounds, point costs, and allocation before saving this world.");
      return;
    }
    const trackers = parseTrackerDefinitions(creationTrackerText);
    if (!trackers) {
      setCreationError("Enter trackers as one name=value/max pair per line, with a value no higher than its maximum.");
      return;
    }
    const additionalLocations = parseStoryWorldLocations(worldLocations);
    if (!additionalLocations) {
      setCreationError("Use up to 100 unique additional places, each no longer than 150 characters.");
      return;
    }
    const requestedStartingLocation = worldStartingLocation.trim();
    const startingLocation = additionalLocations.find((location) =>
      location.toLocaleLowerCase() === requestedStartingLocation.toLocaleLowerCase(),
    ) || requestedStartingLocation;
    const locations = [
      ...(startingLocation ? [startingLocation] : []),
      ...additionalLocations.filter((location) => location.toLocaleLowerCase() !== startingLocation.toLocaleLowerCase()),
    ];
    if (locations.length > 100) {
      setCreationError("Keep the starting place and map to 100 places or fewer.");
      return;
    }
    const openingSituation = worldOpeningSituation.trim();
    const openingHook = worldOpeningHook.trim();
    if (Boolean(openingSituation) !== Boolean(openingHook)) {
      setCreationError("Complete both opening-scene fields, or leave both empty.");
      return;
    }
    const template = STORY_WORLD_TEMPLATES[worldTemplate as keyof typeof STORY_WORLD_TEMPLATES];
    setLibraryError("");
    try {
      const created = await onMainCommit("create_story_world", {
        world_id: newId("world"),
        name,
        description: worldPremise.trim(),
        template_key: worldTemplate,
        content: {
          ...template.content,
          ...(openingSituation ? { opening_scene: { situation: openingSituation, hook: openingHook } } : {}),
          cover_image: worldCover,
          trackers,
          game_mechanics: creationMechanics,
          stats: Object.fromEntries(creationStatDefinitions.map((stat) => [stat.key.trim(), stat.baseline])),
          abilities: creationAbilities.map((ability) => ({
            ...ability,
            ability_id: ability.ability_id.trim(), name: ability.name.trim(), description: ability.description.trim(),
            category: ability.category.trim(), source: ability.source.trim(), activation: ability.activation.trim(),
            deactivation: ability.deactivation.trim(),
            effects: ability.effects.map((item) => item.trim()).filter(Boolean),
            costs: ability.costs.map((cost) => ({ resource: cost.resource.trim(), amount: cost.amount })),
            magic_interactions: ability.magic_interactions.map((item) => item.trim()).filter(Boolean),
            demonstrated_capabilities: ability.demonstrated_capabilities.map((item) => item.trim()).filter(Boolean),
            confirmed_limitations: ability.confirmed_limitations.map((item) => item.trim()).filter(Boolean),
            unresolved_aspects: ability.unresolved_aspects.map((item) => item.trim()).filter(Boolean),
            duration: ability.duration?.trim() || null,
            range: ability.range?.trim() || null,
          })),
          character_creation: {
            point_budget: creationPointBudget,
            allow_unspent_points: creationAllowUnspentPoints,
            allow_below_baseline: creationAllowBelowBaseline,
            stats: Object.fromEntries(creationStatDefinitions.map((stat) => [stat.key.trim(), {
              label: stat.label.trim(), minimum: stat.minimum, maximum: stat.maximum, point_cost: stat.point_cost,
            }])),
          },
          public_lore: worldPremise.trim(),
          starting_location: startingLocation,
          locations,
        },
      }, "Create a story world from a local template");
      setWorldName("");
      setWorldPremise("");
      const defaultStartingLocation = typeof template.content.starting_location === "string" ? template.content.starting_location : "";
      setWorldStartingLocation(defaultStartingLocation);
      setWorldLocations("");
      setWorldOpeningSituation("");
      setWorldOpeningHook("");
      setWorldArchitectBrief("");
      setWorldArchitectDraft(null);
      setWorldArchitectMessage("");
      setWorldCover(null);
      const rows = await request<StoryWorld[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds`);
      setWorlds(rows);
      const createdId = String(created.world_id || "");
      if (createdId) setSelectedWorldId(createdId);
      setShowWorldCreation(false);
      setWorldCreationStep(1);
      setSetupStep(2);
    } catch (createError) {
      setLibraryError(createError instanceof Error ? createError.message : "The world could not be created.");
    }
  }

  async function previewWorldExport() {
    if (!selectedWorldId) return;
    setLibraryError("");
    try {
      const preview = await request<StoryAdventureExportPreview>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds/${encodeURIComponent(selectedWorldId)}/package-preview?export_mode=${encodeURIComponent(worldExportMode)}`,
      );
      setWorldExportReview({ workspaceId, worldId: selectedWorldId, revision, mode: worldExportMode, preview });
    } catch (error) {
      setWorldExportReview(null);
      setLibraryError(error instanceof Error ? error.message : "The world export could not be previewed.");
    }
  }

  async function exportWorldPackage() {
    if (!selectedWorldId || !worldExportReview) return;
    if (worldExportReview.workspaceId !== workspaceId || worldExportReview.worldId !== selectedWorldId
      || worldExportReview.revision !== revision || worldExportReview.mode !== worldExportMode) {
      setWorldExportReview(null);
      setLibraryError("The selected world changed. Preview the export again before downloading.");
      return;
    }
    if (worldExportReview.preview.requires_private_confirmation
      && !window.confirm(`This world export contains unclassified content: ${JSON.stringify(worldExportReview.preview.sensitive)}. Download the full private archive?`)) return;
    try {
      const data = await request<unknown>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds/${encodeURIComponent(selectedWorldId)}/package?export_mode=${encodeURIComponent(worldExportMode)}&confirm_private=${worldExportReview.preview.requires_private_confirmation}`,
      );
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `world-${selectedWorldId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80)}.lke-world`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The world package could not be exported.");
    }
  }

  async function previewWorldPackage(file: File | undefined) {
    setWorldPackage(null);
    setLibraryError("");
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error("Choose a world package smaller than 2 MB.");
      const data: unknown = JSON.parse(await file.text());
      if (file.name.toLocaleLowerCase().endsWith(".mno-world")) {
        const converted = await request<{ package: unknown; preview: NonNullable<typeof worldPackage>["preview"] }>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds/mno-preview`,
          { method: "POST", body: JSON.stringify({ source: data, filename: file.name }) },
        );
        setWorldPackage({ workspace: workspaceId, data: converted.package, preview: converted.preview });
      } else {
        const preview = await request<NonNullable<typeof worldPackage>["preview"]>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds/package-preview`,
          { method: "POST", body: JSON.stringify(data) },
        );
        setWorldPackage({ workspace: workspaceId, data, preview });
      }
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The world package could not be previewed.");
    }
  }

  async function importWorldPackage() {
    if (!worldPackage || worldPackage.workspace !== workspaceId) return;
    try {
      const created = await onMainCommit("import_story_world", { world_id: newId("world"), package: worldPackage.data }, "Import a reviewed duplicate world package");
      const rows = await request<StoryWorld[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds`);
      setWorlds(rows);
      setSelectedWorldId(String(created.world_id));
      setWorldPackage(null);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The world package could not be imported.");
    }
  }

  function buildSelectedAdventureExport(): StoryAdventureExportSelection {
    const selection: StoryAdventureExportSelection = {};
    if (adventureExportSections.includes("turn_ids")) selection.turn_ids = (conversation?.turns || []).map((turn) => turn.turn_id);
    if (adventureExportSections.includes("check_ids")) selection.check_ids = (rpgState?.checks || []).map((check) => check.check_id);
    if (adventureExportSections.includes("mechanic_check_ids")) selection.mechanic_check_ids = (rpgState?.mechanic_checks || []).map((check) => check.check_id);
    if (adventureExportSections.includes("proposal_ids")) selection.proposal_ids = (rpgState?.proposals || []).map((proposal) => proposal.proposal_id);
    if (adventureExportSections.includes("memory_ids")) selection.memory_ids = (studioData?.memories.memories || []).map((memory) => memory.memory_id);
    if (adventureExportSections.includes("thread_ids")) selection.thread_ids = (studioData?.memories.threads || []).map((thread) => thread.thread_id);
    if (adventureExportSections.includes("npc_entity_ids")) selection.npc_entity_ids = (studioData?.npcs || []).map((npc) => npc.npc_entity_id);
    if (adventureExportSections.includes("asset_ids")) selection.asset_ids = (studioData?.assets || []).map((asset) => asset.asset_id);
    if (adventureExportSections.includes("location_ids")) selection.location_ids = (studioData?.locations || []).map((location) => location.location_id);
    return selection;
  }

  async function previewAdventureExport() {
    if (!activeAdventure) return;
    setLibraryError("");
    const selection = adventureExportMode === "selected_content" ? buildSelectedAdventureExport() : undefined;
    try {
      const preview = await request<StoryAdventureExportPreview>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/${encodeURIComponent(activeAdventure.adventure_id)}/package-export-preview`,
        { method: "POST", body: JSON.stringify({ branch_id: branchId, export_mode: adventureExportMode, selection }) },
      );
      setAdventureExportReview({ workspaceId, branchId, adventureId: activeAdventure.adventure_id, revision,
        mode: adventureExportMode, selection, preview });
    } catch (error) {
      setAdventureExportReview(null);
      setLibraryError(error instanceof Error ? error.message : "The adventure export could not be previewed.");
    }
  }

  async function exportAdventurePackage() {
    if (!activeAdventure || !adventureExportReview) return;
    const selection = adventureExportMode === "selected_content" ? buildSelectedAdventureExport() : undefined;
    const scopeMatches = adventureExportReview.workspaceId === workspaceId
      && adventureExportReview.branchId === branchId
      && adventureExportReview.adventureId === activeAdventure.adventure_id
      && adventureExportReview.revision === revision
      && adventureExportReview.mode === adventureExportMode
      && JSON.stringify(adventureExportReview.selection || null) === JSON.stringify(selection || null);
    if (!scopeMatches) {
      setAdventureExportReview(null);
      setLibraryError("The adventure or selected content changed. Preview the export again before downloading.");
      return;
    }
    const sensitive = adventureExportReview.preview.sensitive || {};
    const containsPrivate = adventureExportReview.preview.requires_private_confirmation;
    if (containsPrivate && !window.confirm(
      `This export contains private material: ${JSON.stringify(sensitive)}. Download the reviewed private archive?`,
    )) return;
    setLibraryError("");
    try {
      const data = await request<unknown>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/${encodeURIComponent(activeAdventure.adventure_id)}/package-export`,
        { method: "POST", body: JSON.stringify({ branch_id: branchId, export_mode: adventureExportMode,
          confirm_private: containsPrivate, selection }) },
      );
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      const extension = adventureExportMode === "public_world" ? "lke-world" : "lke-adventure";
      const label = adventureExportMode === "public_world" ? activeAdventure.world_id : activeAdventure.adventure_id;
      link.download = `${extension === "lke-world" ? "world" : "adventure"}-${label.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80)}.${extension}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The adventure package could not be exported.");
    }
  }

  async function previewAdventurePackage(file: File | undefined) {
    setAdventurePackage(null);
    setLibraryError("");
    if (!file) return;
    try {
      if (file.size > 10_000_000) throw new Error("Choose an adventure package smaller than 10 MB.");
      const data: unknown = JSON.parse(await file.text());
      if (file.name.toLocaleLowerCase().endsWith(".mno-adv")) {
        const converted = await request<{ package: unknown; preview: NonNullable<typeof adventurePackage>["preview"] }>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/mno-preview`,
          { method: "POST", body: JSON.stringify({ source: data, filename: file.name }) },
        );
        setAdventurePackage({ workspace: workspaceId, data: converted.package, preview: converted.preview });
      } else {
        const preview = await request<NonNullable<typeof adventurePackage>["preview"]>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/package-preview`,
          { method: "POST", body: JSON.stringify(data) },
        );
        setAdventurePackage({ workspace: workspaceId, data, preview });
      }
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The adventure package could not be previewed.");
    }
  }

  async function importAdventurePackage() {
    if (!adventurePackage || adventurePackage.workspace !== workspaceId || branchId !== "main") return;
    try {
      const imported = await request<{ branch_id: string; world_id: string }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/package-import`,
        {
          method: "POST",
          body: JSON.stringify({
            expected_revision: revision,
            idempotency_key: newId("adventure_import"),
            adventure_id: newId("adventure"),
            package: adventurePackage.data,
          }),
        },
      );
      const rows = await request<StoryWorld[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds`);
      setWorlds(rows);
      setSelectedWorldId(imported.world_id);
      setAdventurePackage(null);
      onSelectBranch(imported.branch_id);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "The adventure package could not be imported.");
    }
  }

  async function createHero(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = heroName.trim();
    if (!label) return;
    try {
      const characterProfile = buildHeroProfile(heroProfileDraft);
      const heroId = newId("hero");
      const properties = {
        role: "protagonist",
        ...(Object.keys(characterProfile).length ? { character_profile: characterProfile } : {}),
      };
      const created = await onMainCommit("create_entity", {
        entity_id: heroId, entity_type: "character", label, properties,
      }, "Create the protagonist for Story Studio");
      setHeroName("");
      setHeroProfileDraft({ ...EMPTY_HERO_PROFILE });
      const createdId = String(created.entity_id || heroId);
      const savedHero: Entity = {
        entity_id: createdId, entity_type: "character", label, properties,
        created_revision: 0, updated_revision: 0,
      };
      setMainCharacters((current) => [...current.filter((item) => item.entity_id !== createdId), savedHero]);
      setAdventureHeroId(createdId);
      setActor(createdId);
      setShowHeroCreation(false);
      setShowHeroProfileEditor(false);
      setSetupStep(3);
      try {
        const rows = await request<Entity[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/entities?branch_id=main`);
        setMainCharacters(rows.filter((item) => ["character", "person"].includes(item.entity_type)));
      } catch {
        setLibraryError("Hero saved. Refresh the workspace if the library does not show the updated list.");
      }
    } catch (createError) {
      setLibraryError(createError instanceof Error ? createError.message : "The protagonist could not be created.");
    }
  }

  async function saveHeroProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSetupHero) return;
    try {
      const properties = { ...selectedSetupHero.properties };
      const characterProfile = buildHeroProfile(heroProfileDraft, true);
      if (Object.keys(characterProfile).length) properties.character_profile = characterProfile;
      else delete properties.character_profile;
      await onMainCommit("update_entity", {
        entity_id: selectedSetupHero.entity_id,
        properties,
      }, "Update reusable hero identity notes");
      setMainCharacters((current) => current.map((item) => item.entity_id === selectedSetupHero.entity_id
        ? { ...item, properties }
        : item));
      setShowHeroProfileEditor(false);
      setLibraryError("");
      try {
        const rows = await request<Entity[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/entities?branch_id=main`);
        setMainCharacters(rows.filter((item) => ["character", "person"].includes(item.entity_type)));
      } catch {
        setLibraryError("Identity saved. Refresh the workspace if the library does not show the updated profile.");
      }
    } catch (saveError) {
      setLibraryError(saveError instanceof Error ? saveError.message : "The hero identity could not be saved.");
    }
  }

  async function saveAdventureHeroProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventureHero) return;
    try {
      const properties = { ...activeAdventureHero.properties };
      const characterProfile = buildHeroProfile(adventureHeroProfileDraft, true);
      if (Object.keys(characterProfile).length) properties.character_profile = characterProfile;
      else delete properties.character_profile;
      await onCommit("update_entity", {
        entity_id: activeAdventureHero.entity_id,
        properties,
      }, "Update this adventure's character identity");
      setShowAdventureHeroProfileEditor(false);
      setAdventureHeroProfileError("");
    } catch (saveError) {
      setAdventureHeroProfileError(saveError instanceof Error ? saveError.message : "The adventure character identity could not be saved.");
    }
  }

  function changeAdventureHeroProfileField(key: keyof HeroProfileDraft, value: string) {
    setAdventureHeroProfileDraft((current) => ({ ...current, [key]: value }));
    setAdventureHeroProfileError("");
  }

  async function reviseWorld(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedWorldDetail) return;
    const latest = selectedWorldDetail.versions.find((item) => item.version === selectedWorldDetail.latest_version);
    if (!latest) return;
    const invalidLorebookEntry = editMnoLorebook.find((entry) => {
      const changed = entry.activation !== entry.originalActivation
        || JSON.stringify(entry.keywords) !== JSON.stringify(entry.originalKeywords);
      const keywords = entry.keywords.map((keyword) => keyword.trim()).filter(Boolean);
      return changed && (keywords.length > 50
        || keywords.some((keyword) => keyword.length > 100)
        || new Set(keywords.map((keyword) => keyword.toLocaleLowerCase())).size !== keywords.length);
    });
    if (invalidLorebookEntry) {
      setLibraryError(`Check the keywords for “${invalidLorebookEntry.title}”: use at most 50 unique keywords, each up to 100 characters.`);
      return;
    }
    const trackers = parseTrackerDefinitions(editTrackerText);
    if (!trackers) {
      setLibraryError("Enter trackers as one name=value/max pair per line, with a value no higher than its maximum.");
      return;
    }
    const openingSituation = editWorldOpeningSituation.trim();
    const openingHook = editWorldOpeningHook.trim();
    if (Boolean(openingSituation) !== Boolean(openingHook)) {
      setLibraryError("Complete both opening-scene fields, or leave both empty.");
      return;
    }
    const locations = parseStoryWorldLocations(editWorldLocations);
    if (!locations) {
      setLibraryError("Use up to 100 unique location names, each no longer than 150 characters.");
      return;
    }
    const requestedStartingLocation = editWorldStartingLocation.trim();
    const matchingStartingLocation = locations.find((location) => location.toLocaleLowerCase() === requestedStartingLocation.toLocaleLowerCase());
    const startingLocation = matchingStartingLocation || (!locations.length ? requestedStartingLocation : "");
    if (requestedStartingLocation && locations.length > 0 && !matchingStartingLocation) {
      setLibraryError("Choose a starting location from the world’s location list, or leave it blank.");
      return;
    }
    const revisedContent: Record<string, unknown> = {
      ...latest.content,
      cover_image: editWorldCover,
      trackers,
      game_mechanics: editMechanics,
      public_lore: editWorldPremise.trim(),
      starting_location: startingLocation,
      locations,
    };
    if (latest.content.mno_import && typeof latest.content.mno_import === "object" && !Array.isArray(latest.content.mno_import)) {
      const importMetadata = { ...(latest.content.mno_import as Record<string, unknown>) };
      const lorebookRules = buildMnoLorebookRules(editMnoLorebook);
      if (Object.keys(lorebookRules).length) importMetadata.lorebook_rules = lorebookRules;
      else delete importMetadata.lorebook_rules;
      revisedContent.mno_import = importMetadata;
    }
    if (openingSituation) revisedContent.opening_scene = { situation: openingSituation, hook: openingHook };
    else delete revisedContent.opening_scene;
    try {
      await onMainCommit("revise_story_world", {
        world_id: selectedWorldDetail.world_id,
        expected_world_version: selectedWorldDetail.latest_version,
        name: editWorldName.trim(),
        description: editWorldDescription.trim(),
        template_key: latest.template_key,
        content: revisedContent,
      }, "Save a new immutable version of the story world");
      const rows = await request<StoryWorld[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds`);
      setWorlds(rows);
      const detail = await request<{ world_id: string; name: string; latest_version: number; versions: { version: number; description: string; template_key: string; content: Record<string, unknown> }[] }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds/${encodeURIComponent(selectedWorldDetail.world_id)}`,
      );
      const refreshedVersion = detail.versions.find((item) => item.version === detail.latest_version);
      setSelectedWorldDetail(detail);
      setEditWorldName(detail.name);
      setEditWorldDescription(refreshedVersion?.description || "");
      setEditWorldPremise(typeof refreshedVersion?.content.public_lore === "string" ? refreshedVersion.content.public_lore : "");
      setEditWorldStartingLocation(typeof refreshedVersion?.content.starting_location === "string" ? refreshedVersion.content.starting_location : "");
      const openingScene = readStoryOpeningScene(refreshedVersion?.content.opening_scene);
      setEditWorldOpeningSituation(openingScene.situation);
      setEditWorldOpeningHook(openingScene.hook);
      setEditWorldCover(readStoryWorldCover(refreshedVersion?.content.cover_image));
      setEditWorldLocations(Array.isArray(refreshedVersion?.content.locations) ? refreshedVersion.content.locations.filter((value): value is string => typeof value === "string").join("\n") : "");
      setEditTrackerText(trackerDefinitionsText(refreshedVersion?.content.trackers));
      setEditMechanics(readStoryMechanics(
        refreshedVersion?.content.game_mechanics,
        refreshedVersion?.template_key === "narrative" ? "narrative_only" : "d20",
      ));
      setEditMnoLorebook(readMnoLorebookDraft(refreshedVersion?.content));
      setEditMnoLorebookSearch("");
      setEditMnoLorebookVisibleCount(20);
    } catch (editError) {
      setLibraryError(editError instanceof Error ? editError.message : "The world revision could not be saved.");
    }
  }

  async function startAdventure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const world = worlds.find((item) => item.world_id === selectedWorldId);
    if (!world || !adventureHeroId) {
      setLibraryError("Choose a world and protagonist before starting an adventure.");
      return;
    }
    if (selectedSetupCreation && !adventureAllocationValid) {
      setLibraryError("Finish a valid character allocation for this world's creation rules before starting.");
      return;
    }
    setLibraryError("");
    try {
      await onCreateAdventure({
        idempotency_key: newId("start-adventure"),
        adventure_id: newId("adventure"),
        world_id: world.world_id,
        world_version: world.latest_version,
        conversation_id: newId("story"),
        name: adventureName.trim() || world.name,
        actor_entity_id: adventureHeroId,
        actor_is_user_controlled: true,
        ...(selectedSetupCreation ? { stats: adventureAllocation } : {}),
      });
      setSetupStep(1);
      setSetupExpanded(false);
    } catch (createError) {
      setLibraryError(createError instanceof Error ? createError.message : "The adventure could not be started.");
    }
  }

  async function rollMechanicsCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventure || !rpgState?.sheet || rpgState.mechanics.mode === "narrative_only") return;
    const skill = rpgState.mechanics.skills.find((item) => item.skill_id === checkSkill);
    const statName = skill?.attribute || checkStat || (rpgState.mechanics.dice.include_attribute ? Object.keys(rpgState.sheet.stats)[0] : "");
    const encounterType = rpgState.mechanics.encounter_types.some((item) => item.encounter_type === checkEncounter)
      ? checkEncounter : rpgState.mechanics.encounter_types[0]?.encounter_type;
    const difficultyId = rpgState.mechanics.difficulties.some((item) => item.difficulty_id === checkDifficulty)
      ? checkDifficulty : rpgState.mechanics.difficulties[0]?.difficulty_id;
    if (!encounterType || !difficultyId || (!statName && !skill && rpgState.mechanics.dice.include_attribute)) return;
    setRpgError("");
    try {
      const rolled = await request<{ revision: number; state: RpgState }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/${encodeURIComponent(activeAdventure.adventure_id)}/mechanic-checks`,
        {
          method: "POST",
          body: JSON.stringify({ branch_id: branchId, expected_revision: revision, idempotency_key: newId("mechanic-check"),
            encounter_type: encounterType, difficulty_id: difficultyId, stat_name: statName || null, skill_id: skill?.skill_id || null }),
        },
      );
      setRpgState(rolled.state);
      onRevisionChange(rolled.revision);
      await onRefresh();
    } catch (rollError) {
      setRpgError(rollError instanceof Error ? rollError.message : "The check could not be rolled.");
    }
  }

  async function proposeRpgChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventure) return;
    const changes = proposalOperation === "tracker_delta"
      ? [{ operation: "tracker_delta", tracker_id: proposalTracker, delta: proposalDelta }]
      : [{ operation: "set_location", location: proposalLocation.trim() }];
    if (proposalOperation === "set_location" && !proposalLocation.trim()) return;
    try {
      await onCommit("propose_rpg_state", {
        adventure_id: activeAdventure.adventure_id,
        source_turn_id: [...(conversation?.turns || [])].reverse().find((turn) => turn.role === "assistant")?.turn_id || null,
        changes,
      }, "Propose a reviewable RPG state change");
      setProposalLocation("");
    } catch (proposalError) {
      setRpgError(proposalError instanceof Error ? proposalError.message : "The state change could not be proposed.");
    }
  }

  async function reviewRpgProposal(
    proposal: RpgState["proposals"][number],
    review_status: "accepted" | "rejected",
    changes = proposal.changes,
  ) {
    try {
      await onCommit("review_rpg_state_proposal", {
        proposal_id: proposal.proposal_id,
        review_status,
        ...(review_status === "accepted" ? { changes } : {}),
      }, `Review RPG state proposal as ${review_status}`);
      setEditingProposalId("");
    } catch (reviewError) {
      setRpgError(reviewError instanceof Error ? reviewError.message : "The proposal could not be reviewed.");
    }
  }

  function updateEditedProposalChange(index: number, change: RpgState["proposals"][number]["changes"][number]) {
    setEditedProposalChanges((current) => current.map((item, position) => position === index ? change : item));
  }

  async function saveRpgStats(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventure) return;
    try {
      await onCommit("update_rpg_sheet", { adventure_id: activeAdventure.adventure_id, stats: editableStats }, "Update player-reviewed RPG stat modifiers");
    } catch (saveError) {
      setRpgError(saveError instanceof Error ? saveError.message : "Character stats could not be saved.");
    }
  }

  async function saveRpgSkills(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventure) return;
    try {
      await onCommit("update_story_skills", { adventure_id: activeAdventure.adventure_id, skill_ranks: editableSkills }, "Update player-reviewed skill ranks");
    } catch (saveError) {
      setRpgError(saveError instanceof Error ? saveError.message : "Character skills could not be saved.");
    }
  }

  async function awardExperience(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventure || !Number.isInteger(experienceAward) || experienceAward < 1) return;
    try {
      await onCommit("award_story_experience", { adventure_id: activeAdventure.adventure_id, amount: experienceAward }, "Award player-reviewed character experience");
    } catch (awardError) {
      setRpgError(awardError instanceof Error ? awardError.message : "Experience could not be awarded.");
    }
  }

  async function setAbilityActive(abilityId: string, active: boolean) {
    if (!activeAdventure) return;
    try {
      await onCommit("set_story_ability_active", {
        adventure_id: activeAdventure.adventure_id, ability_id: abilityId, active,
      }, `${active ? "Activate" : "Deactivate"} the player-selected exceptional ability`);
      setRpgError("");
    } catch (abilityError) {
      setRpgError(abilityError instanceof Error ? abilityError.message : "Ability state could not be changed.");
    }
  }

  async function reloadStudioData(adventureId = activeAdventure?.adventure_id) {
    if (!adventureId) return;
    const data = await request<StoryStudioData>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/${encodeURIComponent(adventureId)}/studio?branch_id=${encodeURIComponent(branchId)}`,
    );
    setStudioData(data);
  }

  async function saveMemoryNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventure || !memoryNote.trim()) return;
    const allowedKnowledgeHolders = memoryKnownBy.filter((entityId) => characters.some((item) => item.entity_id === entityId));
    try {
      await onCommit("create_story_memory", {
        adventure_id: activeAdventure.adventure_id, memory_id: newId("memory"), kind: "note",
        content: memoryNote.trim(), context_enabled: memoryContextEnabled, review_status: "accepted",
        importance: memoryImportance, knowledge_scope: memoryKnowledgeScope,
        known_by: memoryKnowledgeScope === "actors" ? (allowedKnowledgeHolders.length ? allowedKnowledgeHolders : [activeAdventure.actor_entity_id]) : [],
      }, "Save a player-authored adventure note");
      setMemoryNote("");
      setMemoryKnownBy([]);
      await reloadStudioData();
    } catch (memoryError) {
      setRpgError(memoryError instanceof Error ? memoryError.message : "The note could not be saved.");
    }
  }

  async function reviewMemory(memory: StoryMemory, review_status: "accepted" | "rejected") {
    if (!activeAdventure) return;
    try {
      await onCommit("review_story_memory", {
        adventure_id: activeAdventure.adventure_id, memory_id: memory.memory_id, version: memory.version, review_status,
      }, `Review a story memory as ${review_status}`);
      await reloadStudioData();
    } catch (memoryError) {
      setRpgError(memoryError instanceof Error ? memoryError.message : "The memory could not be reviewed.");
    }
  }

  async function toggleMemoryContext(memory: StoryMemory, context_enabled: boolean) {
    if (!activeAdventure) return;
    try {
      await onCommit("revise_story_memory", {
        adventure_id: activeAdventure.adventure_id, memory_id: memory.memory_id, expected_version: memory.version,
        kind: memory.kind, content: memory.content, context_enabled, review_status: memory.review_status === "rejected" ? "proposed" : memory.review_status,
        source_turn_id: memory.source_turn_id, narrative_order: memory.narrative_order, importance: memory.importance,
        knowledge_scope: memory.knowledge_scope, known_by: memory.known_by,
      }, "Change whether a story memory is available to local generation");
      await reloadStudioData();
    } catch (memoryError) {
      setRpgError(memoryError instanceof Error ? memoryError.message : "Memory context settings could not be changed.");
    }
  }

  function prepareSituation() {
    if (!activeAdventure || !rpgState?.sheet) return;
    const lastScene = [...(conversation?.turns || [])].reverse().find((turn) => turn.role === "assistant" && turn.status === "active");
    const openThreads = studioData?.memories.threads.filter((thread) => thread.status === "open") || [];
    const pieces = [
      `Current location: ${rpgState.sheet.current_location || "unknown"}.`,
      lastScene ? `Latest scene (review before saving): ${lastScene.content.slice(0, 1200)}` : "No scene has been played yet.",
      openThreads.length ? `Open threads: ${openThreads.map((thread) => thread.title).join("; ")}.` : "No open threads are recorded.",
    ];
    setSituationDraft(pieces.join("\n\n"));
  }

  async function saveSituation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventure || !situationDraft.trim()) return;
    const current = studioData?.memories.memories.find((item) => item.kind === "situation");
    const lastScene = [...(conversation?.turns || [])].reverse().find((turn) => turn.role === "assistant" && turn.status === "active");
    try {
      await onCommit(current ? "revise_story_memory" : "create_story_memory", {
        adventure_id: activeAdventure.adventure_id, memory_id: current?.memory_id || newId("situation"),
        ...(current ? { expected_version: current.version } : {}), kind: "situation", content: situationDraft.trim(),
        context_enabled: true, review_status: "proposed", source_turn_id: lastScene?.turn_id || null, importance: 5,
        knowledge_scope: "actors", known_by: [activeAdventure.actor_entity_id],
      }, "Save a rebuildable situation summary for review");
      await reloadStudioData();
    } catch (memoryError) {
      setRpgError(memoryError instanceof Error ? memoryError.message : "The situation could not be saved.");
    }
  }

  async function saveThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventure || !threadTitle.trim()) return;
    try {
      await onCommit("save_story_thread", {
        adventure_id: activeAdventure.adventure_id, thread_id: newId("thread"), title: threadTitle.trim(), detail: threadDetail.trim(), status: "open",
      }, "Add an open story thread");
      setThreadTitle(""); setThreadDetail(""); await reloadStudioData();
    } catch (threadError) {
      setRpgError(threadError instanceof Error ? threadError.message : "The open thread could not be saved.");
    }
  }

  async function updateThread(thread: StoryThread, status: "open" | "closed") {
    if (!activeAdventure) return;
    try {
      await onCommit("save_story_thread", {
        adventure_id: activeAdventure.adventure_id, thread_id: thread.thread_id, title: thread.title, detail: thread.detail, status,
      }, `Mark an open story thread ${status}`);
      await reloadStudioData();
    } catch (threadError) {
      setRpgError(threadError instanceof Error ? threadError.message : "The story thread could not be updated.");
    }
  }

  async function saveNpcProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventure) return;
    const data = new FormData(event.currentTarget);
    let selectedNpcId = String(data.get("npc_entity_id") || "");
    try {
      if (selectedNpcId === "new") {
        const name = String(data.get("new_npc_name") || "").trim();
        if (!name) throw new Error("Enter a name for the new NPC.");
        const created = await onCommit("create_entity", {
          entity_id: newId("npc"), entity_type: "character", label: name, properties: { role: "non_player_character" },
        }, "Create an NPC identity for this adventure");
        selectedNpcId = String(created.entity_id || "");
      }
      if (!selectedNpcId) throw new Error("Choose an existing character or create a new NPC.");
      const existingNpc = studioData?.npcs.find((npc) => npc.npc_entity_id === selectedNpcId);
      await onCommit("update_story_npc", {
        adventure_id: activeAdventure.adventure_id, npc_entity_id: selectedNpcId,
        aliases: String(data.get("aliases") || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
        public_profile: {
          ...existingNpc?.public_profile,
          appearance: String(data.get("appearance") || "").trim(),
          motivation: String(data.get("motivation") || "").trim(),
          current_goal: String(data.get("current_goal") || "").trim(),
          whereabouts: String(data.get("whereabouts") || "").trim(),
          voice: String(data.get("voice") || "").trim(),
          relationship_to_actor: String(data.get("relationship_to_actor") || "").trim(),
        },
        private_profile: { ...existingNpc?.private_profile, notes: String(data.get("private_notes") || "").trim() }, review_status: "accepted",
      }, "Save and approve an adventure NPC profile");
      setNpcId(selectedNpcId);
      await reloadStudioData();
    } catch (npcError) {
      setRpgError(npcError instanceof Error ? npcError.message : "The NPC profile could not be saved.");
    }
  }

  async function addNpcFromWorldTemplate(template: Record<string, unknown>) {
    if (!activeAdventure) return;
    const label = typeof template.name === "string" ? template.name.trim() : "";
    if (!label) return;
    const existing = studioData?.npcs.find((npc) => npc.label.toLocaleLowerCase() === label.toLocaleLowerCase());
    if (existing) {
      setNpcId(existing.npc_entity_id);
      setRpgError(`${label} is already in this adventure.`);
      return;
    }
    setRpgError("");
    const npcEntityId = newId("npc");
    const publicProfile = Object.fromEntries(["age", "gender", "race", "job", "appearance", "persona", "extra"]
      .flatMap((key) => typeof template[key] === "string" && template[key].trim() ? [[key, template[key].trim()]] : []));
    const privateNotes = typeof template.secrets === "string" ? template.secrets.trim() : "";
    try {
      await onCommit("create_story_npc", {
        adventure_id: activeAdventure.adventure_id, npc_entity_id: npcEntityId, label,
        aliases: [], public_profile: publicProfile, private_profile: { notes: privateNotes }, review_status: "accepted",
      }, `Add ${label} from the pinned world cast`);
      setNpcId(npcEntityId);
      let portraitError = "";
      const avatar = typeof template.avatar === "string" ? template.avatar : "";
      const match = avatar.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
      if (match) {
        try {
          await onCommit("add_story_asset", {
            adventure_id: activeAdventure.adventure_id, asset_id: newId("asset"), target_kind: "character",
            target_id: npcEntityId, display_name: `${label} portrait`, mime_type: match[1],
            data_base64: match[2].replace(/\s/g, ""), provenance: { origin: "mno_world_cast", world_version: activeAdventure.world_version },
          }, `Attach the imported ${label} portrait to this adventure`);
        } catch (error) {
          portraitError = error instanceof Error ? error.message : "The portrait could not be attached.";
        }
      }
      await reloadStudioData();
      if (portraitError) setRpgError(`${label} was added, but its portrait was skipped: ${portraitError}`);
    } catch (createError) {
      setRpgError(createError instanceof Error ? createError.message : `${label} could not be added to this adventure.`);
    }
  }

  async function setNpcSimulation(enabled: boolean) {
    if (!activeAdventure) return;
    try {
      await onCommit("set_npc_simulation", { adventure_id: activeAdventure.adventure_id, enabled }, "Change opt-in off-screen NPC activity");
    } catch (simulationError) {
      setRpgError(simulationError instanceof Error ? simulationError.message : "NPC simulation setting could not be changed.");
    }
  }

  async function travelToLocation(location: string) {
    if (!activeAdventure) return;
    try {
      await onCommit("travel_to_location", { adventure_id: activeAdventure.adventure_id, location }, "Travel to a location in the pinned world map");
    } catch (travelError) {
      setRpgError(travelError instanceof Error ? travelError.message : "Travel could not be recorded.");
    }
  }

  async function uploadStoryImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAdventure) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("image");
    if (!(file instanceof File) || !file.size) return;
    setAssetError("");
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("Choose an image smaller than 5 MiB.");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("The image could not be read."));
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The image data is invalid."));
        reader.readAsDataURL(file);
      });
      const encoded = dataUrl.split(",", 2)[1];
      await onCommit("add_story_asset", {
        adventure_id: activeAdventure.adventure_id, asset_id: newId("asset"),
        target_kind: data.get("target_kind"), target_id: data.get("target_id"), display_name: file.name,
        mime_type: file.type, data_base64: encoded, provenance: { origin: "user_upload", original_name: file.name },
      }, "Attach a locally stored story illustration with its target and provenance");
      form.reset();
      await reloadStudioData();
    } catch (uploadError) {
      setAssetError(uploadError instanceof Error ? uploadError.message : "The image could not be attached.");
    }
  }

  const selectedNpcProfile = studioData?.npcs.find((npc) => npc.npc_entity_id === npcId) || null;
  const rawMnoWorld = activeWorldContent?.mno_source;
  const worldCastTemplates = rawMnoWorld && typeof rawMnoWorld === "object" && Array.isArray((rawMnoWorld as Record<string, unknown>).npcs)
    ? ((rawMnoWorld as Record<string, unknown>).npcs as unknown[]).filter((template): template is Record<string, unknown> => Boolean(template) && typeof template === "object" && !Array.isArray(template))
    : [];
  const pinnedLocations = Array.isArray(activeWorldContent?.locations)
    ? activeWorldContent.locations.filter((place): place is string => typeof place === "string") : [];
  const adventureLocations = studioData?.locations.filter((location) => (location.effective_status ?? location.status) === "approved") || [];
  const mapLocationsByName = new Map<string, StoryMapLocation>();
  for (const name of pinnedLocations) mapLocationsByName.set(name.toLocaleLowerCase(), {
    location_id: name, name, status: "approved", source_proposal_id: null, created_revision: 0,
    reviewed_revision: null, created_at: "", location_type: "place", description: "", icon: "", x: null, y: null,
  });
  for (const location of adventureLocations) mapLocationsByName.set(location.name.toLocaleLowerCase(), location);
  const approvedMapLocations = [...mapLocationsByName.values()];
  const positionedLocations = approvedMapLocations.filter((location) => typeof location.x === "number" && typeof location.y === "number");
  const mapCoordinates = [
    ...positionedLocations.map((location) => ({ x: location.x as number, y: location.y as number })),
    ...(typeof rpgState?.sheet?.map_x === "number" && typeof rpgState.sheet.map_y === "number" ? [{ x: rpgState.sheet.map_x, y: rpgState.sheet.map_y }] : []),
  ];
  const mapBounds = mapCoordinates.length ? {
    minX: Math.min(...mapCoordinates.map((point) => point.x)), maxX: Math.max(...mapCoordinates.map((point) => point.x)),
    minY: Math.min(...mapCoordinates.map((point) => point.y)), maxY: Math.max(...mapCoordinates.map((point) => point.y)),
  } : null;
  const mapPosition = (x: number, y: number) => {
    if (!mapBounds) return { left: "50%", top: "50%" };
    const width = Math.max(1, mapBounds.maxX - mapBounds.minX);
    const height = Math.max(1, mapBounds.maxY - mapBounds.minY);
    return {
      left: `${10 + ((x - mapBounds.minX) / width) * 80}%`,
      top: `${10 + (1 - (y - mapBounds.minY) / height) * 80}%`,
    };
  };
  const mainAdventures = adventures.filter((item) => item.parent_branch_id === "main");
  const availableWorlds = worlds.filter((item) => !item.archived_at);
  const libraryQuery = storyLibraryQuery.trim().toLocaleLowerCase();
  const visibleAdventures = mainAdventures
    .filter((item) => !libraryQuery || `${item.name} ${item.world_name} ${item.actor_label}`.toLocaleLowerCase().includes(libraryQuery))
    .filter((item) => storyAdventureStatusFilter === "all"
      || (storyAdventureStatusFilter === "archived" ? !!item.archived_at : !item.archived_at && item.status === storyAdventureStatusFilter))
    .filter((item) => storyWorldFilter === "all" || item.world_id === storyWorldFilter)
    .filter((item) => storyHeroFilter === "all" || item.actor_entity_id === storyHeroFilter)
    .sort((left, right) => storyLibrarySort === "name"
      ? left.name.localeCompare(right.name)
      : storyLibrarySort === "created"
        ? right.created_at.localeCompare(left.created_at)
        : right.updated_at.localeCompare(left.updated_at));
  const visibleWorlds = worlds
    .filter((item) => !libraryQuery || `${item.name} ${item.description} ${item.template_key}`.toLocaleLowerCase().includes(libraryQuery))
    .filter((item) => storyWorldStatusFilter === "all"
      || (storyWorldStatusFilter === "archived" ? !!item.archived_at : !item.archived_at))
    .sort((left, right) => storyLibrarySort === "name"
      ? left.name.localeCompare(right.name)
      : storyLibrarySort === "created"
        ? right.created_at.localeCompare(left.created_at)
        : right.updated_at.localeCompare(left.updated_at));
  const activeStoryLibraryFilterCount = [
    storyWorldFilter !== "all",
    storyHeroFilter !== "all",
    storyAdventureStatusFilter !== "all",
    storyWorldStatusFilter !== "active",
  ].filter(Boolean).length;
  const hasStoryLibraryRefinements = !!libraryQuery || activeStoryLibraryFilterCount > 0;
  const clearStoryLibraryRefinements = () => {
    setStoryLibraryQuery("");
    setStoryWorldFilter("all");
    setStoryHeroFilter("all");
    setStoryAdventureStatusFilter("all");
    setStoryWorldStatusFilter("active");
    setStoryLibrarySort("recent");
  };
  const openAdventureSetup = () => {
    setSetupStep(1);
    setSetupExpanded(true);
    document.getElementById("story-adventure-setup")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const mostRecentAdventure = mainAdventures
    .filter((item) => !item.archived_at && item.status === "active")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
  const visibleMostRecentAdventure = mostRecentAdventure
    && visibleAdventures.some((item) => item.adventure_id === mostRecentAdventure.adventure_id)
    ? mostRecentAdventure
    : null;
  const visibleAdventureRows = visibleAdventures.filter((item) => item.adventure_id !== visibleMostRecentAdventure?.adventure_id);
  const adventurePreviewRows = visibleAdventureRows.slice(0, STORY_LIBRARY_PREVIEW_COUNT);
  const additionalAdventureRows = visibleAdventureRows.slice(STORY_LIBRARY_PREVIEW_COUNT);
  const selectedSetupWorld = worlds.find((item) => item.world_id === selectedWorldId);
  const selectedSetupHero = mainCharacters.find((item) => item.entity_id === adventureHeroId);
  const selectedHeroProfile = readHeroProfile(selectedSetupHero);
  const selectedHeroProfileEntries = heroProfileEntries(selectedHeroProfile);
  const selectedImportedHeroProfileEntries = heroProfileEntries(selectedHeroProfile, true);
  const selectedSetupContent = selectedWorldDetail?.world_id === selectedWorldId
    ? selectedWorldDetail.versions.find((item) => item.version === selectedSetupWorld?.latest_version)?.content || null
    : null;
  const filteredEditMnoLorebook = useMemo(() => {
    const query = editMnoLorebookSearch.trim().toLocaleLowerCase();
    if (!query) return editMnoLorebook;
    return editMnoLorebook.filter((entry) => `${entry.title} ${entry.type} ${entry.keywords.join(" ")} ${entry.content}`
      .toLocaleLowerCase().includes(query));
  }, [editMnoLorebook, editMnoLorebookSearch]);
  const selectedSetupCover = readStoryWorldCover(selectedSetupContent?.cover_image);
  const selectedSetupOpeningScene = readStoryOpeningScene(selectedSetupContent?.opening_scene);
  const hasSelectedSetupOpeningScene = !!selectedSetupOpeningScene.situation && !!selectedSetupOpeningScene.hook;
  const selectedSetupCreation = selectedSetupContent ? characterCreationFromContent(selectedSetupContent) : null;
  const selectedSetupBaselines = selectedSetupContent?.stats && typeof selectedSetupContent.stats === "object" && !Array.isArray(selectedSetupContent.stats)
    ? selectedSetupContent.stats as Record<string, number>
    : {};
  const selectedSetupStatDefinitions: CharacterCreationStat[] = selectedSetupCreation
    ? Object.entries(selectedSetupCreation.stats).map(([key, rule]) => ({
      key,
      ...rule,
      baseline: selectedSetupBaselines[key],
      minimum: selectedSetupCreation.allow_below_baseline ? rule.minimum : Math.max(rule.minimum, selectedSetupBaselines[key]),
    }))
    : [];
  const adventurePointsSpent = allocatedCreationPoints(selectedSetupStatDefinitions, adventureAllocation);
  const adventurePointsRemaining = (selectedSetupCreation?.point_budget || 0) - adventurePointsSpent;
  const adventureAllocationValid = !!selectedSetupCreation
    && selectedSetupStatDefinitions.length > 0
    && selectedSetupStatDefinitions.every((stat) => Number.isInteger(adventureAllocation[stat.key])
      && adventureAllocation[stat.key] >= stat.minimum && adventureAllocation[stat.key] <= stat.maximum
      && (selectedSetupCreation.allow_below_baseline || adventureAllocation[stat.key] >= stat.baseline))
    && adventurePointsRemaining >= 0
    && (selectedSetupCreation.allow_unspent_points || adventurePointsRemaining === 0);
  const renderAdventureCard = (item: StoryAdventure) => <article className="story-adventure-card" key={item.adventure_id}>
    <div className="story-library-card-main"><strong>{item.name}</strong><small>{item.world_name} · world v{item.world_version} · {item.actor_label} · {item.turn_count} turns · {item.status}{item.archived_at ? " · archived" : ""}</small></div>
    {renamingAdventureId === item.adventure_id ? <form className="story-card-rename" onSubmit={(event) => { event.preventDefault(); void updateAdventureLibrary(item, { name: renamingAdventureName.trim() }); }}>
      <input aria-label={`New name for ${item.name}`} maxLength={200} required value={renamingAdventureName} onChange={(event) => setRenamingAdventureName(event.target.value)} />
      <button className="secondary-button" type="submit" disabled={busy || !renamingAdventureName.trim()}>Save</button>
      <button className="quiet-button" type="button" onClick={() => setRenamingAdventureId("")}>Cancel</button>
    </form> : <div className="story-card-actions">
      <button className="secondary-button" type="button" disabled={busy || !!item.archived_at} onClick={() => onSelectBranch(item.branch_id)}>{item.archived_at ? "Archived" : "Resume"}</button>
      <details className="story-card-menu">
        <summary aria-label={`More actions for ${item.name}`}>More</summary>
        <div className="story-card-menu-panel">
          <button className="quiet-button" type="button" disabled={busy} onClick={() => { setRenamingAdventureId(item.adventure_id); setRenamingAdventureName(item.name); }}>Rename adventure</button>
          <label className="story-card-status-field">Adventure status<select aria-label={`Status for ${item.name}`} value={item.status} disabled={busy || !!item.archived_at} onChange={(event) => void updateAdventureLibrary(item, { status: event.target.value as StoryAdventure["status"] })}>
            <option value="active">Active</option><option value="paused">Paused</option><option value="complete">Complete</option>
          </select></label>
          <button className="quiet-button" type="button" disabled={busy} onClick={() => void duplicateAdventure(item)}>Duplicate adventure</button>
          <button className="quiet-button" type="button" disabled={busy} onClick={() => void updateAdventureLibrary(item, { archived: !item.archived_at })}>{item.archived_at ? "Restore adventure" : "Archive adventure"}</button>
        </div>
      </details>
    </div>}
  </article>;
  const creationKeys = creationStatDefinitions.map((stat) => stat.key.trim().toLocaleLowerCase());
  const creationAbilityIds = creationAbilities.map((ability) => ability.ability_id.trim());
  const creationAbilitiesValid = creationAbilities.length <= 50
    && creationAbilityIds.every((id, index) => /^[a-z0-9][a-z0-9._-]{0,99}$/.test(id)
      && creationAbilityIds.indexOf(id) === index)
    && creationAbilities.every((ability) => !!ability.name.trim() && ability.name.trim().length <= 120
      && !!ability.description.trim() && ability.description.trim().length <= 4000
      && !!ability.category.trim() && ability.category.trim().length <= 100
      && !!ability.source.trim() && ability.source.trim().length <= 100
      && !!ability.activation.trim() && ability.activation.trim().length <= 1000
      && !!ability.deactivation.trim() && ability.deactivation.trim().length <= 1000
      && [ability.effects, ability.magic_interactions, ability.demonstrated_capabilities,
        ability.confirmed_limitations, ability.unresolved_aspects].every((values) => values.length <= 20
          && values.every((value) => !!value.trim() && value.trim().length <= 1000))
      && ability.costs.length <= 10
      && ability.costs.every((cost) => !!cost.resource.trim() && cost.resource.trim().length <= 60
        && Number.isInteger(cost.amount) && cost.amount >= 1 && cost.amount <= 100000)
      && new Set(ability.costs.map((cost) => cost.resource.trim().toLocaleLowerCase())).size === ability.costs.length
      && (ability.cooldown_turns === null || (Number.isInteger(ability.cooldown_turns)
        && ability.cooldown_turns >= 0 && ability.cooldown_turns <= 1_000_000))
      && [ability.duration, ability.range].every((value) => value === null || value.length <= 200));
  const creationPointBudgetValid = Number.isInteger(creationPointBudget) && creationPointBudget >= 0 && creationPointBudget <= 200;
  const creationStatsValid = creationStatDefinitions.length > 0 && creationStatDefinitions.length <= 20
    && creationKeys.every((key, index) => !!key && creationKeys.indexOf(key) === index)
    && creationStatDefinitions.every((stat) => !!stat.key.trim() && stat.key.trim().length <= 40
      && !!stat.label.trim() && stat.label.trim().length <= 80
      && Number.isInteger(stat.baseline) && Number.isInteger(stat.minimum) && Number.isInteger(stat.maximum)
      && Number.isInteger(stat.point_cost) && stat.minimum >= -10 && stat.maximum <= 10
      && stat.minimum <= stat.baseline && stat.baseline <= stat.maximum
      && (creationAllowBelowBaseline || stat.minimum === stat.baseline)
       && stat.point_cost >= 1 && stat.point_cost <= 20);
  const creationHasValidStartingAllocation = creationPointBudgetValid && creationStatsValid
    && !!balancedCharacterAllocation(creationStatDefinitions.map((stat) => ({
      ...stat,
      minimum: creationAllowBelowBaseline ? stat.minimum : Math.max(stat.minimum, stat.baseline),
    })), creationPointBudget, creationAllowUnspentPoints);
  const creationWorldValid = creationPointBudgetValid && creationStatsValid
    && creationHasValidStartingAllocation && creationAbilitiesValid;
  const additionalCreationLocations = parseStoryWorldLocations(worldLocations);
  const creationStartingLocation = worldStartingLocation.trim();
  const creationLocationNames = additionalCreationLocations === null ? null : (() => {
    const matchingStartingPlace = additionalCreationLocations.find((location) =>
      location.toLocaleLowerCase() === creationStartingLocation.toLocaleLowerCase(),
    );
    const startingPlace = matchingStartingPlace || creationStartingLocation;
    const locations = [
      ...(startingPlace ? [startingPlace] : []),
      ...additionalCreationLocations.filter((location) => location.toLocaleLowerCase() !== startingPlace.toLocaleLowerCase()),
    ];
    return locations.length <= 100 ? locations : null;
  })();
  const creationPlacesValid = creationLocationNames !== null
    && Boolean(worldOpeningSituation.trim()) === Boolean(worldOpeningHook.trim());
  const lastManualMechanicCheck = rpgState?.mechanic_checks.find((check) => check.source_turn_id === null);
  const pendingRpgReviewCount = rpgState?.proposals.filter((item) => item.review_status === "proposed").length ?? 0;
  const pendingMemoryReviewCount = studioData?.memories.memories.filter((memory) => memory.review_status === "proposed").length ?? 0;

  return <>
    <PageHeader kicker="Play and create" title="Your stories" summary={activeAdventure ? "Your open adventure is below. You can switch stories or start another when you need to." : "Pick up where you left off, or make a new world and hero."} />
    <details className="panel story-hub story-hub-disclosure" open={!activeAdventure}>
      <summary className="panel-heading story-hub-summary">
        <div><h2>Worlds & adventures</h2><p>{activeAdventure ? "Switch stories, create a world, or start another adventure." : "Create a world once, then start separate adventures from its pinned version."}</p></div>
        <span className="privacy-tag">LOCAL</span>
      </summary>
      <div className="story-hub-content">
      <div className="story-library-tools">
        <div className="story-library-search-row">
          <input aria-label="Search worlds and adventures" value={storyLibraryQuery} onChange={(event) => setStoryLibraryQuery(event.target.value)} placeholder="Search worlds and adventures" />
          {storyLibraryQuery && <button className="quiet-button" type="button" aria-label="Clear search" onClick={() => setStoryLibraryQuery("")}>Clear</button>}
        </div>
        <details className="story-library-filters" open={storyLibraryFiltersOpen} onToggle={(event) => setStoryLibraryFiltersOpen(event.currentTarget.open)}>
          <summary><span>Filters &amp; sort</span><small>{activeStoryLibraryFilterCount ? `${activeStoryLibraryFilterCount} active` : "Optional"}</small></summary>
          <div className="story-library-filter-grid">
            <label>Adventure world<select aria-label="Filter adventures by world" value={storyWorldFilter} onChange={(event) => setStoryWorldFilter(event.target.value)}>
              <option value="all">All worlds</option>{worlds.map((item) => <option key={item.world_id} value={item.world_id}>{item.name}</option>)}
            </select></label>
            <label>Protagonist<select aria-label="Filter adventures by protagonist" value={storyHeroFilter} onChange={(event) => setStoryHeroFilter(event.target.value)}>
              <option value="all">All protagonists</option>{mainCharacters.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label}</option>)}
            </select></label>
            <label>Adventure status<select aria-label="Filter adventures by status" value={storyAdventureStatusFilter} onChange={(event) => setStoryAdventureStatusFilter(event.target.value as typeof storyAdventureStatusFilter)}>
              <option value="all">All adventure statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="complete">Complete</option><option value="archived">Archived</option>
            </select></label>
            <label>World status<select aria-label="Filter worlds by status" value={storyWorldStatusFilter} onChange={(event) => setStoryWorldStatusFilter(event.target.value as typeof storyWorldStatusFilter)}>
              <option value="active">Active worlds</option><option value="archived">Archived worlds</option><option value="all">All worlds</option>
            </select></label>
            <label>Sort by<select aria-label="Sort worlds and adventures" value={storyLibrarySort} onChange={(event) => setStoryLibrarySort(event.target.value as typeof storyLibrarySort)}>
              <option value="recent">Recently updated</option><option value="created">Recently created</option><option value="name">Name A–Z</option>
            </select></label>
            {hasStoryLibraryRefinements && <button className="quiet-button story-library-clear" type="button" onClick={clearStoryLibraryRefinements}>Clear search and filters</button>}
          </div>
        </details>
      </div>
      <div className="story-adventure-list">
        <div className="story-adventure-list-heading">
          <div><strong>{mainAdventures.length ? "Continue playing" : "Start your first adventure"}</strong>
            <small role="status" aria-live="polite">{visibleAdventures.length === mainAdventures.length ? `${mainAdventures.length} saved` : `Showing ${visibleAdventures.length} of ${mainAdventures.length} adventures`}</small></div>
          <button className="primary-button story-new-adventure" type="button" disabled={busy} aria-controls="story-adventure-setup" aria-expanded={setupExpanded} onClick={openAdventureSetup}>
            {mainAdventures.length ? "New adventure" : "Start your first adventure"}
          </button>
        </div>
        {visibleMostRecentAdventure && <div className="story-most-recent"><div><strong>Pick up where you left off</strong><small>{visibleMostRecentAdventure.name} · {visibleMostRecentAdventure.world_name} v{visibleMostRecentAdventure.world_version} · {visibleMostRecentAdventure.actor_label}</small></div><button className="secondary-button" type="button" disabled={busy} onClick={() => onSelectBranch(visibleMostRecentAdventure.branch_id)}>Resume</button></div>}
        {visibleAdventures.length ? <>
          {adventurePreviewRows.map(renderAdventureCard)}
          {additionalAdventureRows.length > 0 && <details className="story-more-adventures">
            <summary>Show {additionalAdventureRows.length} more adventure{additionalAdventureRows.length === 1 ? "" : "s"}</summary>
            <div className="story-more-adventures-list">{additionalAdventureRows.map(renderAdventureCard)}</div>
          </details>}
        </> : <div className="story-library-empty"><p className="empty-hint">{mainAdventures.length ? "No adventures match this search and these filters." : "Choose a world and a hero. Each adventure keeps its own story and game state."}</p>{mainAdventures.length > 0 && hasStoryLibraryRefinements && <button className="quiet-button" type="button" onClick={clearStoryLibraryRefinements}>Clear search and filters</button>}</div>}
      </div>
      <details className="story-world-library">
        <summary>Browse worlds <small>{visibleWorlds.length} shown of {worlds.length}</small></summary>
        <div className="story-world-library-list">{visibleWorlds.length ? visibleWorlds.map((item) => <article key={item.world_id}>
          <div className="story-library-card-main"><strong>{item.name}</strong><small>{item.description || item.template_key} · v{item.latest_version}{item.archived_at ? " · archived" : ""}</small></div>
          <div className="story-card-actions">
            <button className="secondary-button" type="button" disabled={!!item.archived_at || selectedWorldId === item.world_id} onClick={() => { setSelectedWorldId(item.world_id); setShowWorldCreation(false); setSetupStep(1); setSetupExpanded(true); }}>{selectedWorldId === item.world_id ? "Selected" : "Use this world"}</button>
            <details className="story-card-menu">
              <summary aria-label={`More actions for ${item.name}`}>More</summary>
              <div className="story-card-menu-panel">
                <button className="quiet-button" type="button" disabled={busy} onClick={() => void duplicateWorld(item)}>Duplicate world</button>
                <button className="quiet-button" type="button" disabled={busy} onClick={() => void setWorldArchived(item, !item.archived_at)}>{item.archived_at ? "Restore world" : "Archive world"}</button>
              </div>
            </details>
          </div>
        </article>) : <div className="story-library-empty"><p className="empty-hint">{worlds.length ? "No worlds match this search and these filters." : "Create or import a world to begin."}</p>{worlds.length > 0 && hasStoryLibraryRefinements && <button className="quiet-button" type="button" onClick={clearStoryLibraryRefinements}>Clear search and filters</button>}</div>}</div>
      </details>
      <details id="story-adventure-setup" className="story-world-editor story-hub-setup" open={setupExpanded} onToggle={(event) => setSetupExpanded(event.currentTarget.open)}>
        <summary>Set up an adventure · step {setupStep} of 3</summary>
        <ol className="story-setup-progress" aria-label="Adventure setup progress">
          {(["World", "Hero", "Review"] as const).map((label, index) => <li key={label} aria-current={setupStep === index + 1 ? "step" : undefined} className={setupStep > index + 1 ? "complete" : ""}>
            <span>{index + 1}</span><small>{label}</small>
          </li>)}
        </ol>
        <div className="story-hub-grid story-setup-stage">
        {setupStep === 1 && <section className="story-hub-form">
          <div className="story-hub-title"><span>01</span><div><strong>Choose or create a world</strong><small>New adventures pin one immutable world version.</small></div></div>
          {availableWorlds.length > 0 && <label className="field-label">Choose a world<select value={selectedWorldId} onChange={(event) => { setSelectedWorldId(event.target.value); setLibraryError(""); }}>
            {availableWorlds.map((item) => <option key={item.world_id} value={item.world_id}>{item.name} · v{item.latest_version}</option>)}
          </select></label>}
          {!availableWorlds.length && worlds.length > 0 && <p className="field-note">All existing worlds are archived. Restore a world or create a new one to start an adventure.</p>}
          {selectedSetupWorld && <div className="story-start-summary" role="status">
            <span>Selected: {selectedSetupWorld.name} · world v{selectedSetupWorld.latest_version}</span>
            {selectedSetupCover && <img src={storyWorldCoverUrl(selectedSetupCover)} alt={selectedSetupCover.alt_text || `${selectedSetupWorld.name} cover`} />}
          </div>}
          <button className="secondary-button" type="button" disabled={busy || worldArchitectBusy} onClick={() => { setShowWorldCreation((visible) => !visible); setWorldCreationStep(1); setCreationError(""); }}>
            {showWorldCreation ? "Cancel new world" : "Create a new world"}
          </button>
          {showWorldCreation && <form className="story-hub-form story-hub-create-world" onSubmit={(event) => void createWorld(event)}>
          <div className="story-hub-title"><span>＋</span><div><strong>Create a world</strong><small>Start with a small template. Advanced rules stay optional.</small></div></div>
          <ol className="world-creation-progress" aria-label="World creation progress">
            {(["Name & idea", "Beginning", "Review & create"] as const).map((label, index) => <li key={label}
              aria-current={worldCreationStep === index + 1 ? "step" : undefined}
              className={worldCreationStep > index + 1 ? "complete" : ""}>
              <span>{index + 1}</span><small>{label}</small>
            </li>)}
          </ol>
          <div className="world-creation-stage">
          {worldCreationStep === 1 && <>
          <div className="world-creation-step-heading"><h3>Name your world</h3><p>Choose a style and add a short idea. You can keep it simple and add more details later.</p></div>
          {worldArchitectBusy && <button className="quiet-button full-button" type="button" onClick={cancelWorldDraft}>Cancel local draft</button>}
          <label className="field-label">World name<input value={worldName} disabled={worldArchitectBusy} onChange={(event) => { setWorldName(event.target.value); setWorldArchitectDraft(null); setWorldArchitectMessage(""); setCreationError(""); }} placeholder="The Shattered Coast" maxLength={200} required /><small className="field-note">Required before continuing. Changes stay in this form until you save the world.</small></label>
          <label className="field-label">World style<select value={worldTemplate} disabled={worldArchitectBusy} onChange={(event) => {
            const nextTemplate = event.target.value;
            const nextTemplateContent = STORY_WORLD_TEMPLATES[nextTemplate as keyof typeof STORY_WORLD_TEMPLATES]?.content;
            const defaultStartingLocation = typeof nextTemplateContent?.starting_location === "string" ? nextTemplateContent.starting_location : "";
            const nextStats = defaultCharacterCreationStats(nextTemplate);
            setWorldTemplate(nextTemplate);
            setWorldStartingLocation(defaultStartingLocation);
            setWorldLocations("");
            setCreationStatDefinitions(nextStats);
            setCreationTrackerText(trackerDefinitionsText(
              STORY_WORLD_TEMPLATES[nextTemplate as keyof typeof STORY_WORLD_TEMPLATES]?.content.trackers,
            ));
            setCreationMechanics(defaultStoryMechanics(nextTemplate === "narrative" ? "narrative_only" : "d20"));
            setCreationError("");
            setWorldArchitectDraft(null);
            setWorldArchitectMessage("");
          }}>{Object.entries(STORY_WORLD_TEMPLATES).map(([key, template]) => <option key={key} value={key}>{template.label}</option>)}</select></label>
          <label className="field-label">World idea (optional)<textarea value={worldPremise} onChange={(event) => setWorldPremise(event.target.value)} rows={3} maxLength={4000} placeholder="A floating city where people trade memories" /><small className="field-note">A sentence is enough. This helps the storyteller understand your world.</small></label>
          <details className="character-creation-rules">
            <summary>Draft with the local World Architect (optional)</summary>
            <p className="field-note">Uses only the local Ollama model selected here. It receives the world name, style, and brief. Drafts are not saved or canonical until you review, apply, edit, and save the world.</p>
            <label className="field-label">Creative brief<textarea value={worldArchitectBrief} disabled={worldArchitectBusy} onChange={(event) => { setWorldArchitectBrief(event.target.value); setWorldArchitectDraft(null); setWorldArchitectMessage(""); setCreationError(""); }} rows={3} maxLength={4000} placeholder="A rainbound archipelago where city-states trade memories and old lighthouses predict storms" /></label>
            <div className="world-architect-controls">
              <label className="field-label">Local Ollama model<select aria-label="World Architect local model" value={selectedWorldArchitectModel} onChange={(event) => setWorldArchitectModel(event.target.value)} disabled={worldArchitectBusy}>
                {!selectedWorldArchitectModel && <option value="">Choose a local model</option>}
                {localStoryModels.map((localModel) => <option key={localModel} value={localModel}>{localModel}</option>)}
              </select></label>
              <button className="quiet-button" type="button" disabled={modelDiscoveryBusy || worldArchitectBusy} onClick={() => void loadProviderModels("ollama")}>{modelDiscoveryBusy ? "Checking…" : "Refresh local models"}</button>
              <button className="secondary-button" type="button" disabled={worldArchitectBusy || !worldName.trim() || !worldArchitectBrief.trim() || !localStoryProvider?.available || !selectedWorldArchitectModel} onClick={() => void generateWorldDraft()}>{worldArchitectBusy ? "Drafting locally…" : "Generate local draft"}</button>
            </div>
            {modelDiscoveryError && <p className="inline-error" role="alert">{modelDiscoveryError}</p>}
            {!localStoryProvider?.available && <p className="field-note">Local Ollama is unavailable. Start Ollama and refresh models, or continue with manual world creation.</p>}
            {worldArchitectMessage && <p className="field-note" role="status" aria-live="polite">{worldArchitectMessage}</p>}
            {worldArchitectDraft && <section className="export-preview world-architect-preview" aria-label="World Architect draft preview">
              <strong>Local draft · not saved</strong>
              <p>{worldArchitectDraft.public_lore}</p>
              <p><strong>Starting location:</strong> {worldArchitectDraft.starting_location}</p>
              <p><strong>Other locations:</strong> {worldArchitectDraft.locations.join(" · ")}</p>
              <p><strong>Opening situation:</strong> {worldArchitectDraft.opening_scene.situation}</p>
              <p><strong>Immediate hook:</strong> {worldArchitectDraft.opening_scene.hook}</p>
              <button className="secondary-button" type="button" onClick={applyWorldArchitectDraft}>Use this draft in the editable form</button>
            </section>}
          </details>
          </>}
          {worldCreationStep === 2 && <>
          <div className="world-creation-step-heading"><h3>Choose a starting place</h3><p>Keep the suggested place and continue, or add a few details if you like.</p></div>
          <label className="field-label">Starting place<input value={worldStartingLocation} onChange={(event) => { setWorldStartingLocation(event.target.value); setCreationError(""); }} maxLength={200} placeholder="Where the first scene begins" /></label>
          <details className="character-creation-rules">
            <summary>Add places to the map (optional)</summary>
            <label className="field-label">Other places<textarea value={worldLocations} onChange={(event) => { setWorldLocations(event.target.value); setCreationError(""); }} rows={3} maxLength={16000} placeholder="One place per line" /><small className="field-note">The starting place is added to the map automatically.</small></label>
          </details>
          <details className="character-creation-rules">
            <summary>Add an opening scene (optional)</summary>
            <p className="field-note">Describe what is happening and a hook for the hero. The player still chooses what their hero says and does.</p>
            <label className="field-label">What is happening?<textarea value={worldOpeningSituation} onChange={(event) => { setWorldOpeningSituation(event.target.value); setCreationError(""); }} rows={3} maxLength={4000} placeholder="The harbor bells ring as a storm rolls in" /></label>
            <label className="field-label">What draws the hero in?<textarea value={worldOpeningHook} onChange={(event) => { setWorldOpeningHook(event.target.value); setCreationError(""); }} rows={2} maxLength={2000} placeholder="A missing ship sends a familiar signal" /></label>
          </details>
          <details className="character-creation-rules">
            <summary>Add a world cover (optional)</summary>
            <label className="field-label">Choose an image<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Optional world cover image" disabled={coverPreparing} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void prepareWorldCover(file, false); }} /><small className="field-note">Saved on this device and included in exported world packages.</small></label>
          </details>
          {worldCover && <div className="story-world-cover-preview"><img src={storyWorldCoverUrl(worldCover)} alt={worldCover.alt_text || "World cover preview"} /><label className="field-label">Cover description<input maxLength={300} value={worldCover.alt_text} onChange={(event) => setWorldCover((cover) => cover ? { ...cover, alt_text: event.target.value } : cover)} /></label><button className="quiet-button" type="button" onClick={() => setWorldCover(null)}>Remove cover</button></div>}
          {creationLocationNames === null && <p className="inline-error" role="alert">Use no more than 100 unique locations, each up to 150 characters.</p>}
          {Boolean(worldOpeningSituation.trim()) !== Boolean(worldOpeningHook.trim()) && <p className="inline-error" role="alert">Add both opening-scene fields, or leave both empty.</p>}
          </>}
          {worldCreationStep === 3 && <>
          <div className="world-creation-step-heading"><h3>Review optional rules</h3><p>The defaults are ready for a first adventure. Open advanced rules only if this world needs custom trackers, mechanics, or abilities.</p></div>
          <section className="story-start-summary world-creation-review" aria-label="World summary before save">
            <h4>World summary</h4>
            <strong>{worldName.trim() || "Untitled world"}</strong>
            <span>{STORY_WORLD_TEMPLATES[worldTemplate as keyof typeof STORY_WORLD_TEMPLATES]?.label || "Custom style"} · Starting place: {creationStartingLocation || "not set"}</span>
            <p><strong>Public premise:</strong> {worldPremise.trim() || "No public premise added."}</p>
            <p><strong>Map places:</strong> {creationLocationNames?.length
              ? `${creationLocationNames.slice(0, 8).join(" · ")}${creationLocationNames.length > 8 ? ` · +${creationLocationNames.length - 8} more` : ""}`
              : "None"}</p>
            {worldOpeningSituation.trim() && worldOpeningHook.trim() && <div>
              <p><strong>Opening situation:</strong> {worldOpeningSituation.trim()}</p>
              <p><strong>Immediate hook:</strong> {worldOpeningHook.trim()}</p>
            </div>}
            {worldCover && <img src={storyWorldCoverUrl(worldCover)} alt={worldCover.alt_text || "World cover preview"} />}
          </section>
          <details className="character-creation-rules story-world-advanced">
            <summary>Customize trackers, mechanics, attributes, and abilities</summary>
            <label className="field-label">World-specific trackers<textarea value={creationTrackerText} onChange={(event) => setCreationTrackerText(event.target.value)} rows={3} maxLength={4000} placeholder="health=10/10\nfocus=6/6" /><small className="field-note">One tracker per line as name=current/maximum. Clear the field when this world has no numeric resources.</small></label>
            <StoryMechanicsEditor value={creationMechanics} stats={creationStatDefinitions.map((stat) => stat.key.trim()).filter(Boolean)} onChange={setCreationMechanics} />
          <details className="character-creation-rules">
            <summary>Character attributes · {creationStatDefinitions.length} stats · {creationPointBudget} creation points</summary>
            <p className="field-note">Set the world’s starting attributes. Temporary resources stay in trackers and do not use creation points.</p>
            <label className="field-label">Available creation points<input type="number" min={0} max={200} step={1} value={creationPointBudget} onChange={(event) => setCreationPointBudget(Number(event.target.value))} /></label>
            <label className="control-choice"><input type="checkbox" checked={creationAllowUnspentPoints} onChange={(event) => setCreationAllowUnspentPoints(event.target.checked)} /><span>Allow points to remain unspent</span></label>
            <label className="control-choice"><input type="checkbox" checked={creationAllowBelowBaseline} onChange={(event) => {
              const enabled = event.target.checked;
              setCreationAllowBelowBaseline(enabled);
              if (!enabled) setCreationStatDefinitions((definitions) => definitions.map((stat) => ({ ...stat, minimum: stat.baseline })));
            }} /><span>Allow attribute reductions below baseline</span></label>
            <div className="character-creation-definition-list">
              {creationStatDefinitions.map((stat, index) => <div className="character-creation-definition" key={`${index}-${stat.key}`}>
                <label className="field-label">Stat key<input value={stat.key} maxLength={40} onChange={(event) => updateCreationStat(index, { key: event.target.value })} /></label>
                <label className="field-label">Display name<input value={stat.label} maxLength={80} onChange={(event) => updateCreationStat(index, { label: event.target.value })} /></label>
                <label className="field-label">Baseline<input type="number" min={-10} max={10} step={1} value={stat.baseline} onChange={(event) => updateCreationStat(index, { baseline: Number(event.target.value) })} /></label>
                <label className="field-label">Minimum<input type="number" min={-10} max={10} step={1} value={stat.minimum} onChange={(event) => updateCreationStat(index, { minimum: Number(event.target.value) })} /></label>
                <label className="field-label">Maximum<input type="number" min={-10} max={10} step={1} value={stat.maximum} onChange={(event) => updateCreationStat(index, { maximum: Number(event.target.value) })} /></label>
                <label className="field-label">Points per increase<input type="number" min={1} max={20} step={1} value={stat.point_cost} onChange={(event) => updateCreationStat(index, { point_cost: Number(event.target.value) })} /></label>
                <button type="button" className="link-button" disabled={creationStatDefinitions.length <= 1} onClick={() => removeCreationStat(index)}>Remove stat</button>
              </div>)}
            </div>
            <button type="button" className="secondary-button" disabled={creationStatDefinitions.length >= 20} onClick={addCreationStat}>Add attribute</button>
            <p className="field-note">Players can raise each attribute up to its maximum, refund points down to its minimum, and review the final sheet before starting.</p>
          </details>
          <details className="character-creation-rules exceptional-ability-editor">
            <summary>Exceptional abilities · {creationAbilities.length}</summary>
            <p className="field-note">Abilities use only declared costs and cooldowns. Empty costs and cooldown mean no resource payment or cooldown; no d20 check is added.</p>
            {creationAbilities.map((ability, index) => <fieldset className="exceptional-ability-definition" key={`${index}-${ability.ability_id}`}>
              <legend>{ability.name || `Ability ${index + 1}`}</legend>
              <div className="character-creation-definition">
                <label className="field-label">Ability ID<input value={ability.ability_id} maxLength={100} onChange={(event) => updateCreationAbility(index, { ability_id: event.target.value })} /></label>
                <label className="field-label">Name<input value={ability.name} maxLength={120} onChange={(event) => updateCreationAbility(index, { name: event.target.value })} /></label>
                <label className="field-label">Category<input value={ability.category} maxLength={100} onChange={(event) => updateCreationAbility(index, { category: event.target.value })} /></label>
                <label className="field-label">Source<input value={ability.source} maxLength={100} onChange={(event) => updateCreationAbility(index, { source: event.target.value })} /></label>
                <label className="field-label">Description<textarea value={ability.description} maxLength={4000} onChange={(event) => updateCreationAbility(index, { description: event.target.value })} /></label>
                <label className="field-label">Activation<input value={ability.activation} maxLength={1000} onChange={(event) => updateCreationAbility(index, { activation: event.target.value })} /></label>
                <label className="field-label">Deactivation<input value={ability.deactivation} maxLength={1000} onChange={(event) => updateCreationAbility(index, { deactivation: event.target.value })} /></label>
                <label className="field-label">Known effects<textarea value={ability.effects.join("\n")} onChange={(event) => updateCreationAbility(index, { effects: abilityTextList(event.target.value) })} placeholder="One effect per line" /></label>
                <label className="field-label">Activation costs<textarea value={ability.costs.map((cost) => `${cost.resource}=${cost.amount}`).join("\n")} onChange={(event) => updateCreationAbility(index, { costs: abilityCostList(event.target.value) })} placeholder="resource=amount, one per line" /></label>
                <label className="field-label">Cooldown in completed turns<input type="number" min={0} max={1000000} value={ability.cooldown_turns ?? ""} onChange={(event) => updateCreationAbility(index, { cooldown_turns: event.target.value === "" ? null : Number(event.target.value) })} placeholder="None" /></label>
                <label className="field-label">Duration<input value={ability.duration || ""} maxLength={200} onChange={(event) => updateCreationAbility(index, { duration: event.target.value || null })} /></label>
                <label className="field-label">Range<input value={ability.range || ""} maxLength={200} onChange={(event) => updateCreationAbility(index, { range: event.target.value || null })} /></label>
                <label className="field-label">Interactions with ordinary magic<textarea value={ability.magic_interactions.join("\n")} onChange={(event) => updateCreationAbility(index, { magic_interactions: abilityTextList(event.target.value) })} placeholder="One interaction per line" /></label>
                <label className="field-label">Demonstrated capabilities<textarea value={ability.demonstrated_capabilities.join("\n")} onChange={(event) => updateCreationAbility(index, { demonstrated_capabilities: abilityTextList(event.target.value) })} placeholder="One demonstrated capability per line" /></label>
                <label className="field-label">Confirmed limitations<textarea value={ability.confirmed_limitations.join("\n")} onChange={(event) => updateCreationAbility(index, { confirmed_limitations: abilityTextList(event.target.value) })} placeholder="One confirmed limitation per line" /></label>
                <label className="field-label">Unresolved aspects<textarea value={ability.unresolved_aspects.join("\n")} onChange={(event) => updateCreationAbility(index, { unresolved_aspects: abilityTextList(event.target.value) })} placeholder="One unresolved aspect per line" /></label>
                <button type="button" className="link-button" onClick={() => removeCreationAbility(index)}>Remove ability</button>
              </div>
            </fieldset>)}
            <button type="button" className="secondary-button" disabled={creationAbilities.length >= 50} onClick={addCreationAbility}>Add exceptional ability</button>
            {!creationAbilitiesValid && <p className="field-note" role="status">Complete each ability definition, use a unique lowercase ID, and enter positive resource costs.</p>}
          </details>
          </details>
          {!creationWorldValid && <p className="inline-error" role="alert">{!creationStatsValid || !creationPointBudgetValid
            ? "Review the point budget and attribute rules. Use distinct names, valid bounds, and point costs from 1 to 20."
            : !creationHasValidStartingAllocation
              ? "These rules cannot make a valid starting sheet. Adjust the available points or attribute limits."
              : "Review the ability definitions, costs, and unique IDs."}</p>}
          </>}
          {creationError && <p className="inline-error" role="alert">{creationError}</p>}
          <div className="wizard-actions world-creation-actions">
            <button className="secondary-button" type="button" disabled={busy || worldCreationStep === 1} onClick={() => { setCreationError(""); setWorldCreationStep((step) => step === 3 ? 2 : 1); }}>Back</button>
            {worldCreationStep < 3
              ? <button className="primary-button" type="button" disabled={busy || worldArchitectBusy || (worldCreationStep === 1 && !worldName.trim()) || (worldCreationStep === 2 && (!creationPlacesValid || coverPreparing))} onClick={() => { setCreationError(""); setWorldCreationStep((step) => step === 1 ? 2 : 3); }}>Continue <span>→</span></button>
              : <button className="primary-button" type="submit" disabled={busy || coverPreparing || worldArchitectBusy || !worldName.trim() || !creationWorldValid}>Save world</button>}
          </div>
          </div>
          </form>}
          <div className="wizard-actions">
            <button className="primary-button" type="button" disabled={busy || !selectedSetupWorld || !!selectedSetupWorld.archived_at || !selectedSetupContent} onClick={() => { setLibraryError(""); setSetupStep(2); }}>Continue to hero <span>→</span></button>
          </div>
        </section>}
        {setupStep === 2 && <section className="story-hub-form">
          <div className="story-hub-title"><span>02</span><div><strong>Choose or create a hero</strong><small>The hero can be reused; every adventure gets separate state.</small></div></div>
          {mainCharacters.length > 0 && <label className="field-label">Choose an existing hero<select value={adventureHeroId} onChange={(event) => { setAdventureHeroId(event.target.value); setShowHeroCreation(false); setShowHeroProfileEditor(false); }}>{mainCharacters.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label}</option>)}</select></label>}
          {mainCharacters.length > 0 && !showHeroCreation && <button className="secondary-button" type="button" disabled={busy} onClick={() => { setHeroProfileDraft({ ...EMPTY_HERO_PROFILE }); setShowHeroProfileEditor(false); setShowHeroCreation(true); }}>Create another hero</button>}
          {(showHeroCreation || mainCharacters.length === 0) && <>
            <p className="empty-hint">{mainCharacters.length ? "Add a hero to the workspace library." : "Create your first protagonist here. No Knowledge Explorer setup is needed."}</p>
            <form className="hero-identity-form" onSubmit={(event) => void createHero(event)}>
              <label className="field-label">Hero name<input value={heroName} onChange={(event) => setHeroName(event.target.value)} placeholder="Protagonist name" maxLength={200} required /></label>
              <details className="hero-profile-details">
                <summary>Character details (optional)</summary>
                <p className="field-note">These notes guide identity and voice, not your hero's decisions. They stay on this device; hosted providers do not receive them.</p>
                <div className="hero-profile-fields">
                  {HERO_PROFILE_FIELDS.map(({ key, label, maxLength, rows, placeholder }) => <label className="field-label" key={key}>{label}<textarea value={heroProfileDraft[key]} onChange={(event) => setHeroProfileDraft((current) => ({ ...current, [key]: event.target.value }))} maxLength={maxLength} rows={rows} placeholder={placeholder} /></label>)}
                </div>
              </details>
              <button className="secondary-button" disabled={busy}>Create hero</button>
            </form>
            {mainCharacters.length > 0 && <button className="link-button" type="button" disabled={busy} onClick={() => setShowHeroCreation(false)}>Use an existing hero</button>}
          </>}
          {selectedSetupHero && !showHeroCreation && <div className="hero-identity-section">
            {selectedHeroProfileEntries.length > 0 && <details className="hero-profile-review">
              <summary>Review saved identity · {selectedHeroProfileEntries.length} notes</summary>
              <dl>{selectedHeroProfileEntries.map(({ key, label, value }) => <div key={key}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            </details>}
            {selectedImportedHeroProfileEntries.length > 0 && <details className="hero-profile-review">
              <summary>Imported MNO details · {selectedImportedHeroProfileEntries.length}</summary>
              <dl>{selectedImportedHeroProfileEntries.map(({ key, label, value }) => <div key={key}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            </details>}
            {!showHeroProfileEditor
              ? <button className="link-button" type="button" disabled={busy} onClick={() => { setHeroProfileDraft(selectedHeroProfile); setShowHeroProfileEditor(true); }}>Edit saved identity</button>
              : <form className="hero-identity-form" onSubmit={(event) => void saveHeroProfile(event)}>
                  <strong>Edit {selectedSetupHero.label}</strong>
                  <p className="field-note">These notes guide identity and voice, not your hero's decisions. They stay on this device; hosted providers do not receive them.</p>
                  <div className="hero-profile-fields">
                    {HERO_PROFILE_FIELDS.map(({ key, label, maxLength, rows, placeholder }) => <label className="field-label" key={key}>{label}<textarea value={heroProfileDraft[key]} onChange={(event) => setHeroProfileDraft((current) => ({ ...current, [key]: event.target.value }))} maxLength={maxLength} rows={rows} placeholder={placeholder} /></label>)}
                  </div>
                  {selectedImportedHeroProfileEntries.length > 0 && <details className="hero-profile-details">
                    <summary>Edit imported MNO details · {selectedImportedHeroProfileEntries.length}</summary>
                    <p className="field-note">These source fields are preserved from the adventure package. Clear a field and save to remove it.</p>
                    <div className="hero-profile-fields">
                      {HERO_IMPORTED_PROFILE_FIELDS.map(({ key, label, maxLength, rows, placeholder }) => <label className="field-label" key={key}>{label}<textarea value={heroProfileDraft[key]} onChange={(event) => setHeroProfileDraft((current) => ({ ...current, [key]: event.target.value }))} maxLength={maxLength} rows={rows} placeholder={placeholder} /></label>)}
                    </div>
                  </details>}
                  <div className="wizard-actions">
                    <button className="primary-button" disabled={busy}>Save identity</button>
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => setShowHeroProfileEditor(false)}>Cancel</button>
                  </div>
                </form>}
          </div>}
          <p className="field-note">Reusing a hero starts a new isolated adventure branch with a fresh sheet from the selected world. Other adventures, checks, and trackers are not copied.</p>
          <div className="wizard-actions">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setSetupStep(1)}>Back</button>
            <button className="primary-button" type="button" disabled={busy || !selectedSetupHero} onClick={() => { setLibraryError(""); setSetupStep(3); }}>Review adventure <span>→</span></button>
          </div>
        </section>}
        {setupStep === 3 && <section className="story-hub-form story-start-adventure">
          <div className="story-hub-title"><span>03</span><div><strong>Review and start</strong><small>Your world and hero are ready. You can customize starting attributes if you want.</small></div></div>
          <p className="story-start-summary" role="status">{selectedSetupWorld && selectedSetupHero
            ? `“${adventureName.trim() || selectedSetupWorld.name}” starts as ${selectedSetupHero.label} in ${selectedSetupWorld.name} · world v${selectedSetupWorld.latest_version}.`
            : "Choose a world and hero before starting."}</p>
          <details className="character-creation-rules">
            <summary>Change adventure name (optional)</summary>
            <label className="field-label">Adventure name<input value={adventureName} onChange={(event) => setAdventureName(event.target.value)} placeholder={selectedSetupWorld?.name || "First adventure"} maxLength={200} /></label>
          </details>
          {selectedHeroProfileEntries.length > 0 && <details className="hero-profile-review">
            <summary>Review hero identity · {selectedHeroProfileEntries.length} notes</summary>
            <dl>{selectedHeroProfileEntries.map(({ key, label, value }) => <div key={key}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            <p className="field-note">Identity notes guide style only; you choose what the hero says and does. Hosted providers do not receive them.</p>
          </details>}
          {selectedImportedHeroProfileEntries.length > 0 && <details className="hero-profile-review">
            <summary>Imported MNO details · {selectedImportedHeroProfileEntries.length}</summary>
            <dl>{selectedImportedHeroProfileEntries.map(({ key, label, value }) => <div key={key}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          </details>}
          {hasSelectedSetupOpeningScene && <details className="character-creation-review">
            <summary>Review the opening scene</summary>
            <p>{selectedSetupOpeningScene.situation}</p>
            <p><strong>Immediate hook:</strong> {selectedSetupOpeningScene.hook}</p>
            <small className="field-note">This guides the first generated reply. You choose your hero’s response when you begin play.</small>
          </details>}
          {selectedSetupCreation && <>
            <p className="field-note" role="status" aria-live="polite">{adventureAllocationValid
              ? "Balanced starting attributes are ready. Open the option below only if you want to customize them."
              : "This world needs a valid starting attribute allocation. Open the option below to adjust it."}</p>
            <details className="character-creation-review">
              <summary>Customize starting attributes · {adventurePointsSpent} of {selectedSetupCreation.point_budget} points used</summary>
              <section className="character-creation-allocation" aria-labelledby="character-creation-heading">
                <div className="story-hub-title"><div><strong id="character-creation-heading">Starting attributes</strong><small>World rules set the limits and point costs.</small></div></div>
                <div className="character-creation-allocation-list">
                  {selectedSetupStatDefinitions.map((stat) => {
                    const value = adventureAllocation[stat.key] ?? stat.baseline;
                    return <div className="character-creation-allocation-row" key={stat.key}>
                      <span><strong>{stat.label}</strong><small>{stat.baseline} baseline · {stat.minimum}–{stat.maximum} · {stat.point_cost} point{stat.point_cost === 1 ? "" : "s"} per increase</small></span>
                      <div><button type="button" className="secondary-button" aria-label={`Decrease ${stat.label}`} disabled={busy || value <= stat.minimum} onClick={() => setAdventureAllocation((current) => ({ ...current, [stat.key]: value - 1 }))}>−</button>
                        <output aria-label={`${stat.label} allocation`}>{value}</output>
                        <button type="button" className="secondary-button" aria-label={`Increase ${stat.label}`} disabled={busy || value >= stat.maximum || adventurePointsRemaining < stat.point_cost} onClick={() => setAdventureAllocation((current) => ({ ...current, [stat.key]: value + 1 }))}>+</button></div>
                    </div>;
                  })}
                </div>
                <div className="character-creation-allocation-actions">
                  <button type="button" className="link-button" disabled={busy} onClick={resetAdventureAllocation}>Restore balanced defaults</button>
                  <button type="button" className="link-button" disabled={busy} onClick={randomizeAdventureAllocation}>Try random attributes</button>
                  <strong aria-live="polite">{adventurePointsRemaining} points remaining</strong>
                </div>
                {adventureAllocationMessage && <p className="field-note" role="status">{adventureAllocationMessage}</p>}
                <p className="field-note" role="status" aria-live="polite">{adventurePointsRemaining < 0
                  ? "This allocation exceeds the world’s point budget. Reduce an attribute before continuing."
                  : adventurePointsRemaining > 0 && selectedSetupCreation.allow_unspent_points
                    ? `You may leave these ${adventurePointsRemaining} point${adventurePointsRemaining === 1 ? "" : "s"} unspent or use them before starting.`
                    : adventurePointsRemaining > 0
                      ? `Spend all ${adventurePointsRemaining} remaining point${adventurePointsRemaining === 1 ? "" : "s"} before starting.`
                      : "All creation points are allocated."}</p>
              </section>
            </details>
          </>}
          <p className="field-note">Each start creates a fresh adventure branch and world-specific character sheet. Reusing a hero does not copy another adventure’s turns, checks, trackers, or memories.</p>
          <form className="wizard-actions" onSubmit={(event) => void startAdventure(event)}>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setSetupStep(2)}>Back</button>
            <button className="primary-button" disabled={busy || !selectedSetupWorld || !selectedSetupContent || !selectedSetupHero || (!!selectedSetupCreation && !adventureAllocationValid)}>Start adventure <span>↗</span></button>
          </form>
        </section>}
        </div>
      </details>
      <details className="story-world-editor">
        <summary>Import or export a world</summary>
        <p className="field-note">Public exports include reviewed public lore and mechanics. Full archives may include unclassified author content and require preview and confirmation.</p>
        <div className="adventure-export-controls">
          <label className="field-label">World export format<select value={worldExportMode} onChange={(event) => {
            setWorldExportMode(event.target.value as "public_world" | "full_private_archive");
            setWorldExportReview(null);
          }}>
            <option value="public_world">Public world</option>
            <option value="full_private_archive">Full private archive</option>
          </select></label>
          <div className="story-world-editor-actions">
            <button type="button" className="secondary-button" disabled={!selectedWorldId || busy} onClick={() => void previewWorldExport()}>Preview world export</button>
            <button type="button" className="primary-button" disabled={!selectedWorldId || busy || !worldExportReview} onClick={() => void exportWorldPackage()}>Download reviewed world</button>
          </div>
          {worldExportReview && worldExportReview.workspaceId === workspaceId && worldExportReview.worldId === selectedWorldId
            && worldExportReview.revision === revision && worldExportReview.mode === worldExportMode && <div className="export-preview" role="status" aria-live="polite">
              <strong>{worldExportReview.preview.requires_private_confirmation ? "Unclassified content needs confirmation" : "World export preview"}</strong>
              <span>Included: {JSON.stringify(worldExportReview.preview.included)}</span>
              {worldExportReview.preview.sensitive && <span>Unclassified content: {JSON.stringify(worldExportReview.preview.sensitive)}</span>}
            </div>}
        </div>
        <label className="field-label">Preview a world package<input type="file" accept=".lke-world,.mno-world,application/json" onChange={(event) => { void previewWorldPackage(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
        {worldPackage && worldPackage.workspace === workspaceId && <div>
          <p>{worldPackage.preview.name} · {worldPackage.preview.versions} version(s) · {worldPackage.preview.source_format === "mno-world" ? "MNO RPG Engine world" : `source workspace ${worldPackage.preview.provenance.workspace_id}`} · source world {worldPackage.preview.provenance.world_id}</p>
          {worldPackage.preview.source_format === "mno-world" && <small className="field-note">{worldPackage.preview.stat_count} stats · {worldPackage.preview.tracker_count} trackers · {worldPackage.preview.lore_entry_count} lore entries · {worldPackage.preview.npc_template_count} world-cast templates</small>}
          {worldPackage.preview.content_warning && <p className="content-warning" role="note">{worldPackage.preview.content_warning}</p>}
          {worldPackage.preview.conversion_notes?.map((note) => <small className="field-note" key={note}>{note}</small>)}
          <p className="field-note">{worldPackage.preview.source_id_conflict ? "The source ID already exists here. " : ""}Import creates a separate world with a new ID.</p>
          <details><summary>Inspect package contents</summary><pre dir="auto">{JSON.stringify(worldPackage.data, null, 2)}</pre></details>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void importWorldPackage()}>Import as new world</button>
        </div>}
      </details>
      <details className="story-world-editor">
        <summary>Import or export an adventure</summary>
        <p className="field-note">Preview an export before downloading. Shareable packages omit private profiles, author-only and unpublished memories, hidden MNO messages, and preserved source archives. Full private archives require confirmation.</p>
        {activeAdventure && <div className="adventure-export-controls">
          <label className="field-label">Export format<select value={adventureExportMode} onChange={(event) => {
            setAdventureExportMode(event.target.value as StoryAdventureExportMode);
            setAdventureExportReview(null);
          }}>
            <option value="shareable_adventure">Shareable adventure</option>
            <option value="full_private_archive">Full private archive</option>
            <option value="public_world">Public world only</option>
            <option value="selected_content">Selected content</option>
          </select></label>
          {adventureExportMode === "selected_content" && <fieldset className="export-selection">
            <legend>Include these record groups</legend>
            {[
              ["turn_ids", "Transcript", conversation?.turns.length || 0],
              ["check_ids", "Legacy d20 checks", rpgState?.checks.length || 0],
              ["mechanic_check_ids", "World mechanics checks", rpgState?.mechanic_checks.length || 0],
              ["proposal_ids", "State proposals", rpgState?.proposals.length || 0],
              ["memory_ids", "Memories", studioData?.memories.memories.length || 0],
              ["thread_ids", "Story threads", studioData?.memories.threads.length || 0],
              ["npc_entity_ids", "NPC profiles", studioData?.npcs.length || 0],
              ["asset_ids", "Images", studioData?.assets.length || 0],
              ["location_ids", "Map locations", studioData?.locations.length || 0],
            ].map(([key, label, count]) => <label key={String(key)}>
              <input type="checkbox" checked={adventureExportSections.includes(String(key))}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setAdventureExportSections((current) => checked
                    ? [...current, String(key)]
                    : current.filter((item) => item !== key));
                  setAdventureExportReview(null);
                }} />
              <span>{String(label)} <small>{Number(count)}</small></span>
            </label>)}
          </fieldset>}
          <div className="story-world-editor-actions">
            <button type="button" className="secondary-button" disabled={busy || (adventureExportMode === "selected_content" && adventureExportSections.length === 0)} onClick={() => void previewAdventureExport()}>Preview export</button>
            <button type="button" className="primary-button" disabled={busy || !adventureExportReview} onClick={() => void exportAdventurePackage()}>Download reviewed export</button>
          </div>
          {adventureExportReview && adventureExportReview.workspaceId === workspaceId
            && adventureExportReview.branchId === branchId
            && adventureExportReview.adventureId === activeAdventure.adventure_id
            && adventureExportReview.revision === revision
            && adventureExportReview.mode === adventureExportMode && <div className="export-preview" role="status" aria-live="polite">
              <strong>{adventureExportReview.preview.requires_private_confirmation ? "Private content needs confirmation" : "Export preview"}</strong>
              <span>Included: {JSON.stringify(adventureExportReview.preview.included)}</span>
              {adventureExportReview.preview.sensitive && <span>Source sensitivity: {JSON.stringify(adventureExportReview.preview.sensitive)}</span>}
              {adventureExportReview.preview.excluded && <span>Excluded: {JSON.stringify(adventureExportReview.preview.excluded)}</span>}
              {adventureExportMode === "public_world" && <small>The world export keeps public lore and mechanics; unclassified and preserved source fields are excluded.</small>}
            </div>}
        </div>}
        {branchId === "main" ? <label className="field-label">Preview an adventure package<input type="file" accept=".lke-adventure,.mno-adv,application/json" onChange={(event) => { void previewAdventurePackage(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label> : <p className="field-note">Return to the main workspace to import an adventure as a separate session.</p>}
        {adventurePackage && adventurePackage.workspace === workspaceId && <div>
          <p>{adventurePackage.preview.name} · world v{adventurePackage.preview.world_version} · {adventurePackage.preview.turns} turns · {adventurePackage.preview.memories} memories · {adventurePackage.preview.characters} characters · {adventurePackage.preview.images} images</p>
          {adventurePackage.preview.source_format === "mno-adv" && <p className="field-note">MNO import · {adventurePackage.preview.message_count} transcript messages · {adventurePackage.preview.npc_count} NPCs · {adventurePackage.preview.map_location_count} map places · {adventurePackage.preview.context_excluded_message_count} author-only messages hidden from future model context.</p>}
          {adventurePackage.preview.conversion_notes?.map((note) => <small className="field-note" key={note}>{note}</small>)}
          <p className="field-note">{adventurePackage.preview.source_format === "mno-adv" ? "Source: MNO RPG Engine. The matching world already exists here." : `Source ${adventurePackage.preview.provenance.workspace_id} / ${adventurePackage.preview.provenance.branch_id}. ${adventurePackage.preview.world_import_required ? "The packaged world will be imported as a separate world." : "The matching world already exists here."}`} Import creates an isolated duplicate adventure.{adventurePackage.preview.entity_id_conflicts.length ? ` ${adventurePackage.preview.entity_id_conflicts.length} character ID conflict(s) will be remapped.` : ""}</p>
          <details><summary>Inspect package contents</summary><pre dir="auto">{JSON.stringify(adventurePackage.data, null, 2)}</pre></details>
          <button type="button" className="secondary-button" disabled={busy || branchId !== "main"} onClick={() => void importAdventurePackage()}>Import as new adventure</button>
        </div>}
      </details>
      {selectedWorldDetail && <details className="story-world-editor">
        <summary>Edit selected world · save changes as a new version</summary>
        <p className="field-note">Adventure sessions keep the world version they started with. This edit only affects new adventures.</p>
        <form onSubmit={(event) => void reviseWorld(event)}>
          <label className="field-label">World name<input value={editWorldName} onChange={(event) => setEditWorldName(event.target.value)} maxLength={200} required /></label>
          <label className="field-label">Public world summary<input value={editWorldDescription} onChange={(event) => setEditWorldDescription(event.target.value)} maxLength={1000} placeholder="A short summary safe to share with the hero" /></label>
          <label className="field-label">Public setting premise<textarea value={editWorldPremise} onChange={(event) => setEditWorldPremise(event.target.value)} rows={3} maxLength={4000} placeholder="Setting details safe for the hero to know" /></label>
          <details className="character-creation-rules">
            <summary>Edit the opening scene (optional)</summary>
            <p className="field-note">This version's public scene seed is used only for the first generated reply. It sets the situation and hook without choosing the hero's response.</p>
            <label className="field-label">Opening situation<textarea value={editWorldOpeningSituation} onChange={(event) => { setEditWorldOpeningSituation(event.target.value); setLibraryError(""); }} rows={3} maxLength={4000} placeholder="Where the scene begins and what is already happening" /></label>
            <label className="field-label">Immediate hook<textarea value={editWorldOpeningHook} onChange={(event) => { setEditWorldOpeningHook(event.target.value); setLibraryError(""); }} rows={2} maxLength={2000} placeholder="A question, pressure, or opportunity for the hero" /></label>
            <small className="field-note">Leave both fields empty to remove the opening scene in the new version.</small>
          </details>
          <label className="field-label">Optional world cover<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Optional world cover image" disabled={coverPreparing} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void prepareWorldCover(file, true); }} /><small className="field-note">This image is pinned with the new version and included in world packages.</small></label>
          {editWorldCover && <div className="story-world-cover-preview"><img src={storyWorldCoverUrl(editWorldCover)} alt={editWorldCover.alt_text || "World cover preview"} /><label className="field-label">Cover description<input maxLength={300} value={editWorldCover.alt_text} onChange={(event) => setEditWorldCover((cover) => cover ? { ...cover, alt_text: event.target.value } : cover)} /></label><button className="quiet-button" type="button" onClick={() => setEditWorldCover(null)}>Remove cover</button></div>}
          <label className="field-label">Starting location<input value={editWorldStartingLocation} onChange={(event) => { setEditWorldStartingLocation(event.target.value); setLibraryError(""); }} maxLength={200} placeholder="Where the first scene begins" /></label>
          <label className="field-label">Map locations<textarea value={editWorldLocations} onChange={(event) => { setEditWorldLocations(event.target.value); setLibraryError(""); }} rows={3} maxLength={16000} placeholder="One approved location per line" /><small className="field-note">Use unique names; if a starting location is set, include it here. Adventures already started keep their pinned map.</small></label>
          <label className="field-label">World-specific trackers<textarea value={editTrackerText} onChange={(event) => setEditTrackerText(event.target.value)} rows={3} maxLength={4000} placeholder="health=10/10\nfocus=6/6" /><small className="field-note">One tracker per line as name=current/maximum. These rules affect new adventures from this version.</small></label>
          {editMnoLorebook.length > 0 && <details className="character-creation-rules mno-lorebook-editor">
            <summary>Imported lorebook · {editMnoLorebook.length} entries</summary>
            <p className="field-note">Choose what the local narrator may reference. This lore is not proof that the hero knows it. Up to 4 always-on entries and 4 keyword matches are included per turn, within a 12,000-character limit. Hosted-provider requests omit imported lore. These changes create a new world version; existing adventures keep their pinned version.</p>
            <label className="field-label">Search imported lore<input type="search" value={editMnoLorebookSearch} onChange={(event) => { setEditMnoLorebookSearch(event.target.value); setEditMnoLorebookVisibleCount(20); }} placeholder="Search titles, keywords, and entry text" /></label>
            <small className="field-note">Showing {Math.min(editMnoLorebookVisibleCount, filteredEditMnoLorebook.length)} of {filteredEditMnoLorebook.length} matching entries.</small>
            {filteredEditMnoLorebook.length === 0 && <p className="empty-hint">No lore entries match this search.</p>}
            {filteredEditMnoLorebook.slice(0, editMnoLorebookVisibleCount).map((entry) => <article className="mno-lorebook-entry" key={entry.index}>
              <div className="mno-lorebook-entry-heading"><strong>{entry.title}</strong><small>{entry.type} · source entry {entry.index + 1}</small></div>
              {(entry.activation !== entry.originalActivation || JSON.stringify(entry.keywords) !== JSON.stringify(entry.originalKeywords)) && <button type="button" className="quiet-button mno-lorebook-reset" onClick={() => {
                setEditMnoLorebook((current) => current.map((item) => item.index === entry.index
                  ? { ...item, activation: item.originalActivation, keywords: item.originalKeywords } : item));
                setLibraryError("");
              }}>Restore imported settings</button>}
              <label className="field-label">Activation<select aria-label={`Activation for ${entry.title}`} value={entry.activation} onChange={(event) => {
                const activation = event.target.value as MnoLoreActivation;
                setEditMnoLorebook((current) => current.map((item) => item.index === entry.index ? { ...item, activation } : item));
                setLibraryError("");
              }}>
                <option value="always">Always include</option>
                <option value="keywords">Match keywords</option>
                <option value="disabled">Do not include</option>
              </select></label>
              {entry.activation === "keywords" && <label className="field-label">Keywords<textarea value={entry.keywords.join("\n")} rows={2} maxLength={6000} placeholder="One keyword or phrase per line" onChange={(event) => {
                const keywords = event.target.value.split(/\r?\n/);
                setEditMnoLorebook((current) => current.map((item) => item.index === entry.index ? { ...item, keywords } : item));
                setLibraryError("");
              }} /><small className="field-note">A keyword word in the player's prompt or current location can select this entry. Use up to 50 unique keywords, each up to 100 characters.</small></label>}
              <details className="mno-lorebook-entry-preview"><summary>Preview lore text</summary><p dir="auto">{entry.content}</p></details>
            </article>)}
            {editMnoLorebookVisibleCount < filteredEditMnoLorebook.length && <button type="button" className="quiet-button" onClick={() => setEditMnoLorebookVisibleCount((count) => count + 20)}>Show next {Math.min(20, filteredEditMnoLorebook.length - editMnoLorebookVisibleCount)} entries</button>}
          </details>}
          <StoryMechanicsEditor value={editMechanics}
            stats={Object.keys((selectedWorldDetail.versions.find((item) => item.version === selectedWorldDetail.latest_version)?.content.stats as Record<string, unknown>) || {})}
            onChange={setEditMechanics} />
          <div className="story-world-editor-actions"><small>Current version: v{selectedWorldDetail.latest_version}</small><button className="secondary-button" type="submit" disabled={busy || coverPreparing || !editWorldName.trim()}>Save new version</button></div>
        </form>
      </details>}
      {libraryError && <p className="inline-error" role="alert">{libraryError}</p>}
      {branchId !== "main" && <p className="story-branch-note">This adventure is isolated from the main world. New adventures start from the latest main-workspace snapshot.</p>}
      </div>
    </details>
    <div className="story-grid">
      <section className="panel story-canvas">
        <div className="scene-topline"><span className="scene-indicator">WORLD</span><span>{activeAdventure ? `Adventure: ${activeAdventure.name}` : branchId === "main" ? "Main story" : "Legacy story"}</span></div>
        <div className="story-session-bar">
          <label className="field-label">Saved story<select aria-label="Select saved story" disabled={generating} value={conversationId} onChange={(event) => void selectConversation(event.target.value)}>
            <option value="">Choose a story</option>
            {conversations.map((item) => <option key={item.conversation_id} value={item.conversation_id}>{item.title} · {item.actor_label}</option>)}
          </select></label>
          {conversation && <span className="privacy-tag">{conversation.actor_is_user_controlled ? "PLAYER CONTROL" : "MODEL MAY NARRATE"}</span>}
        </div>
        {conversation && <details className="story-session-options">
          <summary>More story options</summary>
          <div className="story-session-options-content">
            <div className="story-session-actions">
              <button className="secondary-button" type="button" onClick={() => setReaderOpen((open) => !open)}>{readerOpen ? "Close reader" : "Open reader / print"}</button>
              <button className="secondary-button" type="button" onClick={exportStory}>Export story JSON ↓</button>
            </div>
            <label className="control-choice story-history-toggle"><input type="checkbox" checked={showTurnHistory} onChange={(event) => setShowTurnHistory(event.target.checked)} /><span>Show earlier versions and hidden turns</span></label>
            <label className="control-choice"><input type="checkbox" checked={exportIncludesPrompts} onChange={(event) => setExportIncludesPrompts(event.target.checked)} /><span>Include my prompts in export</span></label>
            <label className="control-choice"><input type="checkbox" checked={exportIncludesContext} onChange={(event) => setExportIncludesContext(event.target.checked)} /><span>Include character context details in export</span></label>
            <small className="field-note">Story exports can contain private details. Review the file before sharing.</small>
          </div>
        </details>}
        {conversation && readerOpen && <section className="story-reader is-open" dir="auto">
          <div className="reader-toolbar"><span>Private local reader</span><button className="secondary-button" type="button" onClick={() => window.print()}>Print / save PDF</button></div>
          <h1>{conversation.title}</h1>
          <p className="reader-metadata">{activeAdventure ? `${activeAdventure.world_name} · ${activeAdventure.name} · ${activeAdventure.actor_label}` : `${conversation.actor_label} · Legacy story`}</p>
          {studioData?.assets.filter((asset) => asset.target_kind === "character" && asset.target_id === conversation.actor_entity_id).map((asset) => assetData[asset.asset_id] && <img className="reader-character-art" key={asset.asset_id} src={assetData[asset.asset_id]} alt={`${conversation.actor_label} · ${asset.display_name}`} />)}
          {conversation.turns.filter((turn) => turn.status === "active" && turn.metadata?.context_excluded !== true).map((turn) => <article className="reader-turn" key={turn.turn_id}>
            <h2>{turn.role === "user" ? "Your direction" : turn.metadata?.source_role === "npc" ? `NPC · ${String(turn.metadata.speaker || "Unknown")}` : "Story"}</h2>
            {studioData?.assets.filter((asset) => asset.target_kind === "scene" && asset.target_id === turn.turn_id).map((asset) => assetData[asset.asset_id] && <img className="reader-scene-art" key={asset.asset_id} src={assetData[asset.asset_id]} alt={asset.display_name} />)}
            <p dir="auto">{turn.content}</p>
          </article>)}
          <small>Export preview contains active story turns and attached images. Imported author-only thoughts and metadata, context manifests, and private NPC notes are excluded.</small>
        </section>}
        {!conversation && <form className="story-start-form" onSubmit={(event) => void startConversation(event)}>
          <div className="story-placeholder"><div className="story-sigil">✳</div><h2>Start a persistent story.</h2><p>Each turn is saved locally with its branch revision and the character context used to generate it.</p></div>
          {characters.length ? <>
            <label className="field-label">Story title<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="The Broken Oath" maxLength={200} /></label>
            <label className="field-label">Viewpoint character<select value={selectedActor} onChange={(event) => setActor(event.target.value)}>{characters.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label}</option>)}</select></label>
            <label className="control-choice"><input type="checkbox" checked={actorIsUserControlled} onChange={(event) => setActorIsUserControlled(event.target.checked)} /><span>I control this character. Let me choose their words and actions.</span></label>
            <button className="primary-button full-button" disabled={busy}>Start story <span>↗</span></button>
          </> : <button className="secondary-button full-button" type="button" onClick={() => onNavigate("knowledge")}>Create a character in Knowledge <span>↗</span></button>}
        </form>}
        {conversation && <>
          <div className="story-turn-list" aria-live="polite">
            {conversation.turns.filter((turn) => showTurnHistory || turn.status === "active").length ? conversation.turns.filter((turn) => showTurnHistory || turn.status === "active").map((turn) => <article className={`story-turn ${turn.role} ${turn.status} ${turn.metadata?.context_excluded === true ? "author-only-turn" : ""}`} key={turn.turn_id}>
              <div className="story-turn-label">{turn.role === "user" ? "You" : turn.metadata?.source_role === "npc" ? `NPC · ${String(turn.metadata.speaker || "Unknown")}` : turn.metadata?.source_role === "narrator" ? "Narrator" : turn.metadata?.source_role === "check" ? "Check" : turn.metadata?.context_excluded === true ? "Author note" : "Story"}<span>{turn.status === "deleted" ? "Hidden" : turn.status === "superseded" ? "Earlier version" : ""}</span></div>
              {editingTurnId === turn.turn_id ? <form className="story-turn-edit" onSubmit={(event) => { event.preventDefault(); void saveTurnEdit(turn); }}>
                <label className="field-label">Edit {turn.role === "user" ? "your direction" : "the saved response"}<textarea value={editedTurnText} onChange={(event) => setEditedTurnText(event.target.value)} rows={5} maxLength={20000} required /></label>
                {turn.role === "user" && <small className="field-note">Saving a changed direction moves later active turns to history. You can continue from the corrected prompt.</small>}
                <div className="story-turn-actions"><button type="submit" disabled={busy || !editedTurnText.trim()}>Save edit</button><button type="button" onClick={() => setEditingTurnId("")}>Cancel</button></div>
              </form> : turn.metadata?.context_excluded === true
                ? <details className="story-private-turn"><summary>Show imported author-only content · excluded from future model context</summary><p dir="auto">{turn.content}</p></details>
                : <p dir="auto">{turn.content}</p>}
              {turn.role === "assistant" && rpgState?.mechanic_checks.filter((check) => check.source_turn_id === turn.turn_id).map((check) => {
                const skill = rpgState.mechanics.skills.find((item) => item.skill_id === check.skill_id);
                const difficulty = rpgState.mechanics.difficulties.find((item) => item.difficulty_id === check.difficulty_id);
                const subject = skill?.label || activeStatLabel(check.stat_name);
                const modifier = check.modifier >= 0 ? `+${check.modifier}` : String(check.modifier);
                return <div className={`story-check-result ${check.outcome}`} key={check.check_id} role="group"
                  aria-label={`Automatic check ${check.outcome}: ${subject}, ${difficulty?.label || "difficulty"}`}>
                  <strong>{check.outcome === "success" ? "Success" : "Failure"} · {subject} · {difficulty?.label || "Check"}</strong>
                  <small>Dice {check.dice.join(", ")} · modifier {modifier} · total {check.total} · target {check.target}</small>
                </div>;
              })}
              {turn.status === "active" && <details className="story-turn-options">
                <summary>Turn options</summary>
                <div className="story-turn-actions">
                  <button type="button" disabled={busy || generating} onClick={() => { setEditingTurnId(turn.turn_id); setEditedTurnText(turn.content); }}>Edit</button>
                  {turn.role === "assistant" && <button type="button" disabled={busy || generating || !model.trim() || !storyProviderAvailable} onClick={() => void retryStoryTurn(turn)}>Try again</button>}
                  <button type="button" disabled={busy || generating} onClick={() => void deleteStoryTurn(turn)}>Hide</button>
                  {turn.role === "assistant" && activeAdventure && studioData?.memories.memories.some((memory) => memory.kind === "event" && memory.source_turn_id === turn.turn_id) && <small>A story memory suggestion is ready to review in Adventure details &amp; tools.</small>}
                </div>
              </details>}
              {studioData?.assets.filter((asset) => asset.target_kind === "scene" && asset.target_id === turn.turn_id).map((asset) => assetData[asset.asset_id] && <img className="story-turn-art" key={asset.asset_id} src={assetData[asset.asset_id]} alt={asset.display_name} />)}
              {turn.role === "assistant" && <details className="story-context-details">
                  <summary>{turn.metadata?.source_format === "mno-adv" ? "Imported turn details" : "Turn details"}{turn.context_manifest ? ` · ${turn.context_manifest.included.length} reviewed facts · ${turn.context_manifest.excluded.length} excluded` : ""}</summary>
                  <p>{turn.metadata?.source_format === "mno-adv"
                    ? "Imported story text. It does not change the adventure state."
                    : "Saved story text. World facts change only after you review a suggestion."}</p>
                  {turn.context_manifest && <>
                  {turn.context_manifest.included.map((fact) => <div className="story-context-fact" key={fact.claim_id}>
                    <strong>{fact.subject} · {fact.predicate} {fact.object}</strong>
                    <small>{fact.actor_stance} · {fact.evidence_ids.length} linked sources</small>
                  </div>)}
                  {turn.context_manifest.excluded.map((item) => <small className="story-context-exclusions" key={item.claim_id}>Excluded claim {item.claim_id} · {item.reason}</small>)}
                  {turn.context_manifest.story && <div className="story-context-fact"><strong>{turn.context_manifest.story.world_name} · world v{turn.context_manifest.story.world_version}</strong><small>{turn.context_manifest.story.description} {turn.context_manifest.story.public_lore}</small><small>Location: {turn.context_manifest.story.character_sheet.current_location || "Not set"} · {Object.keys(turn.context_manifest.story.character_sheet.stats).length} stats · {Object.keys(turn.context_manifest.story.character_sheet.trackers).length} trackers · {turn.context_manifest.story.recent_checks.length + turn.context_manifest.story.recent_mechanic_checks.length} recent checks · {turn.context_manifest.story.character_sheet.experience.total_xp} XP</small>
                    {turn.context_manifest.story.opening_scene && <small>Opening scene seed · {turn.context_manifest.story.opening_scene.situation} · Hook: {turn.context_manifest.story.opening_scene.hook}</small>}
                    {turn.context_manifest.story.world_reference && <>
                      <small>Imported lorebook · {turn.context_manifest.story.world_reference.included.length} selected · {turn.context_manifest.story.world_reference.excluded_count} not selected. Narrator reference only; this does not establish what the hero knows.</small>
                      {turn.context_manifest.story.world_reference.narrative_vibe && <small>Imported narrative style · {turn.context_manifest.story.world_reference.narrative_vibe}</small>}
                      {turn.context_manifest.story.world_reference.included.map((entry, index) => <details key={entry.source_index ?? `${entry.title}-${index}`}>
                        <summary>World lore · {entry.title} · {entry.selection_reason === "always" ? "always included" : "keyword match"}</summary>
                        <p dir="auto">{entry.content}</p>
                      </details>)}
                    </>}
                    {(turn.context_manifest.story.memories ?? []).map((memory) => <small key={memory.memory_id}>Memory · {memory.kind} · relevance {memory.selection_score}: {memory.content}</small>)}
                    {(turn.context_manifest.story.author_notes ?? []).map((memory) => <small key={memory.memory_id}>Narrator-only guidance · importance {memory.importance}: {memory.content}</small>)}
                    {(turn.context_manifest.story.excluded_memories ?? []).map((memory) => <small className="story-context-exclusions" key={`${memory.memory_id}-${memory.reason}`}>Memory {memory.memory_id} excluded · {memory.reason}</small>)}
                    {(turn.context_manifest.story.retrieved_episodes ?? []).map((episode) => <details key={episode.turn_id}><summary>Past turn {episode.narrative_order} · {episode.role} · relevance {episode.selection_score}</summary><p dir="auto">{episode.content}</p></details>)}
                    {turn.context_manifest.story.excluded_episode_count > 0 && <small className="story-context-exclusions">{turn.context_manifest.story.excluded_episode_count} older turns excluded or outside this context window.</small>}
                    {(turn.context_manifest.story.open_threads ?? []).map((thread) => <small key={thread.thread_id}>Open thread · {thread.title}: {thread.detail}</small>)}
                    {(turn.context_manifest.story.public_npcs ?? []).map((npc) => <small key={npc.entity_id}>Approved NPC · {npc.name} · {JSON.stringify(npc.profile)}</small>)}
                  </div>}
                  {turn.context_manifest.excluded.length === 0 && <small className="story-context-exclusions">Manifest {turn.context_manifest.manifest_id}</small>}
                  </>}
                </details>}
            </article>) : <div className="story-placeholder compact"><div className="story-sigil">✳</div><h2>Your story is ready.</h2><p>Describe what happens next, and Lorethra will continue the scene.</p></div>}
          </div>
          <form className="story-compose-form" onSubmit={(event) => void generateStoryTurn(event)}>
            <label className="field-label story-direction-label">What happens next?<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} maxLength={4000} placeholder="Describe a moment, a question, or what your hero does." required /></label>
            <details className="story-writing-settings">
              <summary><span>Writing settings</span><small>{selectedStoryProvider?.label || "Choose a model"} · {model === "auto" ? "Default model" : model || "Model not selected"}{effectiveCodexReasoningEffort ? ` · ${effectiveCodexReasoningEffort} reasoning` : ""}</small></summary>
              <div className="story-writing-settings-body">
                <div className="story-provider-fields">
                  <label className="field-label">AI provider<select aria-label="AI provider" value={providerId} onChange={(event) => changeStoryProvider(event.target.value as StoryProvider["id"])} disabled={generating || memoryQuerying}>
                    {storyProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{provider.local ? " · local" : " · online"}</option>)}
                    {!storyProviders.length && <option value="ollama">Ollama · local</option>}
                  </select></label>
                  <label className="field-label">Model<select aria-label="Model" value={customModel ? "__custom__" : model} disabled={generating || memoryQuerying} onChange={(event) => changeStoryModel(event.target.value)}>
                    {!model && !customModel && <option value="">Choose a model</option>}
                    {providerId === "codex" && <option value="auto">Codex default (automatic)</option>}
                    {providerId === "codex" && model && model !== "auto" && !models.includes(model) && <option value={model} disabled>{modelDiscoveryBusy ? "Loading saved model…" : "Saved model unavailable"}</option>}
                    {models.filter((name) => name !== "auto").map((name) => <option key={name} value={name}>{name}</option>)}
                    {providerId !== "codex" && <option value="__custom__">Use a custom model ID</option>}
                  </select></label>
                  {customModel && <label className="field-label">Custom model ID<input aria-label="Custom model ID" value={model} onChange={(event) => setModel(event.target.value)} maxLength={200} disabled={generating || memoryQuerying} placeholder="Provider model ID" /></label>}
                </div>
                {(providerId === "openai" || providerId === "claude" || providerId === "codex") && storyProviderAvailable && <div>
                  <button className="secondary-button" type="button" disabled={modelDiscoveryBusy || generating || memoryQuerying} onClick={() => void loadProviderModels()}>{modelDiscoveryBusy ? "Loading models…" : providerId === "codex" ? "Refresh Codex models" : "Load available models"}</button>
                  <small className="provider-note">{providerId === "codex" ? "Reads the Codex model list without sending story text." : "Requests the provider model list using its configured API key."}</small>
                  {modelDiscoveryError && <p className="inline-error" role="alert">{modelDiscoveryError}</p>}
                  {modelDiscoveryNotice && <p className="provider-note" role="status" aria-live="polite">{modelDiscoveryNotice}</p>}
                </div>}
                {codexReasoningControl("Reasoning effort", generating || memoryQuerying)}
                {selectedStoryProvider && <p className="provider-note">{selectedStoryProvider.setup} {selectedStoryProvider.local ? "Story requests stay on this device." : "Before sending, Lorethra asks what story details will leave this device. Provider terms and charges may apply."}</p>}
                {selectedStoryProvider && EXTERNAL_STORY_PROVIDERS.includes(providerId) && (externalProviderConsents.includes(providerId)
                  ? <button className="link-button provider-consent-revoke" type="button" onClick={() => revokeExternalProviderConsent(providerId)}>Revoke consent for {selectedStoryProvider.label} on this device</button>
                  : <small className="provider-note">Lorethra will ask before the first request to this provider.</small>)}
                {selectedStoryProvider && !storyProviderAvailable && <p className="provider-note">This provider is not ready yet. Check its setup, then refresh.</p>}
                {storyProviderAvailable && !model.trim() && <p className="provider-note">Choose a listed model to continue.</p>}
                <details className="story-advanced-options"><summary>More story options</summary><label className="field-label">Story order<input type="number" min={0} value={order} disabled={memoryQuerying} onChange={(event) => setOrder(Number(event.target.value))} /></label></details>
              </div>
            </details>
            <button className="primary-button full-button" disabled={generating || busy || !storyProviderAvailable || !model.trim() || !prompt.trim()}>{generating ? "Writing your story…" : "Continue story"} <span>✳</span></button>
            {generating && <button className="secondary-button full-button stop-generation" type="button" onClick={stopStoryGeneration}>Stop generation</button>}
            {generating && <small className="provider-note">Stop cancels Lorethra’s request and prevents a partial reply from being saved. A provider may finish work it already accepted, and a remote request may still be billable.</small>}
          </form>
        </>}
        {storyError && <p className="inline-error" role="alert">{storyError}</p>}
      </section>
      <details className="story-adventure-tools">
        <summary className="story-adventure-tools-summary">
          <span><strong>Adventure details &amp; tools</strong><small>{activeAdventure
            ? `${activeAdventure.actor_label} · ${activeAdventure.world_name} · ${rpgState?.sheet?.current_location || "Location not set"} · ${rpgState?.sheet?.experience.total_xp.toLocaleString() ?? 0} XP${rpgState?.sheet?.experience.mode === "manual" ? " · manual rules" : " · automatic rewards"}`
            : "Character, memory, map, and story details"}</small></span>
          {pendingRpgReviewCount + pendingMemoryReviewCount > 0 && <span className="story-review-count" role="status" aria-live="polite">{pendingRpgReviewCount + pendingMemoryReviewCount} to review</span>}
        </summary>
      <div className="story-side-panels">
      <section className="panel rpg-state-panel">
        <div className="panel-heading"><div><h2>Your adventure</h2><p>{activeAdventure ? `${activeAdventure.actor_label} · ${activeAdventure.world_name}` : "Start an adventure to see your character here."}</p></div></div>
        {activeAdventure && rpgState?.sheet ? <>
          <div className="rpg-location"><small>Current location</small><strong dir="auto">{rpgState.sheet.current_location || "Not set"}</strong></div>
          <details className="rpg-character-details">
            <summary><span>Character details</span><small>{rpgState.sheet.experience.total_xp.toLocaleString()} XP · {rpgState.sheet.experience.mode === "manual" ? "manual" : "automatic"}{pendingRpgReviewCount ? ` · ${pendingRpgReviewCount} ${pendingRpgReviewCount === 1 ? "suggestion" : "suggestions"} to review` : ""}</small></summary>
            <div className="rpg-character-details-content">
          {activeAdventureHero && <details className="rpg-edit-stats rpg-hero-identity">
            <summary>Hero identity</summary>
            <p className="field-note">Notes guide local identity and voice without overriding story controls. This adventure keeps its own copy; edits do not affect your reusable hero or other adventures. Hosted providers do not receive these notes.</p>
            {!showAdventureHeroProfileEditor && (activeAdventureHeroProfileEntries.length > 0
              ? <dl className="hero-profile-review-list">{activeAdventureHeroProfileEntries.map(({ key, label, value }) => <div key={key}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
              : <p className="empty-hint">No identity notes saved for this adventure.</p>)}
            {!showAdventureHeroProfileEditor && activeAdventureImportedProfileEntries.length > 0 && <details className="hero-profile-review">
              <summary>Imported MNO details · {activeAdventureImportedProfileEntries.length}</summary>
              <dl>{activeAdventureImportedProfileEntries.map(({ key, label, value }) => <div key={key}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            </details>}
            {!showAdventureHeroProfileEditor
              ? <button className="link-button" type="button" disabled={busy} onClick={() => { setAdventureHeroProfileError(""); setAdventureHeroProfileDraft(activeAdventureHeroProfile); setShowAdventureHeroProfileEditor(true); }}>
                  {activeAdventureHeroProfileEntries.length || activeAdventureImportedProfileEntries.length ? "Edit identity notes" : "Add identity notes"}
                </button>
              : <form className="hero-identity-form" onSubmit={(event) => void saveAdventureHeroProfile(event)}>
                  <div className="hero-profile-fields">
                    {HERO_PROFILE_FIELDS.map(({ key, label, maxLength, rows, placeholder }) => <label className="field-label" key={key}>{label}<textarea autoFocus={key === "concept"} value={adventureHeroProfileDraft[key]} onChange={(event) => changeAdventureHeroProfileField(key, event.target.value)} maxLength={maxLength} rows={rows} placeholder={placeholder} /></label>)}
                  </div>
                  {activeAdventureImportedProfileEntries.length > 0 && <details className="hero-profile-details">
                    <summary>Edit imported MNO details · {activeAdventureImportedProfileEntries.length}</summary>
                    <p className="field-note">Clear an imported field and save to remove it from this adventure profile.</p>
                    <div className="hero-profile-fields">
                      {HERO_IMPORTED_PROFILE_FIELDS.map(({ key, label, maxLength, rows, placeholder }) => <label className="field-label" key={key}>{label}<textarea value={adventureHeroProfileDraft[key]} onChange={(event) => changeAdventureHeroProfileField(key, event.target.value)} maxLength={maxLength} rows={rows} placeholder={placeholder} /></label>)}
                    </div>
                  </details>}
                  {adventureHeroProfileError && <p className="inline-error" role="alert">{adventureHeroProfileError}</p>}
                  <div className="wizard-actions">
                    <button className="primary-button" disabled={busy}>Save identity</button>
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => setShowAdventureHeroProfileEditor(false)}>Cancel</button>
                  </div>
                </form>}
          </details>}
          <div className="rpg-stat-list"><strong>Stats</strong><div>{Object.entries(rpgState.sheet.stats).map(([name, value]) => <span key={name}>{activeStatLabel(name)}<b>{value >= 0 ? `+${value}` : value}</b></span>)}</div></div>
          <details className="rpg-edit-stats"><summary>Edit stat modifiers</summary><form onSubmit={(event) => void saveRpgStats(event)}>{Object.entries(rpgState.sheet.stats).map(([name, value]) => <label className="field-label" key={name}>{name}<input type="number" min={-10} max={10} value={editableStats[name] ?? value} onChange={(event) => setEditableStats((stats) => ({ ...stats, [name]: Number(event.target.value) }))} /></label>)}<button className="secondary-button full-button" disabled={busy}>Save stats</button></form></details>
          <div className="rpg-tracker-list"><strong>Trackers</strong>{Object.entries(rpgState.sheet.trackers).map(([name, tracker]) => <div key={name}><span>{name}</span><b>{tracker.value} / {tracker.max}</b><meter min={0} max={Math.max(1, tracker.max)} value={tracker.value} /></div>)}</div>
          {rpgState.mechanics.skills.length > 0 && <details className="rpg-edit-stats"><summary>Skills and proficiency · {rpgState.mechanics.skills.length}</summary>
            <form onSubmit={(event) => void saveRpgSkills(event)}>{rpgState.mechanics.skills.map((skill) => <label className="field-label" key={skill.skill_id}>{skill.label} · {skill.attribute || "no governing stat"}<input type="number" min={0} max={skill.max_rank} value={editableSkills[skill.skill_id] ?? skill.starting_rank} onChange={(event) => setEditableSkills((ranks) => ({ ...ranks, [skill.skill_id]: Number(event.target.value) }))} /><small>Rank {editableSkills[skill.skill_id] ?? skill.starting_rank} · +{skill.rank_bonus} per rank</small></label>)}<button className="secondary-button full-button" disabled={busy}>Save skill ranks</button></form>
          </details>}
          <section className="rpg-experience-card"><div><strong>Experience</strong><b>{rpgState.sheet.experience.total_xp.toLocaleString()} / {rpgState.sheet.experience.maximum_xp.toLocaleString()} XP</b></div><small>{rpgState.sheet.experience.mode === "manual" ? "This world version keeps its original manual XP rules." : `${rpgState.sheet.experience.automatic_xp.toLocaleString()} XP awarded automatically · ${rpgState.sheet.experience.per_completed_turn} per completed player turn`}{rpgState.sheet.experience.manual_awards ? ` · ${rpgState.sheet.experience.manual_awards} added manually` : ""}</small>
            {rpgState.mechanics.experience.allow_manual_awards && <form className="rpg-check-fields" onSubmit={(event) => void awardExperience(event)}><label className="field-label">Add XP manually<input type="number" min={1} max={1_000_000} step={1} value={experienceAward} onChange={(event) => setExperienceAward(Number(event.target.value))} /></label><button className="secondary-button" disabled={busy || rpgState.sheet.experience.total_xp >= rpgState.sheet.experience.maximum_xp}>Add XP</button></form>}
          </section>
          {rpgState.sheet.abilities.length > 0 && <section className="rpg-ability-list" aria-labelledby="rpg-abilities-heading">
            <strong id="rpg-abilities-heading">Exceptional abilities</strong>
            <p className="field-note">These definitions are pinned to the adventure’s world version. No unstated mana cost, roll, or cooldown is added.</p>
            {rpgState.sheet.abilities.map((ability) => {
              const cooldownReady = rpgState.adventure.completed_turns >= ability.ready_after_turn;
              const costsAvailable = ability.costs.every((cost) => {
                const tracker = Object.entries(rpgState.sheet!.trackers).find(([name]) => name.toLocaleLowerCase() === cost.resource.toLocaleLowerCase())?.[1];
                return !!tracker && tracker.value >= cost.amount;
              });
              const sections: Array<[string, string[]]> = [
                ["Known effects", ability.effects], ["Interactions with ordinary magic", ability.magic_interactions],
                ["Demonstrated capabilities", ability.demonstrated_capabilities], ["Confirmed limitations", ability.confirmed_limitations],
                ["Unresolved aspects", ability.unresolved_aspects],
              ];
              return <article className={`rpg-ability-card ${ability.is_active ? "active" : ""}`} key={ability.ability_id}>
                <div className="rpg-ability-heading"><div><strong>{ability.name}</strong><small>{ability.category} · {ability.source} · {ability.is_active ? "Active" : "Inactive"}</small></div>
                  <button type="button" className={ability.is_active ? "secondary-button" : "primary-button"} disabled={busy || generating || (!ability.is_active && (!cooldownReady || !costsAvailable))} onClick={() => void setAbilityActive(ability.ability_id, !ability.is_active)}>{ability.is_active ? "Deactivate" : "Activate"}</button></div>
                <p>{ability.description}</p>
                <div className="rpg-ability-facts"><span><b>Activation</b>{ability.activation}</span><span><b>Deactivation</b>{ability.deactivation}</span>
                  <span><b>Cost</b>{ability.costs.length ? ability.costs.map((cost) => `${cost.amount} ${cost.resource}`).join(", ") : "None"}</span>
                  <span><b>Cooldown</b>{ability.cooldown_turns === null ? "None" : `${ability.cooldown_turns} completed turns`}{!cooldownReady && ` · ready after turn ${ability.ready_after_turn}`}</span>
                  {ability.duration && <span><b>Duration</b>{ability.duration}</span>}{ability.range && <span><b>Range</b>{ability.range}</span>}
                </div>
                {sections.filter(([, items]) => items.length > 0).map(([label, items]) => <div className="rpg-ability-list-section" key={label}>
                  <b>{label}</b><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
                </div>)}
                {!cooldownReady && <small role="status">This ability’s explicitly defined cooldown has not elapsed.</small>}
                {!costsAvailable && <small role="status">A declared activation resource is unavailable or too low.</small>}
              </article>;
            })}
          </section>}
          {rpgState.mechanics.mode === "narrative_only" ? <p className="field-note">This adventure resolves uncertain moments through the story.</p> : <details className="manual-check-details">
            <summary>Roll a separate check (advanced)</summary>
            <p className="field-note">{rpgState.automatic_checks_enabled ? "Lorethra rolls for risky actions automatically. Use this only when you want an additional check." : "This world version keeps its original check rules. Use this when you want a separate check."}</p>
            <form className="rpg-check-form" onSubmit={(event) => void rollMechanicsCheck(event)}>
              <div className="rpg-check-fields">
                <label className="field-label">Encounter<select value={rpgState.mechanics.encounter_types.some((item) => item.encounter_type === checkEncounter) ? checkEncounter : rpgState.mechanics.encounter_types[0]?.encounter_type || ""} onChange={(event) => setCheckEncounter(event.target.value)}>{rpgState.mechanics.encounter_types.map((item) => <option key={item.encounter_type} value={item.encounter_type}>{item.label}</option>)}</select></label>
                <label className="field-label">Skill<select value={checkSkill} onChange={(event) => setCheckSkill(event.target.value)}><option value="">No skill</option>{rpgState.mechanics.skills.map((item) => <option key={item.skill_id} value={item.skill_id}>{item.label} · rank {rpgState.sheet!.skills[item.skill_id] ?? item.starting_rank}</option>)}</select></label>
                <label className="field-label">Attribute<select value={rpgState.mechanics.skills.find((item) => item.skill_id === checkSkill)?.attribute || checkStat || (rpgState.mechanics.dice.include_attribute ? Object.keys(rpgState.sheet.stats)[0] : "")} disabled={!!rpgState.mechanics.skills.find((item) => item.skill_id === checkSkill)?.attribute} onChange={(event) => setCheckStat(event.target.value)}>
                  {(!rpgState.mechanics.dice.include_attribute || (checkSkill && !rpgState.mechanics.skills.find((item) => item.skill_id === checkSkill)?.attribute)) && <option value="">None</option>}{Object.keys(rpgState.sheet.stats).map((name) => <option key={name} value={name}>{activeStatLabel(name)}</option>)}
                </select></label>
                <label className="field-label">Difficulty<select value={rpgState.mechanics.difficulties.some((item) => item.difficulty_id === checkDifficulty) ? checkDifficulty : rpgState.mechanics.difficulties[0]?.difficulty_id || ""} onChange={(event) => setCheckDifficulty(event.target.value)}>{rpgState.mechanics.difficulties.map((item) => <option key={item.difficulty_id} value={item.difficulty_id}>{item.label} · {item.target}</option>)}</select></label>
              </div>
              <button className="secondary-button full-button" disabled={busy || generating}>Roll using pinned rules</button>
            </form>
          </details>}
          {lastManualMechanicCheck && <div className={`rpg-last-check ${lastManualMechanicCheck.outcome}`}><strong>Last manual check · {lastManualMechanicCheck.outcome}</strong><span>{lastManualMechanicCheck.dice.join(", ")} · bonus {lastManualMechanicCheck.modifier >= 0 ? "+" : ""}{lastManualMechanicCheck.modifier} · total {lastManualMechanicCheck.total} · target {lastManualMechanicCheck.target}</span></div>}
          {rpgState.checks[0] && <div className={`rpg-last-check ${rpgState.checks[0].outcome}`}><strong>Last manual check · {rpgState.checks[0].outcome}</strong><span>Roll {rpgState.checks[0].die_roll} · bonus {rpgState.checks[0].modifier >= 0 ? "+" : ""}{rpgState.checks[0].modifier} · total {rpgState.checks[0].total} · target {rpgState.checks[0].target}</span></div>}
          <details className="rpg-proposal-section">
            <summary>State changes for review · {rpgState.proposals.filter((item) => item.review_status === "proposed").length} pending</summary>
            <form className="rpg-proposal-form" onSubmit={(event) => void proposeRpgChange(event)}>
              <label className="field-label">Change type<select value={proposalOperation} onChange={(event) => setProposalOperation(event.target.value as "tracker_delta" | "set_location")}><option value="tracker_delta">Adjust a tracker</option><option value="set_location">Suggest a location</option></select></label>
              {proposalOperation === "tracker_delta" ? <div className="rpg-check-fields">
                <label className="field-label">Tracker<select value={Object.hasOwn(rpgState.sheet.trackers, proposalTracker) ? proposalTracker : Object.keys(rpgState.sheet.trackers)[0] || ""} onChange={(event) => setProposalTracker(event.target.value)}>{Object.keys(rpgState.sheet.trackers).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
                <label className="field-label">Change<input type="number" value={proposalDelta} onChange={(event) => setProposalDelta(Number(event.target.value))} /></label>
              </div> : <label className="field-label">New location<input value={proposalLocation} onChange={(event) => setProposalLocation(event.target.value)} maxLength={200} placeholder="Where should the story move?" /></label>}
              <small className="field-note">A suggestion stays out of canon and future turns until you accept it.</small>
              <button className="secondary-button full-button" disabled={busy || !rpgState.sheet}>Submit for review</button>
            </form>
            {rpgState.proposals.map((proposal) => <article className={`rpg-proposal ${proposal.review_status}`} key={proposal.proposal_id}>
              <div><strong>{proposal.review_status === "proposed" ? "Needs your review" : `Proposal ${proposal.review_status}`}</strong><small>{proposal.changes.map((change) => change.operation === "tracker_delta" ? `${change.tracker_id} ${change.delta > 0 ? "+" : ""}${change.delta}` : change.operation === "set_location" ? `Location → ${change.location}` : change.operation === "npc_profile" ? `NPC profile → ${change.npc_entity_id}: ${Object.entries(change.updates).map(([key, value]) => `${key === "relationship_to_actor" ? "relationship to protagonist" : key.replaceAll("_", " ")} ${value}`).join(", ")}` : `Event memory → ${change.content.slice(0, 100)}`).join(" · ")}</small></div>
              {proposal.review_status === "proposed" && <>
                {editingProposalId === proposal.proposal_id && <form className="rpg-proposal-edit" onSubmit={(event) => { event.preventDefault(); void reviewRpgProposal(proposal, "accepted", editedProposalChanges); }}>
                  {editedProposalChanges.map((change, index) => change.operation === "tracker_delta" ? <div className="rpg-check-fields" key={`${proposal.proposal_id}-${index}`}>
                    <label className="field-label">Tracker<select value={change.tracker_id} onChange={(event) => updateEditedProposalChange(index, { ...change, tracker_id: event.target.value })}>{Object.keys(rpgState.sheet!.trackers).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
                    <label className="field-label">Change<input type="number" value={change.delta} onChange={(event) => updateEditedProposalChange(index, { ...change, delta: Number(event.target.value) })} /></label>
                  </div> : change.operation === "set_location" ? <label className="field-label" key={`${proposal.proposal_id}-${index}`}>New location<input value={change.location} maxLength={200} onChange={(event) => updateEditedProposalChange(index, { ...change, location: event.target.value })} /></label> : <p key={`${proposal.proposal_id}-${index}`}>This simulation suggestion is reviewed as a whole.</p>)}
                  <div className="rpg-proposal-actions"><button type="submit" disabled={busy || !editedProposalChanges.length}>Save and accept</button><button type="button" disabled={busy} onClick={() => setEditingProposalId("")}>Cancel</button></div>
                </form>}
                {editingProposalId !== proposal.proposal_id && <div className="rpg-proposal-actions">{proposal.changes.every((change) => change.operation === "tracker_delta" || change.operation === "set_location") && <button type="button" disabled={busy} onClick={() => { setEditingProposalId(proposal.proposal_id); setEditedProposalChanges(proposal.changes.map((change) => ({ ...change }))); }}>Edit</button>}<button type="button" disabled={busy} onClick={() => void reviewRpgProposal(proposal, "accepted")}>Accept</button><button type="button" disabled={busy} onClick={() => void reviewRpgProposal(proposal, "rejected")}>Reject</button></div>}
              </>}
            </article>)}
          </details>
            </div>
          </details>
        </> : <p className="empty-hint">Start an adventure from a world to get a character sheet, trackers, and checks using its pinned mechanics.</p>}
        {rpgError && <p className="inline-error" role="alert">{rpgError}</p>}
      </section>
      {activeAdventure && studioData && <details className="panel story-detail-panel">
          <summary><strong>Memories</strong><small>{pendingMemoryReviewCount
            ? `${pendingMemoryReviewCount} ${pendingMemoryReviewCount === 1 ? "suggestion" : "suggestions"} to review`
            : "Save details and open questions"}</small></summary>
        <div className="story-detail-content">
          <form className="story-mini-form" onSubmit={(event) => void saveMemoryNote(event)}>
            <label className="field-label">Player note<textarea value={memoryNote} onChange={(event) => setMemoryNote(event.target.value)} rows={2} maxLength={4000} placeholder="A detail you want to keep for this adventure" /></label>
            <label className="field-label">Memory use<select value={memoryKnowledgeScope} onChange={(event) => {
              const next = event.target.value as StoryMemory["knowledge_scope"];
              setMemoryKnowledgeScope(next);
              if (next === "actors" && !memoryKnownBy.length && activeAdventure) setMemoryKnownBy([activeAdventure.actor_entity_id]);
            }}>
              <option value="shared">Shared story memory</option><option value="actors">Only selected characters know</option>
              <option value="author">Author guidance for the narrator</option><option value="private">Private · never send to a model</option>
            </select></label>
            {memoryKnowledgeScope === "actors" && <fieldset className="memory-known-by"><legend>Who knows this?</legend>
              {characters.map((character) => <label key={character.entity_id}><input type="checkbox"
                checked={memoryKnownBy.includes(character.entity_id) || (!memoryKnownBy.length && character.entity_id === activeAdventure.actor_entity_id)}
                onChange={(event) => setMemoryKnownBy((current) => event.target.checked
                  ? [...new Set([...current, character.entity_id])]
                  : current.filter((entityId) => entityId !== character.entity_id))} />
                <span>{character.label}{character.entity_id === activeAdventure.actor_entity_id ? " · Hero" : ""}</span>
              </label>)}
            </fieldset>}
            <label className="field-label">Importance<select value={memoryImportance} onChange={(event) => setMemoryImportance(Number(event.target.value))}>
              <option value={1}>Minor detail</option><option value={3}>Useful detail</option><option value={5}>Major event</option>
            </select></label>
            <label className="control-choice"><input type="checkbox" checked={memoryContextEnabled} onChange={(event) => setMemoryContextEnabled(event.target.checked)} /><span>Allow this note in story context when its scope permits</span></label>
            <button className="secondary-button full-button" disabled={busy || !memoryNote.trim()}>Save note</button>
          </form>
          <div className="story-memory-list">
            {studioData.memories.memories.map((memory) => <article className={`story-memory-card ${memory.review_status}`} key={memory.memory_id}>
              <div className="story-memory-meta"><strong>{memory.kind === "event" ? "Event" : memory.kind === "situation" ? "Situation" : "Note"} · {memory.review_status} · {memory.importance === 5 ? "major" : memory.importance === 1 ? "minor" : "useful"}</strong><small>v{memory.version} · story order {memory.narrative_order} · {memory.knowledge_scope === "actors" ? `Known by ${memory.known_by.map((id) => characters.find((item) => item.entity_id === id)?.label || id).join(", ")}` : memory.knowledge_scope === "author" ? "Narrator guidance" : memory.knowledge_scope === "private" ? "Private · excluded from AI" : "Shared story memory"}{memory.source_turn_id ? " · sourced to a story turn" : ""}</small></div>
              <p dir="auto">{memory.content}</p>
              <div className="story-memory-actions">
                {memory.review_status === "proposed" && <><button type="button" disabled={busy} onClick={() => void reviewMemory(memory, "rejected")}>Reject</button><button type="button" className="accept-button" disabled={busy} onClick={() => void reviewMemory(memory, "accepted")}>Accept into memory</button></>}
                {memory.review_status === "accepted" && <label className="control-choice"><input type="checkbox" checked={memory.context_enabled} disabled={busy} onChange={(event) => void toggleMemoryContext(memory, event.target.checked)} /><span>Use in story context</span></label>}
                {studioData.memories.history[memory.memory_id]?.length > 1 && <details><summary>History · {studioData.memories.history[memory.memory_id].length} versions</summary>{studioData.memories.history[memory.memory_id].slice(0, -1).map((version) => <p key={version.version}>v{version.version} · {version.review_status} · {version.content}</p>)}</details>}
              </div>
            </article>)}
            {!studioData.memories.memories.length && <p className="empty-hint">No adventure memories yet. Add a note or save a story event for review.</p>}
          </div>
          <form className="story-mini-form" onSubmit={(event) => void saveSituation(event)}>
            <div className="story-detail-heading"><strong>Current situation</strong><button type="button" className="link-button" onClick={prepareSituation}>Rebuild draft</button></div>
            <p className="muted">After the story, location, or threads change, update and review this summary before it can be used again.</p>
            <label className="field-label">Editable summary<textarea value={situationDraft} onChange={(event) => setSituationDraft(event.target.value)} rows={4} maxLength={4000} placeholder="A short, player-reviewed summary of the current scene" /></label>
            <small className="field-note">Rebuilt summaries wait for review before entering model context.</small>
            <button className="secondary-button full-button" disabled={busy || !situationDraft.trim()}>Save situation for review</button>
          </form>
          <form className="story-mini-form" onSubmit={(event) => void saveThread(event)}>
            <strong>Open threads</strong>
            <label className="field-label">Thread<input value={threadTitle} onChange={(event) => setThreadTitle(event.target.value)} maxLength={200} placeholder="Who is following the hero?" /></label>
            <label className="field-label">Detail<textarea value={threadDetail} onChange={(event) => setThreadDetail(event.target.value)} rows={2} maxLength={2000} placeholder="What remains unresolved?" /></label>
            <button className="secondary-button full-button" disabled={busy || !threadTitle.trim()}>Add open thread</button>
          </form>
          <div className="story-thread-list">{studioData.memories.threads.map((thread) => <article className="story-thread-card" key={thread.thread_id}><div><strong>{thread.title}</strong><p>{thread.detail}</p></div><button type="button" className="link-button" disabled={busy} onClick={() => void updateThread(thread, thread.status === "open" ? "closed" : "open")}>{thread.status === "open" ? "Close" : "Reopen"}</button></article>)}</div>
        </div>
      </details>}
      {activeAdventure && studioData && <details className="panel story-detail-panel">
        <summary><strong>NPCs</strong><small>Profiles and optional, reviewed off-screen activity</small></summary>
        <div className="story-detail-content">
          <label className="control-choice"><input type="checkbox" checked={Boolean(rpgState?.adventure.npc_simulation_enabled)} disabled={busy} onChange={(event) => void setNpcSimulation(event.target.checked)} /><span>Simulate up to two approved NPCs every five completed turns. Suggestions always wait for review.</span></label>
          {worldCastTemplates.length > 0 && <details className="story-world-cast">
            <summary>World cast · {worldCastTemplates.length} templates</summary>
            <p className="field-note">Add only the characters you want in this adventure. Their secrets stay author-only; choosing a character never starts off-screen simulation.</p>
            <div className="story-world-cast-list">{worldCastTemplates.map((template, index) => {
              const name = typeof template.name === "string" ? template.name : `World character ${index + 1}`;
              const alreadyAdded = studioData.npcs.some((npc) => npc.label.toLocaleLowerCase() === name.toLocaleLowerCase());
              const descriptor = [template.job, template.race].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join(" · ");
              return <article key={`${name}-${index}`}><div><strong>{name}</strong><small>{descriptor || "World character"}</small></div><button className="secondary-button" type="button" disabled={busy || alreadyAdded} onClick={() => void addNpcFromWorldTemplate(template)}>{alreadyAdded ? "Added" : "Add"}</button></article>;
            })}</div>
          </details>}
          {studioData.npcs.map((npc) => {
            const portrait = studioData.assets.find((asset) => asset.target_kind === "character" && asset.target_id === npc.npc_entity_id);
            const privateTrackers = npc.private_profile.trackers && typeof npc.private_profile.trackers === "object" && !Array.isArray(npc.private_profile.trackers) ? npc.private_profile.trackers as Record<string, unknown> : {};
            const privateTrackerEntries = Object.entries(privateTrackers);
            const privateLife = npc.private_profile.life && typeof npc.private_profile.life === "object" && !Array.isArray(npc.private_profile.life) ? npc.private_profile.life as Record<string, unknown> : {};
            const privateNotes = typeof npc.private_profile.notes === "string" ? npc.private_profile.notes : "";
            return <article className="story-npc-card" key={npc.npc_entity_id}>
              <div className="story-npc-heading">
                {portrait && assetData[portrait.asset_id] && <img src={assetData[portrait.asset_id]} alt={`${npc.label} portrait`} />}
                <div><strong>{npc.label} · {npc.review_status}</strong><small>{npc.aliases.length ? `Also known as ${npc.aliases.join(", ")}` : "No aliases"}</small><p>{npc.public_profile.job || npc.public_profile.race || "Character"} · Goal: {npc.public_profile.current_goal || "not set"}</p>{npc.public_profile.relationship_to_actor && <p className="story-npc-relationship"><strong>Relationship to protagonist:</strong> <span dir="auto">{npc.public_profile.relationship_to_actor}</span></p>}</div>
              </div>
              <details><summary>Profile</summary><dl className="story-npc-details">
                {(["age", "gender", "race", "job", "appearance", "persona", "motivation", "voice", "current_goal", "whereabouts", "relationship_to_actor", "extra"] as const).filter((key) => npc.public_profile[key]).map((key) => <div key={key}><dt>{key === "relationship_to_actor" ? "Relationship to protagonist" : key.replaceAll("_", " ")}</dt><dd dir="auto">{npc.public_profile[key]}</dd></div>)}
              </dl></details>
              <details><summary>Private notes and trackers · author-only</summary>
                <p className="private-note">Only you can see these details. They are never included in story context or sent to a model.</p>
                <div className="story-npc-private-notes"><strong>Private notes</strong><p dir="auto">{privateNotes || "No private notes saved."}</p></div>
                {privateTrackerEntries.length > 0
                  ? <>
                    <strong className="story-npc-section-label">Relationship and NPC trackers</strong>
                    <dl className="story-npc-details">
                      {privateTrackerEntries.slice(0, 40).map(([key, value]) => <div key={key}>
                        <dt>{humanizeImportedField(key)}</dt>
                        <dd dir="auto">{renderImportedProfileValue(value)}</dd>
                      </div>)}
                      {privateTrackerEntries.length > 40 && <div><dt>More</dt><dd>{privateTrackerEntries.length - 40} additional trackers</dd></div>}
                    </dl>
                  </>
                  : <p className="empty-hint">No imported relationship or character trackers.</p>}
              </details>
              <details><summary>Off-screen life · author-only</summary><dl className="story-npc-details">
                {[["Mini-goal", privateLife.lifeGoal], ["Whereabouts", privateLife.lifeWhere], ["Last activity", privateLife.lifeTick], ["First seen", privateLife.firstSeenTurn], ["Last seen", privateLife.lastSeenTurn], ["Life history", privateLife.lifeHistory]]
                  .filter(([, value]) => value !== undefined && value !== null && value !== "")
                  .map(([label, value]) => <div key={String(label)}><dt>{String(label)}</dt><dd dir="auto">{renderImportedProfileValue(value)}</dd></div>)}
                {!Object.keys(privateLife).length && <p className="empty-hint">No private-life record yet.</p>}
              </dl></details>
            </article>;
          })}
          <form className="story-mini-form story-npc-form" key={npcId || "npc-new"} onSubmit={(event) => void saveNpcProfile(event)}>
            <strong>Match, link an alias, or create an NPC</strong>
            <label className="field-label">Existing NPC<select name="npc_entity_id" value={npcId || "new"} onChange={(event) => setNpcId(event.target.value)}><option value="new">Create a new NPC</option>{characters.filter((item) => item.entity_id !== activeAdventure.actor_entity_id).map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label}</option>)}</select></label>
            {(npcId === "new" || !characters.some((item) => item.entity_id === npcId)) && <label className="field-label">New NPC name<input name="new_npc_name" maxLength={200} placeholder="Name" required /></label>}
            <label className="field-label">Aliases<input name="aliases" defaultValue={selectedNpcProfile?.aliases.join(", ") || ""} placeholder="Names or titles that identify this NPC" /></label>
            <label className="field-label">Appearance<input name="appearance" defaultValue={selectedNpcProfile?.public_profile.appearance || ""} maxLength={500} /></label>
            <label className="field-label">Motivation<input name="motivation" defaultValue={selectedNpcProfile?.public_profile.motivation || ""} maxLength={500} /></label>
            <label className="field-label">Current goal<input name="current_goal" defaultValue={selectedNpcProfile?.public_profile.current_goal || ""} maxLength={500} /></label>
            <label className="field-label">Whereabouts<input name="whereabouts" defaultValue={selectedNpcProfile?.public_profile.whereabouts || ""} maxLength={500} /></label>
            <label className="field-label">Voice<input name="voice" defaultValue={selectedNpcProfile?.public_profile.voice || ""} maxLength={500} /></label>
            <label className="field-label">Relationship to protagonist<textarea name="relationship_to_actor" defaultValue={selectedNpcProfile?.public_profile.relationship_to_actor || ""} rows={2} maxLength={500} /><small className="field-note">Describe the NPC's current stance as narrator guidance. The protagonist does not automatically know this; off-screen updates wait for your review.</small></label>
            <label className="field-label">Private author notes<textarea name="private_notes" defaultValue={typeof selectedNpcProfile?.private_profile.notes === "string" ? selectedNpcProfile.private_profile.notes : ""} rows={2} maxLength={4000} /><small className="field-note">Private notes are visible only in this panel and are never included in story context.</small></label>
            <button className="secondary-button full-button" disabled={busy}>Save approved NPC profile</button>
          </form>
        </div>
      </details>}
      {activeAdventure && rpgState?.sheet && <details className="panel story-detail-panel">
        <summary><strong>Map & travel</strong><small>{rpgState.sheet.current_location || "Location not set"}</small></summary>
        <div className="story-detail-content">
          <p className="field-note">Travel changes the current location only when you choose an approved map point. Model-suggested locations remain proposals.</p>
          {approvedMapLocations.length
            ? <>
              {mapBounds && positionedLocations.length > 0 && <div className="story-map-preview" role="group" aria-label={`Schematic map of ${rpgState.sheet.map_region || "the adventure region"}`}>
                {positionedLocations.map((place) => <button type="button" key={place.location_id} className={`story-map-pin ${place.name === rpgState.sheet?.current_location ? "selected" : ""}`} style={mapPosition(place.x as number, place.y as number)} title={place.description || place.name} aria-label={`${place.name}${place.name === rpgState.sheet?.current_location ? ", current location" : ", travel here"}`} disabled={busy || place.name === rpgState.sheet?.current_location} onClick={() => void travelToLocation(place.name)}><span>{place.icon || "◇"}</span><small>{place.name}</small></button>)}
                {typeof rpgState.sheet.map_x === "number" && typeof rpgState.sheet.map_y === "number" && <div className="story-map-here" style={mapPosition(rpgState.sheet.map_x, rpgState.sheet.map_y)}><span>●</span><small>HERE</small></div>}
              </div>}
              <div className="story-map-locations">{approvedMapLocations.map((place) => <article className={`story-map-place ${place.name === rpgState.sheet?.current_location ? "selected" : ""}`} key={place.location_id}>
                <div><strong>{place.icon ? `${place.icon} ` : ""}{place.name}</strong><small>{place.location_type || "Place"}</small></div>
                {place.description && <p dir="auto">{place.description}</p>}
                <button type="button" disabled={busy || place.name === rpgState.sheet?.current_location} onClick={() => void travelToLocation(place.name)}>{place.name === rpgState.sheet?.current_location ? "Here" : "Travel"}</button>
              </article>)}</div>
            </>
            : <p className="empty-hint">This adventure’s pinned world has no approved map locations yet. Add them in the world editor, then start a new adventure from that version.</p>}
          {rpgState.proposals.filter((proposal) => proposal.review_status === "proposed" && proposal.changes.some((change) => change.operation === "set_location")).map((proposal) => <p className="field-note" key={proposal.proposal_id}>Suggested location: {proposal.changes.filter((change) => change.operation === "set_location").map((change) => change.operation === "set_location" ? change.location : "").join(", ")} · review it in Character & game state.</p>)}
        </div>
      </details>}
      {activeAdventure && studioData && <details className="panel story-detail-panel">
        <summary><strong>Illustrations & reader</strong><small>Local images, selective revisions, and print layout</small></summary>
        <div className="story-detail-content">
          <p className="field-note">Images stay in this adventure’s local database and backup. Uploads include target and provenance and are excluded from the model prompt.</p>
          <form className="story-mini-form" onSubmit={(event) => void uploadStoryImage(event)}>
            <label className="field-label">Attach to<select name="target_kind"><option value="character">Character</option><option value="scene">Scene</option></select></label>
            <label className="field-label">Target<select name="target_id"><option value={activeAdventure.actor_entity_id}>{activeAdventure.actor_label}</option>{conversation?.turns.filter((turn) => turn.role === "assistant" && turn.status === "active").map((turn) => <option key={turn.turn_id} value={turn.turn_id}>Scene · order {turn.narrative_order}</option>)}</select></label>
            <label className="field-label">Image<input type="file" name="image" accept="image/png,image/jpeg,image/webp" required /></label>
            <button className="secondary-button full-button" disabled={busy}>Attach image</button>
          </form>
          {studioData.assets.map((asset) => <div className="story-asset-row" key={asset.asset_id}>{assetData[asset.asset_id] && <img src={assetData[asset.asset_id]} alt={asset.display_name} />}<span>{asset.display_name}<small>{asset.target_kind} · {asset.size_bytes} bytes · {String(asset.provenance.origin || "local")}</small></span></div>)}
          {assetError && <p className="inline-error" role="alert">{assetError}</p>}
        </div>
      </details>}
      <section className="panel context-panel">
        <div className="panel-heading"><div><h2>Character perspective</h2><p>Only reviewed facts this character knows enter the generation context.</p></div><span className="privacy-tag">LOCAL</span></div>
        {characters.length ? <>
          <label className="field-label">Character<select value={selectedActor} disabled={Boolean(conversation) || memoryQuerying} onChange={(event) => setActor(event.target.value)}>{characters.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label}</option>)}</select></label>
          <label className="field-label">Story order<input type="number" min={0} value={order} disabled={memoryQuerying} onChange={(event) => setOrder(Number(event.target.value))} /></label>
          <button className="primary-button full-button" onClick={() => void preview()}>Build context preview <span>↗</span></button>
          <form className="temporal-query-form" onSubmit={(event) => void queryCharacterMemory(event)}>
            <div className="form-divider">ask about character memory</div>
            <label className="field-label">Question<textarea
              dir="auto"
              value={memoryQuestion}
              onChange={(event) => { setMemoryQuestion(event.target.value); setMemoryAnswer(null); setMemoryQueryError(""); }}
              rows={3}
              maxLength={4000}
              placeholder="What does this character remember at this point in the story?"
              disabled={memoryQuerying}
            /></label>
            <small className="field-note">Uses the selected local model and only reviewed claims the character knows at this story order. Empty memory can be checked without a model.</small>
            <button className="secondary-button full-button" disabled={memoryQuerying || generating || busy || !memoryQuestion.trim()}>{memoryQuerying ? "Checking memory locally…" : "Ask character’s memory"} <span>⌕</span></button>
          </form>
          {memoryQueryError && <p className="inline-error" role="alert">{memoryQueryError}</p>}
          {memoryAnswer && <div className={`temporal-answer ${memoryAnswer.status}`} role="status">
            <div className="context-result-heading"><strong>{memoryAnswer.status === "answered" ? "Character memory" : "Insufficient memory"}</strong><small>Order {memoryAnswer.context_manifest.as_of_narrative_order} · revision {memoryAnswer.context_manifest.base_revision}</small></div>
            <p dir="auto">{memoryAnswer.answer}</p>
            {memoryAnswer.citations.map((citation) => <div className="temporal-citation" key={citation.claim_id}>
              <strong dir="auto">{citation.subject} · {citation.predicate} {citation.object}</strong>
              <small>{citation.actor_stance} · {citation.epistemic_status} · story {citation.narrative_order} · aware {citation.awareness_order}</small>
              {citation.evidence_ids.length > 0 && <small>Evidence: {citation.evidence_ids.join(", ")}</small>}
            </div>)}
          </div>}
          <form className="belief-form" onSubmit={(event) => void recordBelief(event)}>
            <div className="form-divider">record a knowledge change</div>
            <label className="field-label">Reviewed claim<select name="claim_id" required>{claims.filter((item) => item.review_status === "accepted").map((item) => <option key={item.claim_id} value={item.claim_id}>{item.predicate}: {item.object_value}</option>)}</select></label>
            <label className="field-label">Character's stance<select name="stance"><option value="knows">Knows</option><option value="believes">Believes</option><option value="denies">Denies</option><option value="unaware">Has not learned</option></select></label>
            <label className="field-label">Awareness order<input name="awareness_order" type="number" min={0} defaultValue={order} /></label>
            <button className="secondary-button full-button" disabled={busy || !claims.some((item) => item.review_status === "accepted")}>Record character knowledge <span>+</span></button>
          </form>
        </> : <p className="empty-hint">Create a character entity to preview their knowledge.</p>}
        {error && <p className="inline-error">{error}</p>}
        {context && <div className="context-result">
          <div className="context-result-heading"><strong>Included knowledge</strong><small>{context.included.length} reviewed claims</small></div>
          {context.included.length ? context.included.map((item, index) => <div className="context-claim" key={`${item.subject}-${index}`}><span>{item.subject}</span><strong>{item.predicate} {item.object}</strong><small>Character {item.actor_stance}</small></div>) : <p className="empty-hint">No eligible claims at this point in the story.</p>}
          <small className="excluded-count">{context.excluded.length} excluded for review, time, awareness, or privacy.</small>
          <button className="secondary-button context-export-button" onClick={exportContext}>Save portable context JSON <span>↓</span></button>
          <small className="context-export-note">Includes the exact manifest, selected branch, and source revision.</small>
          {contextExportNotice && <p className="context-export-success" role="status">{contextExportNotice}</p>}
        </div>}
      </section>
      </div>
      </details>
    </div>
    <details className="story-secondary-import">
      <summary>Import an older conversation</summary>
      <ExternalExchangePanel workspaceId={workspaceId} branchId={branchId} revision={revision} busy={busy} onCommit={onCommit} />
    </details>
  </>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Transcript contains a value that cannot be hashed.");
  return serialized;
}

async function hashExchangeTurns(turns: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(turns)));
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function ExternalExchangePanel({ workspaceId, branchId, revision, busy, onCommit }: {
  workspaceId: string;
  branchId: string;
  revision: number;
  busy: boolean;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<Record<string, unknown>>;
}) {
  const [exchanges, setExchanges] = useState<ExternalExchange[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    request<ExternalExchange[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/exchanges?branch_id=${encodeURIComponent(branchId)}`)
      .then((rows) => { if (active) setExchanges(rows); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "External exchanges could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, branchId, revision]);

  async function importExchange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("exchange_file");
    if (!(file instanceof File) || !file.size) {
      setError("Choose a non-empty lke.exchange.v1 JSON file.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Exchange files are limited to 10 MiB.");
      return;
    }

    setImporting(true);
    setError("");
    setNotice("");
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Exchange file must contain a JSON object.");
      const payload = parsed as Record<string, unknown>;
      if (payload.protocol !== "lke.exchange.v1") throw new Error("This file is not an lke.exchange.v1 exchange.");
      if (typeof payload.transcript_id !== "string" || !payload.transcript_id.trim()) {
        throw new Error("Exchange needs a stable transcript_id shared by every imported segment of the same conversation.");
      }
      if (typeof payload.exchange_id !== "string" || !payload.exchange_id.trim()) payload.exchange_id = newId("exchange");
      if (payload.transcript_hash === undefined && Array.isArray(payload.turns)) {
        payload.transcript_hash = await hashExchangeTurns(payload.turns);
      }
      const result = await onCommit(
        "import_exchange", payload, `Import external exchange ${payload.exchange_id}`,
        "External transcript saved as a reviewable exchange.",
      );
      setNotice(result.duplicate
        ? "This transcript was already imported; no duplicate was added."
        : Array.isArray(result.missing_turns) && result.missing_turns.length
          ? "Transcript saved. Missing turn ranges were detected; review continuity before using this exchange."
        : result.stale_context
          ? "Transcript saved. Its context is stale and needs review."
          : "Transcript saved. External text remains separate from canonical knowledge.");
      form.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The exchange could not be imported.");
    } finally {
      setImporting(false);
    }
  }

  return <section className="panel external-exchange-panel">
    <div className="panel-heading"><div><h2>External conversation exchange</h2><p>Import a versioned transcript from ChatGPT or Codex. Imported text stays separate from story turns and canonical knowledge.</p></div><span className="panel-count">{exchanges.length} saved</span></div>
    <div className="external-exchange-warning">External messages are untrusted transcript data. Importing never accepts facts or applies proposed changes. Keep the same transcript_id on every segment so missing turns can be detected.</div>
    <form className="external-exchange-form" onSubmit={(event) => void importExchange(event)}>
      <label className="field-label">Exchange JSON<input name="exchange_file" type="file" accept=".json,application/json" disabled={busy || importing} /></label>
      <button className="secondary-button" disabled={busy || importing}>{importing ? "Importing…" : "Import transcript"}</button>
    </form>
    {notice && <p className="context-export-success" role="status">{notice}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading ? <p className="empty-hint">Loading saved exchanges…</p>
      : exchanges.length ? <div className="external-exchange-list">{exchanges.map((exchange) => <details className="external-exchange" key={`${exchange.exchange_id}-${exchange.created_revision}`}>
        <summary><strong>{exchange.exchange_id}</strong><span className={exchange.stale_context ? "exchange-status stale" : "exchange-status"}>{exchange.stale_context ? "Stale context" : "Current context"}</span><small>Turns {exchange.from_turn}–{exchange.to_turn} of {exchange.transcript_total_turns} · base r{exchange.base_revision} · imported r{exchange.created_revision}</small></summary>
        <p className="external-exchange-identity">Transcript {exchange.transcript_id} · context snapshot r{exchange.base_revision} · branch now r{exchange.current_revision}</p>
        {exchange.missing_turns.length > 0 && <p className="exchange-gap-warning" role="status">Missing turns in this transcript: {exchange.missing_turns.map((gap) => `${gap.from_turn}–${gap.to_turn}`).join(", ")}. Keep dependent changes out of the canonical record until the gaps are resolved.</p>}
        <details className="external-context-snapshot"><summary>Context manifest snapshot</summary>
          {exchange.context_manifest.included.length > 0 ? <ul>{exchange.context_manifest.included.map((fact) => <li key={fact.claim_id}>{fact.subject} · {fact.predicate} · {fact.object}</li>)}</ul> : <p>No facts were included in the exported context.</p>}
          {exchange.context_manifest.excluded.length > 0 && <p>{exchange.context_manifest.excluded.length} facts were excluded; the manifest preserves the reasons.</p>}
        </details>
        {exchange.proposed_change_ids.length > 0 && <p className="exchange-change-ids">Proposed change references: {exchange.proposed_change_ids.join(", ")}. Review and apply each separately through the command gateway.</p>}
        {exchange.turns.map((turn) => <div className="external-exchange-turn" key={turn.turn_number}><strong>Turn {turn.turn_number}</strong>{turn.messages.map((message, index) => <p key={`${message.role}-${index}`}><b>{message.role}</b> · {message.content}</p>)}</div>)}
      </details>)}</div>
      : <p className="empty-hint">No external exchanges have been imported on this branch.</p>}
    <small className="field-note">The importer verifies branch identity, contiguous turns within each segment, matching content across overlaps, transcript hash, and context revision. A stale or incomplete transcript is retained for review without changing official state.</small>
  </section>;
}

function JournalPage({ workspaceId, branchId, revision, sources, importText, busy, onCommit }: {
  workspaceId: string;
  branchId: string;
  revision: number;
  sources: Source[];
  importText: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  busy: boolean;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
}) {
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [selectedSource, setSelectedSource] = useState<SourceDetails | null>(null);
  const [events, setEvents] = useState<JournalEvent[]>([]);
  const [editingEvent, setEditingEvent] = useState<JournalEvent | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showFullText, setShowFullText] = useState(false);
  const orderedSources = useMemo(() => [...sources].sort((left, right) => right.created_at.localeCompare(left.created_at)), [sources]);

  useEffect(() => {
    let active = true;
    setEventsLoading(true);
    setEventsError("");
    const filters = new URLSearchParams({ branch_id: branchId });
    if (fromDate) filters.set("from_date", fromDate);
    if (toDate) filters.set("to_date", toDate);
    request<JournalEvent[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/journal-events?${filters.toString()}`)
      .then((rows) => { if (active) setEvents(rows); })
      .catch((reason) => { if (active) setEventsError(reason instanceof Error ? reason.message : "The memory timeline could not be loaded."); })
      .finally(() => { if (active) setEventsLoading(false); });
    return () => { active = false; };
  }, [workspaceId, branchId, revision, fromDate, toDate]);

  useEffect(() => {
    if (!orderedSources.length) {
      setSelectedSourceId("");
      return;
    }
    if (!orderedSources.some((source) => source.source_id === selectedSourceId)) setSelectedSourceId(orderedSources[0].source_id);
  }, [orderedSources, selectedSourceId]);

  useEffect(() => {
    let active = true;
    if (!selectedSourceId) {
      setSelectedSource(null);
      setError("");
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    setShowFullText(false);
    request<SourceDetails>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(selectedSourceId)}`)
      .then((source) => { if (active) setSelectedSource(source); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "The note could not be opened."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, selectedSourceId]);

  const contentLimit = 20000;
  const displayedContent = selectedSource && !showFullText ? selectedSource.content.slice(0, contentLimit) : selectedSource?.content || "";

  async function saveEvent(command: string, payload: Record<string, unknown>, reason: string, successText: string) {
    await onCommit(command, payload, reason, successText);
    setEditingEvent(null);
  }

  return <><PageHeader kicker="Personal memory" title="Journal & Memory" summary="Save personal accounts with exact or uncertain timing, and keep source notes intact." /><div className="journal-grid"><SourceForm busy={busy} onSubmit={importText} /><section className="panel journal-notes"><div className="panel-heading"><div><h2>Saved notes</h2><p>Original source text stays unchanged. Review is separate from storage.</p></div><span className="panel-count">{sources.length}</span></div>
    {orderedSources.length ? <div className="journal-entry-list" aria-label="Saved notes">{orderedSources.map((source) => <button key={source.source_id} className={`journal-entry ${selectedSourceId === source.source_id ? "selected" : ""}`} onClick={() => setSelectedSourceId(source.source_id)}>
      <span className="journal-entry-type">{source.media_type === "text/markdown" ? "MD" : "TXT"}</span><span className="journal-entry-copy"><strong>{source.display_name}</strong><small>{new Date(source.created_at).toLocaleString()}</small></span><span className="journal-entry-arrow">↗</span>
    </button>)}</div> : <div className="journal-empty"><div className="journal-mark">▤</div><h2>Your notes remain yours.</h2><p>Save a note or import a text file. It will stay as original source material until you choose to build reviewed memories from it.</p></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading && <p className="empty-hint" role="status">Opening original note…</p>}
    {selectedSource && !loading && <article className="journal-reader"><div className="journal-reader-heading"><div><h3>{selectedSource.display_name}</h3><small>{selectedSource.media_type} · saved {new Date(selectedSource.created_at).toLocaleString()}</small></div><span className="status-pill">ORIGINAL SOURCE</span></div><pre>{displayedContent}</pre>{selectedSource.content.length > contentLimit && <button className="secondary-button journal-expand" onClick={() => setShowFullText((value) => !value)}>{showFullText ? "Show less" : `Show full text (${selectedSource.content.length.toLocaleString()} characters)`}</button>}</article>}
  </section></div>
    <section className="panel journal-timeline"><div className="panel-heading"><div><h2>Memory timeline</h2><p>Each entry remains an account with its own source and timing. Conflicting dates stay separate.</p></div><span className="panel-count">{events.length} accounts · {branchId}</span></div>
      <div className="journal-date-filter"><span>Show dated accounts that overlap</span><label>From<input type="date" value={fromDate} max={toDate || undefined} onChange={(inputEvent) => setFromDate(inputEvent.target.value)} /></label><label>Through<input type="date" value={toDate} min={fromDate || undefined} onChange={(inputEvent) => setToDate(inputEvent.target.value)} /></label><button className="link-button" disabled={!fromDate && !toDate} onClick={() => { setFromDate(""); setToDate(""); }}>Clear dates</button></div>
      <small className="journal-date-filter-note">Relative and unknown timing stays outside a calendar filter.</small>
      <div className="journal-memory-grid"><div className="journal-event-list" aria-label="Memory timeline">
        {eventsError && <p className="inline-error" role="alert">{eventsError}</p>}
        {eventsLoading ? <p className="empty-hint" role="status">Loading saved accounts…</p>
          : events.length ? events.map((event) => <JournalEventCard key={event.event_id} event={event} onCorrect={() => setEditingEvent(event)} />)
            : !eventsError && <p className="empty-hint">No events have been recorded on this branch. Add an account with a date, an approximate time, or unknown timing.</p>}
      </div>
      <JournalEventForm key={editingEvent?.event_id || "new-journal-event"} event={editingEvent} sources={sources} busy={busy} onSave={saveEvent} onCancel={() => setEditingEvent(null)} />
      </div>
    </section>
  </>;
}

function JournalEventCard({ event, onCorrect }: { event: JournalEvent; onCorrect: () => void }) {
  return <article className="journal-event-card"><div className="journal-event-topline"><span className={`journal-time-kind ${event.temporal_kind}`}>{event.temporal_kind === "exact" ? "DATED ACCOUNT" : event.temporal_kind === "range" ? "DATE RANGE" : event.temporal_kind === "relative" ? "APPROXIMATE TIME" : "TIME UNKNOWN"}</span><small>Version {event.version} · recorded at revision {event.created_revision}</small></div>
    <h3>{event.title}</h3><div className="journal-event-time">{formatJournalTime(event)}</div>
    {event.details && <p className="journal-event-details">{event.details}</p>}
    {event.participants.length > 0 && <div className="journal-participants"><span>People mentioned</span>{event.participants.map((person) => <small key={person}>{person}</small>)}</div>}
    {(event.source_name || event.source_quote) && <div className="journal-event-source"><strong>Source · {event.source_name || "Saved note"}</strong>{event.source_quote && <blockquote>{event.source_quote}</blockquote>}</div>}
    <div className="journal-event-actions"><button className="link-button" onClick={onCorrect}>Correct this account</button>{event.history.length > 0 && <details className="journal-event-history"><summary>{event.history.length} earlier {event.history.length === 1 ? "version" : "versions"}</summary>{event.history.map((version) => <JournalEventHistory key={version.version} version={version} />)}</details>}</div>
  </article>;
}

function JournalEventHistory({ version }: { version: JournalEventVersion }) {
  return <div className="journal-history-version"><div><strong>Version {version.version} · {formatJournalTime(version)}</strong><small>Recorded at revision {version.created_revision} · {new Date(version.created_at).toLocaleString()}</small></div><p>{version.title}</p>{version.details && <p>{version.details}</p>}{version.source_quote && <blockquote>{version.source_quote}</blockquote>}</div>;
}

function JournalEventForm({ event, sources, busy, onSave, onCancel }: {
  event: JournalEvent | null;
  sources: Source[];
  busy: boolean;
  onSave: (command: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [temporalKind, setTemporalKind] = useState<JournalEvent["temporal_kind"]>(event?.temporal_kind || "unknown");

  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const form = formEvent.currentTarget;
    const values = new FormData(form);
    const sourceId = String(values.get("source_id") || "");
    const sourceQuote = String(values.get("source_quote") || "").trim();
    const payload: Record<string, unknown> = {
      title: values.get("title"),
      details: values.get("details"),
      participants: String(values.get("participants") || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
      temporal_kind: temporalKind,
      occurred_from: String(values.get("occurred_from") || "") || null,
      occurred_to: String(values.get("occurred_to") || "") || null,
      time_note: String(values.get("time_note") || ""),
      source_id: sourceId || null,
      source_quote: sourceQuote || null,
    };
    const command = event ? "revise_journal_event" : "create_journal_event";
    if (event) {
      payload.event_id = event.event_id;
      payload.expected_event_version = event.version;
    }
    await onSave(command, payload, event ? `Correct journal event ${event.event_id}` : "Record a personal journal event", event ? "Saved a new version; the earlier account remains in its history." : "Recorded this account on the selected branch.");
    if (!event) {
      form.reset();
      setTemporalKind("unknown");
    }
  }

  return <section className="journal-event-form"><div className="journal-form-heading"><div><h3>{event ? "Correct an account" : "Record an event"}</h3><p>{event ? `This creates version ${event.version + 1}; the previous wording stays available.` : "This records your account, not an independently verified fact."}</p></div>{event && <button type="button" className="link-button" onClick={onCancel}>Cancel</button>}</div>
    <form onSubmit={(formEvent) => void submit(formEvent)}>
      <label className="field-label">What happened?<input name="title" required maxLength={200} defaultValue={event?.title || ""} placeholder="A short description" /></label>
      <label className="field-label">More detail<textarea name="details" rows={3} maxLength={4000} defaultValue={event?.details || ""} placeholder="Add context without filling in details you are unsure about." /></label>
      <label className="field-label">People mentioned<input name="participants" maxLength={1000} defaultValue={event?.participants.join(", ") || ""} placeholder="Separate names with commas" /></label>
      <label className="field-label">How certain is the timing?<select name="temporal_kind" value={temporalKind} onChange={(inputEvent) => setTemporalKind(inputEvent.target.value as JournalEvent["temporal_kind"])}><option value="exact">I know the date</option><option value="range">It was within a date range</option><option value="relative">I know it approximately or by context</option><option value="unknown">I do not know the timing</option></select></label>
      {temporalKind === "exact" && <label className="field-label">Date<input name="occurred_from" type="date" required defaultValue={event?.occurred_from || ""} /></label>}
      {temporalKind === "range" && <div className="journal-date-range"><label className="field-label">From<input name="occurred_from" type="date" required defaultValue={event?.occurred_from || ""} /></label><label className="field-label">Through<input name="occurred_to" type="date" required defaultValue={event?.occurred_to || ""} /></label></div>}
      {(temporalKind === "relative" || temporalKind === "unknown") && <label className="field-label">Timing note<input name="time_note" required={temporalKind === "relative"} maxLength={300} defaultValue={event?.time_note || ""} placeholder={temporalKind === "relative" ? "e.g. the winter after university" : "Optional note about what is unknown"} /></label>}
      <label className="field-label">Saved source (optional)<select name="source_id" defaultValue={event?.source_id || ""}><option value="">No source attached · personal account</option>{sources.map((source) => <option key={source.source_id} value={source.source_id}>{source.display_name}</option>)}</select></label>
      <label className="field-label">Exact quote from the source (optional)<textarea name="source_quote" rows={2} defaultValue={event?.source_quote || ""} placeholder="This wording must match the saved note." /></label>
      <button className="primary-button full-button" disabled={busy || !sources.length && Boolean(event?.source_id)}>{event ? "Save correction" : "Add to memory timeline"} <span>↗</span></button>
    </form>
  </section>;
}

function formatJournalTime(event: Pick<JournalEventVersion, "temporal_kind" | "occurred_from" | "occurred_to" | "time_note">) {
  const displayDate = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  if (event.temporal_kind === "exact" && event.occurred_from) return displayDate(event.occurred_from);
  if (event.temporal_kind === "range" && event.occurred_from && event.occurred_to) return `${displayDate(event.occurred_from)} – ${displayDate(event.occurred_to)}`;
  if (event.temporal_kind === "relative") return event.time_note;
  return event.time_note ? `Date not known · ${event.time_note}` : "Date not known";
}

function ScenarioPage({ workspaceId, branchId, branches, revision, entities, relations, claims, sources, busy, onBranch, onPromote, onCommit, onReviewRule, onReviewAssumption }: {
  workspaceId: string;
  branchId: string;
  branches: Branch[];
  revision: number;
  entities: Entity[];
  relations: Relation[];
  claims: Claim[];
  sources: Source[];
  busy: boolean;
  onBranch: () => void;
  onPromote: (sourceBranchId: string, sourceRevision: number, targetBranchId: string, targetRevision: number) => Promise<void>;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
  onReviewRule: (id: string, status: "accepted" | "rejected") => Promise<void>;
  onReviewAssumption: (scenarioId: string, optionId: string, assumptionId: string, version: number, status: "accepted" | "rejected") => Promise<void>;
}) {
  const branch = branches.find((item) => item.branch_id === branchId);
  const parentBranchId = branch?.parent_branch_id || "";
  const parentBranch = branches.find((item) => item.branch_id === parentBranchId);
  const parentSnapshotCurrent = Boolean(parentBranch && branch?.parent_revision !== null && branch?.parent_revision !== undefined && parentBranch.head_revision === branch.parent_revision);
  const parentHasAdvanced = Boolean(parentBranch && !parentSnapshotCurrent);
  const [baseline, setBaseline] = useState<{ entities: Entity[]; relations: Relation[]; claims: Claim[] } | null>(null);
  const [baselineError, setBaselineError] = useState("");
  const [branchRevisions, setBranchRevisions] = useState<Revision[]>([]);
  const [branchRevisionsLoading, setBranchRevisionsLoading] = useState(false);
  const [branchRevisionsError, setBranchRevisionsError] = useState("");
  const [promotionReviewed, setPromotionReviewed] = useState(false);
  const [ruleEvaluations, setRuleEvaluations] = useState<RuleEvaluation[]>([]);
  const [ruleError, setRuleError] = useState("");
  const [rulesLoading, setRulesLoading] = useState(true);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const [scenariosLoading, setScenariosLoading] = useState(true);
  const [scenarioError, setScenarioError] = useState("");

  useEffect(() => {
    let active = true;
    if (!workspaceId) {
      setScenarios([]);
      setScenariosLoading(false);
      return () => { active = false; };
    }
    setScenariosLoading(true);
    setScenarioError("");
    request<Scenario[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/scenarios?branch_id=${encodeURIComponent(branchId)}`)
      .then((rows) => { if (active) setScenarios(rows); })
      .catch((reason) => { if (active) setScenarioError(reason instanceof Error ? reason.message : "Scenarios could not be loaded."); })
      .finally(() => { if (active) setScenariosLoading(false); });
    return () => { active = false; };
  }, [workspaceId, branchId, revision]);

  useEffect(() => {
    if (!scenarios.some((scenario) => scenario.scenario_id === selectedScenarioId)) {
      setSelectedScenarioId(scenarios[0]?.scenario_id || "");
    }
  }, [scenarios, selectedScenarioId]);

  useEffect(() => {
    let active = true;
    setRulesLoading(true);
    setRuleError("");
    request<RuleEvaluation[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/rules/evaluations?branch_id=${encodeURIComponent(branchId)}`)
      .then((rows) => { if (active) setRuleEvaluations(rows); })
      .catch((reason) => { if (active) setRuleError(reason instanceof Error ? reason.message : "Rule checks could not be loaded."); })
      .finally(() => { if (active) setRulesLoading(false); });
    return () => { active = false; };
  }, [workspaceId, branchId, revision]);

  useEffect(() => {
    if (!parentBranchId) {
      setBaseline(null);
      setBaselineError("");
      return;
    }
    let active = true;
    setBaseline(null);
    setBaselineError("");
    const parent = `branch_id=${encodeURIComponent(parentBranchId)}`;
    void Promise.all([
      request<Entity[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/entities?${parent}`),
      request<Relation[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/relations?${parent}`),
      request<Claim[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/claims?${parent}`),
    ]).then(([parentEntities, parentRelations, parentClaims]) => {
      if (active) setBaseline({ entities: parentEntities, relations: parentRelations, claims: parentClaims });
    }).catch((reason) => {
      if (active) setBaselineError(reason instanceof Error ? reason.message : "The parent snapshot could not be loaded.");
    });
    return () => { active = false; };
  }, [workspaceId, parentBranchId]);

  useEffect(() => {
    let active = true;
    if (!workspaceId || !parentBranchId) {
      setBranchRevisions([]);
      setBranchRevisionsError("");
      setBranchRevisionsLoading(false);
      return () => { active = false; };
    }
    setBranchRevisions([]);
    setBranchRevisionsLoading(true);
    setBranchRevisionsError("");
    request<Revision[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/revisions?branch_id=${encodeURIComponent(branchId)}`)
      .then((rows) => { if (active) setBranchRevisions(rows); })
      .catch((reason) => { if (active) setBranchRevisionsError(reason instanceof Error ? reason.message : "Branch history could not be loaded."); })
      .finally(() => { if (active) setBranchRevisionsLoading(false); });
    return () => { active = false; };
  }, [workspaceId, branchId, parentBranchId, revision]);

  useEffect(() => { setPromotionReviewed(false); }, [branchId, revision]);

  const entityIds = new Set((baseline?.entities || []).map((item) => item.entity_id));
  const entityById = new Map((baseline?.entities || []).map((item) => [item.entity_id, item]));
  const relationById = new Map((baseline?.relations || []).map((item) => [item.relation_id, item]));
  const claimById = new Map((baseline?.claims || []).map((item) => [item.claim_id, item]));
  const addedEntities = baseline ? entities.filter((item) => !entityIds.has(item.entity_id)) : [];
  const changedEntities = baseline ? entities.filter((item) => {
    const previous = entityById.get(item.entity_id);
    return previous && JSON.stringify([previous.entity_type, previous.label, previous.properties]) !== JSON.stringify([item.entity_type, item.label, item.properties]);
  }) : [];
  const addedRelations = baseline ? relations.filter((item) => !relationById.has(item.relation_id)) : [];
  const changedRelations = baseline ? relations.filter((item) => {
    const previous = relationById.get(item.relation_id);
    return previous && JSON.stringify([previous.source_entity_id, previous.target_entity_id, previous.relation_type, previous.properties, previous.review_status]) !== JSON.stringify([item.source_entity_id, item.target_entity_id, item.relation_type, item.properties, item.review_status]);
  }) : [];
  const addedClaims = baseline ? claims.filter((item) => !claimById.has(item.claim_id)) : [];
  const changedClaims = baseline ? claims.filter((item) => {
    const previous = claimById.get(item.claim_id);
    return previous && JSON.stringify([previous.subject_entity_id, previous.predicate, previous.object_value, previous.epistemic_status, previous.review_status, previous.visibility, previous.narrative_order, previous.evidence]) !== JSON.stringify([item.subject_entity_id, item.predicate, item.object_value, item.epistemic_status, item.review_status, item.visibility, item.narrative_order, item.evidence]);
  }) : [];
  const relationLabel = (relation: Relation) => {
    const source = entities.find((item) => item.entity_id === relation.source_entity_id)?.label || relation.source_entity_id;
    const target = entities.find((item) => item.entity_id === relation.target_entity_id)?.label || relation.target_entity_id;
    return `${source} · ${relation.relation_type} · ${target}`;
  };
  const claimLabel = (claim: Claim) => {
    const subject = entities.find((item) => item.entity_id === claim.subject_entity_id)?.label || claim.subject_entity_id;
    return `${subject} · ${claim.predicate} · ${claim.object_value}`;
  };
  const differenceCount = addedEntities.length + changedEntities.length + addedRelations.length + changedRelations.length + addedClaims.length + changedClaims.length;
  const branchChanges = branchRevisions.filter((item) => item.revision > (branch?.base_revision ?? 0));
  const canPromote = Boolean(
    branch && parentBranch && parentSnapshotCurrent && branch.head_revision === revision && revision > branch.base_revision && branchChanges.length > 0 &&
    !branchRevisionsLoading && !branchRevisionsError && !busy,
  );

  async function confirmPromotion() {
    if (!branch || !parentBranch || !canPromote) return;
    const confirmed = window.confirm(
      `Promote revisions ${branch.base_revision + 1}–${revision} from ${branch.branch_id} into ${parentBranch.branch_id}? This writes one audited revision on the parent. The scenario assumptions remain assumptions.`
    );
    if (!confirmed) return;
    try {
      await onPromote(branch.branch_id, revision, parentBranch.branch_id, parentBranch.head_revision);
    } catch {
      // The parent view reports command errors through the workspace notice.
    }
  }

  return <>
    <PageHeader kicker="Alternate futures" title="Decision & Scenario Lab" summary="Explore changes on a branch that keeps its starting point and never silently alters the main world." action={<button className="primary-button" onClick={() => void onBranch()}>Create scenario branch <span>↗</span></button>} />
    <div className="scenario-banner"><div className="branch-symbol">◇</div><div><strong>{branchId === "main" ? "You’re viewing the main branch" : `Exploring ${branchId}`}</strong><p>{branchId === "main" ? "Create a snapshot before changing assumptions or exploring an alternate event." : "Changes in this branch stay isolated from its parent."}</p></div><span className="revision-chip">Revision {revision}</span></div>
    <div className="scenario-grid">
      <section className="panel">
        <div className="panel-heading"><div><h2>Current structure</h2><p>Knowledge carried into this branch</p></div></div>
        <div className="scenario-stats"><div><strong>{entities.length}</strong><small>concepts</small></div><div><strong>{relations.length}</strong><small>relationships</small></div><div><strong>{claims.length}</strong><small>claims</small></div></div>
        <div className="branch-note">Branch writes use the same revision checks and audit trail as the main workspace.</div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Branch differences</h2><p>{parentBranchId ? `Compared with the current ${parentBranchId} state; this branch started at revision ${branch?.parent_revision ?? branch?.base_revision ?? 0}.` : "The main branch is the starting point for scenarios."}</p></div>{parentBranchId && <span className="panel-count">{baseline ? `${differenceCount} changes` : "Comparing…"}</span>}</div>
        {!parentBranchId
          ? <p className="empty-hint">Choose a scenario branch from the top menu, or create one from this starting point.</p>
          : baselineError
            ? <p className="inline-error">{baselineError}</p>
            : !baseline
              ? <p className="empty-hint">Loading the parent branch records…</p>
              : <>
                {parentHasAdvanced && <p className="branch-stale-note">The parent no longer matches revision {branch?.parent_revision}. This comparison uses its current state; the command history below shows child-only changes. Rebase is unavailable, so create a fresh branch from the current parent and reapply the changes you want.</p>}
                {differenceCount === 0
                  ? <p className="empty-hint">No record differences from the current parent state.</p>
                  : <div className="branch-differences">
                  {addedEntities.map((item) => <div className="branch-difference" key={`entity-${item.entity_id}`}><span>New concept</span><strong>{item.label}</strong><small>{item.entity_type}</small><details><summary>Inspect record</summary><pre>{JSON.stringify(item, null, 2)}</pre></details></div>)}
                  {changedEntities.map((item) => <div className="branch-difference" key={`entity-change-${item.entity_id}`}><span>Concept changed</span><strong>{item.label}</strong><details><summary>Before and after</summary><pre>{JSON.stringify({ before: entityById.get(item.entity_id), after: item }, null, 2)}</pre></details></div>)}
                  {addedRelations.map((item) => <div className="branch-difference" key={`relation-${item.relation_id}`}><span>New relationship · {item.review_status}</span><strong>{relationLabel(item)}</strong><details><summary>Inspect record</summary><pre>{JSON.stringify(item, null, 2)}</pre></details></div>)}
                  {changedRelations.map((item) => <div className="branch-difference" key={`relation-change-${item.relation_id}`}><span>Relationship changed</span><strong>{relationLabel(item)}</strong><details><summary>Before and after</summary><pre>{JSON.stringify({ before: relationById.get(item.relation_id), after: item }, null, 2)}</pre></details></div>)}
                  {addedClaims.map((item) => <div className="branch-difference" key={`claim-${item.claim_id}`}><span>New claim · {item.review_status}</span><strong>{claimLabel(item)}</strong><details><summary>Inspect record</summary><pre>{JSON.stringify(item, null, 2)}</pre></details></div>)}
                  {changedClaims.map((item) => <div className="branch-difference" key={`claim-change-${item.claim_id}`}><span>Claim changed</span><strong>{claimLabel(item)}</strong><details><summary>Before and after</summary><pre>{JSON.stringify({ before: claimById.get(item.claim_id), after: item }, null, 2)}</pre></details></div>)}
                  </div>}
              </>}
        <div className="branch-note">Scenario assumptions remain separate from canonical facts, including after a branch promotion.</div>
      </section>
    </div>
    {parentBranchId && <section className="panel branch-review-panel">
      <div className="panel-heading"><div><h2>Review branch changes</h2><p>Every command after the branch’s starting revision is available with its full payload, including story text, journal entries, evidence, and scenario assumptions.</p></div>
        <div className="branch-review-actions"><span className="panel-count">{branchRevisionsLoading ? "Loading history…" : `${branchChanges.length} branch changes`}</span>
          <button className="primary-button" disabled={!canPromote || !promotionReviewed} title={parentHasAdvanced ? "The parent must still be at the branch starting revision." : branchRevisionsError || undefined} onClick={() => void confirmPromotion()}>Promote to {parentBranchId} <span>↗</span></button>
        </div>
      </div>
      {branchRevisionsError ? <p className="inline-error" role="alert">{branchRevisionsError}</p>
        : branchRevisionsLoading ? <p className="empty-hint" role="status">Loading the complete branch command history…</p>
          : !branchChanges.length ? <p className="empty-hint">No branch changes are available to promote yet.</p>
            : <ol className="branch-review-list">{[...branchChanges].reverse().map((item) => <li key={item.revision}>
              <details><summary><span>Revision {item.revision}</span><strong>{item.reason}</strong><small>{item.actor} · follows {item.parent_revision ?? "none"} · {new Date(item.created_at).toLocaleString()}</small></summary>
                <pre>{JSON.stringify({ request: item.payload, result: item.result }, null, 2)}</pre>
              </details>
            </li>)}</ol>}
      {branchChanges.length > 0 && !branchRevisionsError && <label className="branch-review-check"><input type="checkbox" checked={promotionReviewed} disabled={!canPromote} onChange={(event) => setPromotionReviewed(event.target.checked)} /><span>I reviewed these branch changes and want to promote them into {parentBranchId}.</span></label>}
      {!parentSnapshotCurrent && <p className="branch-stale-note">Promotion requires {parentBranchId} to remain at revision {branch?.parent_revision ?? "the branch starting point"}. If it has changed, create a fresh branch and reapply the changes; automatic conflict merging is unavailable.</p>}
    </section>}
    <section className="panel scenario-create-panel"><div className="panel-heading"><div><h2>Frame a decision</h2><p>Record the problem, constraints, options, and evidence before comparing outcomes.</p></div><span className="panel-count">Scenario input</span></div>
      <ScenarioCreateForm claims={claims} entities={entities} sources={sources} busy={busy} onCommit={onCommit} onCreated={setSelectedScenarioId} />
    </section>
    <section className="panel scenario-options-panel"><div className="panel-heading"><div><h2>Conditional comparison</h2><p>Rule results are deterministic checks; model-generated advice is not included here.</p></div>
      {scenarios.length > 0 && <label className="scenario-select-label">Scenario<select value={selectedScenarioId} onChange={(event) => setSelectedScenarioId(event.target.value)}>{scenarios.map((scenario) => <option key={scenario.scenario_id} value={scenario.scenario_id}>{scenario.title}</option>)}</select></label>}
    </div>
      {scenarioError && <p className="inline-error" role="alert">{scenarioError}</p>}
      {scenariosLoading ? <p className="empty-hint" role="status">Loading decision scenarios…</p>
        : !scenarios.length ? <p className="empty-hint">Add a decision above to compare its options on this branch.</p>
          : scenarios.find((scenario) => scenario.scenario_id === selectedScenarioId) && <ScenarioDetails
            scenario={scenarios.find((scenario) => scenario.scenario_id === selectedScenarioId)!}
            entities={entities} claims={claims} busy={busy} onCommit={onCommit}
            onReviewAssumption={onReviewAssumption}
          />}
    </section>
    <section className="panel scenario-rule-panel"><div className="panel-heading"><div><h2>Rule checks</h2><p>Test reviewed constraints against known claims in this branch.</p></div><span className="panel-count">{ruleEvaluations.filter((item) => item.rule.review_status === "accepted" && item.evaluation.status === "violated").length} violated</span></div>
      <div className="scenario-rule-layout"><ScenarioRuleForm entities={entities} busy={busy} onCommit={onCommit} /><div className="scenario-rule-results">
        {ruleError && <p className="inline-error" role="alert">{ruleError}</p>}
        {rulesLoading ? <p className="empty-hint" role="status">Checking branch rules…</p>
          : ruleEvaluations.length ? ruleEvaluations.map((item) => <ScenarioRuleResult key={item.rule.rule_id} item={item} claims={claims} busy={busy} onReview={onReviewRule} />)
            : !ruleError && <p className="empty-hint">No rules are recorded on this branch. Add a rule to check a required or forbidden fact.</p>}
      </div></div>
      <div className="branch-note">Only accepted rules and accepted claims marked as known can produce a definite baseline result. Accepted option assumptions can produce conditional results; missing, unreviewed, or uncertain information stays unknown.</div>
    </section>
  </>;
}

function ScenarioCreateForm({ claims, entities, sources, busy, onCommit, onCreated }: {
  claims: Claim[];
  entities: Entity[];
  sources: Source[];
  busy: boolean;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
  onCreated: (scenarioId: string) => void;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const options = ["a", "b", "c"].map((key) => ({
      option_id: `option_${crypto.randomUUID().slice(0, 10)}`,
      label: String(data.get(`option_${key}_label`) || "").trim(),
      description: String(data.get(`option_${key}_description`) || "").trim(),
    })).filter((option) => option.label);
    if (options.length < 2 || options.length > 3) {
      return;
    }
    const scenarioId = `scenario_${crypto.randomUUID().slice(0, 12)}`;
    try {
      await onCommit("create_scenario", {
        scenario_id: scenarioId,
        title: data.get("title"),
        problem: data.get("problem"),
        constraints: String(data.get("constraints") || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        options,
        evidence_claim_ids: data.getAll("evidence_claim_ids").map(String),
        evidence_source_ids: data.getAll("evidence_source_ids").map(String),
      }, "Create a decision scenario", "Decision scenario saved on this branch.");
      form.reset();
      onCreated(scenarioId);
    } catch { /* The workspace notice reports why the scenario was not saved. */ }
  }

  return <form className="scenario-create-form" onSubmit={(event) => void submit(event)}>
    <div className="scenario-create-basics">
      <label className="field-label">Decision title<input name="title" required maxLength={200} placeholder="e.g. How should we fund the archive?" /></label>
      <label className="field-label">Problem<textarea name="problem" rows={2} required maxLength={4000} placeholder="Describe the decision and what needs to be resolved." /></label>
      <label className="field-label">Constraints<textarea name="constraints" rows={2} maxLength={3000} placeholder="One constraint per line (optional)" /></label>
    </div>
    <div className="scenario-create-options">
      {["a", "b", "c"].map((key, index) => <div className="scenario-option-input" key={key}>
        <span>Option {String.fromCharCode(65 + index)}{index < 2 ? " · required" : " · optional"}</span>
        <input name={`option_${key}_label`} maxLength={200} required={index < 2} placeholder={index === 0 ? "Proceed" : index === 1 ? "Wait" : "A third option"} />
        <textarea name={`option_${key}_description`} rows={2} maxLength={1000} placeholder="What this option involves" />
      </div>)}
    </div>
    <div className="scenario-evidence-pickers">
      <details><summary>Link related claims ({claims.length})</summary>
        <div className="scenario-evidence-list">{claims.length ? claims.map((claim) => <label key={claim.claim_id}><input type="checkbox" name="evidence_claim_ids" value={claim.claim_id} /><span>{entities.find((entity) => entity.entity_id === claim.subject_entity_id)?.label || claim.subject_entity_id} · {claim.predicate} · {claim.object_value}<small>{claim.review_status} · {claim.epistemic_status}</small></span></label>) : <small>No claims are recorded on this branch.</small>}</div>
      </details>
      <details><summary>Link sources ({sources.length})</summary>
        <div className="scenario-evidence-list">{sources.length ? sources.map((source) => <label key={source.source_id}><input type="checkbox" name="evidence_source_ids" value={source.source_id} /><span>{source.display_name}<small>{source.media_type}</small></span></label>) : <small>No sources are available in this workspace.</small>}</div>
      </details>
      <button className="primary-button" type="submit" disabled={busy}>Save decision frame <span>↗</span></button>
    </div>
  </form>;
}

function ScenarioDetails({ scenario, entities, claims, busy, onCommit, onReviewAssumption }: {
  scenario: Scenario;
  entities: Entity[];
  claims: Claim[];
  busy: boolean;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
  onReviewAssumption: (scenarioId: string, optionId: string, assumptionId: string, version: number, status: "accepted" | "rejected") => Promise<void>;
}) {
  return <>
    <div className="scenario-brief">
      <div><span className="scenario-section-label">DECISION</span><p>{scenario.problem}</p></div>
      <div><span className="scenario-section-label">CONSTRAINTS</span>{scenario.constraints.length
        ? <ul>{scenario.constraints.map((constraint, index) => <li key={`${index}-${constraint}`}>{constraint}</li>)}</ul>
        : <p className="empty-hint">No constraints recorded.</p>}</div>
      <div><span className="scenario-section-label">RELATED EVIDENCE</span><div className="scenario-evidence-summary">
        {scenario.evidence_claims.map((claim) => <span key={claim.claim_id}>{claim.subject_label} · {claim.predicate} · {claim.object_value}</span>)}
        {scenario.evidence_sources.map((source) => <span key={source.source_id}>{source.display_name}</span>)}
        {!scenario.evidence_claims.length && !scenario.evidence_sources.length && <small>No evidence is linked yet.</small>}
      </div></div>
    </div>
    <div className="scenario-option-grid">{scenario.options.map((option) => <ScenarioOptionCard
      key={option.option_id} scenarioId={scenario.scenario_id} option={option} entities={entities}
      claims={claims} busy={busy} onCommit={onCommit} onReviewAssumption={onReviewAssumption}
    />)}</div>
  </>;
}

function ScenarioOptionCard({ scenarioId, option, entities, claims, busy, onCommit, onReviewAssumption }: {
  scenarioId: string;
  option: ScenarioOption;
  entities: Entity[];
  claims: Claim[];
  busy: boolean;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
  onReviewAssumption: (scenarioId: string, optionId: string, assumptionId: string, version: number, status: "accepted" | "rejected") => Promise<void>;
}) {
  const [editingAssumption, setEditingAssumption] = useState<ScenarioAssumption | null>(null);
  const acceptedRules = option.rule_evaluations.filter((item) => item.rule.review_status === "accepted");
  const pendingRuleCount = option.rule_evaluations.filter((item) => item.rule.review_status === "proposed").length;
  const violatedHardRules = acceptedRules.filter((item) => item.rule.severity === "hard" && item.evaluation.status === "violated").length;
  return <article className="scenario-option-card">
    <div className="scenario-option-heading"><div><span className="scenario-section-label">OPTION</span><h3>{option.label}</h3></div><span className="scenario-option-summary">{violatedHardRules ? `${violatedHardRules} hard constraint${violatedHardRules === 1 ? "" : "s"} violated` : "No known hard violations"}</span></div>
    {option.description && <p className="scenario-option-description">{option.description}</p>}
    <div className="scenario-option-assumptions"><div className="scenario-subheading"><h4>Assumptions</h4><span>{option.assumptions.length}</span></div>
      {option.assumptions.length ? option.assumptions.map((assumption) => {
        const history = option.assumption_history.filter((item) => item.assumption_id === assumption.assumption_id);
        return <article className={`scenario-assumption ${assumption.review_status}`} key={assumption.assumption_id}>
          <div className="scenario-assumption-heading"><strong>{assumption.subject_label} · {assumption.predicate} · {assumption.object_value}</strong><span>{assumption.review_status} · v{assumption.version}</span></div>
          <small>{assumption.assumption_action === "replace" ? "Replace a single-valued baseline property" : "Add a value to a multi-valued property"}</small>
          {assumption.review_status === "proposed" && <div className="scenario-rule-actions">
            <button onClick={() => void onReviewAssumption(scenarioId, option.option_id, assumption.assumption_id, assumption.version, "rejected")} disabled={busy}>Reject</button>
            <button className="accept-button" onClick={() => void onReviewAssumption(scenarioId, option.option_id, assumption.assumption_id, assumption.version, "accepted")} disabled={busy}>Accept assumption</button>
          </div>}
          <button className="quiet-button scenario-edit-trigger" onClick={() => setEditingAssumption(assumption)}>Revise this assumption</button>
          {history.length > 1 && <details className="scenario-assumption-history"><summary>Earlier versions ({history.length - 1})</summary>{history.slice(0, -1).map((version) => <p key={version.version}>v{version.version} · {version.object_value} · {version.review_status}</p>)}</details>}
        </article>;
      }) : <p className="empty-hint">No assumptions have been added to this option.</p>}
      <ScenarioAssumptionForm scenarioId={scenarioId} option={option} entities={entities} busy={busy} onCommit={onCommit}
        editing={editingAssumption} onCancel={() => setEditingAssumption(null)} />
    </div>
    <div className="scenario-option-outcomes"><div className="scenario-subheading"><h4>Rule outcomes</h4><span>{pendingRuleCount ? `${pendingRuleCount} rule${pendingRuleCount === 1 ? "" : "s"} awaiting review` : "deterministic"}</span></div>
      {acceptedRules.length ? acceptedRules.map((item) => <ScenarioOptionRuleResult key={item.rule.rule_id} item={item} option={option} claims={claims} />)
        : <p className="empty-hint">Accept a rule below to see its outcome for this option.</p>}
    </div>
  </article>;
}

function ScenarioAssumptionForm({ scenarioId, option, entities, busy, onCommit, editing, onCancel }: {
  scenarioId: string;
  option: ScenarioOption;
  entities: Entity[];
  busy: boolean;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
  editing: ScenarioAssumption | null;
  onCancel: () => void;
}) {
  const currentEditing = editing;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const action = String(data.get("assumption_action")) as "add" | "replace";
    try {
      await onCommit("set_scenario_assumption", {
        scenario_id: scenarioId,
        option_id: option.option_id,
        assumption_id: currentEditing?.assumption_id || `assumption_${crypto.randomUUID().slice(0, 12)}`,
        ...(currentEditing ? { expected_version: currentEditing.version } : {}),
        subject_entity_id: data.get("subject_entity_id"),
        predicate: data.get("predicate"),
        object_value: data.get("object_value"),
        assumption_action: action,
        predicate_cardinality: action === "replace" ? "single" : "multiple",
      }, currentEditing ? "Revise a scenario assumption" : "Add a scenario assumption", currentEditing ? "A new assumption version was saved." : "Assumption saved for this option.");
      form.reset();
      if (currentEditing) onCancel();
    } catch { /* The workspace notice reports why the assumption was not saved. */ }
  }

  return <form className="scenario-assumption-form" key={`${currentEditing?.assumption_id || "new"}-${currentEditing?.version || 0}`} onSubmit={(event) => void submit(event)}>
    {currentEditing && <div className="scenario-editing-note">Revising assumption v{currentEditing.version}<button type="button" onClick={onCancel}>Cancel</button></div>}
    <label className="field-label">Concept<select name="subject_entity_id" required defaultValue={currentEditing?.subject_entity_id || entities[0]?.entity_id || ""}>{entities.map((entity) => <option key={entity.entity_id} value={entity.entity_id}>{entity.label}</option>)}</select></label>
    <div className="scenario-assumption-fields"><label className="field-label">Property<input name="predicate" required maxLength={200} defaultValue={currentEditing?.predicate} placeholder="e.g. funding status" /></label><label className="field-label">Assumed value<input name="object_value" required maxLength={4000} defaultValue={currentEditing?.object_value} placeholder="e.g. paused" /></label></div>
    <label className="field-label">How it changes the scenario<select name="assumption_action" defaultValue={currentEditing?.assumption_action || "replace"}><option value="replace">Replace one known value (single-valued)</option><option value="add">Add another value (multi-valued)</option></select></label>
    <button className="quiet-button scenario-assumption-save" disabled={busy || entities.length === 0}>{currentEditing ? "Save revised assumption" : "Add assumption"}</button>
  </form>;
}

function ScenarioOptionRuleResult({ item, option, claims }: { item: RuleEvaluation; option: ScenarioOption; claims: Claim[] }) {
  const { rule, evaluation } = item;
  const evidenceClaims = evaluation.evidence_claim_ids.map((id) => claims.find((claim) => claim.claim_id === id)).filter((claim): claim is Claim => Boolean(claim));
  const assumedValues = evaluation.assumption_ids.map((id) => option.assumptions.find((assumption) => assumption.assumption_id === id)).filter((assumption): assumption is ScenarioAssumption => Boolean(assumption));
  return <article className={`scenario-outcome ${evaluation.status}`}>
    <div className="scenario-outcome-heading"><strong>{rule.name}</strong><span className={`rule-state ${evaluation.status}`}>{evaluation.status}</span><small>{evaluation.conditional ? "conditional" : "baseline"}</small></div>
    <p>{evaluation.explanation}</p>
    {evidenceClaims.length > 0 && <small>Claims: {evidenceClaims.map((claim) => `${claim.predicate} · ${claim.object_value}`).join("; ")}</small>}
    {assumedValues.length > 0 && <small>Assumptions: {assumedValues.map((assumption) => `${assumption.predicate} · ${assumption.object_value}`).join("; ")}</small>}
  </article>;
}

function ScenarioRuleForm({ entities, busy, onCommit }: {
  entities: Entity[];
  busy: boolean;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string, successText: string) => Promise<void>;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await onCommit("create_rule", {
        name: data.get("name"),
        description: data.get("description"),
        rule_mode: data.get("rule_mode"),
        severity: data.get("severity"),
        subject_entity_id: data.get("subject_entity_id"),
        predicate: data.get("predicate"),
        object_value: data.get("object_value"),
        predicate_cardinality: data.get("predicate_cardinality"),
        review_status: "proposed",
      }, "Add a proposed branch rule", "Rule saved for review. It will be evaluated after you accept it.");
      form.reset();
    } catch { /* The workspace notice reports why the rule was not saved. */ }
  }

  return <section className="scenario-rule-form"><div className="scenario-rule-form-heading"><h3>Add a rule</h3><p>New rules wait for your review.</p></div>
    <form onSubmit={(event) => void submit(event)}>
      <label className="field-label">Rule name<input name="name" required maxLength={200} placeholder="e.g. Keep the archive intact" /></label>
      <label className="field-label">Applies to<select name="subject_entity_id" required defaultValue={entities[0]?.entity_id || ""}>{entities.map((entity) => <option key={entity.entity_id} value={entity.entity_id}>{entity.label}</option>)}</select></label>
      <div className="scenario-rule-condition"><label className="field-label">Property<input name="predicate" required maxLength={200} placeholder="e.g. archive status" /></label><label className="field-label">Value<input name="object_value" required maxLength={4000} placeholder="e.g. preserved" /></label></div>
      <label className="field-label">Constraint<select name="rule_mode"><option value="require">This value must be known</option><option value="forbid">This value must not be known</option></select></label>
      <label className="field-label">Priority<select name="severity"><option value="hard">Hard constraint</option><option value="soft">Soft preference</option></select></label>
      <label className="field-label">Property meaning<select name="predicate_cardinality"><option value="multiple">Can hold several values</option><option value="single">Can hold only one value</option></select></label>
      <label className="field-label">Why this rule matters (optional)<textarea name="description" rows={2} maxLength={1000} placeholder="A short explanation" /></label>
      <button className="primary-button full-button" disabled={busy || entities.length === 0}>Save rule for review <span>↗</span></button>
    </form>
    {entities.length === 0 && <small className="field-note">Add a concept on this branch before creating a rule.</small>}
  </section>;
}

function ScenarioRuleResult({ item, claims, busy, onReview }: {
  item: RuleEvaluation;
  claims: Claim[];
  busy: boolean;
  onReview: (id: string, status: "accepted" | "rejected") => Promise<void>;
}) {
  const { rule, evaluation } = item;
  const state = rule.review_status === "proposed" ? "Needs review" : rule.review_status === "rejected" ? "Rejected · inactive" : evaluation.status;
  const evidence = evaluation.evidence_claim_ids.map((id) => claims.find((claim) => claim.claim_id === id)).filter((claim): claim is Claim => Boolean(claim));
  return <article className={`scenario-rule-result ${rule.review_status === "accepted" ? evaluation.status : rule.review_status}`}>
    <div className="scenario-rule-result-top"><div><span className={`rule-severity ${rule.severity}`}>{rule.severity === "hard" ? "HARD" : "SOFT"}</span><h3>{rule.name}</h3></div><span className={`rule-state ${rule.review_status === "accepted" ? evaluation.status : rule.review_status}`}>{state}</span></div>
    <p className="scenario-rule-expression"><strong>{rule.subject_label}</strong> · {rule.predicate} · {rule.object_value}<small>{rule.rule_mode === "require" ? "Required value" : "Forbidden value"} · {rule.predicate_cardinality === "single" ? "single-valued property" : "multi-valued property"}</small></p>
    {rule.description && <p className="scenario-rule-description">{rule.description}</p>}
    <p className="scenario-rule-explanation">{rule.review_status === "rejected" ? "This rule was rejected and is not evaluated." : evaluation.explanation}</p>
    {evidence.length > 0 && <small className="scenario-rule-evidence">Evidence: {evidence.map((claim) => `${claim.predicate} · ${claim.object_value}`).join("; ")}</small>}
    {rule.review_status === "proposed" && <div className="scenario-rule-actions"><button onClick={() => void onReview(rule.rule_id, "rejected")} disabled={busy}>Reject</button><button className="accept-button" onClick={() => void onReview(rule.rule_id, "accepted")} disabled={busy}>Accept rule</button></div>}
  </article>;
}
