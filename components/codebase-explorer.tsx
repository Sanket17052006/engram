'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Braces, Boxes, ChevronRight, CircleHelp, FileCode2, FlaskConical, LoaderCircle, Network, RefreshCw, Search, X } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { readUserModelConfig } from '@/lib/byo-model';

type GraphNode = { id: string; type: string; label: string; properties: Record<string, unknown> };
type GraphEdge = { id: string; source: string; target: string; type: string };
type GraphData = { nodes: GraphNode[]; edges: GraphEdge[]; meta?: { repository?: string; importedAt?: string; filesScanned?: number; truncated?: boolean; branch?:string; commit?:string } };
type RepositoryIssue = { number:number; title:string; state:string };
type Kind = 'All' | 'Files' | 'Symbols' | 'Tests' | 'Imports';
type Area = 'All areas' | 'FastAPI' | 'UI' | 'Docs' | 'Solr & search' | 'Infogami';
const kinds: Kind[] = ['All', 'Files', 'Symbols', 'Tests', 'Imports'];
const areas: Exclude<Area, 'All areas'>[] = ['FastAPI', 'UI', 'Docs', 'Solr & search', 'Infogami'];

function belongsToArea(node: GraphNode, area: Exclude<Area, 'All areas'>) {
  const path = String(node.properties.path ?? '').toLowerCase().replaceAll('\\', '/');
  if (area === 'FastAPI') return /(^|\/)(fastapi|api)(\/|\.|$)/.test(path) || path.includes('fastapi');
  if (area === 'UI') return /(^|\/)(ui|web|frontend|templates|components)(\/|\.|$)/.test(path) || /\.(tsx|jsx)$/.test(path);
  if (area === 'Docs') return /(^|\/)(docs?|documentation)(\/|\.|$)/.test(path);
  if (area === 'Solr & search') return /(^|\/)(solr|search)(\/|\.|$)/.test(path) || path.includes('solr');
  return path.includes('infogami') || path.endsWith('/web.py') || path === 'web.py';
}

function point(index: number, count: number) {
  const angle = index * 2.399963;
  const radius = 12 + Math.min(30, Math.sqrt(index + 1) * 5.5);
  return { x: 50 + Math.cos(angle) * radius, y: 50 + Math.sin(angle) * radius };
}

