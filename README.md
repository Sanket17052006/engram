# Engram

Engram turns GitHub repository activity into a graph-backed project memory. People ask natural-language questions; deterministic agents query FalkorDB with parameterized Cypher and return source links, the query, and the evidence path. No LLM is required for the answer path.

## Run locally

Requirements: Node.js 22+, a persistent FalkorDB instance, and a GitHub App for user-connected repositories. Set `OPENAI_API_KEY` to enable natural-language answer synthesis; graph retrieval and deterministic answers continue to work without it.

```sh
npm install
docker compose up -d falkordb
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. Sign in with GitHub, install the read-only app for repositories you choose, and select one repository to create your workspace. Any repository available to that installation can be selected; OpenLibrary is only one possible personal demo target. To connect a repository, create a GitHub App and set the App slug, App ID, Client ID, Client secret, private key, and a random `SESSION_SECRET` in `.env.local`. Keep that file and the downloaded PEM private key out of Git.

## Free self-hosted deployment

For a no-monthly-compute-cost beta, the best fit is one OCI Always Free Ampere VM running the app, Caddy, and FalkorDB in Docker. Oracle currently lists up to 2 OCPUs and 12 GB RAM in its Always Free A1 allowance. This avoids putting private repository data in a free database tier without continuous persistence/backups. A single free VM is still one failure domain: it is suitable for a personal beta or small pilot, not a high-availability or guaranteed-SLA production service. Oracle may reclaim Always Free instances it considers idle; keep backups outside that VM. [OCI Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

Vercel Hobby is a poor fit for the full stack: its cron jobs run at most daily and it does not host the FalkorDB process. Render's free services spin down after inactivity and have ephemeral local filesystems, which is unsuitable for the graph volume. [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Render free service limits](https://render.com/docs/free)

1. Provision an Ubuntu OCI A1 VM, attach the public IP to a DNS name, and open only SSH, HTTP, and HTTPS in the cloud firewall. Do not expose port 6379.
2. Install Docker Engine and Compose on the VM, clone this repository, and copy `.env.production.example` to `.env.production`.
3. Set a random hex `FALKORDB_PASSWORD` and `SESSION_SECRET`, enter the GitHub App credentials, and add an `OPENAI_API_KEY` if AI answer synthesis is wanted. Configure the GitHub App callback and setup URLs with `https://<your-domain>/api/github/auth/callback` and `https://<your-domain>/api/github/callback`.
4. Point the domain to the VM and run `docker compose --env-file .env.production -f docker-compose.production.yml up -d --build`. Caddy obtains and renews HTTPS certificates. FalkorDB has authentication, append-only persistence, a named data volume, and no public port.
5. Pin `FALKORDB_IMAGE` to a version tested by your deployment before inviting users. Set a recurring off-instance backup and test restore before storing data you cannot afford to lose.

The graph is served from the last successful snapshot while a GitHub refresh is rate-limited; retries are explicit and GitHub's `Retry-After` is returned. This build still uses user-triggered imports. Webhook-driven continuous sync, a managed job queue, automated off-site backup verification, and account deletion/export are required before offering it as a generally available multi-tenant service.

The GitHub App needs read-only **Metadata**, **Issues**, **Pull requests**, and **Contents** repository permissions. Contents access is used for commit history; the rest of the sync continues with a warning if that permission is unavailable. Configure the user callback as `http://localhost:3000/api/github/auth/callback` and the installation setup URL as `http://localhost:3000/api/github/callback`. Do not enable “Request user authorization during installation”; Engram has a separate PKCE sign-in step. Install the app only on repositories you choose.

For a deployed instance, register the production callback and setup URLs on the GitHub App, use HTTPS, provide a stable `SESSION_SECRET`, and set the FalkorDB URL to a private network endpoint with authentication/TLS where supported. Configure `OPENAI_API_KEY` and optionally `OPENAI_MODEL` on the server to turn on natural-language answer synthesis. Engram sends the user question plus up to 12 bounded graph results and source links to that configured OpenAI account; requests set `store: false`. Without an LLM key, the graph tools still query FalkorDB and return their deterministic evidence summary. The answer panel indicates which mode produced the answer.

FalkorDB uses the Redis protocol at `redis://localhost:6379`; its optional browser UI is on `http://localhost:3001`. The project overview reports when the latest import completed and the newest activity timestamp found.

## Graph model

