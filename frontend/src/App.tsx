import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Branch, Claim, ContextManifest, downloadBackup, Entity, ExternalExchange, ExtractionBatch, ExtractionCandidate, JournalEvent, JournalEventVersion, newId, OllamaModelStatus, Relation, request, Revision, RuleEvaluation, Scenario, ScenarioAssumption, ScenarioOption, Source, SourceDetails, StoryConversation, StoryConversationSummary, StoryGenerationResult, Workspace } from "./api";

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
      setNotice({ tone: "success", text: commandType === "create_conversation" ? "Story started on this branch." : "Character knowledge saved to this branch." });
      return result;
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The change could not be saved." });
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
          <div className="top-actions"><span className="revision-chip">Revision {revision}</span><button className="quiet-button" disabled={busy || !workspaceId} onClick={() => void saveBackup()}>Back up</button><button className="quiet-button" disabled={busy} onClick={() => restoreInputRef.current?.click()}>Restore</button><input ref={restoreInputRef} type="file" accept=".lkebackup,application/zip" hidden onChange={(event) => void restoreBackup(event)} /><button className="quiet-button" disabled={busy} onClick={() => void load()}>Refresh</button></div>
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
            {page === "story" && <StoryPage key={JSON.stringify([dataEpoch, workspaceId, branchId])} entities={entities} claims={claims} workspaceId={workspaceId} branchId={branchId} revision={revision} busy={busy} onNavigate={setPage} onCommit={commitStoryCommand} onRevisionChange={(value) => { revisionRef.current = value; setRevision(value); }} onRefresh={() => refresh()} />}
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

