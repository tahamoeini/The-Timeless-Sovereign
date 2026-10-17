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

export type Source = { source_id: string; display_name: string; media_type: string; created_at: string };
export type Branch = { branch_id: string; parent_branch_id: string | null; head_revision: number };
export type SourceResult = { source_id: string; display_name: string; excerpt: string };

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

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
