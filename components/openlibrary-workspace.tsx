'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight, BookOpen, Database, GitPullRequest, Github, LoaderCircle, MessageSquareText, Search, Send, ShieldCheck } from 'lucide-react';

type Item = { number: number; title: string; state: string; url: string; author: string; comments: number };
type Source = { title: string; url: string; role: string };
type Project = { repository: string; pulls: Item[]; issues: Item[]; graph: string; syncedAt?: string; latestActivityAt?: string | null; counts: { pullRequests: number; issues: number; reviews: number; files: number } };

export function OpenLibraryWorkspace() {
  const [data, setData] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<Item[]>([]);
  const [evidence, setEvidence] = useState<Source[]>([]);
  const [cypher, setCypher] = useState('');
  const [querySource, setQuerySource] = useState('');
  const [agent, setAgent] = useState('');
  const [memoryCount, setMemoryCount] = useState(0);
  const [selectedRepo,setSelectedRepo]=useState('');
  const [signedIn,setSignedIn]=useState('');

  async function checkAccount(){try{const response=await fetch('/api/github/status',{cache:'no-store'});const status=await response.json();setSignedIn(status.user?.login??'');if(status.selectedRepo){setSelectedRepo(status.selectedRepo);await load(status.selectedRepo)}}catch{}}
  useEffect(()=>{void checkAccount()},[]);

  async function load(repo=selectedRepo) {
    setBusy(true); setError('');
    try { const response = repo?await fetch('/api/github/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repository:repo})}):await fetch('/api/openlibrary', { method: 'POST',cache:'no-store' }); const result = await response.json(); if (!response.ok) throw Error(result.error); setData(repo?{repository:result.repository,pulls:result.pulls,issues:result.issues,graph:'falkordb',syncedAt:result.syncedAt,latestActivityAt:result.latestActivityAt,counts:{pullRequests:result.imported.pullRequests,issues:result.imported.issues,reviews:result.imported.reviews,files:result.imported.files}}:result); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load the repository.'); }
    finally { setBusy(false); }
  }

  async function ask() {
    if (!data || !prompt.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/openlibrary/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, records: [...data.pulls, ...data.issues] }) });
      const result = await response.json(); if (!response.ok) throw Error(result.error);
      setQuerySource(result.source); setCypher(result.cypher ?? ''); setSources(result.rows ?? []);
      setEvidence(result.sources ?? []); setAgent(result.handoff?.to ?? result.intent ?? 'Project Guide'); setMemoryCount(result.memory?.count ?? 0);
      setAnswer(result.answer ?? 'The graph did not return an answer.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not query project memory.'); }
    finally { setBusy(false); }
  }

  const activity = data ? [...data.pulls.slice(0, 5), ...data.issues.slice(0, 5)] : [];
  const repository = data?.repository ?? selectedRepo ?? 'internetarchive/openlibrary';
  const repositoryName = repository.split('/').pop() || 'Open Library';
  const repositoryUrl = `https://github.com/${repository}`;
  return <div className="app-shell">
    <aside className="sidebar">
      <Link href="/" className="side-logo"><span className="side-mark"><BookOpen size={17}/></span>engram<span className="brand-dot">.</span></Link>
      <div className="workspace-select"><span className="ws-avatar">{repositoryName.slice(0,2).toUpperCase()}</span><div><strong>{repositoryName}</strong><small>{signedIn?`Signed in as ${signedIn}`:'Public project graph'}</small></div></div>
      <div className="side-label">PROJECT MEMORY</div>
      <a className="side-link active" href="#overview"><Activity/><span>Overview</span></a>
      <a className="side-link" href="#activity"><GitPullRequest/><span>Pull requests & issues</span></a>
      <a className="side-link" href="#ask"><MessageSquareText/><span>Ask the project</span></a>
      <Link href="/workspace/openlibrary/explore" className="side-link"><GitPullRequest/><span>Explore graph</span></Link>
      <div className="side-spacer"/><div className="graph-status"><small><i className="status-pulse"/> DATA SOURCE</small><p>{repository}</p></div>
      <Link href="/setup/github" className="side-link"><Github/><span>Connect another repo</span></Link>
    </aside>
    <div className="main-area">
      <header className="app-header"><div className="breadcrumb"><span>Project memory</span><span>/</span><strong>{repository}</strong></div><div className="header-tools"><span className="answer-tag"><i/> {signedIn?`Connected as ${signedIn}`:'Public repository'}</span>{signedIn&&<form action="/api/github/logout" method="post"><button className="text-link" type="submit">Sign out</button></form>}</div></header>
      <main className="content ol-content" id="overview">
        <div className="ol-hero"><div><div className="eyebrow"><span className="pulse"/> CONTRIBUTOR KNOWLEDGE GRAPH</div><h1>Understand the work<br/>behind <em>{repositoryName}.</em></h1><p>Explore real pull requests and issues, trace contributor activity, and find context before you contribute.</p><div className="hero-actions"><button className="button-primary" onClick={()=>load(selectedRepo)} disabled={busy}>{busy?<LoaderCircle className="spin" size={16}/>:<Database size={16}/>} {data?'Refresh project data':'Load live project data'} <ArrowRight size={15}/></button><a href={repositoryUrl} target="_blank" rel="noreferrer" className="text-link">View repository <Github size={14}/></a></div></div><div className="ol-graph-card"><div className="pane-label">PROJECT CONTEXT CONNECTS</div><svg viewBox="0 0 360 210"><g className="ol-links"><path d="M55 55 170 92 292 48M170 92 92 160 250 165M292 48 250 165"/></g>{[['Pull request',55,55],['Contributor',170,92],['Issue',292,48],['File',92,160],['Review',250,165]].map(([label,x,y])=><g key={String(label)}><circle cx={Number(x)} cy={Number(y)} r="9"/><text x={Number(x)} y={Number(y)+26}>{label}</text></g>)}</svg><small>PRs · issues · contributors · reviews</small></div></div>
        {error&&<div className="setup-alert">{error}</div>}
        <div className="stat-grid ol-stats"><div className="stat-card"><small>Recent pull requests</small><strong>{data?.counts.pullRequests??'—'}</strong><em>{data?.syncedAt?`Synced ${new Date(data.syncedAt).toLocaleTimeString()}`:data?'Fetched from GitHub':'Load data to explore'}</em></div><div className="stat-card"><small>Recent issues</small><strong>{data?.counts.issues??'—'}</strong><em>Non-PR issues</em></div><div className="stat-card"><small>Graph mode</small><strong className="ol-mode">{data?.graph==='falkordb'?'Live':'Preview'}</strong><em>{data?.graph==='falkordb'?'Persisted in FalkorDB':'Configure FalkorDB to persist'}</em></div></div>
        <section className="ol-ask" id="ask"><div><span className="pane-label">ASK THE PROJECT</span><h2>Get oriented before you contribute.</h2><p>Reviewer recommendations use overlapping files and recorded reviews. Every answer links to its evidence and query.</p></div><div className="ol-query"><div className="ol-input"><Search size={17}/><input value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>e.key==='Enter'&&ask()} placeholder="Who should review PR #442? Who knows OAuth?"/><button onClick={ask} disabled={!data||busy}>{busy?<LoaderCircle size={16}/>:<Send size={16}/>}</button></div>{answer&&<div className="ol-answer"><strong>{agent} · {querySource}</strong><p>{answer}</p>{signedIn&&<small className="memory-note"><ShieldCheck size={13}/> Shared repository memory · {memoryCount ? `${memoryCount} earlier exchanges retrieved` : 'first exchange in this session'}</small>}{evidence.map((source,i)=><a className="ol-source" key={`${source.url}-${i}`} href={source.url} target="_blank" rel="noreferrer"><span>{source.role} · {source.title}</span><ArrowRight size={12}/></a>)}{cypher&&<details className="ol-cypher"><summary>Show graph query · {sources.length} result(s)</summary><pre>{cypher}{'\n\n'}Parameters: {JSON.stringify({ repository, prompt })}</pre></details>}</div>}</div></section>
        <section id="activity" className="ol-activity"><div className="section-title"><h2>Recent repository activity</h2><span>{data?`${activity.length} records shown`:'Load live data to see current records'}</span></div>{!data?<div className="panel-card ol-empty"><GitPullRequest size={24}/><h3>Bring the project graph to life</h3><p>Load a bounded recent slice of the public Open Library repository.</p><button className="button-dark" onClick={()=>load(selectedRepo)} disabled={busy}>{busy?'Loading…':'Load Open Library activity'} <ArrowRight size={13}/></button></div>:<div className="panel-card convo-list">{activity.map((item,i)=><a className="convo-row" key={`${item.number}-${i}`} href={item.url} target="_blank" rel="noreferrer"><span className="convo-icon">{i<5?<GitPullRequest size={16}/>:<MessageSquareText size={16}/>}</span><span><strong>#{item.number} · {item.title}</strong><small>by {item.author} · {item.state} · {item.comments} comments</small></span><ArrowRight size={14}/></a>)}</div>}</section>
        <footer className="ol-footer"><span>Repository activity from GitHub: {repository}.</span><span>FalkorDB stores connected project context.</span></footer>
      </main>
    </div>
  </div>;
}
