import { invoke } from "@tauri-apps/api/core";

export type Workspace = {
  workspace_id: string;
  name: string;
  created_at: string;
  main_revision: number;
};

export type Entity = {
  entity_id: string;
  entity_type: string;
  label: string;
  properties: Record<string, unknown>;
  created_revision: number;
  updated_revision: number;
};

export type Relation = {
  relation_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  properties: Record<string, unknown>;
  review_status: "proposed" | "accepted" | "rejected";
};

export type Claim = {
  claim_id: string;
  subject_entity_id: string;
  predicate: string;
  object_value: string;
  epistemic_status: string;
  review_status: "proposed" | "accepted" | "rejected";
  visibility: string;
  narrative_order: number;
  evidence: string[];
};
export type RuleEvaluation = {
  rule: {
    rule_id: string;
    name: string;
    description: string;
    rule_mode: "require" | "forbid";
    severity: "hard" | "soft";
    subject_entity_id: string;
    subject_label: string;
    predicate: string;
    object_value: string;
    predicate_cardinality: "single" | "multiple";
    review_status: "proposed" | "accepted" | "rejected";
    created_revision: number;
  };
  evaluation: {
    status: "satisfied" | "violated" | "unknown";
    reason_code: string;
    explanation: string;
    conditional: boolean;
    evidence_claim_ids: string[];
    assumption_ids: string[];
    uncertain_claim_ids: string[];
    unreviewed_claim_ids: string[];
    unreviewed_assumption_ids: string[];
  };
};
export type ScenarioAssumption = {
  scenario_id: string;
  option_id: string;
  assumption_id: string;
  version: number;
  subject_entity_id: string;
  subject_label: string;
  predicate: string;
  object_value: string;
  assumption_action: "add" | "replace";
  predicate_cardinality: "single" | "multiple";
  review_status: "proposed" | "accepted" | "rejected";
  supersedes_version: number | null;
  created_revision: number;
  created_at: string;
};
export type ScenarioOption = {
  scenario_id: string;
  option_id: string;
  label: string;
  description: string;
  position: number;
  created_revision: number;
  assumptions: ScenarioAssumption[];
  assumption_history: ScenarioAssumption[];
  rule_evaluations: RuleEvaluation[];
};
export type Scenario = {
  scenario_id: string;
  title: string;
  problem: string;
  constraints: string[];
  created_revision: number;
  created_at: string;
  evidence_claims: Array<Pick<Claim, "claim_id" | "subject_entity_id" | "predicate" | "object_value" | "epistemic_status" | "review_status" | "visibility"> & { subject_label: string }>;
  evidence_sources: Array<Pick<Source, "source_id" | "display_name" | "media_type">>;
  options: ScenarioOption[];
};

