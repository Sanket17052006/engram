# Engram

Engram turns GitHub repository activity into a graph-backed project memory. People ask natural-language questions; deterministic agents query FalkorDB with parameterized Cypher and return source links, the query, and the evidence path. No LLM is required for the answer path.

## Run locally

Requirements: Node.js 20+, Docker, and a GitHub App for private repository access.

```sh
npm install
docker compose up -d falkordb
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. The public Open Library demo can import `internetarchive/openlibrary` without signing in. To connect a private or personal repository, create a GitHub App and set the App slug, App ID, Client ID, Client secret, private key, and a random `SESSION_SECRET` in `.env.local`. Keep that file and the downloaded PEM private key out of Git.

The GitHub App needs read-only **Metadata**, **Issues**, **Pull requests**, and **Contents** repository permissions. Contents access is used for commit history; the rest of the sync continues with a warning if that permission is unavailable. Configure the user callback as `http://localhost:3000/api/github/auth/callback` and the installation setup URL as `http://localhost:3000/api/github/callback`. Do not enable “Request user authorization during installation”; Engram has a separate PKCE sign-in step. Install the app only on repositories you choose.

FalkorDB uses the Redis protocol at `redis://localhost:6379`; its optional browser UI is on `http://localhost:3001`. The project overview reports when the latest import completed and the newest activity timestamp found.

## Graph model

Each connected user and repository gets a separate FalkorDB graph. The public Open Library demo uses `engram_openlibrary`.

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

Every import requests the newest updated pull requests and issues first with `cache: no-store`, stores `syncedAt` and `latestActivityAt`, and removes work items and commits that have fallen outside the bounded index. The GitHub App sync indexes up to 200 PRs and 200 issues. It fetches reviews, comments, and changed files for up to the 50 most recently updated PRs and comments for up to the 50 most recently updated issues. Commit and contributor lists are capped at 200 and 100 respectively. Each record body is truncated before it enters the graph. The public demo uses smaller 20-item windows and detailed activity for its newest 10 PRs and issues.

This is a recent-activity memory, not a complete archive. Data outside the import windows is not searchable. Sync currently runs when the user requests an import; webhooks and a background incremental job are future deployment work. A production service also needs a durable user database, account deletion/export flow, operational logging policy, and managed secret storage.

## API routes

- `GET /api/github/auth/start` and `/api/github/auth/callback` — GitHub App user authorization with state and PKCE.
- `GET /api/github/start` and `/api/github/callback` — installation handoff, account verification, and session binding.
- `GET /api/github/repos` — repositories visible to the verified installation.
- `POST /api/github/sync` — bounded repository import into the user/repository graph.
- `GET /api/github/status`, `POST /api/github/logout` — connection status and local sign-out.
- `POST /api/openlibrary` — refresh the public Open Library demo graph.
- `POST /api/openlibrary/ask` and `POST /api/chat` — routed graph query with answer, evidence, Cypher, memory, and handoff metadata.
- `GET /api/graph/explore` and `GET /api/node/:nodeId` — graph shape, node attributes, and relationship attributes.

## Checks

```sh
npm run build
npm run dev
npm run test:e2e
```

The end-to-end suite defaults to `http://localhost:3100`; set `ENGRAM_E2E_URL` to override it. It exercises service status, OAuth/PKCE redirect construction, unauthenticated access boundaries, FalkorDB query routes, and explorer response shape. A full GitHub installation sync test requires an installed app and a browser-authorized session.
