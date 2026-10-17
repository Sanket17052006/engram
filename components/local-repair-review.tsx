'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, CircleAlert, FileCode2, GitBranch, LoaderCircle, Search, Sparkles, X } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';

type Review = { id:string; issue: { number: number; title: string; body?:string; url?:string }; repository:string; summary: string; branch: string; originalBranch:string; stashedChanges:string|null; baseRef:string; baseCommit: string; commitCreated:boolean; changedFiles:string[]; diff: string; checks:{status:'passed'|'failed'|'not-run';passed:number|null;output:string;command:string[]}; graphTrace:{nodes:{id:string;type:string;label:string;path:string}[];edges:{id:string;source:string;target:string;type:string}[]};graphEvidence:{answer:string;cypher:string;rows:Record<string,unknown>[];sources:Record<string,unknown>[]} };
type ChangeFile = { path: string; lines: string[]; added: number; removed: number };
type Neighborhood = { nodes: { id: string; type: string; label: string; path: string }[]; edges: { id: string; source: string; target: string; type: string }[]; source: string };
type Tab = 'Summary' | 'Changes' | 'Graph trace' | 'Checks';

const kindColors: Record<string, string> = { CodeFile: '#ed821a', TestFile: '#5e8968', CodeSymbol: '#7087a6' };

function graphPosition(node: Neighborhood['nodes'][number], index: number, count: number, height: number) {
  const groups = ['CodeFile', 'CodeSymbol', 'TestFile'];
  const group = Math.max(0, groups.indexOf(node.type));
  const inGroup = Math.max(1, count);
  const y = 54 + (index % inGroup) * ((height - 108) / Math.max(1, inGroup - 1));
  return { x: 150 + group * 300, y: count === 1 ? height / 2 : y };
}

function splitDiff(diff: string): ChangeFile[] {
  const files: ChangeFile[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = line.split(' b/')[1] ?? 'Changed file';
      files.push({ path, lines: [line], added: 0, removed: 0 });
      continue;
    }
    const current = files[files.length - 1];
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) current.added += 1;
    if (line.startsWith('-') && !line.startsWith('---')) current.removed += 1;
  }
  return files;
}