export type Source = { source_id: string; display_name: string; media_type: string; created_at: string };
export type SourceDetails = Source & { content: string };
export type ExtractionCandidate = {
  candidate_id: string;
  kind: "entity" | "claim";
  payload: {
    label?: string;
    entity_type?: string;
    subject_label?: string;
    predicate?: string;
    object_value?: string;
    quote: string;
    source_start: number;
    source_end: number;
  };
  review_status: "proposed" | "accepted" | "rejected";
  canonical_record_type: "entity" | "claim" | null;
  canonical_record_id: string | null;
  created_revision: number;
  reviewed_revision: number | null;
};
export type ExtractionBatch = {
  batch_id: string;
  source_id: string;
  source_name: string;
  source_sha256: string;
  model: string;
  extractor_version: string;
  prompt_version: string;
  output_schema_version: number;
  created_revision: number;
  created_at: string;
  candidates: ExtractionCandidate[];
};
export type JournalEventVersion = {
  event_id: string;
  version: number;
  title: string;
  details: string;
  participants: string[];
  temporal_kind: "exact" | "range" | "relative" | "unknown";
  occurred_from: string | null;
  occurred_to: string | null;
  time_note: string;
  source_id: string | null;
  source_name: string | null;
  source_quote: string | null;
  supersedes_version: number | null;
  created_revision: number;
  created_at: string;
};
export type JournalEvent = JournalEventVersion & { history: JournalEventVersion[] };
export type Branch = { branch_id: string; parent_branch_id: string | null; parent_revision: number | null; base_revision: number; head_revision: number; created_at: string };
export type Revision = { revision: number; parent_revision: number | null; actor: string; reason: string; created_at: string; event_type: string | null; payload: Record<string, unknown>; result: Record<string, unknown> | null };
export type SourceResult = { source_id: string; display_name: string; excerpt: string };
export type StoryTurn = {
  turn_id: string;
  turn_order: number;
  role: "user" | "assistant";
  narrative_order: number;
  content: string;
  provider: "ollama" | null;
  model: string | null;
  context_manifest_id: string | null;
  context_manifest: ContextManifest | null;
  context_revision: number | null;
  created_revision: number;
  created_at: string;
};
export type ContextManifest = {
  protocol: string;
  manifest_id: string;
  workspace_id: string;
  branch_id: string;
  base_revision: number;
  actor: { entity_id: string; label: string; entity_type: string };
  as_of_narrative_order: number;
  included: { claim_id: string; subject: string; predicate: string; object: string; actor_stance: string; evidence_ids: string[] }[];
  excluded: { claim_id: string; reason: string }[];
  token_estimate: number;
};
export type ExternalExchange = {
  exchange_id: string;
  transcript_id: string;
  context_manifest_id: string;
  base_revision: number;
  from_turn: number;
  to_turn: number;
  transcript_total_turns: number;
  transcript_hash: string;
  context_manifest: ContextManifest;
  turns: { turn_number: number; messages: { role: string; content: string }[] }[];
  proposed_change_ids: string[];
  created_revision: number;
  created_at: string;
  stale_context: boolean;
  missing_turns: { from_turn: number; to_turn: number }[];
  current_revision: number;
};
export type StoryConversationSummary = {
  conversation_id: string;
  actor_entity_id: string;
  actor_label: string;
  title: string;
  actor_is_user_controlled: boolean;
  created_revision: number;
  updated_revision: number;
  created_at: string;
  updated_at: string;
  turn_count: number;
};
export type StoryConversation = Omit<StoryConversationSummary, "turn_count"> & { turns: StoryTurn[] };
export type OllamaModelStatus = { available: boolean; models: string[] };
export type StoryGenerationResult = {
  conversation_id: string;
  user_turn_id: string;
  assistant_turn_id: string;
  provider: "ollama";
  model: string;
  context_manifest_id: string;
  context_revision: number;
  revision: number;
  idempotent_replay: boolean;
  conversation: StoryConversation;
};

export type RuntimeConfig = { baseUrl: string; token: string };

let runtime: RuntimeConfig | null = null;

async function resolveRuntime(): Promise<RuntimeConfig> {
  if (runtime) return runtime;
  const tauri = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  if (tauri) {
    runtime = await invoke<RuntimeConfig>("get_api_config");
  } else {
    const baseUrl = import.meta.env.VITE_LKE_API_URL;
    const token = import.meta.env.VITE_LKE_API_TOKEN;
    if (!baseUrl || !token) throw new Error("Start the desktop app, or configure a local API URL and token for development.");
    runtime = { baseUrl, token };
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${runtime.baseUrl}/api/v1/health`);
      if (response.ok) return runtime;
    } catch {
      // The sidecar may need a moment to bind its selected loopback port.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  runtime = null;
  throw new Error("The local LKE service did not start. Restart the app and try again.");
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = await resolveRuntime();
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function downloadBackup(): Promise<Blob> {
  const config = await resolveRuntime();
  const response = await fetch(`${config.baseUrl}/api/v1/backup`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail || `Backup download failed (${response.status})`);
  }
  return response.blob();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
