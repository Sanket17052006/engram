# Engram

Engram explores project history as connected knowledge. The first real repository is Open Library (`internetarchive/openlibrary`): recent pull requests, issues, review events, changed files, and their contributors.

## Local development

```sh
npm install
cp .env.example .env.local
npm run dev
```

Visit http://localhost:3000 and open **Explore Open Library**. Load a bounded recent window from GitHub. Public reads work without a token, but GitHub limits unauthenticated requests; set a read-only `GITHUB_TOKEN` in `.env.local` for a larger API quota. Never commit `.env.local`.

## FalkorDB

Start the included local database:

```sh
docker compose up -d falkordb
```

FalkorDB listens at `redis://localhost:6379` and its browser is at http://localhost:3001. Configure `FALKORDB_URL=redis://localhost:6379` in `.env.local`, restart Next.js, then load the repository again. Engram writes to the `engram_openlibrary` graph. Without FalkorDB, the app labels the session as Preview and still fetches public repository activity; graph persistence is not available.

For hosted deployment, use a FalkorDB Cloud connection URL in `FALKORDB_URL` and keep it in the hosting provider's secret settings.

## Current graph model

- `Repository` — selected GitHub repository
- `WorkItem` (`kind: PR | Issue`) — title, state, author, dates, source URL, and bounded body text
- `Contributor` — GitHub login
- `Review` — submitted review state and source URL
- `File` — changed file path and source URL
- Relationships: `HAS_ITEM`, `OPENED`, `SUBMITTED`, `ON_PR`, and `MODIFIES`

The initial import is intentionally bounded to the 20 most recently updated PRs and 20 issues, with reviews and files for the 10 most recent PRs. The UI links each record back to GitHub. Do not use the current preview's text matcher as a substitute for a graph-backed answer; the next integration step is to route questions and graph exploration through FalkorDB Cypher and return evidence paths.

## API

- `POST /api/openlibrary` — fetch recent public repository activity and persist the bounded graph slice when FalkorDB is configured
- `POST /api/chat` — legacy prototype chat route; not yet connected to the Open Library workspace
- `GET /api/graph/explore` — legacy graph explorer route; still requires Open Library graph shaping

## Local repository

This project is kept in the `Sanket17052006/engram` GitHub repository. Local commits are fine; do not push until explicitly asked.
