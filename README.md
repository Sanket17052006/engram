<p align="center">
  <img src="public/engram-brain-network.png" alt="Engram brain and graph mark" width="160" />
</p>

# Engram

**A living, graph-backed memory for the work inside a GitHub repository.**

Engram connects contributors, pull requests, issues, reviews, discussions, commits, and files so teams can find the context behind their code and work.

<br />

## The problem Engram solves

Important project knowledge is scattered across GitHub activity. A pull request shows a change, but the surrounding review history, people who know the affected files, linked issues, and earlier decisions can take time to piece together. That context is especially hard to recover when a contributor is new to a repository or the people who remember the history are unavailable.

Engram imports a repository a user explicitly selects, connects its activity as a FalkorDB graph, and uses graph queries to answer practical questions with source links. The product is repository-agnostic: each user signs in with GitHub and chooses which repository to index. No repository is preselected.

## What it can do

- **Find reviewers from prior work.** For a pull request, follow changed files to earlier pull requests and reviews, then rank contributors by overlapping review history.
- **Find relevant experience.** Search review and file history for people who have worked on a topic or path.
- **Trace discussions.** Find issues, pull requests, and comments that may explain a change or decision, with links to the original GitHub records.
- **Explore contributor connections.** Start from the signed-in contributor and follow connected people, work items, commits, files, and relationships one neighborhood at a time.
- **Keep project memory across questions.** Save graph-grounded question and answer episodes in the user-and-repository graph, and make recent relevant episodes available to later agent runs.
- **Inspect the evidence.** Answers include the selected investigator, MCP graph tool, Cypher query and parameters, source links, memory use, and agent handoff.

Engram's agents investigate and recommend based on repository evidence. They do not write to GitHub or make code changes.

## How an answer is produced

1. **Authenticate and scope.** Next.js checks the GitHub session and the user's selected repository.
2. **Plan the investigation.** The FastAPI LangGraph workflow chooses a specialist and its MCP graph tool. Gemini selects the tool when configured; deterministic routing is the fallback.
3. **Query graph evidence.** The read-only MCP tool runs parameterized Cypher against the user's private FalkorDB repository graph.
4. **Ground the response.** The workflow builds an answer from graph records and their GitHub source URLs. Gemini may phrase this grounded draft; it does not supply the underlying facts.
5. **Remember the investigation.** Engram stores an `Episode` and agent handoff in the same user-and-repository graph.
6. **Return a traceable answer.** The user receives the response, evidence, query, parameters, sources, and memory details.

The question is routed to one of five specialist tools: `reviewer_candidates`, `expertise_lookup`, `decision_trace`, `contributor_activity`, or `repository_search`. Gemini can select the read-only tool when configured. If Gemini is unavailable, deterministic routing selects a tool instead. The selected tool—not the language model—queries FalkorDB and supplies the evidence. Gemini receives a graph-derived draft and bounded source metadata for phrasing; invalid or unavailable synthesis falls back to the deterministic graph answer.

## Real agent execution, verified

The agent workflow is implemented in Python with LangGraph and FastMCP. The graph defines planning, memory retrieval, MCP tool execution, and grounded answer/memory steps. A live smoke run on **October 15, 2026** exercised five different questions against an imported repository graph:

| Investigator | MCP tool | Evidence rows | Source links |
|---|---|---:|---:|
| Reviewer Router | `reviewer_candidates` | 1 | 3 |
| Expertise Finder | `expertise_lookup` | 2 | 3 |
| Decision Trace | `decision_trace` | 8 | 6 |
| Contributor Activity | `contributor_activity` | 2 | 6 |
| Project Guide | `repository_search` | 8 | 6 |
| **Total** | **5 completed tool calls** | **21** | **24** |

All five calls returned graph records, produced source-linked answers, and wrote an `Episode` to FalkorDB. Gemini selected the tool and phrased the answer in all five checks. The counts above describe that verification snapshot; they are not fixed product limits or a promise about another repository's available history.

## The graph model

FalkorDB stores typed nodes and relationships instead of flattening activity into unrelated lists. Every graph is scoped to a GitHub user and selected repository.

