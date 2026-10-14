import { Suspense } from 'react';
import { GitHubSetup } from '@/components/github-setup';
export default function Page(){return <Suspense fallback={<main className="setup-page"><p>Loading GitHub setup…</p></main>}><GitHubSetup/></Suspense>}
