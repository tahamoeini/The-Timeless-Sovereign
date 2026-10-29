import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "./api";
import { buildStoryExport } from "./storyExport";
import { Branch, Claim, ContextManifest, downloadBackup, Entity, ExternalExchange, ExtractionBatch, ExtractionCandidate, JournalEvent, JournalEventVersion, newId, OllamaModelStatus, Relation, request, Revision, RuleEvaluation, RpgState, Scenario, ScenarioAssumption, ScenarioOption, Source, SourceDetails, StoryAdventure, StoryConversation, StoryConversationSummary, StoryGenerationResult, StoryMemory, StoryProvider, StoryStudioData, StoryThread, StoryWorld, TemporalQueryResult, Workspace } from "./api";

type Page = "story" | "knowledge" | "journal" | "scenario";
type Notice = { tone: "error" | "success" | "info"; text: string } | null;

const NAV: { id: Page; title: string; icon: string; sub: string }[] = [
  { id: "story", title: "Story Studio", icon: "✳", sub: "Worlds and characters" },
  { id: "knowledge", title: "Knowledge", icon: "⌘", sub: "Sources and relationships" },
  { id: "journal", title: "Journal", icon: "▤", sub: "Notes and memories" },
  { id: "scenario", title: "Scenarios", icon: "◇", sub: "Explore what-if branches" },
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
      setNotice({ tone: "success", text: commandType === "create_conversation" ? "Story started on this branch." : commandType === "add_belief" ? "Character knowledge saved to this branch." : "RPG state saved." });
      return result;
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The change could not be saved." });
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
      link.download = `lke-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.lkebackup`;
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
      setNotice({ tone: "error", text: "Choose an LKE .lkebackup file." });
      input.value = "";
      return;
    }
    const confirmed = window.confirm(
      "Restoring replaces every workspace in this LKE installation with the selected backup. This cannot be undone from LKE. Download a backup of the current data first if you want to keep it. Continue?",
    );
    if (!confirmed) {
      input.value = "";
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const restored = await request<{ manifest: { created_at: string }; workspaces: Workspace[] }>("/api/v1/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      const selected = restored.workspaces.find((workspace) => workspace.workspace_id === workspaceId)?.workspace_id
        || restored.workspaces[0]?.workspace_id
        || "";
      setWorkspaces(restored.workspaces);
      setWorkspaceId(selected);
      setBranchId("main");
      setPage("story");
      setDataEpoch((value) => value + 1);
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
      setNotice({ tone: "success", text: `Restored backup from ${new Date(restored.manifest.created_at).toLocaleString()}.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Backup could not be restored." });
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
        <div className="brand"><div className="brand-mark">L</div><div><strong>Living Knowledge</strong><span>ENGINE</span></div></div>
        <div className="workspace-label">WORKSPACE</div>
        <select className="workspace-select" value={workspaceId} disabled={busy} onChange={(event) => { setWorkspaceId(event.target.value); setBranchId("main"); }} aria-label="Select workspace">
          <option value="">Choose a workspace</option>
          {workspaces.map((workspace) => <option key={workspace.workspace_id} value={workspace.workspace_id}>{workspace.name}</option>)}
        </select>
        <nav className="primary-nav" aria-label="Main navigation">
          {NAV.map((item) => <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => setPage(item.id)}>
            <span className="nav-icon">{item.icon}</span><span><b>{item.title}</b><small>{item.sub}</small></span>
          </button>)}
        </nav>
        <div className="sidebar-bottom"><span className="privacy-dot" />Local storage <span className="sidebar-version">v0.1</span></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>{activeWorkspace?.name || "Your knowledge space"}</span><span className="crumb-sep">/</span><select className="branch-select" aria-label="Select branch" value={branchId} disabled={busy} onChange={(event) => setBranchId(event.target.value)}>{branches.map((branch) => <option key={branch.branch_id} value={branch.branch_id}>{branch.branch_id === "main" ? "Main" : branch.branch_id}</option>)}</select></div>
          <div className="top-actions"><span className="revision-chip">Revision {revision}</span><button className="quiet-button" disabled={busy} onClick={() => void rebuildSearch()}>Rebuild search</button><button className="quiet-button" disabled={busy || !workspaceId} onClick={() => void saveBackup()}>Back up</button><button className="quiet-button" disabled={busy} onClick={() => restoreInputRef.current?.click()}>Restore</button><input ref={restoreInputRef} type="file" accept=".lkebackup,application/zip" hidden onChange={(event) => void restoreBackup(event)} /><button className="quiet-button" disabled={busy} onClick={() => void load()}>Refresh</button></div>
        </header>
        <div className="page-content">
          {notice && <div className={`notice ${notice.tone}`} role="status"><span>{notice.tone === "error" ? "!" : notice.tone === "success" ? "✓" : "·"}</span>{notice.text}<button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}

          {!workspaceId ? <section className="welcome-card">
            <div className="eyebrow">A private workspace for connected knowledge</div>
            <h1>Start with a world, an idea, or a note.</h1>
            <p>Create a workspace to bring sources, people, stories, and scenarios together. Your information stays on this device.</p>
            <form className="inline-create" onSubmit={createWorkspace}>
              <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="Give your workspace a name" aria-label="Workspace name" maxLength={200} />
              <button className="primary-button" disabled={busy}>Create workspace <span>↗</span></button>
            </form>
            <div className="welcome-points"><span>◉ Evidence stays linked</span><span>◈ Explore safely in branches</span><span>⌁ Your data stays yours</span></div>
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
            {page === "story" && <StoryPage key={JSON.stringify([dataEpoch, workspaceId, branchId])} entities={entities} claims={claims} workspaceId={workspaceId} branchId={branchId} revision={revision} busy={busy} onNavigate={setPage} onSelectBranch={setBranchId} onCommit={commitStoryCommand} onMainCommit={commitMainCommand} onCreateAdventure={createStoryAdventure} onRevisionChange={(value) => { revisionRef.current = value; setRevision(value); }} onRefresh={() => refresh()} />}
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

function StoryPage({ entities, claims, workspaceId, branchId, revision, busy, onNavigate, onSelectBranch, onCommit, onMainCommit, onCreateAdventure, onRevisionChange, onRefresh }: {
  entities: Entity[];
  claims: Claim[];
  workspaceId: string;
  branchId: string;
  revision: number;
  busy: boolean;
  onNavigate: (page: Page) => void;
  onSelectBranch: (branchId: string) => void;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string) => Promise<Record<string, unknown>>;
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
  const [providerId, setProviderId] = useState<StoryProvider["id"]>(() => {
    try {
      const saved = window.localStorage.getItem("lke.story.provider");
      return saved === "openai" || saved === "claude" || saved === "codex" || saved === "huggingface" || saved === "huggingface_local" ? saved : "ollama";
    } catch { return "ollama"; }
  });
  const [model, setModel] = useState(() => {
    try { return window.localStorage.getItem("lke.story.model") || ""; } catch { return ""; }
  });
  const [title, setTitle] = useState("");
  const [actorIsUserControlled, setActorIsUserControlled] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [exportIncludesContext, setExportIncludesContext] = useState(false);
  const [exportIncludesPrompts, setExportIncludesPrompts] = useState(true);
  const [worlds, setWorlds] = useState<StoryWorld[]>([]);
  const [adventures, setAdventures] = useState<StoryAdventure[]>([]);
  const [mainCharacters, setMainCharacters] = useState<Entity[]>([]);
  const [adventureHeroId, setAdventureHeroId] = useState("");
  const [selectedWorldId, setSelectedWorldId] = useState("");
  const [selectedWorldDetail, setSelectedWorldDetail] = useState<{ world_id: string; name: string; latest_version: number; versions: { version: number; description: string; template_key: string; content: Record<string, unknown> }[] } | null>(null);
  const [editWorldLocations, setEditWorldLocations] = useState("");
  const [worldName, setWorldName] = useState("");
  const [worldPremise, setWorldPremise] = useState("");
  const [editWorldName, setEditWorldName] = useState("");
  const [editWorldDescription, setEditWorldDescription] = useState("");
  const [editWorldPremise, setEditWorldPremise] = useState("");
  const [worldTemplate, setWorldTemplate] = useState("fantasy");
  const [adventureName, setAdventureName] = useState("");
  const [heroName, setHeroName] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [rpgState, setRpgState] = useState<RpgState | null>(null);
  const [editableStats, setEditableStats] = useState<Record<string, number>>({});
  const [rpgError, setRpgError] = useState("");
  const [checkStat, setCheckStat] = useState("");
  const [checkTarget, setCheckTarget] = useState(12);
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
  const memoryScopeRef = useRef("");
  const storyMounted = useRef(true);
  const selectedStoryProvider = storyProviders.find((provider) => provider.id === providerId);
  const storyProviderAvailable = selectedStoryProvider?.available ?? false;
  const models = selectedStoryProvider?.models ?? [];
  function changeStoryProvider(nextId: StoryProvider["id"]) {
    const next = storyProviders.find((provider) => provider.id === nextId);
    setProviderId(nextId);
    setModel(next?.default_model || next?.models[0] || (nextId === "codex" ? "auto" : ""));
    setStoryError("");
  }
  useEffect(() => {
    storyMounted.current = true;
    return () => { storyMounted.current = false; };
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem("lke.story.provider", providerId);
      window.localStorage.setItem("lke.story.model", model);
    } catch { /* Preferences are optional; canonical story data stays in SQLite. */ }
  }, [providerId, model]);
  useEffect(() => {
    let active = true;
    Promise.all([
      request<StoryWorld[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds`),
      request<StoryAdventure[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures`),
      request<Entity[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/entities?branch_id=main`),
    ]).then(([worldRows, adventureRows, characterRows]) => {
      if (!active) return;
      setWorlds(worldRows);
      setAdventures(adventureRows);
      setMainCharacters(characterRows.filter((item) => ["character", "person"].includes(item.entity_type)));
      setSelectedWorldId((current) => worldRows.some((item) => item.world_id === current) ? current : worldRows[0]?.world_id || "");
      setAdventureHeroId((current) => characterRows.some((item) => item.entity_id === current) ? current : characterRows.find((item) => ["character", "person"].includes(item.entity_type))?.entity_id || "");
    }).catch((loadError) => {
      if (active) setLibraryError(loadError instanceof Error ? loadError.message : "The world library could not be loaded.");
    });
    return () => { active = false; };
  }, [workspaceId]);
  useEffect(() => {
    if (!selectedWorldId) {
      setSelectedWorldDetail(null);
      return;
    }
    let active = true;
    request<{ world_id: string; name: string; latest_version: number; versions: { version: number; description: string; template_key: string; content: Record<string, unknown> }[] }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds/${encodeURIComponent(selectedWorldId)}`,
    ).then((detail) => {
      if (!active) return;
      const updatedLatest = detail.versions.find((item) => item.version === detail.latest_version);
      setSelectedWorldDetail(detail);
      setEditWorldName(detail.name);
      setEditWorldDescription(updatedLatest?.description || "");
      setEditWorldPremise(typeof updatedLatest?.content.public_lore === "string" ? updatedLatest.content.public_lore : "");
      setEditWorldLocations(Array.isArray(updatedLatest?.content.locations) ? updatedLatest.content.locations.filter((value): value is string => typeof value === "string").join("\n") : "");
    }).catch((loadError) => {
      if (active) setLibraryError(loadError instanceof Error ? loadError.message : "The selected world could not be opened.");
    });
    return () => { active = false; };
  }, [selectedWorldId, workspaceId]);
  const activeAdventure = adventures.find((item) => item.branch_id === branchId && item.conversation_id === conversationId) || null;
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
    link.download = `lke-context-${branchFilePart}-r${context.base_revision}.json`;
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
    link.download = `lke-story-${conversation.conversation_id.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80)}.json`;
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
    const fingerprint = JSON.stringify([workspaceId, branchId, conversation.conversation_id, providerId, model, prompt, order]);
    if (pendingStoryRequest.current?.fingerprint !== fingerprint) {
      pendingStoryRequest.current = {
        fingerprint,
        body: JSON.stringify({
          branch_id: branchId,
          conversation_id: conversation.conversation_id,
          expected_revision: revision,
          idempotency_key: newId("story-turn"),
          provider: providerId,
          model,
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

  async function retryStoryTurn(turn: StoryConversation["turns"][number]) {
    if (!conversation || !activeAdventure || generating || busy || turn.role !== "assistant") return;
    const controller = new AbortController();
    generationAbort.current = controller;
    setGenerating(true);
    setStoryError("");
    try {
      const result = await request<StoryGenerationResult>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/retry`,
        { method: "POST", signal: controller.signal,
          body: JSON.stringify({ branch_id: branchId, conversation_id: conversation.conversation_id, turn_id: turn.turn_id, expected_revision: revision, idempotency_key: newId("retry-turn"), provider: providerId, model }) },
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
    const laterIds = conversation.turns.filter((item) => item.turn_order > turn.turn_order && item.status === "active").map((item) => item.turn_id);
    try {
      await onCommit("edit_story_turn", {
        conversation_id: conversation.conversation_id, turn_id: turn.turn_id, action: "edit",
        content: editedTurnText.trim(), ...(turn.role === "user" ? { superseded_turn_ids: laterIds } : {}),
      }, "Edit a saved story turn and preserve its prior versions");
      setEditingTurnId("");
      setEditedTurnText("");
      await selectConversation(conversation.conversation_id);
    } catch (editError) {
      setStoryError(editError instanceof Error ? editError.message : "The turn could not be edited.");
    }
  }

  async function deleteStoryTurn(turn: StoryConversation["turns"][number]) {
    if (!conversation || !window.confirm("Hide this turn from the active story? Its history will remain available.")) return;
    const laterIds = conversation.turns.filter((item) => item.turn_order > turn.turn_order && item.status === "active").map((item) => item.turn_id);
    try {
      await onCommit("edit_story_turn", {
        conversation_id: conversation.conversation_id, turn_id: turn.turn_id, action: "delete", superseded_turn_ids: laterIds,
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

  async function createWorld(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = worldName.trim();
    if (!name) return;
    const template = STORY_WORLD_TEMPLATES[worldTemplate as keyof typeof STORY_WORLD_TEMPLATES];
    setLibraryError("");
    try {
      const created = await onMainCommit("create_story_world", {
        world_id: newId("world"),
        name,
        description: worldPremise.trim(),
        template_key: worldTemplate,
        content: { ...template.content, public_lore: worldPremise.trim(), locations: typeof template.content.starting_location === "string" && template.content.starting_location ? [template.content.starting_location] : [] },
      }, "Create a story world from a local template");
      setWorldName("");
      setWorldPremise("");
      const rows = await request<StoryWorld[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/worlds`);
      setWorlds(rows);
      const createdId = String(created.world_id || "");
      if (createdId) setSelectedWorldId(createdId);
    } catch (createError) {
      setLibraryError(createError instanceof Error ? createError.message : "The world could not be created.");
    }
  }

  async function createHero(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = heroName.trim();
    if (!label) return;
    try {
      const created = await onMainCommit("create_entity", {
        entity_id: newId("hero"), entity_type: "character", label, properties: { role: "protagonist" },
      }, "Create the protagonist for Story Studio");
      setHeroName("");
      const rows = await request<Entity[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/entities?branch_id=main`);
      const characters = rows.filter((item) => ["character", "person"].includes(item.entity_type));
      setMainCharacters(characters);
      const createdId = String(created.entity_id || "");
      setAdventureHeroId(createdId || characters[0]?.entity_id || "");
      setActor(createdId || characters[0]?.entity_id || "");
    } catch (createError) {
      setLibraryError(createError instanceof Error ? createError.message : "The protagonist could not be created.");
    }
  }

  async function reviseWorld(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedWorldDetail) return;
    const latest = selectedWorldDetail.versions.find((item) => item.version === selectedWorldDetail.latest_version);
    if (!latest) return;
    try {
      await onMainCommit("revise_story_world", {
        world_id: selectedWorldDetail.world_id,
        expected_world_version: selectedWorldDetail.latest_version,
        name: editWorldName.trim(),
        description: editWorldDescription.trim(),
        template_key: latest.template_key,
        content: { ...latest.content, public_lore: editWorldPremise.trim(), locations: editWorldLocations.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).slice(0, 100) },
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
      setEditWorldLocations(Array.isArray(refreshedVersion?.content.locations) ? refreshedVersion.content.locations.filter((value): value is string => typeof value === "string").join("\n") : "");
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
      });
    } catch (createError) {
      setLibraryError(createError instanceof Error ? createError.message : "The adventure could not be started.");
    }
  }

  async function rollD20(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const statName = checkStat || (rpgState?.sheet ? Object.keys(rpgState.sheet.stats)[0] : "");
    if (!activeAdventure || !statName) return;
    setRpgError("");
    try {
      const rolled = await request<{ revision: number; state: RpgState }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/adventures/${encodeURIComponent(activeAdventure.adventure_id)}/checks`,
        {
          method: "POST",
          body: JSON.stringify({ branch_id: branchId, expected_revision: revision, idempotency_key: newId("d20"), stat_name: statName, target: checkTarget }),
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

  async function saveEventMemory(turn: StoryConversation["turns"][number]) {
    if (!activeAdventure || turn.role !== "assistant") return;
    try {
      await onCommit("create_story_memory", {
        adventure_id: activeAdventure.adventure_id, memory_id: newId("memory"), kind: "event",
        content: turn.content.slice(0, 1000), context_enabled: true, review_status: "proposed", source_turn_id: turn.turn_id,
        importance: 3, knowledge_scope: "actors", known_by: [activeAdventure.actor_entity_id],
      }, "Propose a sourced event memory for player review");
      await reloadStudioData();
    } catch (memoryError) {
      setRpgError(memoryError instanceof Error ? memoryError.message : "The event could not be proposed.");
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
    try {
      await onCommit(current ? "revise_story_memory" : "create_story_memory", {
        adventure_id: activeAdventure.adventure_id, memory_id: current?.memory_id || newId("situation"),
        ...(current ? { expected_version: current.version } : {}), kind: "situation", content: situationDraft.trim(),
        context_enabled: true, review_status: "proposed", source_turn_id: null, importance: 5,
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
      await onCommit("update_story_npc", {
        adventure_id: activeAdventure.adventure_id, npc_entity_id: selectedNpcId,
        aliases: String(data.get("aliases") || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
        public_profile: {
          appearance: String(data.get("appearance") || "").trim(),
          motivation: String(data.get("motivation") || "").trim(),
          current_goal: String(data.get("current_goal") || "").trim(),
          whereabouts: String(data.get("whereabouts") || "").trim(),
          voice: String(data.get("voice") || "").trim(),
        },
        private_profile: { notes: String(data.get("private_notes") || "").trim() }, review_status: "accepted",
      }, "Save and approve an adventure NPC profile");
      setNpcId(selectedNpcId);
      await reloadStudioData();
    } catch (npcError) {
      setRpgError(npcError instanceof Error ? npcError.message : "The NPC profile could not be saved.");
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
  const pinnedLocations = Array.isArray(activeWorldContent?.locations)
    ? activeWorldContent.locations.filter((place): place is string => typeof place === "string") : [];
  const adventureLocations = studioData?.locations.filter((location) => location.status === "approved").map((location) => location.name) || [];
  const approvedMapLocations = [...new Map([...pinnedLocations, ...adventureLocations].map((place) => [place.toLocaleLowerCase(), place])).values()];

  return <>
    <PageHeader kicker="Narrative workspace" title="Story Studio" summary="Continue a saved story with a local model, while keeping character knowledge and world facts under your control." />
    <section className="panel story-hub">
      <div className="panel-heading">
        <div><h2>Worlds & adventures</h2><p>Create a world once, then start separate adventures from its pinned version.</p></div>
        <span className="privacy-tag">LOCAL</span>
      </div>
      <div className="story-hub-grid">
        <form className="story-hub-form" onSubmit={(event) => void createWorld(event)}>
          <div className="story-hub-title"><span>01</span><div><strong>Create a world</strong><small>Start with a small template and add detail as you play.</small></div></div>
          <label className="field-label">World name<input value={worldName} onChange={(event) => setWorldName(event.target.value)} placeholder="The Shattered Coast" maxLength={200} required /></label>
          <label className="field-label">Starting style<select value={worldTemplate} onChange={(event) => setWorldTemplate(event.target.value)}>{Object.entries(STORY_WORLD_TEMPLATES).map(([key, template]) => <option key={key} value={key}>{template.label}</option>)}</select></label>
          <label className="field-label">Public setting premise<textarea value={worldPremise} onChange={(event) => setWorldPremise(event.target.value)} rows={3} maxLength={4000} placeholder="Share setting details that are safe for the hero to know." /></label>
          <button className="secondary-button full-button" disabled={busy || !worldName.trim()}>Save world</button>
        </form>
        <div className="story-hub-form">
          <div className="story-hub-title"><span>02</span><div><strong>Build a protagonist</strong><small>One character leads each adventure.</small></div></div>
          {mainCharacters.length ? <label className="field-label">Choose your hero<select value={adventureHeroId} onChange={(event) => setAdventureHeroId(event.target.value)}>{mainCharacters.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label}</option>)}</select></label> : <>
            <p className="empty-hint">Create your first protagonist here. You can add more characters later.</p>
            <form className="story-hero-create" onSubmit={(event) => void createHero(event)}><input value={heroName} onChange={(event) => setHeroName(event.target.value)} placeholder="Protagonist name" aria-label="Protagonist name" maxLength={200} required /><button className="secondary-button" disabled={busy}>Create hero</button></form>
          </>}
          <form className="story-start-adventure" onSubmit={(event) => void startAdventure(event)}>
            <label className="field-label">World<select value={selectedWorldId} onChange={(event) => setSelectedWorldId(event.target.value)} disabled={!worlds.length}><option value="">{worlds.length ? "Choose a world" : "Create a world first"}</option>{worlds.map((item) => <option key={item.world_id} value={item.world_id}>{item.name} · v{item.latest_version}</option>)}</select></label>
            <label className="field-label">Adventure name<input value={adventureName} onChange={(event) => setAdventureName(event.target.value)} placeholder={worlds.find((item) => item.world_id === selectedWorldId)?.name || "First adventure"} maxLength={200} /></label>
            <button className="primary-button full-button" disabled={busy || !worlds.length || !adventureHeroId}>Start adventure <span>↗</span></button>
          </form>
        </div>
      </div>
      {selectedWorldDetail && <details className="story-world-editor">
        <summary>Edit selected world · save changes as a new version</summary>
        <p className="field-note">Adventure sessions keep the world version they started with. This edit only affects new adventures.</p>
        <form onSubmit={(event) => void reviseWorld(event)}>
          <label className="field-label">World name<input value={editWorldName} onChange={(event) => setEditWorldName(event.target.value)} maxLength={200} required /></label>
          <label className="field-label">Public world summary<input value={editWorldDescription} onChange={(event) => setEditWorldDescription(event.target.value)} maxLength={1000} placeholder="A short summary safe to share with the hero" /></label>
          <label className="field-label">Public setting premise<textarea value={editWorldPremise} onChange={(event) => setEditWorldPremise(event.target.value)} rows={3} maxLength={4000} placeholder="Setting details safe for the hero to know" /></label>
          <label className="field-label">Map locations<textarea value={editWorldLocations} onChange={(event) => setEditWorldLocations(event.target.value)} rows={3} maxLength={4000} placeholder="One approved location per line" /><small className="field-note">These locations belong to the new world version. Adventures already started keep their pinned map.</small></label>
          <div className="story-world-editor-actions"><small>Current version: v{selectedWorldDetail.latest_version}</small><button className="secondary-button" type="submit" disabled={busy || !editWorldName.trim()}>Save new version</button></div>
        </form>
      </details>}
      {libraryError && <p className="inline-error" role="alert">{libraryError}</p>}
      {branchId !== "main" && <p className="story-branch-note">This adventure is isolated from the main world. New adventures start from the latest main-workspace snapshot.</p>}
      <div className="story-adventure-list">
        <div className="story-adventure-list-heading"><strong>Continue an adventure</strong><small>{adventures.filter((item) => item.parent_branch_id === "main").length} saved</small></div>
        {adventures.filter((item) => item.parent_branch_id === "main").length ? adventures.filter((item) => item.parent_branch_id === "main").map((item) => <article className="story-adventure-card" key={item.adventure_id}>
          <div><strong>{item.name}</strong><small>{item.world_name} · world v{item.world_version} · {item.actor_label} · {item.turn_count} turns</small></div>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => onSelectBranch(item.branch_id)}>Resume</button>
        </article>) : <p className="empty-hint">Your new adventures will appear here. Existing unbound stories remain in the saved story menu below.</p>}
      </div>
    </section>
    <div className="story-grid">
      <section className="panel story-canvas">
        <div className="scene-topline"><span className="scene-indicator">WORLD</span><span>{activeAdventure ? `Adventure: ${activeAdventure.name}` : branchId === "main" ? "Main story" : "Legacy story"}</span></div>
        <div className="story-session-bar">
          <label className="field-label">Saved story<select aria-label="Select saved story" disabled={generating} value={conversationId} onChange={(event) => void selectConversation(event.target.value)}>
            <option value="">Choose a story</option>
            {conversations.map((item) => <option key={item.conversation_id} value={item.conversation_id}>{item.title} · {item.actor_label}</option>)}
          </select></label>
          {conversation && <span className="privacy-tag">{conversation.actor_is_user_controlled ? "PLAYER CONTROL" : "MODEL MAY NARRATE"}</span>}
          {conversation && <button className="secondary-button" type="button" onClick={exportStory}>Export story JSON ↓</button>}
          {conversation && <button className="secondary-button" type="button" onClick={() => setReaderOpen((open) => !open)}>{readerOpen ? "Close reader" : "Reader / print"}</button>}
        </div>
        {conversation && <label className="control-choice story-history-toggle"><input type="checkbox" checked={showTurnHistory} onChange={(event) => setShowTurnHistory(event.target.checked)} /><span>Show edited, hidden, and superseded turn history</span></label>}
        {conversation && readerOpen && <section className="story-reader is-open" dir="auto">
          <div className="reader-toolbar"><span>Private local reader</span><button className="secondary-button" type="button" onClick={() => window.print()}>Print / save PDF</button></div>
          <h1>{conversation.title}</h1>
          <p className="reader-metadata">{activeAdventure ? `${activeAdventure.world_name} · ${activeAdventure.name} · ${activeAdventure.actor_label}` : `${conversation.actor_label} · Legacy story`}</p>
          {studioData?.assets.filter((asset) => asset.target_kind === "character" && asset.target_id === conversation.actor_entity_id).map((asset) => assetData[asset.asset_id] && <img className="reader-character-art" key={asset.asset_id} src={assetData[asset.asset_id]} alt={`${conversation.actor_label} · ${asset.display_name}`} />)}
          {conversation.turns.filter((turn) => turn.status === "active").map((turn) => <article className="reader-turn" key={turn.turn_id}>
            <h2>{turn.role === "user" ? "Your direction" : "Story"}</h2>
            {studioData?.assets.filter((asset) => asset.target_kind === "scene" && asset.target_id === turn.turn_id).map((asset) => assetData[asset.asset_id] && <img className="reader-scene-art" key={asset.asset_id} src={assetData[asset.asset_id]} alt={asset.display_name} />)}
            <p dir="auto">{turn.content}</p>
          </article>)}
          <small>Export preview contains only active story turns and attached images. Context manifests and private NPC notes are excluded.</small>
        </section>}
        {conversation && <div className="story-export-options">
          <label className="control-choice"><input type="checkbox" checked={exportIncludesPrompts} onChange={(event) => setExportIncludesPrompts(event.target.checked)} /><span>Include my prompts in export</span></label>
          <label className="control-choice"><input type="checkbox" checked={exportIncludesContext} onChange={(event) => setExportIncludesContext(event.target.checked)} /><span>Include character context manifests in export</span></label>
          <small className="field-note">Generated prose may repeat details from prompts even when prompts are omitted. Context manifests can reveal private character knowledge. Review the file before sharing.</small>
        </div>}
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
            {conversation.turns.filter((turn) => showTurnHistory || turn.status === "active").length ? conversation.turns.filter((turn) => showTurnHistory || turn.status === "active").map((turn) => <article className={`story-turn ${turn.role} ${turn.status}`} key={turn.turn_id}>
              <div className="story-turn-label">{turn.role === "user" ? "You" : `Story · ${turn.model || "local model"}`}<span>Order {turn.narrative_order}{turn.status !== "active" ? ` · ${turn.status}` : ""}</span></div>
              {editingTurnId === turn.turn_id ? <form className="story-turn-edit" onSubmit={(event) => { event.preventDefault(); void saveTurnEdit(turn); }}>
                <label className="field-label">Edit {turn.role === "user" ? "your direction" : "the saved response"}<textarea value={editedTurnText} onChange={(event) => setEditedTurnText(event.target.value)} rows={5} maxLength={20000} required /></label>
                {turn.role === "user" && <small className="field-note">Saving a changed direction moves later active turns to history. You can continue from the corrected prompt.</small>}
                <div className="story-turn-actions"><button type="submit" disabled={busy || !editedTurnText.trim()}>Save edit</button><button type="button" onClick={() => setEditingTurnId("")}>Cancel</button></div>
              </form> : <p dir="auto">{turn.content}</p>}
              {turn.status === "active" && <div className="story-turn-actions">
                <button type="button" disabled={busy || generating} onClick={() => { setEditingTurnId(turn.turn_id); setEditedTurnText(turn.content); }}>Edit</button>
                {turn.role === "assistant" && <button type="button" disabled={busy || generating || !model.trim() || !storyProviderAvailable} onClick={() => void retryStoryTurn(turn)}>Retry</button>}
                <button type="button" disabled={busy || generating} onClick={() => void deleteStoryTurn(turn)}>Hide</button>
                {turn.role === "assistant" && activeAdventure && <button type="button" disabled={busy || generating} onClick={() => void saveEventMemory(turn)}>Remember event</button>}
              </div>}
              {studioData?.assets.filter((asset) => asset.target_kind === "scene" && asset.target_id === turn.turn_id).map((asset) => assetData[asset.asset_id] && <img className="story-turn-art" key={asset.asset_id} src={assetData[asset.asset_id]} alt={asset.display_name} />)}
              {turn.role === "assistant" && <>
                <small>Generated from revision {turn.context_revision}; prose is saved, world facts are unchanged.</small>
                {turn.context_manifest && <details className="story-context-details">
                  <summary>Context used · {turn.context_manifest.included.length} reviewed facts · {turn.context_manifest.excluded.length} excluded</summary>
                  {turn.context_manifest.included.map((fact) => <div className="story-context-fact" key={fact.claim_id}>
                    <strong>{fact.subject} · {fact.predicate} {fact.object}</strong>
                    <small>{fact.actor_stance} · {fact.evidence_ids.length} linked sources</small>
                  </div>)}
                  {turn.context_manifest.excluded.map((item) => <small className="story-context-exclusions" key={item.claim_id}>Excluded claim {item.claim_id} · {item.reason}</small>)}
                  {turn.context_manifest.story && <div className="story-context-fact"><strong>{turn.context_manifest.story.world_name} · world v{turn.context_manifest.story.world_version}</strong><small>{turn.context_manifest.story.description} {turn.context_manifest.story.public_lore}</small><small>Location: {turn.context_manifest.story.character_sheet.current_location || "Not set"} · {Object.keys(turn.context_manifest.story.character_sheet.stats).length} stats · {Object.keys(turn.context_manifest.story.character_sheet.trackers).length} trackers · {turn.context_manifest.story.recent_checks.length} recent checks</small>
                    {(turn.context_manifest.story.memories ?? []).map((memory) => <small key={memory.memory_id}>Memory · {memory.kind} · relevance {memory.selection_score}: {memory.content}</small>)}
                    {(turn.context_manifest.story.author_notes ?? []).map((memory) => <small key={memory.memory_id}>Narrator-only guidance · importance {memory.importance}: {memory.content}</small>)}
                    {(turn.context_manifest.story.excluded_memories ?? []).map((memory) => <small className="story-context-exclusions" key={`${memory.memory_id}-${memory.reason}`}>Memory {memory.memory_id} excluded · {memory.reason}</small>)}
                    {(turn.context_manifest.story.retrieved_episodes ?? []).map((episode) => <details key={episode.turn_id}><summary>Past turn {episode.narrative_order} · {episode.role} · relevance {episode.selection_score}</summary><p dir="auto">{episode.content}</p></details>)}
                    {turn.context_manifest.story.excluded_episode_count > 0 && <small className="story-context-exclusions">{turn.context_manifest.story.excluded_episode_count} older turns excluded or outside this context window.</small>}
                    {(turn.context_manifest.story.open_threads ?? []).map((thread) => <small key={thread.thread_id}>Open thread · {thread.title}: {thread.detail}</small>)}
                    {(turn.context_manifest.story.public_npcs ?? []).map((npc) => <small key={npc.entity_id}>Approved NPC · {npc.name} · {JSON.stringify(npc.profile)}</small>)}
                  </div>}
                  {turn.context_manifest.excluded.length === 0 && <small className="story-context-exclusions">Manifest {turn.context_manifest.manifest_id}</small>}
                </details>}
              </>}
            </article>) : <div className="story-placeholder compact"><div className="story-sigil">✳</div><h2>Your story is ready.</h2><p>Choose a model and describe what should happen next.</p></div>}
          </div>
          <form className="story-compose-form" onSubmit={(event) => void generateStoryTurn(event)}>
            <div className="story-provider-fields">
              <label className="field-label">AI provider<select aria-label="AI provider" value={providerId} onChange={(event) => changeStoryProvider(event.target.value as StoryProvider["id"])} disabled={generating || memoryQuerying}>
                {storyProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{provider.local ? " · local" : " · online"}</option>)}
                {!storyProviders.length && <option value="ollama">Ollama · local</option>}
              </select></label>
              <label className="field-label">Model<input aria-label="Model" list="story-provider-models" value={model} onChange={(event) => setModel(event.target.value)} maxLength={200} disabled={generating || memoryQuerying} placeholder={providerId === "codex" ? "auto or a Codex model" : "Model name"} /></label>
              <datalist id="story-provider-models">{models.map((name) => <option key={name} value={name} />)}</datalist>
            </div>
            <label className="field-label">Story order<input type="number" min={0} value={order} disabled={memoryQuerying} onChange={(event) => setOrder(Number(event.target.value))} /></label>
            <label className="field-label">Your direction<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} maxLength={4000} placeholder="What should the scene explore? If you control the character, write the actions or words you want them to take." required /></label>
            {selectedStoryProvider && <p className="provider-note">{selectedStoryProvider.setup} {selectedStoryProvider.local ? "This provider is configured for local inference." : "The prompt, recent story, and authorized context are sent to this provider. API and account charges or data terms may apply."}</p>}
            {selectedStoryProvider && !storyProviderAvailable && <p className="provider-note">This provider is not available yet. Check its setup above, then reload the workspace.</p>}
            {storyProviderAvailable && !model.trim() && <p className="provider-note">Enter a model name to continue. Installed local models appear as suggestions.</p>}
            <button className="primary-button full-button" disabled={generating || busy || !storyProviderAvailable || !model.trim() || !prompt.trim()}>{generating ? "Writing story…" : `Continue story${selectedStoryProvider ? ` with ${selectedStoryProvider.label}` : ""}`} <span>✳</span></button>
            {generating && <button className="secondary-button full-button stop-generation" type="button" onClick={stopStoryGeneration}>Stop generation</button>}
          </form>
        </>}
        {storyError && <p className="inline-error" role="alert">{storyError}</p>}
      </section>
      <div className="story-side-panels">
      <section className="panel rpg-state-panel">
        <div className="panel-heading"><div><h2>Character & game state</h2><p>{activeAdventure ? `${activeAdventure.actor_label} · ${activeAdventure.world_name} v${activeAdventure.world_version}` : "State appears here when you play a world-based adventure."}</p></div><span className="privacy-tag">D20</span></div>
        {activeAdventure && rpgState?.sheet ? <>
          <div className="rpg-location"><small>Current location</small><strong dir="auto">{rpgState.sheet.current_location || "Not set"}</strong></div>
          <div className="rpg-stat-list"><strong>Stats</strong><div>{Object.entries(rpgState.sheet.stats).map(([name, value]) => <span key={name}>{name}<b>{value >= 0 ? `+${value}` : value}</b></span>)}</div></div>
          <details className="rpg-edit-stats"><summary>Edit stat modifiers</summary><form onSubmit={(event) => void saveRpgStats(event)}>{Object.entries(rpgState.sheet.stats).map(([name, value]) => <label className="field-label" key={name}>{name}<input type="number" min={-10} max={10} value={editableStats[name] ?? value} onChange={(event) => setEditableStats((stats) => ({ ...stats, [name]: Number(event.target.value) }))} /></label>)}<button className="secondary-button full-button" disabled={busy}>Save stats</button></form></details>
          <div className="rpg-tracker-list"><strong>Trackers</strong>{Object.entries(rpgState.sheet.trackers).map(([name, tracker]) => <div key={name}><span>{name}</span><b>{tracker.value} / {tracker.max}</b><meter min={0} max={Math.max(1, tracker.max)} value={tracker.value} /></div>)}</div>
          <form className="rpg-check-form" onSubmit={(event) => void rollD20(event)}>
            <div className="story-hub-title"><span>🎲</span><div><strong>Roll a check</strong><small>d20 + stat modifier against a visible target.</small></div></div>
            <div className="rpg-check-fields">
              <label className="field-label">Stat<select value={checkStat || Object.keys(rpgState.sheet.stats)[0] || ""} onChange={(event) => setCheckStat(event.target.value)}>{Object.keys(rpgState.sheet.stats).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
              <label className="field-label">Target<input type="number" min={1} max={100} value={checkTarget} onChange={(event) => setCheckTarget(Number(event.target.value))} /></label>
            </div>
            <button className="secondary-button full-button" disabled={busy || generating || !Object.keys(rpgState.sheet.stats).length}>Roll d20</button>
          </form>
          {rpgState.checks[0] && <div className={`rpg-last-check ${rpgState.checks[0].outcome}`}><strong>Last check · {rpgState.checks[0].outcome}</strong><span>{rpgState.checks[0].die_roll} + {rpgState.checks[0].modifier} = {rpgState.checks[0].total} vs {rpgState.checks[0].target}</span></div>}
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
              <div><strong>{proposal.review_status === "proposed" ? "Needs your review" : `Proposal ${proposal.review_status}`}</strong><small>{proposal.changes.map((change) => change.operation === "tracker_delta" ? `${change.tracker_id} ${change.delta > 0 ? "+" : ""}${change.delta}` : change.operation === "set_location" ? `Location → ${change.location}` : change.operation === "npc_profile" ? `NPC profile → ${change.npc_entity_id}: ${Object.entries(change.updates).map(([key, value]) => `${key} ${value}`).join(", ")}` : `Event memory → ${change.content.slice(0, 100)}`).join(" · ")}</small></div>
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
        </> : <p className="empty-hint">Start an adventure from a world to get a character sheet, trackers, and d20 checks.</p>}
        {rpgError && <p className="inline-error" role="alert">{rpgError}</p>}
      </section>
      {activeAdventure && studioData && <details className="panel story-detail-panel">
        <summary><strong>Memories</strong><small>Notes, reviewed event memories, current situation, and open threads</small></summary>
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
          {studioData.npcs.map((npc) => <article className="story-npc-card" key={npc.npc_entity_id}><div><strong>{npc.label} · {npc.review_status}</strong><small>{npc.aliases.length ? `Also known as ${npc.aliases.join(", ")}` : "No aliases"}</small></div><p>{npc.public_profile.appearance || "Appearance not set"} · Goal: {npc.public_profile.current_goal || "not set"}</p><small className="private-note">Private notes stay out of model context: {npc.private_profile.notes || "none"}</small></article>)}
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
            <label className="field-label">Private author notes<textarea name="private_notes" defaultValue={selectedNpcProfile?.private_profile.notes || ""} rows={2} maxLength={4000} /><small className="field-note">Private notes are visible only in this panel and are never included in story context.</small></label>
            <button className="secondary-button full-button" disabled={busy}>Save approved NPC profile</button>
          </form>
        </div>
      </details>}
      {activeAdventure && rpgState?.sheet && <details className="panel story-detail-panel">
        <summary><strong>Map & travel</strong><small>{rpgState.sheet.current_location || "Location not set"} · pinned world version {activeAdventure.world_version}</small></summary>
        <div className="story-detail-content">
          <p className="field-note">Travel changes the current location only when you choose an approved map point. Model-suggested locations remain proposals.</p>
          {approvedMapLocations.length
            ? <div className="story-map-locations">{approvedMapLocations.map((place) => <button type="button" key={place} className={place === rpgState.sheet?.current_location ? "selected" : ""} disabled={busy || place === rpgState.sheet?.current_location} onClick={() => void travelToLocation(place)}>{place}{place === rpgState.sheet?.current_location ? " · Here" : " · Travel"}</button>)}</div>
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
    </div>
    <ExternalExchangePanel workspaceId={workspaceId} branchId={branchId} revision={revision} busy={busy} onCommit={onCommit} />
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