| Node | Example information |
|---|---|
| `Repository` | Name, URL, default branch, visibility, import timestamp, and activity timestamp |
| `Contributor` | GitHub login and profile, observed PRs/issues, reviews, comments, commits, and activity |
| `WorkItem` | Pull request or issue, title, state, author, dates, labels, assignees, and change statistics |
| `Review` / `Comment` | Author, review state or comment text, time, and original GitHub URL |
| `File` | Path, change status, additions, deletions, and source URL |
| `Commit` / `RepositoryBranch` | SHA, message, author, date, branch, and GitHub URL |
| `Episode` / `Agent` | Question, grounded answer, investigator, intent, evidence count, memory timestamp, and handoff |

Relationships represent repository membership, authorship, assignment, requested review, review submission, comments, changed files, commits, branches, labels, and issue-closing references. Relationship properties preserve context such as review state, dates, and file change counts. The explorer begins with the user's connected work and displays a bounded local neighborhood; users can follow connections as needed instead of rendering the whole repository graph at once.

## Architecture and technology

| Layer | Technology | Why it is used |
|---|---|---|
| Web app and UI | Next.js 15 App Router, React 18, TypeScript, Tailwind CSS | Responsive UI, server routes for GitHub integration, and one deployment artifact for the web layer |
| Agent core | Python 3.12, FastAPI, LangGraph | Structured agent workflow, typed API boundaries, and asynchronous graph/provider calls |
| Tool interface | FastMCP | Exposes the graph investigators through a discoverable MCP tool boundary |
| Graph database | FalkorDB | Redis-protocol graph storage and parameterized Cypher queries over relationships |
| Repository data | GitHub App REST API | User-authorized installation tokens with repository-scoped read access |
| Optional language model | Gemini API | Tool selection and concise phrasing of graph-grounded drafts; deterministic operation remains available without it |
| Local/deployment runtime | Docker Compose, Caddy | Local services and a single-host HTTPS deployment option |

## Sign-in and data boundaries

1. A person signs in with GitHub through Engram's GitHub App user-authorization flow. OAuth `state` and PKCE protect the callback.
2. Engram verifies the GitHub identity and encrypts the session cookie with `jose`. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
3. The user installs Engram and grants repository access, then chooses one repository from that installation.
4. Next.js uses a GitHub installation token to read the selected repository. The token, App private key, and client secret stay on the server.
5. The verified GitHub user ID and selected repository determine the private FalkorDB graph name. Chat and graph APIs require the signed-in session and selected repository; responses are marked `private, no-store`.
6. Next.js calls the FastAPI core with a separate shared internal key and identity/repository headers. In production, the app, core, and database communicate over a private Docker network; the core and database are not exposed through Caddy.

Cloning the source does not include `.env.local`, GitHub credentials, tokens, or graph data. A local clone cannot sign in to an owner's account: each developer must configure their own GitHub App credentials and session secret. In a hosted instance, each user authorizes their own GitHub account and chooses the repository they grant Engram access to.

The only GitHub App permissions needed are read-only **Metadata**, **Issues**, **Pull requests**, and **Contents** (for commit history). Engram does not request write permissions. Installations can be revoked from GitHub at any time.

## Import freshness and coverage

Imports fetch current GitHub API data when the user requests a refresh and use `cache: no-store`. A failed or rate-limited refresh leaves the last successful graph snapshot available; the UI reports its import and newest-activity timestamps. Rate-limit responses include GitHub's retry timing when provided.

Import is intentionally bounded to make API use and graph size predictable:

- Up to **200** recently updated pull requests and **200** recently updated issues.
- Reviews, comments, and changed files for up to the **50** most recently updated pull requests; comments for up to the **50** most recently updated issues.
- Up to **100** contributors.
- Up to **200** deduplicated commits, including recent commits from the **12** most active branches, with up to **30** commits per selected branch.
- Record bodies and discussion text are truncated before storage.
- Up to **100** recent memory episodes are retained per user and repository graph.

This is a recent-activity index rather than a complete historical archive. GitHub API access and repository size determine which source records are available. Forks use public upstream PR and issue context when accessible; branch and commit activity remains tied to the selected repository.

## Run locally

### Requirements

