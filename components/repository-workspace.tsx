'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight, BookOpen, Database, GitCommit, GitPullRequest, Github, LoaderCircle, MessageSquareText, Search, Send, ShieldCheck } from 'lucide-react';

type Item = { number: number; title: string; state: string; url: string; author: string; comments: number; updated_at:string };
type Commit = {sha:string;message:string;url:string;authorLogin:string;authorName:string;date:string};
type ActivityItem = {kind:'Pull request'|'Issue'|'Commit';number:number;title:string;state:string;url:string;author:string;comments:number;updated_at:string};
type Source = { title: string; url: string; role: string };
type ReviewerMatch = { login?: string; sharedFiles?: number; relatedReviews?: number; matchingFiles?: string[] };
type Project = { repository: string; pulls: Item[]; issues: Item[]; commits:Commit[]; graph: string; syncedAt?: string; latestActivityAt?: string | null; stale?:boolean; counts: { pullRequests: number; issues: number; reviews: number; files: number; commits:number; contributors:number } };

export function RepositoryWorkspace() {
  const [data, setData] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<ReviewerMatch[]>([]);
  const [evidence, setEvidence] = useState<Source[]>([]);
  const [cypher, setCypher] = useState('');
  const [querySource, setQuerySource] = useState('');
  const [answerMode, setAnswerMode] = useState<'openai' | 'graph-template' | ''>('');
  const [agent, setAgent] = useState('');
  const [memoryCount, setMemoryCount] = useState(0);
  const [selectedRepo,setSelectedRepo]=useState('');
  const [signedIn,setSignedIn]=useState('');
  const [briefPr,setBriefPr]=useState('');

  async function readCache(repo=selectedRepo){
    if(!repo)return false;
    try{const response=await fetch('/api/github/sync',{cache:'no-store'});if(!response.ok)return false;const cached=await response.json();setData({...cached,counts:{pullRequests:cached.imported?.pullRequests??cached.counts?.pullRequests??0,issues:cached.imported?.issues??cached.counts?.issues??0,reviews:cached.imported?.reviews??cached.counts?.reviews??0,files:cached.imported?.files??cached.counts?.files??0,commits:cached.imported?.commits??cached.counts?.commits??0,contributors:cached.imported?.people??cached.counts?.contributors??0}});return true}catch{return false}
  }
  async function checkAccount(){try{const response=await fetch('/api/github/status',{cache:'no-store'});const status=await response.json();setSignedIn(status.user?.login??'');if(status.selectedRepo){setSelectedRepo(status.selectedRepo);await readCache(status.selectedRepo)}}catch{}}
  useEffect(()=>{void checkAccount()},[]);

  async function load(repo=selectedRepo) {
    setBusy(true); setError('');
    const cached=await readCache(repo);
    try {
      if(!repo)throw new Error('Select a repository in setup before importing activity.');
      const response=await fetch('/api/github/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repository:repo}),cache:'no-store'});
      const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error??'Repository refresh failed.'),{code:result.code,retryAt:result.retryAt});
      setData(repo?{repository:result.repository,pulls:result.pulls,issues:result.issues,commits:result.commits??[],graph:'falkordb',syncedAt:result.syncedAt,latestActivityAt:result.latestActivityAt,counts:{pullRequests:result.imported.pullRequests,issues:result.imported.issues,reviews:result.imported.reviews,files:result.imported.files,commits:result.imported.commits,contributors:result.imported.people}}:result);
    } catch(e) {
      const failure=e as Error&{retryAt?:string};
      const reason=`${failure.message??'Could not refresh the repository.'}${failure.retryAt?` Retry after ${new Date(failure.retryAt).toLocaleString()}.`:''}`;
      setError(cached?`Showing the last successful graph snapshot. Refresh failed: ${reason}`:reason);
    }
    finally { setBusy(false); }
  }

  async function ask(question=prompt) {
    if (!data || !question.trim() || busy) return;
    setBusy(true); setError('');
    try {
      setPrompt(question);
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: question }) });
      const result = await response.json(); if (!response.ok) throw Error(result.error);
      setQuerySource(result.source); setAnswerMode(result.answerMode ?? 'graph-template'); setCypher(result.cypher ?? ''); setSources(result.rows ?? []);
      setEvidence(result.sources ?? []); setAgent(result.handoff?.to ?? result.intent ?? 'Project Guide'); setMemoryCount(result.memory?.count ?? 0);
      setAnswer(result.answer ?? 'The graph did not return an answer.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not query project memory.'); }
    finally { setBusy(false); }
  }

  const activity:ActivityItem[] = data ? [
    ...data.pulls.map(item=>({...item,kind:'Pull request' as const})),
    ...data.issues.map(item=>({...item,kind:'Issue' as const})),
    ...data.commits.map(item=>({kind:'Commit' as const,number:0,title:item.message.split('\n')[0],state:'committed',url:item.url,author:item.authorLogin||item.authorName||'unknown',comments:0,updated_at:item.date})),
  ].sort((left,right)=>Date.parse(right.updated_at)-Date.parse(left.updated_at)).slice(0,12) : [];
  const repository = data?.repository ?? selectedRepo;
  const repositoryName = repository?.split('/').pop() || 'Repository';
  const repositoryUrl = repository ? `https://github.com/${repository}` : 'https://github.com';
  const graphPreviewNodes = data ? [
    {label:repositoryName,kind:'Repository',x:55,y:55},
    ...(data.counts.contributors?[{label:`${data.counts.contributors} contributors`,kind:'Contributor',x:170,y:92}]:[]),
    ...(data.counts.commits?[{label:`${data.counts.commits} commits`,kind:'Commit',x:292,y:48}]:[]),
    ...(data.counts.pullRequests?[{label:`${data.counts.pullRequests} pull requests`,kind:'Pull request',x:92,y:160}]:[]),
    ...(data.counts.issues?[{label:`${data.counts.issues} issues`,kind:'Issue',x:250,y:165}]:[]),
    ...(data.counts.reviews?[{label:`${data.counts.reviews} reviews`,kind:'Review',x:319,y:133}]:[]),
  ] : [
    {label:'Repository',kind:'Repository',x:55,y:55},{label:'Contributors',kind:'Contributor',x:170,y:92},
    {label:'Commits',kind:'Commit',x:292,y:48},{label:'Pull requests',kind:'Pull request',x:92,y:160},{label:'Issues',kind:'Issue',x:250,y:165},
  ];
  return <div className="app-shell">
    <aside className="sidebar">
      <Link href="/" className="side-logo"><span className="side-mark"><BookOpen size={17}/></span>engram<span className="brand-dot">.</span></Link>
      <div className="workspace-select"><span className="ws-avatar">{repositoryName.slice(0,2).toUpperCase()}</span><div><strong>{repositoryName}</strong><small>{signedIn?`Signed in as ${signedIn}`:'GitHub repository'}</small></div></div>
      <div className="side-label">PROJECT MEMORY</div>
      <a className="side-link active" href="#overview"><Activity/><span>Overview</span></a>
      <a className="side-link" href="#activity"><GitPullRequest/><span>Pull requests & issues</span></a>
      <a className="side-link" href="#ask"><MessageSquareText/><span>Ask the project</span></a>
      <Link href="/workspace/connected/explore" className="side-link"><GitPullRequest/><span>Explore graph</span></Link>
      <div className="side-spacer"/><div className="graph-status"><small><i className="status-pulse"/> DATA SOURCE</small><p>{repository}</p></div>
      <Link href="/setup/github" className="side-link"><Github/><span>Connect another repo</span></Link>
    </aside>
    <div className="main-area">
      <header className="app-header"><div className="breadcrumb"><span>Project memory</span><span>/</span><strong>{repository}</strong></div><div className="header-tools"><span className="answer-tag"><i/> {signedIn?`Connected as ${signedIn}`:'Repository'}</span>{signedIn&&<form action="/api/github/logout" method="post"><button className="text-link" type="submit">Sign out</button></form>}</div></header>
      <main className="content ol-content" id="overview">
        <div className="ol-hero"><div><div className="eyebrow"><span className="pulse"/> CONTRIBUTOR KNOWLEDGE GRAPH</div><h1>Understand the work<br/>behind <em>{repositoryName}.</em></h1><p>Explore real pull requests and issues, trace contributor activity, and find context before you contribute.</p><div className="hero-actions"><button className="button-primary" onClick={()=>load(selectedRepo)} disabled={busy}>{busy?<LoaderCircle className="spin" size={16}/>:<Database size={16}/>} {data?'Refresh project data':'Load live project data'} <ArrowRight size={15}/></button><a href={repositoryUrl} target="_blank" rel="noreferrer" className="text-link">View repository <Github size={14}/></a></div></div><div className="ol-graph-card"><div className="pane-label">{data?'IMPORTED GRAPH DATA':'GRAPH STRUCTURE'}</div><svg viewBox="0 0 360 210"><g className="ol-links">{graphPreviewNodes.slice(1).map(node=><path key={node.kind} d={`M${graphPreviewNodes[0].x} ${graphPreviewNodes[0].y} ${node.x} ${node.y}`}/>)}</g>{graphPreviewNodes.map(node=><g key={node.kind}><circle cx={node.x} cy={node.y} r="9"/><text x={node.x} y={node.y+26}>{node.label}</text></g>)}</svg><small>{data?`${data.counts.contributors} contributors · ${data.counts.commits} commits · ${data.counts.pullRequests} pull requests`:'People · commits · pull requests · issues'}</small></div></div>
        {error&&<div className="setup-alert">{error}</div>}
        <div className="stat-grid ol-stats"><div className="stat-card"><small>Recent pull requests</small><strong>{data?.counts.pullRequests??'—'}</strong><em>{data?.syncedAt?`${data.stale?'Cached · last good GitHub check':'GitHub checked'} ${new Date(data.syncedAt).toLocaleString()}`:data?'Fetched from GitHub':'Load data to explore'}</em>{data?.latestActivityAt&&<em>Newest imported activity: {new Date(data.latestActivityAt).toLocaleString()}</em>}</div><div className="stat-card"><small>Recent issues</small><strong>{data?.counts.issues??'—'}</strong><em>{data?`${data.counts.contributors} contributors · ${data.counts.commits} commits`:'Non-PR issues'}</em></div><div className="stat-card"><small>Graph status</small><strong className="ol-mode">{data?.graph?'Ready':'Not loaded'}</strong><em>{data?.graph?'FalkorDB graph · refresh checks GitHub live':'Import a repository to build its graph'}</em></div></div>
        <section className="ol-ask" id="ask"><div><span className="pane-label">REVIEWER INTELLIGENCE</span><h2>Find reviewers through real work.</h2><p>Choose a pull request from this repository. Engram follows changed files to earlier pull requests and reviews, then shows who has relevant experience and why.</p></div><div className="ol-query">{data?.pulls.length?<div className="review-brief-start"><label htmlFor="review-pr">Build a reviewer brief</label><div className="review-brief-controls"><select id="review-pr" value={briefPr||String(data.pulls[0].number)} onChange={event=>setBriefPr(event.target.value)}>{data.pulls.map(pull=><option key={pull.number} value={pull.number}>#{pull.number} · {pull.title}</option>)}</select><button className="button-primary" onClick={()=>void ask(`Who should review PR #${briefPr||data.pulls[0].number}?`)} disabled={busy}>{busy?<LoaderCircle className="spin" size={15}/>:<Search size={15}/>} Find matches</button></div></div>:<div className="panel-card ol-empty"><h3>{data?'No pull requests in this imported repository window':'Load a repository to build a reviewer brief'}</h3><p>{data?'This repository has commit activity, but no PR review history to rank. You can still explore contributors and their recent commits.':'Reviewer matches are calculated from the selected repository’s real file and review history.'}</p>{data&&data.counts.commits>0&&<button className="button-primary" onClick={()=>void ask('Who contributed recently?')} disabled={busy}>{busy?<LoaderCircle size={15} className="spin"/>:<Activity size={15}/>} Explore recent contributors</button>}</div>}<div className="ol-input"><Search size={17}/><input value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>e.key==='Enter'&&ask()} placeholder="Or ask about contributors, changes, or decisions"/><button onClick={()=>void ask()} disabled={!data||busy}>{busy?<LoaderCircle size={16}/>:<Send size={16}/>}</button></div>{answer&&<div className="ol-answer"><strong>{agent} · {querySource} · {answerMode==='openai'?'AI-generated':answerMode==='graph-template'?'Graph-grounded fallback':'Answer'}</strong><p>{answer}</p>{querySource==='reviewer-router'&&sources.length>0&&<div className="reviewer-matches"><div className="reviewer-matches-head"><strong>Evidence-backed reviewer matches</strong><span>Ranked by shared files and related reviews</span></div>{sources.map((match,index)=><article className="reviewer-match" key={`${match.login??'reviewer'}-${index}`}><span className="reviewer-rank">0{index+1}</span><div className="reviewer-match-main"><strong>@{match.login??'Contributor'}</strong><small>{match.relatedReviews??0} related reviews · {match.sharedFiles??0} shared files</small>{Boolean(match.matchingFiles?.length)&&<div className="file-chips">{match.matchingFiles?.slice(0,4).map(file=><code key={file}>{file}</code>)}</div>}</div></article>)}</div>}{signedIn&&<small className="memory-note"><ShieldCheck size={13}/> Repository memory · {memoryCount ? `${memoryCount} related prior exchange(s) retrieved` : 'No related earlier question used'}</small>}{evidence.map((source,i)=><a className="ol-source" key={`${source.url}-${i}`} href={source.url} target="_blank" rel="noreferrer"><span>{source.role} · {source.title}</span><ArrowRight size={12}/></a>)}{cypher&&<details className="ol-cypher"><summary>Show graph query · {sources.length} result(s)</summary><pre>{cypher}{'\n\n'}Parameters: {JSON.stringify({ repository, prompt })}</pre></details>}</div>}</div></section>
        <section id="activity" className="ol-activity"><div className="section-title"><h2>Recent repository activity</h2><span>{data?`${activity.length} records shown`:'Load live data to see current records'}</span></div>{!data?<div className="panel-card ol-empty"><GitPullRequest size={24}/><h3>Bring the project graph to life</h3><p>Import a bounded recent slice from your selected GitHub repository.</p><button className="button-dark" onClick={()=>load(selectedRepo)} disabled={busy}>{busy?'Loading…':'Import repository activity'} <ArrowRight size={13}/></button></div>:activity.length?<div className="panel-card convo-list">{activity.map((item,i)=><a className="convo-row" key={`${item.kind}-${item.url}-${i}`} href={item.url} target="_blank" rel="noreferrer"><span className="convo-icon">{item.kind==='Commit'?<GitCommit size={16}/>:item.kind==='Pull request'?<GitPullRequest size={16}/>:<MessageSquareText size={16}/>}</span><span><strong>{item.kind==='Commit'?item.title:`#${item.number} · ${item.title}`}</strong><small>{item.author} · {item.kind==='Commit'?'committed':item.state} · {new Date(item.updated_at).toLocaleDateString()}</small></span><ArrowRight size={14}/></a>)}</div>:<div className="panel-card ol-empty"><h3>No pull requests, issues or commits in this import</h3><p>Refresh the repository data or select another repository with the activity you want to explore.</p></div>}</section>
        <footer className="ol-footer"><span>Repository activity from GitHub: {repository}.</span><span>FalkorDB stores connected project context.</span></footer>
      </main>
    </div>
  </div>;
}
