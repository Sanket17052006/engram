'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Database, Github, Network, ShieldCheck } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';

const sampleRepositories = ['vercel/next.js', 'facebook/react', 'pallets/flask'];

export function PublicRepoStart() {
  const [repository, setRepository] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();

  function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    let value = repository.trim();
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) throw Error();
        value = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
      } catch {
        setError('Enter a GitHub repository URL or owner/repository.');
        return;
      }
    }
    const parts = value.replace(/^@/, '').split('/');
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part) || part === '.' || part === '..')) {
      setError('Enter a repository as owner/name, for example vercel/next.js.');
      return;
    }
    router.push(`/demo/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`);
  }

  return (
    <main className="public-demo-page">
      <header className="public-demo-nav">
        <Link href="/" className="brand" aria-label="Engram home">
          <span className="brand-mark"><BrandMark size={38} /></span>
          <span>engram<span className="brand-dot">.</span></span>
        </Link>
        <Link className="public-demo-back" href="/"><ArrowLeft size={15} /> <span>Back to Engram</span></Link>
      </header>

      <section className="public-demo-layout" aria-labelledby="public-demo-title">
        <div className="public-demo-intro">
          <span className="public-demo-eyebrow"><i /> PUBLIC REPOSITORY EXPLORER</span>
          <h1 id="public-demo-title">A repo has a story.<br /><em>Follow the connections.</em></h1>
          <p className="public-demo-lede">Explore contributors, pull requests, reviews, issues, commits, and files as one living graph. Ask a question and get an answer grounded in the repository’s public GitHub activity.</p>
          <div className="public-demo-points">
            <div><span><Network size={16} /></span><p><strong>Connected context</strong><small>See how people and project work link together.</small></p></div>
            <div><span><Database size={16} /></span><p><strong>Real graph data</strong><small>Recent public activity, indexed in FalkorDB.</small></p></div>
          </div>
        </div>

        <div className="public-demo-card">
          <div className="public-demo-card-top"><span className="public-demo-github"><Github size={18} /></span><span className="public-demo-live"><i /> PUBLIC DATA</span></div>
          <h2>Choose a repository</h2>
          <p className="public-demo-card-copy">Enter a public GitHub repository to build its graph and start exploring.</p>
          <form onSubmit={submit} className="public-repo-form">
            <label htmlFor="public-repository">GitHub repository</label>
            <div className="public-repo-input-wrap">
              <Github size={18} aria-hidden="true" />
              <input
                id="public-repository"
                aria-describedby={error ? 'public-repository-error' : 'public-repository-hint'}
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="owner/repository"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <small id="public-repository-hint">Or paste a GitHub URL, like github.com/owner/repo</small>
            {error && <p id="public-repository-error" className="public-repo-error" role="alert">{error}</p>}
            <button className="public-repo-submit" type="submit">Explore repository <ArrowRight size={17} /></button>
          </form>
          <div className="public-demo-samples"><span>Try a popular repo</span><div>{sampleRepositories.map((sample) => <button key={sample} type="button" onClick={() => { setRepository(sample); setError(''); }}>{sample}</button>)}</div></div>
          <div className="public-demo-assurance"><ShieldCheck size={16} /><span>Public repositories only</span><i /><span>Read only</span><i /><span>No sign in</span></div>
        </div>
      </section>

      <footer className="public-demo-footer"><span>ENGRAM <i /> PROJECT MEMORY, MADE VISIBLE</span><span>Guest graphs stay separate from personal workspaces.</span></footer>
    </main>
  );
}