- Node.js 22+
- Docker with Compose
- A GitHub App configured for user authorization and repository read access
- Gemini API key (optional; deterministic agent routing and graph-grounded answers work without it)

### 1. Configure environment

```sh
cp .env.example .env.local
openssl rand -hex 32
```

Set the generated value as `SESSION_SECRET`, and set a different random value for `ENGRAM_INTERNAL_API_KEY`. Add your GitHub App slug, App ID, Client ID, Client secret, and private key. Keep `.env.local` private; it is ignored by Git.

For local development on port `3100`, set the GitHub App user callback URL to:

```text
http://localhost:3100/api/github/auth/callback
```

Set the App setup URL to:

```text
http://localhost:3100/api/github/callback
```

Enable GitHub App user authorization, use read-only repository permissions, and allow installation on any account if users outside your own account should connect their repositories. Engram uses a separate PKCE sign-in flow; leave “Request user authorization during installation” disabled.

### 2. Start FalkorDB and the agent core

```sh
docker compose up -d --build falkordb core
```

### 3. Start the web app

```sh
npm ci
npm run dev
```

Open [http://localhost:3100](http://localhost:3100), sign in, install Engram, choose a repository, and import it. Optional service endpoints: [FalkorDB browser](http://localhost:3001) and [FastAPI health](http://localhost:8000/health).

## Configuration reference

See [`.env.example`](.env.example) for local settings and [`.env.production.example`](.env.production.example) for deployment settings. Never commit either a populated `.env.local` or a downloaded private key.

| Variable | Purpose |
|---|---|
| `GITHUB_APP_SLUG`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID` | Identify the GitHub App |
| `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` | Server-only GitHub App credentials |
| `SESSION_SECRET` | Encrypts the user session cookie |
| `FALKORDB_URL` | FalkorDB Redis-protocol connection string |
| `ENGRAM_CORE_URL`, `ENGRAM_INTERNAL_API_KEY` | Private Next.js-to-FastAPI connection |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional tool selection and answer phrasing |
| `APP_DOMAIN`, `FALKORDB_PASSWORD`, `FALKORDB_IMAGE` | Production deployment and protected database settings |

## Self-hosting and trade-offs

The production Compose file runs Next.js, FastAPI, FalkorDB, and Caddy on one host. Caddy terminates HTTPS; only HTTP and HTTPS are published, while FalkorDB and FastAPI stay on the internal network. Set a strong unique session secret, internal API key, and database password. Use a pinned FalkorDB image version and keep tested backups outside the host.

This single-host design keeps the stack straightforward and inexpensive to operate, but it is one failure domain and needs independent backups. Sync is user-triggered rather than continuously updated by webhooks or a job queue. The deployment guide therefore recommends testing off-host backups and restore procedures before storing data that cannot be re-imported.

Gemini improves routing and phrasing but adds a provider dependency and sends the question plus bounded graph-derived answer context to Google's API. Disable its key to keep queries and answer generation on the local deterministic path. FalkorDB stores repository activity as a graph, which makes relationship traversal direct; the cost is that Engram currently indexes a bounded recent window rather than every GitHub event.

## Checks

```sh
npm run build
npm run test:e2e
```

The end-to-end suite verifies the GitHub setup page, OAuth state/PKCE redirect, unauthenticated repository/chat/graph access, cache headers, and service-status credential redaction. Live agent verification additionally exercises each of the five MCP graph tools against FalkorDB and confirms evidence, source links, answer mode, and persisted episodes.

## API routes

| Route | Purpose |
|---|---|
| `GET /api/github/auth/start`, `GET /api/github/auth/callback` | GitHub user sign-in with state and PKCE |
| `GET /api/github/start`, `GET /api/github/callback` | Installation flow and account verification |
| `GET /api/github/repos` | List repositories available to the verified installation |
| `POST /api/github/sync`, `GET /api/github/sync` | Import a selected repository or read its cached snapshot |
| `GET /api/github/status`, `POST /api/github/logout` | Connection state and sign-out |
| `POST /api/chat` | Run the scoped graph-agent workflow |
| `GET /api/graph/explore`, `GET /api/node/:nodeId` | Explore connected graph neighborhoods and node details |