function StoryPage({ entities, claims, workspaceId, branchId, revision, busy, onNavigate, onCommit, onRevisionChange, onRefresh }: {
  entities: Entity[];
  claims: Claim[];
  workspaceId: string;
  branchId: string;
  revision: number;
  busy: boolean;
  onNavigate: (page: Page) => void;
  onCommit: (command: string, payload: Record<string, unknown>, reason: string) => Promise<Record<string, unknown>>;
  onRevisionChange: (revision: number) => void;
  onRefresh: () => Promise<void>;
}) {
  const characters = entities.filter((item) => ["character", "person"].includes(item.entity_type));
  const [actor, setActor] = useState("");
  const [order, setOrder] = useState(0);
  const [context, setContext] = useState<ContextManifest | null>(null);
  const [contextExportNotice, setContextExportNotice] = useState("");
  const [error, setError] = useState("");
  const [storyError, setStoryError] = useState("");
  const [conversations, setConversations] = useState<StoryConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [conversation, setConversation] = useState<StoryConversation | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [ollamaAvailable, setOllamaAvailable] = useState(false);
  const [model, setModel] = useState("");
  const [title, setTitle] = useState("");
  const [actorIsUserControlled, setActorIsUserControlled] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [exportIncludesContext, setExportIncludesContext] = useState(false);
  const storySelectionRequest = useRef(0);
  const storyMounted = useRef(true);
  useEffect(() => {
    storyMounted.current = true;
    return () => { storyMounted.current = false; };
  }, []);
  const selectedActor = conversation?.actor_entity_id || (characters.some((item) => item.entity_id === actor) ? actor : characters[0]?.entity_id || "");

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
    request<OllamaModelStatus>("/api/v1/providers/ollama/models").then((status) => {
      if (!active) return;
      setOllamaAvailable(status.available);
      setModels(status.models);
      setModel((current) => status.models.includes(current) ? current : status.models[0] || "");
    }).catch(() => {
      if (active) {
        setOllamaAvailable(false);
        setModels([]);
      }
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
    const exportPackage = {
      protocol: "lke.story-export.v1",
      exported_at: new Date().toISOString(),
      workspace_id: workspaceId,
      branch_id: branchId,
      base_revision: revision,
      context_manifests_included: exportIncludesContext,
      conversation: {
        ...conversation,
        turns: conversation.turns.map((turn) => ({
          ...turn,
          context_manifest: exportIncludesContext ? turn.context_manifest : undefined,
        })),
      },
    };
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
    if (!conversation || generating || busy || !model) return;
    setGenerating(true);
    setStoryError("");
    try {
      const generated = await request<StoryGenerationResult>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/story/generate`,
        {
          method: "POST",
          body: JSON.stringify({
            branch_id: branchId,
            conversation_id: conversation.conversation_id,
            expected_revision: revision,
            idempotency_key: newId("story-turn"),
            model,
            prompt,
            narrative_order: order,
          }),
        },
      );
      if (!storyMounted.current) return;
      setConversation(generated.conversation);
      setPrompt("");
      onRevisionChange(generated.revision);
      await onRefresh();
      if (!storyMounted.current) return;
      await loadConversations(generated.conversation_id);
    } catch (generationError) {
      if (!storyMounted.current) return;
      setStoryError(generationError instanceof Error ? generationError.message : "The local model could not continue this story.");
    } finally {
      setGenerating(false);
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

  return <>
    <PageHeader kicker="Narrative workspace" title="Story Studio" summary="Continue a saved story with a local model, while keeping character knowledge and world facts under your control." />
    <div className="story-grid">
      <section className="panel story-canvas">
        <div className="scene-topline"><span className="scene-indicator">WORLD</span><span>Branch: {branchId === "main" ? "Main story" : branchId}</span></div>
        <div className="story-session-bar">
          <label className="field-label">Saved story<select aria-label="Select saved story" disabled={generating} value={conversationId} onChange={(event) => void selectConversation(event.target.value)}>
            <option value="">Choose a story</option>
            {conversations.map((item) => <option key={item.conversation_id} value={item.conversation_id}>{item.title} · {item.actor_label}</option>)}
          </select></label>
          {conversation && <span className="privacy-tag">{conversation.actor_is_user_controlled ? "PLAYER CONTROL" : "MODEL MAY NARRATE"}</span>}
          {conversation && <button className="secondary-button" type="button" onClick={exportStory}>Export story JSON ↓</button>}
        </div>
        {conversation && <div className="story-export-options">
          <label className="control-choice"><input type="checkbox" checked={exportIncludesContext} onChange={(event) => setExportIncludesContext(event.target.checked)} /><span>Include character context manifests in export</span></label>
          <small className="field-note">The export includes your prompts and generated prose. Context manifests can also reveal private character knowledge. Review the file before sharing.</small>
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
            {conversation.turns.length ? conversation.turns.map((turn) => <article className={`story-turn ${turn.role}`} key={turn.turn_id}>
              <div className="story-turn-label">{turn.role === "user" ? "You" : `Story · ${turn.model || "local model"}`}<span>Order {turn.narrative_order}</span></div>
              <p>{turn.content}</p>
              {turn.role === "assistant" && <>
                <small>Generated from revision {turn.context_revision}; prose is saved, world facts are unchanged.</small>
                {turn.context_manifest && <details className="story-context-details">
                  <summary>Context used · {turn.context_manifest.included.length} reviewed facts · {turn.context_manifest.excluded.length} excluded</summary>
                  {turn.context_manifest.included.map((fact) => <div className="story-context-fact" key={fact.claim_id}>
                    <strong>{fact.subject} · {fact.predicate} {fact.object}</strong>
                    <small>{fact.actor_stance} · {fact.evidence_ids.length} linked sources</small>
                  </div>)}
                  {turn.context_manifest.excluded.map((item) => <small className="story-context-exclusions" key={item.claim_id}>Excluded claim {item.claim_id} · {item.reason}</small>)}
                  {turn.context_manifest.excluded.length === 0 && <small className="story-context-exclusions">Manifest {turn.context_manifest.manifest_id}</small>}
                </details>}
              </>}
            </article>) : <div className="story-placeholder compact"><div className="story-sigil">✳</div><h2>Your story is ready.</h2><p>Choose a local model and describe what should happen next.</p></div>}
          </div>
          <form className="story-compose-form" onSubmit={(event) => void generateStoryTurn(event)}>
            <label className="field-label">Local model<select aria-label="Local model" value={model} onChange={(event) => setModel(event.target.value)} disabled={!models.length}>
              {models.length ? models.map((name) => <option key={name} value={name}>{name}</option>) : <option value="">No local models found</option>}
            </select></label>
            <label className="field-label">Story order<input type="number" min={0} value={order} onChange={(event) => setOrder(Number(event.target.value))} /></label>
            <label className="field-label">Your direction<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} maxLength={4000} placeholder="What should the scene explore? If you control the character, write the actions or words you want them to take." required /></label>
            {!ollamaAvailable && <p className="provider-note">Ollama is not running. Start Ollama on this device to continue privately with a local model.</p>}
            {ollamaAvailable && !models.length && <p className="provider-note">No local model is installed yet. Add a model in Ollama, then refresh this workspace.</p>}
            <button className="primary-button full-button" disabled={generating || busy || !ollamaAvailable || !model || !prompt.trim()}>{generating ? "Writing locally…" : "Continue story locally"} <span>✳</span></button>
          </form>
        </>}
        {storyError && <p className="inline-error" role="alert">{storyError}</p>}
      </section>
      <section className="panel context-panel">
        <div className="panel-heading"><div><h2>Character perspective</h2><p>Only reviewed facts this character knows enter the generation context.</p></div><span className="privacy-tag">LOCAL</span></div>
        {characters.length ? <>
          <label className="field-label">Character<select value={selectedActor} disabled={Boolean(conversation)} onChange={(event) => setActor(event.target.value)}>{characters.map((item) => <option key={item.entity_id} value={item.entity_id}>{item.label}</option>)}</select></label>
          <label className="field-label">Story order<input type="number" min={0} value={order} onChange={(event) => setOrder(Number(event.target.value))} /></label>
          <button className="primary-button full-button" onClick={() => void preview()}>Build context preview <span>↗</span></button>
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
      time_note: values.get("time_note"),
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
