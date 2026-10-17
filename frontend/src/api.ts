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
  return runtime;
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

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