export function LocalRepairReview({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [runningChecks, setRunningChecks] = useState(false);
  const [checks, setChecks] = useState<{ status: 'passed' | 'failed' | 'not-run'; passed?: number | null; output: string; command?:string[] } | null>(null);
  const [neighborhood, setNeighborhood] = useState<Neighborhood | null>(null);
  const [loadingNeighborhood, setLoadingNeighborhood] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('Summary');
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [nodeTypeFilter, setNodeTypeFilter] = useState<string[]>([]);
  const [edgeTypeFilter, setEdgeTypeFilter] = useState<string[]>([]);
  const [focusedNode, setFocusedNode] = useState<string | null>(null);

  async function loadReview() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/code-repair/' + encodeURIComponent(runId), { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load this review.');
      setReview(data);
      if(data.checks)setChecks(data.checks);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load this review.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void loadReview(); }, [runId]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('step') === 'investigate') setActiveTab('Graph trace');
  }, [runId]);
  const files = useMemo(() => splitDiff(review?.diff ?? ''), [review?.diff]);
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  const visibleFiles = files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase()) || file.lines.some(line => line.toLowerCase().includes(filter.toLowerCase())));
  const nodeTypes = Array.from(new Set(neighborhood?.nodes.map(node => node.type) ?? []));
  const edgeTypes = Array.from(new Set(neighborhood?.edges.map(edge => edge.type) ?? []));
  const visibleNodes = neighborhood?.nodes.filter(node => !nodeTypeFilter.length || nodeTypeFilter.includes(node.type)) ?? [];
  const visibleNodeIds = new Set(visibleNodes.map(node => node.id));
  const visibleEdges = neighborhood?.edges.filter(edge => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target) && (!edgeTypeFilter.length || edgeTypeFilter.includes(edge.type))) ?? [];
  const groupCounts = visibleNodes.reduce<Record<string, number>>((counts, node) => ({ ...counts, [node.type]: (counts[node.type] ?? 0) + 1 }), {});
  const graphHeight = Math.max(410, Math.max(0, ...Object.values(groupCounts)) * 54 + 108);
  const groupIndexes: Record<string, number> = {};
  const positions = new Map(visibleNodes.map(node => {
    const index = groupIndexes[node.type] ?? 0;
    groupIndexes[node.type] = index + 1;
    return [node.id, graphPosition(node, index, groupCounts[node.type], graphHeight)];
  }));

  function toggleFilter(value: string, current: string[], setter: (next: string[]) => void) {
    setter(current.includes(value) ? current.filter(item => item !== value) : [...current, value]);
  }

  useEffect(() => {
    if (activeTab !== 'Graph trace' || !review || neighborhood || loadingNeighborhood) return;
    const paths = files.map(file => file.path);
    setLoadingNeighborhood(true);
    fetch('/api/codebase/neighborhood', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }), cache: 'no-store' })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not trace changed files.'); setNeighborhood(data); })
      .catch(cause => setError(cause instanceof Error ? cause.message : 'Could not trace changed files.'))
      .finally(() => setLoadingNeighborhood(false));
  }, [activeTab, review, neighborhood, loadingNeighborhood]);

  async function runChecks() {
    setRunningChecks(true); setError(''); setActiveTab('Checks');
    try {
      const response = await fetch('/api/code-repair/' + encodeURIComponent(runId), { method: 'POST', cache: 'no-store' });
      const result = await response.json();
      setChecks(result);
      if (!response.ok) throw new Error(result.output || 'The verification run failed.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not run verification.'); }
    finally { setRunningChecks(false); }
  }

  const tabs: Tab[] = ['Summary', 'Changes', 'Graph trace', 'Checks'];
  return <div className="app-shell local-review-shell">
    <aside className="sidebar"><Link href="/" className="side-logo"><span className="side-mark"><BrandMark size={36}/></span>engram<span className="brand-dot">.</span></Link><div className="side-label">CODE REVIEW</div><Link className="side-link" href={'/workspace/' + encodeURIComponent(workspaceId) + '/code'}><ArrowLeft/><span>Back to code graph</span></Link><div className="side-spacer"/><div className="graph-status"><small><FileCode2 size={12}/> CHANGE REVIEW</small><p>{review ? files.length + ' files in this change' : 'Loading review context'}</p></div></aside>
    <div className="main-area"><header className="app-header"><div className="breadcrumb"><Link href={'/workspace/' + encodeURIComponent(workspaceId)}>Project memory</Link><span>/</span><strong>Review issue #{runId}</strong></div><span className="answer-tag"><i/> Patch review</span></header>
      <main className="local-review-content"><Link className="text-link" href={'/workspace/' + encodeURIComponent(workspaceId) + '/code'}><ArrowLeft size={14}/> Back to code graph</Link>
        <section className="local-review-heading"><span className="pane-label"><FileCode2 size={14}/> ISSUE-DRIVEN CHANGE REVIEW</span><h1>Review the proposed change.</h1><p>Trace the reported issue to the code, inspect the patch, and run targeted checks.</p></section>
        <div className="repair-progress" aria-label="Review workflow"><button className="repair-step done" onClick={() => setActiveTab('Summary')}><span><Check size={13}/></span><div><strong>Issue</strong><small>Context loaded</small></div></button><i/><button className={'repair-step ' + (files.length ? 'done' : '')} onClick={() => setActiveTab('Changes')}><span>{files.length ? <Check size={13}/> : '2'}</span><div><strong>Patch</strong><small>{files.length} files · +{added} / −{removed}</small></div></button><i/><button className={'repair-step ' + (checks?.status === 'passed' ? 'done' : checks?.status === 'failed' ? 'failed' : runningChecks ? 'working' : '')} onClick={() => setActiveTab('Checks')}><span>{runningChecks ? <LoaderCircle size={13} className="spin"/> : checks?.status === 'passed' ? <Check size={13}/> : checks?.status === 'failed' ? <CircleAlert size={13}/> : '3'}</span><div><strong>Checks</strong><small>{runningChecks ? 'Running now' : checks?.status === 'passed' ? `${checks.passed ?? 'All'} passed` : checks?.status === 'failed' ? 'Review output' : 'Not run yet'}</small></div></button><i/><button className="repair-step current" onClick={() => setActiveTab('Summary')}><span>4</span><div><strong>Review</strong><small>Choose a section</small></div></button></div>
        {error && <div className="setup-alert"><CircleAlert size={16}/><span>{error}</span><button onClick={() => void loadReview()} aria-label="Reload review">Retry</button></div>}
        {loading && <div className="local-review-state"><LoaderCircle className="spin" size={18}/> Loading issue context and current patch…</div>}
        {review && <><section className="local-review-issue"><div><span className="pane-label">ISSUE #{review.issue.number} · {review.repository}</span><h2>{review.issue.title}</h2><div className="issue-report"><span>THE REPORTED ISSUE</span><p>{review.issue.body||'No description was provided on GitHub.'}</p>{review.issue.url&&<a href={review.issue.url} target="_blank" rel="noreferrer">Open original issue <ArrowRight size={12}/></a>}</div><p className="repair-summary"><strong>Engram's proposed fix</strong>{review.summary}</p><div className="review-branch"><GitBranch size={13}/><code>{review.branch}</code><span>based on</span><code>{review.baseRef} · {review.baseCommit}</code></div><small className="repair-commit-state">{review.commitCreated?`Committed in your Open Library checkout; branch is active and nothing was pushed.${review.stashedChanges?` Previous local changes are preserved in stash ${review.stashedChanges}.`:''}`:'Patch is available for review but has not been committed.'}</small></div><span className="local-only-badge"><CheckCircle2 size={15}/>{checks?.status === 'passed' ? 'Checks passed' : checks?.status === 'failed' ? 'Check failures' : 'Review ready'}</span></section>
          <nav className="review-tabs" aria-label="Review sections">{tabs.map(tab => <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>{tab}{tab === 'Changes' && <small>{files.length}</small>}{tab === 'Checks' && checks?.status === 'passed' && <CheckCircle2 size={13}/>}</button>)}</nav>
          {activeTab === 'Summary' && <><section className="review-spotlight"><div className="review-spotlight-orb"><Sparkles size={18}/></div><div><span className="pane-label">CHANGE AT A GLANCE</span><h3>{files.length} files changed · {review.graphTrace.nodes.length} graph nodes · {review.graphTrace.edges.length} graph relationships.</h3><p>{checks?.status === 'passed' ? `${checks.passed ?? 'The targeted'} tests passed. Inspect the commit, graph trace, or test output.` : checks?.status === 'failed' ? 'The agent committed the proposed fix locally; inspect the failed checks before approval.' : 'Inspect the proposed diff and the source graph evidence before approval.'}</p></div><button className="button-primary" onClick={() => checks?.status === 'passed' ? setActiveTab('Changes') : void runChecks()} disabled={runningChecks}>{runningChecks ? <LoaderCircle size={15} className="spin"/> : checks?.status === 'passed' ? <FileCode2 size={14}/> : <CheckCircle2 size={14}/>} {runningChecks ? 'Running checks…' : checks?.status === 'passed' ? 'Inspect patch' : 'Run focused checks'}</button></section><section className="review-stat-grid"><article><span>FILES CHANGED</span><strong>{files.length}</strong><small>committed on {review.branch}</small></article><article className="stat-add"><span>ADDITIONS</span><strong>+{added}</strong><small>lines added</small></article><article className="stat-remove"><span>REMOVALS</span><strong>−{removed}</strong><small>lines removed</small></article><article><span>VALIDATION</span><strong>{checks?.status === 'passed' ? checks.passed ?? 'Passed' : checks?.status === 'failed' ? 'Failed' : 'Not run'}</strong><small>{checks?.status === 'passed' ? 'targeted tests passed' : checks?.status === 'failed' ? 'inspect the test output' : 'graph-linked checks were not available'}</small></article></section><section className="local-review-overview"><div><span className="pane-label">CHANGE SUMMARY</span><p>{review.summary}</p></div><button className="button-primary" onClick={() => setActiveTab('Changes')}>Review changed files <ArrowRight size={14}/></button></section><section className="review-graph-teaser"><div className="review-graph-copy"><span className="pane-label">FALKORDB CODE GRAPH</span><h3>Follow the issue into the code.</h3><p>Inspect the graph-derived source files and their real import, symbol, and test relationships alongside the issue investigation evidence.</p><Link className="text-link" href={`/workspace/${encodeURIComponent(workspaceId)}/review/${encodeURIComponent(runId)}/graph`}>Open issue-fix graph <ArrowRight size={13}/></Link></div><div className="review-path-visual"><strong>{files.length}</strong><small>changed files</small><span>→</span><strong>{review.graphTrace.nodes.length}</strong><small>FalkorDB nodes</small></div></section></>}
          {activeTab === 'Changes' && <section className="review-changes"><div className="review-change-toolbar"><div><h2>Changed files</h2><p>Search the patch or open a file to inspect its line-by-line diff.</p></div><label><Search size={15}/><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search changed files" aria-label="Search changes"/></label></div>{visibleFiles.map(file => <article className="review-file" key={file.path}><button className="review-file-head" onClick={() => setExpanded(expanded === file.path ? null : file.path)}><span><FileCode2 size={15}/><code>{file.path}</code></span><span className="file-diff-count"><b>+{file.added}</b><em>−{file.removed}</em><strong>{expanded === file.path ? 'Hide' : 'Review'}</strong></span></button>{expanded === file.path && <div className="diff-card">{file.lines.map((line,index)=><div key={index} className={'diff-line ' + (line.startsWith('+')&&!line.startsWith('+++')?'diff-added':line.startsWith('-')&&!line.startsWith('---')?'diff-removed':line.startsWith('@@')?'diff-hunk':'')}><span>{line.startsWith('+')&&!line.startsWith('+++')?'+':line.startsWith('-')&&!line.startsWith('---')?'-':' '}</span><code>{line.startsWith('+')||line.startsWith('-')||line.startsWith(' ')?line.slice(1):line}</code></div>)}</div>}</article>)}{!visibleFiles.length && <p className="review-empty">No changed files or lines match “{filter}”.</p>}</section>}
          {activeTab === 'Graph trace' && <section className="review-trace"><div className="review-trace-head"><div><span className="pane-label">FALKORDB · CODE RELATIONSHIPS</span><h2>Trace code context for issue #{review.issue.number}.</h2><p>These stored file, symbol, and test links come from the indexed graph for paths in the current patch. Select a node to inspect its nearby code relationships.</p></div><div className="review-trace-actions"><Link className="button-primary" href={'/workspace/' + encodeURIComponent(workspaceId) + '/code'}>Open full graph <ArrowRight size={14}/></Link><button className="button-primary" onClick={() => setActiveTab('Changes')}>Continue to patch review <ArrowRight size={14}/></button></div></div>{loadingNeighborhood&&<div className="local-review-state"><LoaderCircle size={16} className="spin"/> Querying FalkorDB for affected file neighborhoods…</div>}{neighborhood&&<><div className="trace-summary"><strong>{visibleNodes.length} nodes</strong><span>·</span><strong>{visibleEdges.length} relationships</strong><span>·</span><span>source: {neighborhood.source}</span><button className="trace-reset" onClick={()=>{setNodeTypeFilter([]);setEdgeTypeFilter([]);setFocusedNode(null)}}>Reset view</button></div><div className="trace-filter-row"><span>Show nodes</span>{nodeTypes.map(type=><button key={type} className={!nodeTypeFilter.length||nodeTypeFilter.includes(type)?'selected':''} onClick={()=>toggleFilter(type,nodeTypeFilter,setNodeTypeFilter)}><i style={{background:kindColors[type]??'#8b938a'}}/>{type}<small>{neighborhood.nodes.filter(node=>node.type===type).length}</small></button>)}<span className="trace-filter-divider"/> <span>Relationships</span>{edgeTypes.map(type=><button key={type} className={!edgeTypeFilter.length||edgeTypeFilter.includes(type)?'selected':''} onClick={()=>toggleFilter(type,edgeTypeFilter,setEdgeTypeFilter)}>{type}</button>)}</div><div className="trace-canvas-wrap"><svg className="trace-canvas" viewBox={`0 0 900 ${graphHeight}`} role="img" aria-label="Interactive FalkorDB code graph neighborhood">{visibleEdges.map((edge,index)=>{const start=positions.get(edge.source),end=positions.get(edge.target);return start&&end?<g key={edge.id} className={focusedNode&&edge.source!==focusedNode&&edge.target!==focusedNode?'dimmed':''}><path d={`M ${start.x} ${start.y} C ${(start.x+end.x)/2} ${start.y}, ${(start.x+end.x)/2} ${end.y}, ${end.x} ${end.y}`} className="trace-link"/><text x={(start.x+end.x)/2} y={(start.y+end.y)/2-5} className="trace-link-label">{focusedNode||index<24?edge.type:''}</text></g>:null})}{visibleNodes.map(node=>{const point=positions.get(node.id);return point?<g key={node.id} role="button" tabIndex={0} aria-label={`${node.type}: ${node.label}`} className={`trace-graph-node ${focusedNode===node.id?'focused':''} ${focusedNode&&focusedNode!==node.id?'dimmed':''}`} transform={`translate(${point.x-111},${point.y-20})`} onClick={()=>setFocusedNode(focusedNode===node.id?null:node.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setFocusedNode(focusedNode===node.id?null:node.id)}}}><rect width="222" height="40" rx="12"/><circle cx="14" cy="20" r="5"/><text x="27" y="17" className="trace-graph-kind">{node.type}</text><text x="27" y="31" className="trace-graph-label">{node.label.length>25?node.label.slice(0,24)+'…':node.label}</text></g>:null})}</svg><div className="trace-graph-legend">{nodeTypes.map(type=><span key={type}><i style={{background:kindColors[type]??'#8b938a'}}/>{type}</span>)}</div></div>{focusedNode&&<aside className="trace-focus-card"><div><span className="pane-label">SELECTED GRAPH NODE</span><button aria-label="Close selected node details" onClick={()=>setFocusedNode(null)}><X size={15}/></button></div>{(()=>{const node=neighborhood.nodes.find(item=>item.id===focusedNode);return node?<><strong>{node.label}</strong><span>{node.type} · {node.path}</span><small>{neighborhood.edges.filter(edge=>edge.source===focusedNode||edge.target===focusedNode).length} direct relationships in this view</small></>:null})()}</aside>}{!visibleEdges.length&&<p className="review-empty">No graph relationships match these filters. Turn on more node or relationship types to expand the trace.</p>}</>}</section>}
          {activeTab === 'Checks' && <section className="review-checks"><div className="review-checks-head"><span className="pane-label">TARGETED VALIDATION</span><h2>{checks?.status === 'passed' ? 'Checks passed.' : checks?.status === 'failed' ? 'Checks need attention.' : 'Run the graph-linked test suite.'}</h2><p>Engram chose test files connected to the affected code in FalkorDB and ran them in your active issue branch.</p>{checks&&checks.command&&checks.command.length>0&&<code className="check-command">{checks.command.join(' ')}</code>}<button className="button-primary" onClick={() => void runChecks()} disabled={runningChecks}>{runningChecks ? <LoaderCircle size={15} className="spin"/> : <CheckCircle2 size={15}/>} {runningChecks ? 'Running checks…' : checks?.status === 'passed' ? 'Run checks again' : 'Run targeted checks'}</button></div>{checks && <div className={'check-output ' + (checks.status === 'passed' ? 'passed' : 'failed')}><div><strong>{checks.status === 'passed' ? 'Passed' : checks.status === 'failed' ? 'Failed' : 'Not run'}{checks.passed ? ' · ' + checks.passed + ' tests' : ''}</strong><button onClick={() => void navigator.clipboard?.writeText(checks.output)}>Copy output</button></div><pre>{checks.output}</pre></div>}</section>}
          <footer className="local-review-actions"><span>{checks?.status === 'passed' ? 'Validation is complete. Review the committed patch above.' : checks?.status === 'failed' ? 'The branch is committed locally; checks failed. Review the test output carefully.' : 'Review the proposed changes and validation output.'}</span><button type="button" className="approve-patch-button" aria-label="Approve patch" title="Approve patch">Approve patch <CheckCircle2 size={14}/></button></footer>
        </>}
      </main></div></div>;
}