Each connected user and repository gets a separate FalkorDB graph. A workspace only becomes available after GitHub sign-in and an explicit repository selection; no repository is preselected or publicly imported.

| Node | Useful properties |
|---|---|
| `Repository` | full name, URL, description, default branch, visibility, import time, latest activity time, indexed counts |
| `WorkItem` | PR or issue kind, number, title, bounded body, state, author, labels, timestamps, comment count, merge and change statistics |
| `Contributor` | login, profile URL, avatar, PRs/issues opened, reviews/comments written, commits authored, last activity |
| `Review` | state, submission time, source URL, bounded review body |
| `File` | path, change status, additions, deletions, total changes, GitHub URL |
| `Comment` | author relationship, bounded body, timestamps, source URL |
| `Commit` | SHA, message, author, authored date, source URL |
| `Episode` and `Agent` | private question/answer history, selected agent, intent, evidence count, and handoff |

Edges encode repository membership, authorship, opened work, submitted reviews, file changes, comment context, commit authorship, and agent handoffs. Edges retain dates, review state, file-change statistics, or source context where applicable. The graph explorer exposes both node and edge attributes.

## Agents and track coverage

- **Connected-data agent work:** Reviewer Router follows a target PR’s changed files to previous PRs, then through their reviews to contributors. It ranks matches by shared files and related reviews, returns evidence links, and shows the parameterized Cypher.
- **Agent memory and coordination:** Context Retriever hands evidence to Reviewer Router, Expertise Finder, Decision Trace, or Project Guide. Follow-up questions can retrieve matching past episodes from the user’s private repository graph. The graph keeps the latest 100 episodes per repository.
- **Company/project brain:** the graph joins contributors, PRs, issues, comments, reviews, changed files, and commits. Expertise results are based on observed review activity. Decision Trace surfaces matching source discussions; it does not claim that every merged PR is a formally approved decision.

## Freshness and import bounds

Every import requests the newest updated pull requests and issues first with `cache: no-store`, stores `syncedAt` and `latestActivityAt`, and removes work items and commits that have fallen outside the bounded index. GitHub's transient server errors receive short retries. Primary or secondary rate limits return HTTP 429 with `Retry-After` and `retryAt`; a failed refresh does not delete or overwrite the last successful graph snapshot. Workspace views read the cached graph first and continue to show it if refresh is unavailable. The GitHub App sync indexes up to 200 PRs and 200 issues. It fetches reviews, comments, and changed files for up to the 50 most recently updated PRs and comments for up to the 50 most recently updated issues. Commit and contributor lists are capped at 200 and 100 respectively. Each record body is truncated before it enters the graph. Imports use the same bounded windows for every selected repository.

This is a recent-activity memory, not a complete archive. Data outside the import windows is not searchable. Sync currently runs when the user requests an import; webhook-driven refresh and a background incremental job are future deployment work. A production service also needs a durable user database, account deletion/export flow, operational logging policy, and managed secret storage. The app can run as a self-hosted service today, but a public multi-tenant launch still needs those operational controls, abuse protection, monitoring, and a deployment domain; a local Docker setup alone is not a hosted production service.

## API routes

- `GET /api/github/auth/start` and `/api/github/auth/callback` — GitHub App user authorization with state and PKCE.
- `GET /api/github/start` and `/api/github/callback` — installation handoff, account verification, and session binding.
- `GET /api/github/repos` — repositories visible to the verified installation.
- `POST /api/github/sync` — bounded repository import into the user/repository graph.
- `GET /api/github/sync` — serve the last successful private-repository snapshot without calling GitHub.
- `GET /api/github/status`, `POST /api/github/logout` — connection status and local sign-out.
- `POST /api/chat` — routed graph query for the signed-in user’s selected repository, with answer, evidence, Cypher, memory, and handoff metadata.
- `GET /api/graph/explore` and `GET /api/node/:nodeId` — graph shape, node attributes, and relationship attributes for the selected repository; both require a signed-in session.

## Checks

```sh
npm run build
npm run dev
npm run test:e2e
```

The end-to-end suite defaults to `http://localhost:3100`; set `ENGRAM_E2E_URL` to override it. It exercises service status, OAuth/PKCE redirect construction, unauthenticated access boundaries, FalkorDB query routes, and explorer response shape. A full GitHub installation sync test requires an installed app and a browser-authorized session.
