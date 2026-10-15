'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BrandMark } from '@/components/brand-mark';
import { Activity, ArrowRight, BookmarkCheck, Brain, Database, GitCommit, GitPullRequest, Github, LoaderCircle, MessageSquareText, Network, Search, ShieldCheck, Trash2, X } from 'lucide-react';

type Item = { number: number; title: string; state: string; url: string; author: string; comments: number; updated_at:string };
type Commit = {sha:string;message:string;url:string;authorLogin:string;authorName:string;date:string};
type ActivityItem = {kind:'Pull request'|'Issue'|'Commit';number:number;title:string;state:string;url:string;author:string;comments:number;updated_at:string};
type Source = { id?: number; title: string; url: string; role: string };
type SavedMemory = { nodeId:string; id:string; question:string; answer:string; agent:string; intent:string; savedAt:string; sources:Source[] };
type RecalledMemory = { question:string; answer:string; savedAt:string };
type ReviewerMatch = { login?: string; sharedFiles?: number; relatedReviews?: number; matchingFiles?: string[] };
type Project = { repository: string; upstreamRepository?:string|null; pulls: Item[]; issues: Item[]; commits:Commit[]; graph: string; syncedAt?: string; latestActivityAt?: string | null; stale?:boolean; counts: { pullRequests: number; issues: number; reviews: number; files: number; commits:number; branches:number; contributors:number } };
type AvailableRepo = { id:number; full_name:string; description:string|null; private:boolean; language:string|null; default_branch:string };
type SyncResponse = { repository:string; upstreamRepository?:string|null; pulls:Item[]; issues:Item[]; commits:Commit[]; syncedAt:string; latestActivityAt:string|null; imported:Record<string,number> };
type WorkspaceView = 'overview' | 'activity' | 'ask' | 'memory';

function projectFromSync(result:SyncResponse & {counts?:Project['counts']}):Project {
  const counts=result.counts??{} as Project['counts'];
  return {repository:result.repository,upstreamRepository:result.upstreamRepository??null,pulls:result.pulls??[],issues:result.issues??[],commits:result.commits??[],graph:'falkordb',syncedAt:result.syncedAt,latestActivityAt:result.latestActivityAt,counts:{pullRequests:result.imported?.pullRequests??counts.pullRequests??0,issues:result.imported?.issues??counts.issues??0,reviews:result.imported?.reviews??counts.reviews??0,files:result.imported?.files??counts.files??0,commits:result.imported?.commits??counts.commits??0,branches:result.imported?.branches??counts.branches??0,contributors:result.imported?.people??counts.contributors??0}};
}

