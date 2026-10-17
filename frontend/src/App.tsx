import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Branch, Claim, Entity, newId, OllamaModelStatus, Relation, request, Source, StoryConversation, StoryConversationSummary, StoryGenerationResult, Workspace } from "./api";

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
  const [branches, setBranches] = useState<Branch[]>([{ branch_id: "main", parent_branch_id: null, head_revision: 0 }]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [branchId, setBranchId] = useState("main");
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>({ tone: "info", text: "Connecting to your private workspace…" });

  const activeWorkspace = useMemo(() => workspaces.find((item) => item.workspace_id === workspaceId), [workspaces, workspaceId]);

  const refresh = useCallback(async (id = workspaceId, branch = branchId) => {
    if (!id) return;
    const [entityRows, relationRows, claimRows, sourceRows, branchRows, rev] = await Promise.all([
      request<Entity[]>(`/api/v1/workspaces/${encodeURIComponent(id)}/entities?branch_id=${encodeURIComponent(branch)}`),
      request<Relation[]>(`/api/v1/workspaces/${encodeURIComponent(id)}/relations?branch_id=${encodeURIComponent(branch)}`),
      request<Claim[]>(`/api/v1/workspaces/${encodeURIComponent(id)}/claims?branch_id=${encodeURIComponent(branch)}`),
      request<Source[]>(`/api/v1/workspaces/${encodeURIComponent(id)}/sources`),
      request<Branch[]>(`/api/v1/workspaces/${encodeURIComponent(id)}/branches`),
      request<{ revision: number }>(`/api/v1/workspaces/${encodeURIComponent(id)}/revision?branch_id=${encodeURIComponent(branch)}`),
    ]);
    setEntities(entityRows);
    setRelations(relationRows);
    setClaims(claimRows);
    setSources(sourceRows);
    setBranches(branchRows);
    setRevision(rev.revision);
    revisionRef.current = rev.revision;
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
      setBranches([{ branch_id: "main", parent_branch_id: null, head_revision: 0 }]);
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
      const content = file ? await file.text() : String(data.get("content") || "");
      const displayName = file?.name || String(data.get("display_name") || "").trim();
      if (!displayName) throw new Error("Add a source title or choose a local text file.");
      if (!content.trim()) throw new Error("Add text content or choose a non-empty local text file.");
      if (new TextEncoder().encode(content).length > 10 * 1024 * 1024) throw new Error("Text imports are limited to 10 MB.");
      const mediaType = file && /\.(md|markdown)$/i.test(file.name) ? "text/markdown" : "text/plain";
      await runCommand("import_source", { display_name: displayName, content, media_type: mediaType }, "Import a local text source");
      form.reset();
      setNotice({ tone: "success", text: "Source is stored locally. No extraction has been run." });
    });
  }

  async function review(kind: "claim" | "relation", id: string, status: "accepted" | "rejected") {
    setBusy(true);
    try {
      await runCommand(kind === "claim" ? "review_claim" : "review_relation", { [`${kind}_id`]: id, review_status: status }, `User ${status} ${kind}`);
      setNotice({ tone: "success", text: `${kind === "claim" ? "Claim" : "Relationship"} ${status}.` });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Review failed." }); }
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

  const visibleClaims = claims.filter((claim) => !query || `${claim.predicate} ${claim.object_value}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">L</div><div><strong>Living Knowledge</strong><span>ENGINE</span></div></div>
        <div className="workspace-label">WORKSPACE</div>
        <select className="workspace-select" value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setBranchId("main"); }} aria-label="Select workspace">
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
          <div className="breadcrumbs"><span>{activeWorkspace?.name || "Your knowledge space"}</span><span className="crumb-sep">/</span><select className="branch-select" aria-label="Select branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}>{branches.map((branch) => <option key={branch.branch_id} value={branch.branch_id}>{branch.branch_id === "main" ? "Main" : branch.branch_id}</option>)}</select></div>
          <div className="top-actions"><span className="revision-chip">Revision {revision}</span><button className="quiet-button" onClick={() => void load()}>Refresh</button></div>
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
          </section> : <>
            {page === "knowledge" && <KnowledgePage
              workspaceId={workspaceId} entities={entities} relations={relations} claims={visibleClaims} sources={sources} busy={busy} query={query} setQuery={setQuery}
              addEntity={addEntity} addRelation={addRelation} addClaim={addClaim} importText={importText} review={review}
            />}
            {page === "story" && <StoryPage entities={entities} claims={claims} workspaceId={workspaceId} branchId={branchId} revision={revision} busy={busy} onNavigate={setPage} onCommit={commitStoryCommand} onRevisionChange={(value) => { revisionRef.current = value; setRevision(value); }} onRefresh={() => refresh()} />}
            {page === "journal" && <JournalPage importText={importText} busy={busy} />}
            {page === "scenario" && <ScenarioPage branchId={branchId} revision={revision} entities={entities} relations={relations} onBranch={createScenario} />}
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
  workspaceId: string; entities: Entity[]; relations: Relation[]; claims: Claim[]; sources: Source[]; busy: boolean; query: string; setQuery: (query: string) => void;
  addEntity: (event: FormEvent<HTMLFormElement>) => Promise<void>; addRelation: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  addClaim: (event: FormEvent<HTMLFormElement>) => Promise<void>; importText: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  review: (kind: "claim" | "relation", id: string, status: "accepted" | "rejected") => Promise<void>;
}) {
  const [tab, setTab] = useState<"map" | "evidence" | "review">("map");
  return <>
    <PageHeader kicker="Your knowledge space" title="Knowledge Explorer" summary="Build a source-backed map of people, ideas, events, and their relationships." />
    <div className="metric-row"><Metric value={props.entities.length} label="Concepts" icon="◉" /><Metric value={props.relations.length} label="Relationships" icon="⟷" /><Metric value={props.claims.length} label="Claims" icon="≋" /><Metric value={props.claims.filter((item) => item.review_status === "proposed").length + props.relations.filter((item) => item.review_status === "proposed").length} label="Needs review" icon="◷" accent /></div>
    <div className="toolbar"><div className="tabs"><button className={tab === "map" ? "selected" : ""} onClick={() => setTab("map")}>Knowledge map</button><button className={tab === "evidence" ? "selected" : ""} onClick={() => setTab("evidence")}>Sources</button><button className={tab === "review" ? "selected" : ""} onClick={() => setTab("review")}>Review</button></div><label className="search-box"><span>⌕</span><input value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="Search this workspace" aria-label="Search workspace" /></label></div>
    {tab === "map" && <div className="knowledge-grid"><section className="panel graph-panel"><div className="panel-heading"><div><h2>Concept map</h2><p>Accepted links and proposals share one editable source.</p></div><span className="panel-count">{props.entities.length} nodes</span></div><Graph entities={props.entities} relations={props.relations} /><div className="graph-legend"><span><i className="legend-node" />Concept</span><span><i className="legend-line" />Accepted relationship</span><span><i className="legend-line proposed" />Needs review</span></div></section>
      <div className="stacked-panels"><EntityForm busy={props.busy} onSubmit={props.addEntity} /><RelationForm entities={props.entities} busy={props.busy} onSubmit={props.addRelation} /></div></div>}
    {tab === "evidence" && <div className="knowledge-grid"><SourceForm busy={props.busy} onSubmit={props.importText} /><SourceResults workspaceId={props.workspaceId} query={props.query} /> </div>}
    {tab === "review" && <div className="review-list"><ReviewList claims={props.claims} relations={props.relations} review={props.review} busy={props.busy} /></div>}
    <section className="panel claims-panel"><div className="panel-heading"><div><h2>Claims</h2><p>Epistemic confidence and review status are kept distinct.</p></div></div><ClaimForm entities={props.entities} sources={props.sources} busy={props.busy} onSubmit={props.addClaim} /><div className="claim-list">{props.claims.length ? props.claims.map((claim) => <div className="claim-row" key={claim.claim_id}><span className={`status-dot ${claim.review_status}`} /><div><strong>{props.entities.find((item) => item.entity_id === claim.subject_entity_id)?.label || claim.subject_entity_id} <span className="claim-predicate">{claim.predicate}</span> {claim.object_value}</strong><small>{claim.epistemic_status} · {claim.review_status} · {claim.visibility} · {claim.evidence.length} evidence</small></div>{claim.review_status === "proposed" && <button className="link-button" onClick={() => void props.review("claim", claim.claim_id, "accepted")} disabled={props.busy}>Review</button>}</div>) : <p className="empty-hint">No claims yet. Add a claim and review it before it becomes accepted knowledge.</p>}</div></section>
  </>;
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
  const [context, setContext] = useState<{ included: { subject: string; predicate: string; object: string; actor_stance: string }[]; excluded: { claim_id: string; reason: string }[] } | null>(null);
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
      if (active) {
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
    try {
      setContext(await request<{ included: { subject: string; predicate: string; object: string; actor_stance: string }[]; excluded: { claim_id: string; reason: string }[] }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/context`, {
        method: "POST",
        body: JSON.stringify({ branch_id: branchId, actor_entity_id: selectedActor, as_of_narrative_order: order, token_budget: 4000 }),
      }));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Context could not be built.");
    }
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
    setConversationId(id);
    setConversation(null);
    setStoryError("");
    if (!id) return;
    try {
      const detail = await request<StoryConversation>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(id)}?branch_id=${encodeURIComponent(branchId)}`,
      );
      setConversation(detail);
      setActor(detail.actor_entity_id);
      const lastTurn = detail.turns[detail.turns.length - 1];
      setOrder(lastTurn?.narrative_order || 0);
    } catch (loadError) {
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
      setConversation(generated.conversation);
      setPrompt("");
      onRevisionChange(generated.revision);
      await onRefresh();
      await loadConversations(generated.conversation_id);
    } catch (generationError) {
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
          <label className="field-label">Saved story<select aria-label="Select saved story" value={conversationId} onChange={(event) => void selectConversation(event.target.value)}>
            <option value="">Choose a story</option>
            {conversations.map((item) => <option key={item.conversation_id} value={item.conversation_id}>{item.title} · {item.actor_label}</option>)}
          </select></label>
          {conversation && <span className="privacy-tag">{conversation.actor_is_user_controlled ? "PLAYER CONTROL" : "MODEL MAY NARRATE"}</span>}
        </div>
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
        </div>}
      </section>
    </div>
  </>;
}

function JournalPage({ importText, busy }: { importText: (event: FormEvent<HTMLFormElement>) => Promise<void>; busy: boolean }) {
  return <><PageHeader kicker="Personal memory" title="Journal & Memory" summary="Keep original notes intact and build an evidence-linked account over time." /><div className="journal-grid"><SourceForm busy={busy} onSubmit={importText} /><section className="panel journal-empty"><div className="journal-mark">▤</div><h2>Your notes remain yours.</h2><p>Imported text is preserved as a source. Dated events, conflicting accounts, and memory summaries will appear here as those workflows are added.</p><span className="status-pill">SOURCE STORAGE READY · EXTRACTION IN PROGRESS</span></section></div></>;
}

function ScenarioPage({ branchId, revision, entities, relations, onBranch }: { branchId: string; revision: number; entities: Entity[]; relations: Relation[]; onBranch: () => void }) {
  return <><PageHeader kicker="Alternate futures" title="Decision & Scenario Lab" summary="Explore changes on a branch that keeps its starting point and never silently alters the main world." action={<button className="primary-button" onClick={() => void onBranch()}>Create scenario branch <span>↗</span></button>} /><div className="scenario-banner"><div className="branch-symbol">◇</div><div><strong>{branchId === "main" ? "You’re viewing the main branch" : `Exploring ${branchId}`}</strong><p>{branchId === "main" ? "Create a snapshot before changing assumptions or exploring an alternate event." : "Changes in this branch stay isolated from its parent."}</p></div><span className="revision-chip">Base view · revision {revision}</span></div><div className="scenario-grid"><section className="panel"><div className="panel-heading"><div><h2>Current structure</h2><p>Knowledge carried into this branch</p></div></div><div className="scenario-stats"><div><strong>{entities.length}</strong><small>concepts</small></div><div><strong>{relations.length}</strong><small>relationships</small></div><div><strong>{relations.filter((item) => item.review_status === "proposed").length}</strong><small>proposals</small></div></div><div className="branch-note">Branch writes use the same revision checks and audit trail as the main workspace.</div></section><section className="panel"><div className="panel-heading"><div><h2>Compare outcomes</h2><p>Assumptions and rule-based consequences</p></div></div><p className="empty-hint">Scenario evaluation and branch comparison are not implemented yet. The branch foundation is ready for isolated changes.</p></section></div></>;
}