export function CodebaseExplorer() {
  const router = useRouter();
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [busy, setBusy] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('All');
  const [area, setArea] = useState<Area>('All areas');
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [issues, setIssues] = useState<RepositoryIssue[]>([]);
  const [selectedIssue, setSelectedIssue] = useState('');
  const [issueRepository, setIssueRepository] = useState('');
  const [refreshingIssues, setRefreshingIssues] = useState(false);
  const [issueError, setIssueError] = useState('');
  const [fixingIssue, setFixingIssue] = useState(false);
  const [fixError, setFixError] = useState('');
  const [fixStage, setFixStage] = useState('');

  async function load() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/codebase/graph', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not read the code graph.');
      setGraph(data);
      if(typeof data.meta?.repository==='string')setIssueRepository(current=>current||data.meta.repository);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the code graph.');
      setGraph(null);
    } finally { setBusy(false); }
  }

  async function importSource() {
    setImporting(true); setError('');
    try {
      const response = await fetch('/api/codebase/import', { method: 'POST', cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Code graph import failed.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Code graph import failed.');
    } finally { setImporting(false); }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    let active = true;
    fetch('/api/github/sync', { cache: 'no-store' }).then(async response => {
      if (!response.ok) return;
      const snapshot = await response.json();
      if (!active) return;
      const recentIssues = Array.isArray(snapshot.issues) ? snapshot.issues as RepositoryIssue[] : [];
      setIssueRepository(typeof snapshot.repository==='string'?snapshot.repository:'');
      setIssues(recentIssues);
      setSelectedIssue(current => current || String(recentIssues[0]?.number ?? ''));
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  async function refreshRepositoryIssues(){
    if(!issueRepository||refreshingIssues)return;
    setRefreshingIssues(true);setIssueError('');
    try{
      const response=await fetch('/api/github/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repository:issueRepository}),cache:'no-store'});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Could not refresh issues from GitHub.');
      const latest=Array.isArray(result.issues)?result.issues as RepositoryIssue[]:[];
      setIssues(latest);setSelectedIssue(current=>latest.some(issue=>String(issue.number)===current)?current:String(latest[0]?.number??''));
      setIssueRepository(typeof result.repository==='string'?result.repository:issueRepository);
    }catch(cause){setIssueError(cause instanceof Error?cause.message:'Could not refresh issues from GitHub.')}
    finally{setRefreshingIssues(false)}
  }
  async function fixSelectedIssue(){
    const issue=issues.find(item=>String(item.number)===selectedIssue);
    if(!issue||fixingIssue)return;
    setFixingIssue(true);setFixError('');setFixStage('Refreshing the selected repository source from GitHub and rebuilding its FalkorDB code graph…');
    try{
      const imported=await fetch('/api/codebase/import',{method:'POST',cache:'no-store'});
      const importResult=await imported.json();
      if(!imported.ok)throw new Error(importResult.error||'Could not refresh source code in FalkorDB.');
      setFixStage(`Indexed ${importResult.filesScanned??'current'} source files at ${String(importResult.commit??'').slice(0,12)||'the latest branch head'}. Querying issue evidence and preparing a local repair…`);
      const response=await fetch('/api/code-repair/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issueNumber:issue.number,modelConfig:readUserModelConfig()}),cache:'no-store'});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Engram could not prepare this issue fix.');
      router.push(`/workspace/connected/review/${encodeURIComponent(result.id)}`);
    }catch(cause){setFixError(cause instanceof Error?cause.message:'Engram could not prepare this issue fix.');setFixingIssue(false);setFixStage('')}
  }
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  const counts = useMemo(() => ({
    Files: nodes.filter(n => n.type === 'CodeFile').length,
    Symbols: nodes.filter(n => n.type === 'CodeSymbol').length,
    Tests: nodes.filter(n => n.type === 'TestFile').length,
    Imports: edges.filter(e => e.type === 'IMPORTS').length,
  }), [nodes, edges]);
  const areaCounts = useMemo(() => Object.fromEntries(areas.map(item => [item, nodes.filter(node => belongsToArea(node, item)).length])) as Record<Exclude<Area, 'All areas'>, number>, [nodes]);
  const areaSeedIds = useMemo(() => {
    if (area === 'All areas') return null;
    return new Set(nodes.filter(node => belongsToArea(node, area)).map(node => node.id));
  }, [nodes, area]);
  const areaContextIds = useMemo(() => {
    if (!areaSeedIds) return null;
    const ids = new Set(areaSeedIds);
    for (const edge of edges) if (areaSeedIds.has(edge.source) || areaSeedIds.has(edge.target)) {
      ids.add(edge.source);
      ids.add(edge.target);
    }
    return ids;
  }, [areaSeedIds, edges]);
  const shown = useMemo(() => nodes.filter(node => {
    const matchesArea = !areaContextIds || areaContextIds.has(node.id);
    const matchesKind = kind === 'All' || kind === 'Files' && node.type === 'CodeFile' || kind === 'Tests' && node.type === 'TestFile' || kind === 'Symbols' && node.type === 'CodeSymbol' || kind === 'Imports' && edges.some(e => e.type === 'IMPORTS' && (e.source === node.id || e.target === node.id));
    const matchesSearch = `${node.label} ${node.type} ${node.properties.path ?? ''}`.toLowerCase().includes(query.toLowerCase());
    return matchesArea && matchesKind && matchesSearch;
  }), [nodes, edges, kind, query, areaContextIds]);
  const shownIds = useMemo(() => new Set(shown.map(n => n.id)), [shown]);
  const shownEdges = edges.filter(edge => shownIds.has(edge.source) && shownIds.has(edge.target));
  const degree = new Map<string, number>();
  for (const edge of shownEdges) { degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1); degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1); }
  const canvasLimit = area === 'All areas' ? 100 : 48;
  const canvasNodes = [...shown].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, canvasLimit);
  const positioned = canvasNodes.map((node, index) => ({ node, ...point(index, canvasNodes.length) }));
  const pos = new Map(positioned.map(item => [item.node.id, item]));
  const selectedEdges = selected ? edges.filter(edge => edge.source === selected.id || edge.target === selected.id) : [];

  return <div className="app-shell code-graph-shell">
    <aside className="sidebar">
      <Link href="/" className="side-logo"><span className="side-mark"><BrandMark size={36} /></span>engram<span className="brand-dot">.</span></Link>
      <div className="workspace-select"><span className="ws-avatar">CG</span><div><strong>Codebase graph</strong><small>{graph?.meta?.repository ?? 'Selected repository'}</small></div></div>
      <div className="side-label">PROJECT MEMORY</div>
      <nav className="side-navigation" aria-label="Repository navigation">
        <Link className="side-link" href="/workspace/connected"><Network/><span className="side-link-copy"><strong>Project overview</strong><small>GitHub activity and findings</small></span></Link>
        <Link className="side-link" href="/workspace/connected/explore"><Boxes/><span className="side-link-copy"><strong>Activity graph</strong><small>People, PRs, issues, reviews</small></span></Link>
        <Link className="side-link active" aria-current="page" href="/workspace/connected/code"><FileCode2/><span className="side-link-copy"><strong>Code graph</strong><small>Files, symbols, tests, imports</small></span></Link>
      </nav>
      <div className="side-spacer"/><div className="graph-status"><small><i className="status-pulse"/> CODE STRUCTURE</small><p>{nodes.length} nodes · {edges.length} links</p></div>
    </aside>
    <div className="main-area">
      <header className="app-header"><div className="breadcrumb"><Link href="/workspace/connected">Project memory</Link><span>/</span><strong>Code graph</strong></div><div className="header-tools"><span className="answer-tag"><i/> FalkorDB · repository code</span><button className="text-link" onClick={() => void load()} disabled={busy}><RefreshCw size={13} className={busy ? 'spin' : ''}/> Refresh</button></div></header>
      <main className="code-graph-content">
        <section className="code-repair-entry" aria-label="Investigate a repository issue">
          <span><strong>Investigate and fix a GitHub issue</strong><small>{issues.length?`${issues.length} recent issues in ${issueRepository||'the selected repository'} · refreshed from GitHub and represented in FalkorDB`:'Load recent issues from the selected repository into FalkorDB, then investigate them with graph evidence.'}</small></span>
          {issues.length>0&&<select aria-label="Choose an issue to investigate" value={selectedIssue} onChange={event=>setSelectedIssue(event.target.value)}>{issues.map(issue=><option key={issue.number} value={issue.number}>#{issue.number} · {issue.title} ({issue.state})</option>)}</select>}
          <button className="text-link" onClick={()=>void refreshRepositoryIssues()} disabled={!issueRepository||refreshingIssues}>{refreshingIssues?<LoaderCircle className="spin" size={14}/>:<RefreshCw size={14} className={refreshingIssues?'spin':''}/>} {refreshingIssues?'Refreshing GitHub…':'Refresh from GitHub'}</button>
          {issues.length>0&&<button type="button" className="button-primary" onClick={()=>void fixSelectedIssue()} disabled={fixingIssue||!selectedIssue}>{fixingIssue?<LoaderCircle className="spin" size={15}/>:<ArrowRight size={15}/>} {fixingIssue?'Investigating graph and preparing fix…':'Fix selected issue'}</button>}
          {!issues.length&&!refreshingIssues&&<span className="issue-picker-empty">No cached issues yet. Refresh from GitHub to import them.</span>}
          {issueError&&<span className="issue-picker-error" role="alert">{issueError}</span>}
          {fixingIssue&&<span className="issue-picker-empty" role="status"><LoaderCircle className="spin" size={14}/>{fixStage||'FalkorDB investigation → isolated upstream branch → patch generation → targeted checks. This can take a few minutes.'}</span>}
          {fixError&&<span className="issue-picker-error" role="alert">{fixError}</span>}
        </section>
        <section className="code-graph-heading"><div><span className="pane-label"><Braces size={14}/> SOURCE CODE RELATIONSHIPS</span><h1>Follow code paths.</h1><p>Engram fetches a bounded source snapshot from the selected repository’s current upstream/default branch. FalkorDB stores files, Python symbols, tests, and their actual import/test relationships for graph-grounded issue repair.</p></div><button className="button-primary" onClick={() => void importSource()} disabled={importing || busy}>{importing ? <LoaderCircle className="spin" size={16}/> : <FileCode2 size={16}/>} {importing ? 'Fetching GitHub source…' : nodes.length ? 'Refresh code graph' : 'Import current source'} <ArrowRight size={15}/></button></section>
        {error && <div className="setup-alert" role="alert">{error}</div>}
        <section className="code-graph-filter-stack" aria-label="Code graph filters"><div className="code-graph-area-filter"><div><strong>Browse by area</strong><small>{area === 'All areas' ? 'Choose a subsystem for a focused view' : `${area} · nearby connected records included`}</small></div><div className="code-graph-area-pills" role="group" aria-label="Repository area"> <button className={area === 'All areas' ? 'selected' : ''} onClick={() => setArea('All areas')}>All areas<span>{nodes.length}</span></button>{areas.filter(item => areaCounts[item] > 0).map(item => <button key={item} className={area === item ? 'selected' : ''} onClick={() => setArea(item)}>{item}<span>{areaCounts[item]}</span></button>)}</div></div><section className="code-graph-toolbar"><div className="code-graph-filters" role="tablist" aria-label="Filter code graph by record type">{kinds.map(item => <button key={item} role="tab" aria-selected={kind === item} className={kind === item ? 'selected' : ''} onClick={() => setKind(item)}>{item}<span className="graph-filter-count">{item === 'All' ? nodes.length : counts[item]}</span></button>)}</div><label className="code-graph-search"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder={area === 'All areas' ? 'Find a file or symbol' : `Search within ${area}`} aria-label="Search code graph"/></label></section></section>
        {!graph?.nodes.length && !busy ? <section className="code-graph-empty"><span><FileCode2 size={22}/></span><h2>Build the code structure graph</h2><p>Engram fetches the selected repository source through its GitHub installation, parses it without executing code, then stores source files, symbols, test files, and detected relationships in FalkorDB.</p><button className="button-dark" onClick={() => void importSource()} disabled={importing}>{importing ? <LoaderCircle className="spin" size={15}/> : <Boxes size={15}/>} {importing ? 'Fetching source and indexing…' : 'Import selected GitHub repository'}</button></section> : <section className="code-graph-workspace">
          <div className="code-graph-canvas" aria-label="Repository code relationship graph">
            {busy && !graph && <div className="code-graph-loading"><LoaderCircle className="spin" size={18}/> Loading code graph…</div>}
            {!shown.length && graph && <div className="code-graph-loading">No code records match this filter.</div>}
            {shown.length > canvasLimit && <div className="code-graph-limit">Canvas shows the {canvasLimit} most-connected of {shown.length} matching nodes. Search or choose an area to narrow the view.</div>}
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{shownEdges.map(edge => { const from = pos.get(edge.source), to = pos.get(edge.target); return from && to ? <g key={edge.id}><line x1={`${from.x}%`} y1={`${from.y}%`} x2={`${to.x}%`} y2={`${to.y}%`} className={`code-edge edge-${edge.type.toLowerCase()}`}/><title>{edge.type}</title></g> : null; })}</svg>
            {positioned.map(({node, x, y}) => <button key={node.id} className={`code-graph-node type-${node.type.toLowerCase()} ${selected?.id === node.id ? 'active' : ''}`} style={{left: `${x}%`, top: `${y}%`}} onClick={() => setSelected(node)} title={`${node.type}: ${node.label}`}><i/>{node.label.length > 46 ? `${node.label.slice(0, 43)}…` : node.label}</button>)}
            <div className="code-graph-legend"><span><i className="legend-file"/>Files</span><span><i className="legend-symbol"/>Symbols</span><span><i className="legend-test"/>Tests</span><span><i className="legend-edge"/>Imports</span></div>
          </div>
          <aside className="code-graph-sidepanel">{selected ? <><div className="code-detail-top"><span className="pane-label">{selected.type.replace('Code','').toUpperCase()}</span><button className="detail-close-button" onClick={() => setSelected(null)} aria-label="Close code details"><X size={15}/></button></div><h2>{selected.label}</h2><code className="code-detail-path">{String(selected.properties.path ?? selected.properties.id ?? '')}</code>{typeof selected.properties.summary === 'string' && selected.properties.summary && <p>{selected.properties.summary}</p>}<div className="node-section"><h3>RECORD DETAILS</h3>{Object.entries(selected.properties).filter(([key]) => !['repository','sourceType','graphKey','id','path','summary'].includes(key)).slice(0, 8).map(([key, value]) => <div className="code-detail-prop" key={key}><small>{key}</small><span>{String(value)}</span></div>)}</div><div className="node-section"><h3>DIRECT CONNECTIONS · {selectedEdges.length}</h3>{selectedEdges.slice(0, 20).map(edge => { const other = nodes.find(node => node.id === (edge.source === selected.id ? edge.target : edge.source)); return other ? <button className="connected-record-row" key={edge.id} onClick={() => setSelected(other)}><span><small>{edge.type.toLowerCase()}</small><br/>{other.label}</span><ChevronRight size={12}/></button> : null; })}{!selectedEdges.length && <p>No indexed relationships found for this record.</p>}</div></> : <><span className="code-graph-panel-icon"><CircleHelp size={18}/></span><h2>Inspect a code record</h2><p>Select a node to see its path, summary, file properties, and direct relationships.</p><div className="node-section"><h3>GRAPH MODEL</h3><p><strong>CodeFile</strong> nodes connect to <strong>CodeSymbol</strong> nodes through DEFINES. Local source imports become IMPORTS edges; matching test files link to modules through TESTS.</p></div></>}</aside>
        </section>}
        <footer className="code-graph-footer"><span>{graph?.meta?.filesScanned ? `${graph.meta.filesScanned} source files scanned` : 'No code import yet'}{graph?.meta?.branch ? ` · ${graph.meta.branch}` : ''}{graph?.meta?.commit ? ` · ${graph.meta.commit.slice(0,12)}` : ''}{graph?.meta?.importedAt ? ` · imported ${new Date(graph.meta.importedAt).toLocaleString()}` : ''}{graph?.meta?.truncated ? ' · bounded at the 2,500 file import limit' : ''}</span><span>Source is parsed as text; repository code is never executed.</span></footer>
      </main>
    </div>
  </div>;
}