export function RepositoryWorkspace({view='overview',guestRepository}:{view?:WorkspaceView;guestRepository?:string}) {
  const [data, setData] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<ReviewerMatch[]>([]);
  const [evidence, setEvidence] = useState<Source[]>([]);
  const [cypher, setCypher] = useState('');
  const [querySource, setQuerySource] = useState('');
  const [answerMode, setAnswerMode] = useState<'gemini' | 'graph-template' | ''>('');
  const [evidenceCounts, setEvidenceCounts] = useState({recordCount:0,sourceCount:0});
  const [agent, setAgent] = useState('');
  const [memoryCount, setMemoryCount] = useState(0);
  const [recalledMemories, setRecalledMemories] = useState<RecalledMemory[]>([]);
  const [episodeId, setEpisodeId] = useState('');
  const [savedThisAnswer, setSavedThisAnswer] = useState(false);
  const [savingMemory, setSavingMemory] = useState(false);
  const [savedMemories, setSavedMemories] = useState<SavedMemory[]>([]);
  const [selectedRepo,setSelectedRepo]=useState(guestRepository??'');
  const [signedIn,setSignedIn]=useState('');
  const [briefPr,setBriefPr]=useState('');
  const [repoSwitcherOpen,setRepoSwitcherOpen]=useState(false);
  const [availableRepos,setAvailableRepos]=useState<AvailableRepo[]>([]);
  const [repoSearch,setRepoSearch]=useState('');
  const [reposLoading,setReposLoading]=useState(false);
  const [switchingRepo,setSwitchingRepo]=useState('');

  const isGuest=Boolean(guestRepository);
  const repoPath=guestRepository?`/demo/${guestRepository.split('/').map(encodeURIComponent).join('/')}`:'/workspace/connected';
  async function readCache(repo=selectedRepo){
    if(!repo)return false;
    try{const endpoint=isGuest?`/api/demo/snapshot?repository=${encodeURIComponent(repo)}`:'/api/github/sync';const response=await fetch(endpoint,{cache:'no-store'});if(!response.ok)return false;const cached=await response.json();setData(projectFromSync(cached as SyncResponse & {counts?:Project['counts']}));return true}catch{return false}
  }
  async function checkAccount(){try{const response=await fetch('/api/github/status',{cache:'no-store'});const status=await response.json();setSignedIn(status.user?.login??'');if(status.selectedRepo){setSelectedRepo(status.selectedRepo);await readCache(status.selectedRepo)}}catch{}}
  useEffect(()=>{if(isGuest){setSelectedRepo(guestRepository??'');void load(guestRepository??'',false)}else void checkAccount()},[]);
  useEffect(()=>{if(view==='memory'&&!isGuest){void readMemories()}},[view,isGuest]);

  async function readMemories(){
    try{const response=await fetch('/api/memories',{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error??'Could not load saved memory.');setSavedMemories(result.items??[])}
    catch(e){setError(e instanceof Error?e.message:'Could not load saved memory.')}
  }

  async function load(repo=selectedRepo,force=true) {
    setBusy(true); setError('');
    const cached=await readCache(repo);
    if(isGuest&&cached&&!force){setBusy(false);return}
    try {
      if(!repo)throw new Error(isGuest?'Enter a public GitHub repository to continue.':'Select a repository in setup before importing activity.');
      const endpoint=isGuest?'/api/demo/import':'/api/github/sync';
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repository:repo,...(isGuest?{force}: {})}),cache:'no-store'});
      const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error??'Repository refresh failed.'),{code:result.code,retryAt:result.retryAt});
      setData(projectFromSync(result as SyncResponse & {counts?:Project['counts']}));
    } catch(e) {
      const failure=e as Error&{retryAt?:string};
      const reason=`${failure.message??'Could not refresh the repository.'}${failure.retryAt?` Retry after ${new Date(failure.retryAt).toLocaleString()}.`:''}`;
      setError(cached?`Showing the last successful graph snapshot. Refresh failed: ${reason}`:reason);
    }
    finally { setBusy(false); }
  }

  async function ask(question=prompt) {
    if (!data || !question.trim() || busy) return;
    setBusy(true); setAsking(true); setError('');
    try {
      setPrompt(question);
      const selectedTargetNumber=Number(briefPr||data?.pulls[0]?.number||0);
      const response = await fetch(isGuest?'/api/demo/chat':'/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isGuest?{ prompt: question, repository: guestRepository,targetNumber:selectedTargetNumber }:{ prompt: question,targetNumber:selectedTargetNumber }) });
      const result = await response.json(); if (!response.ok) throw Error(result.error);
      setQuerySource(result.source); setAnswerMode(result.answerMode ?? 'graph-template'); setEvidenceCounts(result.evidence ?? {recordCount:result.rows?.length??0,sourceCount:result.sources?.length??0}); setCypher(result.cypher ?? ''); setSources(result.rows ?? []);
      setEvidence(result.sources ?? []); setAgent(result.handoff?.to ?? result.intent ?? 'Project Guide'); setMemoryCount(result.memory?.count ?? 0);setRecalledMemories(result.memory?.recent??[]);setEpisodeId(result.episodeId??'');setSavedThisAnswer(false);
      setAnswer(result.answer ?? 'The graph did not return an answer.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not query project memory.'); }
    finally { setBusy(false); setAsking(false); }
  }

  async function saveCurrentAnswer(){
    if(!episodeId||savingMemory||isGuest)return;
    setSavingMemory(true);setError('');
    try{const response=await fetch('/api/memories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({episodeId})});const result=await response.json();if(!response.ok)throw new Error(result.error??'Could not save this investigation.');setSavedThisAnswer(true);if(view==='memory')await readMemories()}
    catch(e){setError(e instanceof Error?e.message:'Could not save this investigation to project memory.')}
    finally{setSavingMemory(false)}
  }

  async function removeMemory(memoryId:string){
    try{const response=await fetch('/api/memories',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({memoryId})});const result=await response.json();if(!response.ok)throw new Error(result.error??'Could not remove saved memory.');setSavedMemories(items=>items.filter(item=>item.id!==memoryId))}
    catch(e){setError(e instanceof Error?e.message:'Could not remove saved memory.')}
  }

  async function openRepoSwitcher(){
    setRepoSwitcherOpen(true);setRepoSearch('');
    setReposLoading(true);
    try{const response=await fetch('/api/github/repos',{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error??'Could not load repositories.');setAvailableRepos(result.repositories??[])}
    catch(e){setError(e instanceof Error?e.message:'Could not load repositories.');setRepoSwitcherOpen(false)}
    finally{setReposLoading(false)}
  }

  async function switchRepository(repo:AvailableRepo){
    if(repo.full_name===(data?.repository??selectedRepo)){setRepoSwitcherOpen(false);return}
    setSwitchingRepo(repo.full_name);setBusy(true);setError('');
    try{
      const response=await fetch('/api/github/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repository:repo.full_name}),cache:'no-store'});
      const result=await response.json();if(!response.ok)throw new Error(result.error??'Repository import failed.');
      const project=projectFromSync(result as SyncResponse);
      setData(project);setSelectedRepo(project.repository);setBriefPr('');setPrompt('');setAnswer('');setEvidence([]);setSources([]);setCypher('');setQuerySource('');setAnswerMode('');setEvidenceCounts({recordCount:0,sourceCount:0});setAgent('');setMemoryCount(0);setRepoSwitcherOpen(false);
    }catch(e){setError(e instanceof Error?e.message:'Could not switch repository.');setRepoSwitcherOpen(false)}
    finally{setBusy(false);setSwitchingRepo('')}
  }

  const activity:ActivityItem[] = data ? [
    ...data.pulls.map(item=>({...item,kind:'Pull request' as const})),
    ...data.issues.map(item=>({...item,kind:'Issue' as const})),
    ...data.commits.map(item=>({kind:'Commit' as const,number:0,title:item.message.split('\n')[0],state:'committed',url:item.url,author:item.authorLogin||item.authorName||'unknown',comments:0,updated_at:item.date})),
  ].sort((left,right)=>Date.parse(right.updated_at)-Date.parse(left.updated_at)).slice(0,12) : [];
  const repository = data?.repository ?? selectedRepo;
  const repositoryName = repository?.split('/').pop() || 'Repository';
  const repositoryUrl = repository ? `https://github.com/${repository}` : 'https://github.com';
  const filteredRepos = availableRepos.filter(repo=>`${repo.full_name} ${repo.description??''}`.toLowerCase().includes(repoSearch.toLowerCase()));
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
  const answerLabel = answerMode==='gemini'?'Gemini · graph-grounded':answerMode==='graph-template'?'Graph-grounded fallback':'Answer';
  const examplePull=data?.pulls[0];
  const questionExamples=[
    {label:'Find a reviewer',question:examplePull?`Who should review PR #${examplePull.number}?`:'Who should review this PR?'},
    {label:'Find an expert',question:'Who has expertise in database changes?'},
    {label:'Understand a decision',question:examplePull?`Why did ${examplePull.title} change?`:'Why was a recent change made?'},
    {label:'Find active contributors',question:'Who contributed recently?'},
  ];
  return <div className="app-shell">
    <aside className="sidebar">
      <Link href="/" className="side-logo"><span className="side-mark"><BrandMark size={38}/></span>engram<span className="brand-dot">.</span></Link>
      <div className="workspace-select"><span className="ws-avatar">{repositoryName.slice(0,2).toUpperCase()}</span><div><strong>{repositoryName}</strong><small>{isGuest?'Public repository · guest mode':signedIn?`Signed in as ${signedIn}`:'GitHub repository'}</small></div></div>
      <div className="side-label">PROJECT MEMORY</div>
      <nav className="side-navigation" aria-label="Project navigation">
        <Link aria-current={view==='overview'?'page':undefined} className={`side-link ${view==='overview'?'active':''}`} href={repoPath}><Activity/><span className="side-link-copy"><strong>Overview</strong><small>Status, counts &amp; next steps</small></span></Link>
        <Link aria-current={view==='activity'?'page':undefined} className={`side-link ${view==='activity'?'active':''}`} href={`${repoPath}/activity`}><GitPullRequest/><span className="side-link-copy"><strong>Activity</strong><small>PRs, issues &amp; commits</small></span></Link>
        <Link aria-current={view==='ask'?'page':undefined} className={`side-link ${view==='ask'?'active':''}`} href={`${repoPath}/ask`}><MessageSquareText/><span className="side-link-copy"><strong>Ask</strong><small>Questions &amp; recommendations</small></span></Link>
        {!isGuest&&<Link aria-current={view==='memory'?'page':undefined} className={`side-link ${view==='memory'?'active':''}`} href={`${repoPath}/memory`}><Brain/><span className="side-link-copy"><strong>Saved memory</strong><small>Findings you kept</small></span></Link>}
        <Link className="side-link" href={`${repoPath}/explore`}><Network/><span className="side-link-copy"><strong>Graph explorer</strong><small>Visual connections</small></span></Link>
      </nav>
      <div className="side-spacer"/><div className="graph-status"><small><i className="status-pulse"/> DATA SOURCE</small><p>{repository}</p></div>
      <Link href={isGuest?"/demo":"/setup/github"} className="side-link"><Github/><span>{isGuest?"Try another public repo":"Connect another repo"}</span></Link>
    </aside>
    <div className="main-area">
      <header className="app-header"><div className="breadcrumb"><span>Project memory</span><span>/</span><strong>{repository}</strong></div><div className="header-tools">{signedIn&&<button aria-label="Switch repository" className="text-link repo-switch-trigger" onClick={()=>void openRepoSwitcher()} disabled={busy}>Switch repository <ArrowRight size={12}/></button>}<span className="answer-tag"><i/> {isGuest?'PUBLIC DATA · guest mode':signedIn?`Connected as ${signedIn}`:'Repository'}</span>{signedIn&&!isGuest&&<form action="/api/github/logout" method="post"><button className="text-link" type="submit">Sign out</button></form>}</div></header>
      <main className="content ol-content">
        {view === 'overview' && <>
        <div className="ol-hero"><div><div className="eyebrow"><span className="pulse"/> CONTRIBUTOR KNOWLEDGE GRAPH</div><h1>Understand the work<br/>behind <em>{repositoryName}.</em></h1><p>Explore real pull requests and issues, trace contributor activity, and find context before you contribute.</p><div className="hero-actions"><button className="button-primary" onClick={()=>load(selectedRepo,true)} disabled={busy}>{busy?<LoaderCircle className="spin" size={16}/>:<Database size={16}/>} {data?'Refresh project data':'Load live project data'} <ArrowRight size={15}/></button><a href={repositoryUrl} target="_blank" rel="noreferrer" className="text-link">View repository <Github size={14}/></a></div></div><div className="ol-graph-card"><div className="pane-label">{data?'IMPORTED GRAPH DATA':'GRAPH STRUCTURE'}</div><svg viewBox="0 0 360 210"><g className="ol-links">{graphPreviewNodes.slice(1).map(node=><path key={node.kind} d={`M${graphPreviewNodes[0].x} ${graphPreviewNodes[0].y} ${node.x} ${node.y}`}/>)}</g>{graphPreviewNodes.map(node=><g key={node.kind}><circle cx={node.x} cy={node.y} r="9"/><text x={node.x} y={node.y+26}>{node.label}</text></g>)}</svg><small>{data?`${data.counts.contributors} contributors · ${data.counts.commits} commits · ${data.counts.pullRequests} pull requests · ${data.counts.branches} recent branches`:'People · commits · pull requests · issues'}</small></div></div>
        {error&&<div className="setup-alert">{error}</div>}
        <div className="stat-grid ol-stats"><div className="stat-card"><small>Recent pull requests</small><strong>{data?.counts.pullRequests??'—'}</strong><em>{data?.syncedAt?`${data.stale?'Cached · last good GitHub check':'GitHub checked'} ${new Date(data.syncedAt).toLocaleString()}`:data?'Fetched from GitHub':'Load data to explore'}</em>{data?.upstreamRepository&&<em>Public upstream context: {data.upstreamRepository}</em>}{data?.latestActivityAt&&<em>Newest activity in indexed data: {new Date(data.latestActivityAt).toLocaleString()}</em>}</div><div className="stat-card"><small>Recent issues</small><strong>{data?.counts.issues??'—'}</strong><em>{data?`${data.counts.contributors} contributors · ${data.counts.commits} commits`:'Non-PR issues'}</em></div><div className="stat-card"><small>Graph status</small><strong className="ol-mode">{data?.graph?'Ready':'Not loaded'}</strong><em>{data?.graph?`${data.counts.branches} recent branches indexed · refresh checks GitHub live`:'Import a repository to build its graph'}</em></div></div>
        <section className="workspace-guide" aria-labelledby="workspace-guide-title"><div className="workspace-guide-heading"><span className="pane-label">START HERE</span><h2 id="workspace-guide-title">What do you want to do?</h2><p>Each area has a clear job. Pick one to get started.</p></div><div className="workspace-guide-grid">
          <Link className="workspace-guide-card" href={`${repoPath}/ask`}><span className="workspace-guide-icon ask"><MessageSquareText size={18}/></span><strong>Ask a question</strong><p>Get graph-backed answers about reviewers, expertise, changes, and decisions.</p><span className="workspace-guide-action">Ask the project <ArrowRight size={13}/></span></Link>
          <Link className="workspace-guide-card" href={`${repoPath}/activity`}><span className="workspace-guide-icon activity"><GitPullRequest size={18}/></span><strong>Browse repository activity</strong><p>Read recent pull requests, issues, and commits as a timeline.</p><span className="workspace-guide-action">View activity <ArrowRight size={13}/></span></Link>
          <Link className="workspace-guide-card" href={`${repoPath}/explore`}><span className="workspace-guide-icon graph"><Network size={18}/></span><strong>Explore connections</strong><p>Follow people, files, reviews, and work items through the graph.</p><span className="workspace-guide-action">Open graph explorer <ArrowRight size={13}/></span></Link>
          {!isGuest&&<Link className="workspace-guide-card" href={`${repoPath}/memory`}><span className="workspace-guide-icon memory"><Brain size={18}/></span><strong>Return to saved findings</strong><p>Keep source-backed investigations and recall them in future questions.</p><span className="workspace-guide-action">Open saved memory <ArrowRight size={13}/></span></Link>}
        </div></section>
        </>}
        {view === 'ask' && <section className="ol-ask"><div><span className="pane-label">ASK THE PROJECT</span><h2>Ask about this repository.</h2><p>Use this page for questions and recommendations. Engram follows repository graph connections and shows the records behind each answer. To browse a timeline, open <Link href={`${repoPath}/activity`}>Activity</Link>; to inspect connections visually, open <Link href={`${repoPath}/explore`}>Graph explorer</Link>.</p><div className="memory-promo"><Brain size={16}/><span><strong>{isGuest?'Sign in to keep useful findings':'Keep useful findings'}</strong><small>{isGuest?'Connect GitHub to save source-backed findings privately across visits.':'Save a source-backed investigation so future questions can use it.'}</small></span>{isGuest?<Link href="/setup/github">Connect GitHub <ArrowRight size={12}/></Link>:<Link href={`${repoPath}/memory`}>View memory <ArrowRight size={12}/></Link>}</div></div><div className="ol-query"><div className="question-examples"><span className="pane-label">EXAMPLES · SELECT ONE TO START</span><div className="question-example-list">{questionExamples.map(example=><button key={example.label} onClick={()=>setPrompt(example.question)}>{example.label}<span>{example.question}</span></button>)}</div></div>{data?.pulls.length?<div className="review-brief-start"><label htmlFor="review-pr">Choose a pull request for reviewer questions</label><div className="review-brief-controls"><select id="review-pr" value={briefPr||String(data.pulls[0].number)} onChange={event=>setBriefPr(event.target.value)}>{data.pulls.map(pull=><option key={pull.number} value={pull.number}>#{pull.number} · {pull.title}</option>)}</select><button className="button-primary" onClick={()=>void ask(`Who should review PR #${briefPr||data.pulls[0].number}?`)} disabled={busy}>{busy?<LoaderCircle className="spin" size={15}/>:<Search size={15}/>} Find reviewers</button></div></div>:<div className="panel-card ol-empty"><h3>{data?'No pull requests in this imported repository window':'Import this repository to get graph-backed answers'}</h3><p>{data?'This repository has commit activity, but no PR review history to rank. You can still explore contributors and their recent commits.':'Engram needs recent GitHub activity in FalkorDB before it can answer. Import the selected repository first; then try one of the examples above.'}</p>{!data&&<button className="button-primary" onClick={()=>void load(selectedRepo,true)} disabled={busy}>{busy?<LoaderCircle className="spin" size={15}/>:<Database size={15}/>} Import repository data</button>}{data&&data.counts.commits>0&&<button className="button-primary" onClick={()=>void ask('Who contributed recently?')} disabled={busy}>{busy?<LoaderCircle size={15} className="spin"/>:<Activity size={15}/>} Explore recent contributors</button>}</div>}<label className="question-input-label" htmlFor="project-question">Ask in plain English</label><div className="ol-input"><Search size={17}/><input id="project-question" value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>e.key==='Enter'&&ask()} placeholder="Who should review my async database migration PR?"/><button className="ask-submit" onClick={()=>void ask()} disabled={!data||busy||!prompt.trim()} aria-label="Search repository graph">{asking?<LoaderCircle className="spin" size={16}/>:<Search size={16}/>}<span>{asking?'Searching…':'Search graph'}</span></button></div>{asking&&<div className="ask-progress" role="status" aria-live="polite"><LoaderCircle className="spin" size={18}/><span><strong>Searching the repository graph…</strong><small>Tracing related work and gathering source evidence.</small></span></div>}{answer&&<div className="ol-answer"><strong>{agent} · {answerLabel} · {evidenceCounts.recordCount} graph records / {evidenceCounts.sourceCount} sources</strong><p>{answer}</p>{querySource==='reviewer-router'&&sources.length>0&&<div className="reviewer-matches"><div className="reviewer-matches-head"><strong>Evidence-backed reviewer matches</strong><span>Ranked by shared files and related reviews</span></div>{sources.filter(match=>match.login).map((match,index)=><article className="reviewer-match" key={`${match.login}-${index}`}><span className="reviewer-rank">0{index+1}</span><div className="reviewer-match-main"><strong>@{match.login}</strong><small>{match.relatedReviews??0} related reviews · {match.sharedFiles??0} shared files</small>{Boolean(match.matchingFiles?.length)&&<div className="file-chips">{match.matchingFiles?.slice(0,4).map(file=><code key={file}>{file}</code>)}</div>}</div></article>)}</div>}{signedIn&&<small className="memory-note"><ShieldCheck size={13}/> Repository memory · {memoryCount ? `${memoryCount} saved note(s) retrieved` : 'No related saved note used'}</small>}{memoryCount>0&&recalledMemories[0]&&<div className="memory-recall-card"><span><Brain size={13}/> PREVIOUSLY SAVED CONTEXT</span><strong>{recalledMemories[0].question}</strong><p>{recalledMemories[0].answer}</p><Link href={`${repoPath}/memory`}>Open project memory <ArrowRight size={12}/></Link></div>}{evidence.map((source,i)=><a className="ol-source" key={`${source.url}-${i}`} href={source.url} target="_blank" rel="noreferrer"><span>Source {source.id ?? i + 1} · {source.role} · {source.title}</span><ArrowRight size={12}/></a>)}{signedIn&&!isGuest&&episodeId&&evidence.length>0&&<button className={`save-memory-button ${savedThisAnswer?'saved':''}`} onClick={()=>void saveCurrentAnswer()} disabled={savingMemory||savedThisAnswer}>{savingMemory?<LoaderCircle className="spin" size={14}/>:<BookmarkCheck size={14}/>} {savedThisAnswer?'Saved to project memory':'Save this finding to project memory'}</button>}{cypher&&<details className="ol-cypher"><summary>Show graph query · {sources.length} result(s)</summary><pre>{cypher}{'\n\n'}Parameters: {JSON.stringify({ repository, prompt })}</pre></details>}</div>}</div></section>}
        {view === 'activity' && <section className="ol-activity"><div className="section-title"><h1>Pull requests &amp; issues</h1><span>{data?`${activity.length} recent records`:'Import a repository to view activity'}</span></div><p className="activity-intro">Recent pull requests, issues, and commits from {repository || 'your selected repository'}.</p>{!data?<div className="panel-card ol-empty"><GitPullRequest size={24}/><h3>Build your repository timeline</h3><p>Import a bounded recent slice from GitHub. Engram keeps the last successful graph available if GitHub is temporarily unavailable.</p><button className="button-dark" onClick={()=>load(selectedRepo,true)} disabled={busy}>{busy?'Importing…':'Import repository activity'} <ArrowRight size={13}/></button></div>:activity.length?<div className="panel-card convo-list">{activity.map((item,i)=><a className="convo-row" key={`${item.kind}-${item.url}-${i}`} href={item.url} target="_blank" rel="noreferrer"><span className="convo-icon">{item.kind==='Commit'?<GitCommit size={16}/>:item.kind==='Pull request'?<GitPullRequest size={16}/>:<MessageSquareText size={16}/>}</span><span><strong>{item.kind==='Commit'?item.title:`#${item.number} · ${item.title}`}</strong><small>{item.author} · {item.kind==='Commit'?'committed':item.state} · {new Date(item.updated_at).toLocaleDateString()}</small></span><ArrowRight size={14}/></a>)}</div>:<div className="panel-card ol-empty"><h3>No recent activity in this import</h3><p>Refresh the repository or choose another GitHub repository.</p></div>}</section>}
        {view === 'memory' && <section className="ol-memory-page"><div className="memory-page-heading"><div><span className="pane-label"><Brain size={14}/> FALKORDB · PERSISTENT PROJECT MEMORY</span><h1>Keep the context<br/><em>worth carrying forward.</em></h1><p>Save source-backed findings from one investigation. Engram reconnects each saved memory to its original repository records and can bring relevant notes into later answers.</p></div><Link className="button-primary" href={`${repoPath}/ask`}><MessageSquareText size={15}/> Investigate the graph</Link></div>{error&&<div className="setup-alert">{error}</div>}{savedMemories.length?<div className="memory-list">{savedMemories.map(memory=><article className="saved-memory-card" key={memory.id}><div className="saved-memory-top"><span className="memory-type"><BookmarkCheck size={13}/> SAVED INVESTIGATION</span><time>{memory.savedAt?new Date(memory.savedAt).toLocaleString():''}</time><button aria-label="Remove saved memory" className="memory-remove" onClick={()=>void removeMemory(memory.id)}><Trash2 size={15}/></button></div><h2>{memory.question}</h2><p>{memory.answer}</p><div className="saved-memory-meta"><span>{memory.agent||'Project investigator'}</span><span>{memory.sources?.length??0} source links</span><span>Connected in this repository graph</span></div><div className="saved-memory-sources">{memory.sources?.map((source,index)=><a key={`${memory.id}-${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer"><span><small>{source.role}</small><strong>{source.title}</strong></span><ArrowRight size={13}/></a>)}</div></article>)}</div>:<div className="memory-empty"><span><Brain size={24}/></span><h2>No saved investigations yet</h2><p>Ask a question about this repository, inspect its GitHub sources, then save a finding you want future investigations to remember.</p><Link className="button-dark" href={`${repoPath}/ask`}>Ask the project <ArrowRight size={13}/></Link></div>}</section>}
        <footer className="ol-footer"><span>Repository activity from GitHub: {repository}.</span><span>{isGuest?'FalkorDB stores a public repository graph; guest questions are not saved.':'FalkorDB stores connected project context.'}</span></footer>
      </main>
    </div>
    {repoSwitcherOpen&&!isGuest&&<div className="repo-switch-overlay" role="presentation" onMouseDown={event=>event.target===event.currentTarget&&setRepoSwitcherOpen(false)}><section className="repo-switch-dialog" role="dialog" aria-modal="true" aria-labelledby="repo-switch-title"><header><div><span className="pane-label">YOUR GITHUB INSTALLATION</span><h2 id="repo-switch-title">Choose a repository</h2><p>Each repository gets its own private graph and memory.</p></div><button className="close-btn" onClick={()=>setRepoSwitcherOpen(false)} aria-label="Close repository switcher"><X size={16}/></button></header><label className="repo-switch-search"><Search size={15}/><input autoFocus value={repoSearch} onChange={event=>setRepoSearch(event.target.value)} placeholder="Search repositories you can access"/></label><div className="repo-switch-list">{reposLoading?<div className="repo-switch-empty"><LoaderCircle className="spin" size={18}/> Loading repositories from GitHub…</div>:filteredRepos.length?filteredRepos.map(repo=><button className={`repo-switch-option ${repo.full_name===repository?'current':''}`} key={repo.id} onClick={()=>void switchRepository(repo)} disabled={Boolean(switchingRepo)}><span className="repo-switch-avatar">{repo.full_name.split('/').at(-1)?.slice(0,2).toUpperCase()}</span><span className="repo-switch-copy"><strong>{repo.full_name}</strong><small>{repo.description||`${repo.language??'Repository'} · ${repo.default_branch}`}</small></span><span className="repo-switch-state">{switchingRepo===repo.full_name?<><LoaderCircle className="spin" size={14}/> Importing</>:repo.full_name===repository?'Current':repo.private?'Private':'Public'}</span></button>):<div className="repo-switch-empty">{availableRepos.length?'No repository matches that search.':'No repositories are available to this GitHub App installation yet.'}<Link href="/setup/github">Manage GitHub access <ArrowRight size={12}/></Link></div>}</div><footer><ShieldCheck size={14}/> Only repositories granted to this Engram installation appear here.</footer></section></div>}
  </div>;
}
