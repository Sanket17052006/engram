from __future__ import annotations

import hmac
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field, model_validator

from .agent import ask, mcp
from .codebase import scan_codebase
from .db import graph_for, graph_named, normalize, rows


app = FastAPI(title="Engram Core", version="0.1.0")


class Principal(BaseModel):
    user_id: str
    login: str
    repository: str


async def principal(
    internal_key: Annotated[str | None, Header(alias="X-Engram-Core-Key")] = None,
    user_id: Annotated[str | None, Header(alias="X-Engram-User-Id")] = None,
    login: Annotated[str | None, Header(alias="X-Engram-Login")] = None,
    repository: Annotated[str | None, Header(alias="X-Engram-Repository")] = None,
) -> Principal:
    expected = os.environ.get("ENGRAM_INTERNAL_API_KEY", "")
    if not expected or not internal_key or not hmac.compare_digest(expected, internal_key):
        raise HTTPException(status_code=401, detail="Internal service authentication failed")
    if not user_id or not user_id.isdigit() or not login or not re.fullmatch(r"[A-Za-z0-9-]{1,39}", login):
        raise HTTPException(status_code=401, detail="A verified GitHub user is required")
    if not repository or repository.count("/") != 1:
        raise HTTPException(status_code=400, detail="Select a repository first")
    return Principal(user_id=user_id, login=login, repository=repository)


class UserModelConfig(BaseModel):
    provider: Literal["openai", "anthropic", "gemini", "groq", "openrouter", "together", "deepseek", "ollama"]
    model: str = Field(min_length=1, max_length=120, pattern=r"^[a-zA-Z0-9._:/-]+$")
    api_key: str | None = Field(default=None, alias="apiKey", max_length=4096)

    @model_validator(mode="after")
    def require_key_for_hosted_provider(self):
        if self.provider != "ollama" and (not self.api_key or len(self.api_key) < 8):
            raise ValueError("A provider API key is required")
        return self


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    target_number: int = Field(default=0, ge=0, le=10_000_000, alias="targetNumber")
    user_model: UserModelConfig | None = Field(default=None, alias="modelConfig")
    remember: bool = True


class MemorySaveRequest(BaseModel):
    episode_id: str = Field(min_length=36, max_length=36, alias="episodeId")


class MemoryDeleteRequest(BaseModel):
    memory_id: str = Field(min_length=36, max_length=64, alias="memoryId")


class GraphQuery(BaseModel):
    graph_name: str = Field(pattern=r"^engram_u[0-9]+_[a-f0-9]{12}$", alias="graphName")
    query: str = Field(min_length=1, max_length=64_000)
    params: dict = Field(default_factory=dict)


class CodebaseNeighborhoodRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=20)


class CodebaseFile(BaseModel):
    path: str = Field(min_length=1, max_length=300)
    content: str = Field(max_length=1_000_000)


class CodebaseImportContents(BaseModel):
    files: list[CodebaseFile] = Field(min_length=1, max_length=2500)
    commit: str = Field(min_length=7, max_length=64)
    branch: str = Field(min_length=1, max_length=120)

    @model_validator(mode="after")
    def validate_content_size_and_paths(self):
        total = 0
        for item in self.files:
            parts = Path(item.path).parts
            if Path(item.path).is_absolute() or ".." in parts or ".git" in parts or not re.fullmatch(r"[A-Za-z0-9_./-]+", item.path):
                raise ValueError("Source files must use safe repository-relative paths")
            total += len(item.content.encode("utf-8"))
        if total > 30_000_000:
            raise ValueError("Code graph import is limited to 30 MB of source text")
        return self


def _codebase_root() -> str:
    root = os.environ.get("ENGRAM_CODEBASE_ROOT", "")
    if not root:
        raise HTTPException(status_code=503, detail="No local source checkout is configured for code graph import.")
    return root


@app.post("/v1/codebase/import")
async def import_codebase(identity: Annotated[Principal, Depends(principal)]):
    """Index a preconfigured local checkout without accepting paths from the caller."""
    try:
        scanned = scan_codebase(_codebase_root())
        if not scanned["nodes"]:
            raise HTTPException(status_code=422, detail="No supported source files were found in the configured checkout.")
        return await _store_scanned_codebase(identity, scanned)
    except HTTPException:
        raise
    except Exception as error:
        print(f"Code graph import failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="Could not import the configured source checkout into FalkorDB.") from error


async def _store_scanned_codebase(identity: Principal, scanned: dict):
    graph = graph_for(identity.user_id, identity.repository)
    repository = identity.repository
    await graph.query("MATCH (n {repository:$repo, sourceType:'codebase'}) DETACH DELETE n", {"repo": repository})
    node_groups: dict[str, list[dict]] = {"CodeFile": [], "TestFile": [], "CodeSymbol": []}
    for item in scanned["nodes"]:
        node = dict(item)
        label = str(node.pop("type"))
        node["graphKey"] = node.pop("id")
        node["repository"] = repository
        node["sourceType"] = "codebase"
        node_groups[label].append(node)
    for label, batch in node_groups.items():
        for start in range(0, len(batch), 100):
            await graph.query(f"UNWIND $items AS item MERGE (n:{label} {{graphKey:item.graphKey, repository:item.repository, sourceType:item.sourceType}}) SET n += item", {"items": batch[start:start + 100]})
    edges = [dict(edge, repository=repository, sourceType="codebase") for edge in scanned["edges"]]
    for start in range(0, len(edges), 100):
        await graph.query("""UNWIND $items AS item
          MATCH (source {graphKey:item.source,repository:item.repository,sourceType:item.sourceType})
          MATCH (target {graphKey:item.target,repository:item.repository,sourceType:item.sourceType})
          MERGE (source)-[r:CODE_RELATION {kind:item.type,repository:item.repository,sourceType:item.sourceType}]->(target)""", {"items": edges[start:start + 100]})
    stored_edges = rows(await graph.query("MATCH ()-[r:CODE_RELATION {repository:$repo,sourceType:'codebase'}]->() RETURN count(r)", {"repo": repository}), ["count"])
    actual_edge_count = int(stored_edges[0].get("count", 0)) if stored_edges else 0
    snapshot = {"repository": repository, "sourceType": "codebase", "filesScanned": scanned["filesScanned"], "nodeCount": len(scanned["nodes"]), "edgeCount": actual_edge_count, "truncated": scanned["truncated"], "importedAt": datetime.now(timezone.utc).isoformat(), "commit": scanned.get("commit", ""), "branch": scanned.get("branch", "")}
    await graph.query("MERGE (s:CodebaseSnapshot {repository:$repository,sourceType:'codebase'}) SET s += $snapshot", {"repository": repository, "snapshot": snapshot})
    return {"imported": True, "repository": repository, "filesScanned": snapshot["filesScanned"], "nodeCount": snapshot["nodeCount"], "edgeCount": snapshot["edgeCount"], "truncated": snapshot["truncated"], "importedAt": snapshot["importedAt"], "commit": snapshot["commit"], "branch": snapshot["branch"]}


@app.post("/v1/codebase/import-content")
async def import_codebase_contents(body: CodebaseImportContents, identity: Annotated[Principal, Depends(principal)]):
    """Store a bounded code snapshot obtained by the authenticated GitHub gateway."""
    try:
        with tempfile.TemporaryDirectory(prefix="engram-code-import-") as temporary:
            root = Path(temporary).resolve()
            for item in body.files:
                target = (root / item.path).resolve()
                if not target.is_relative_to(root):
                    raise HTTPException(status_code=400, detail="Unsafe source path in code graph import.")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(item.content, encoding="utf-8")
            scanned = scan_codebase(root)
        if not scanned["nodes"]:
            raise HTTPException(status_code=422, detail="The selected GitHub repository has no supported source files in the bounded import window.")
        scanned["commit"] = body.commit
        scanned["branch"] = body.branch
        return await _store_scanned_codebase(identity, scanned)
    except HTTPException:
        raise
    except Exception as error:
        print(f"GitHub code graph import failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="Could not store the GitHub source snapshot in FalkorDB.") from error


@app.get("/v1/codebase/graph")
async def codebase_graph(identity: Annotated[Principal, Depends(principal)]):
    try:
        graph = graph_for(identity.user_id, identity.repository)
        nodes = rows(await graph.query("""MATCH (n {repository:$repo,sourceType:'codebase'})
          WHERE n:CodeFile OR n:TestFile OR n:CodeSymbol
          RETURN id(n),labels(n),properties(n) LIMIT 12000""", {"repo": identity.repository}), ["nodeId", "labels", "node"])
        edges = rows(await graph.query("""MATCH (source {repository:$repo,sourceType:'codebase'})-[r:CODE_RELATION {repository:$repo,sourceType:'codebase'}]->(target {repository:$repo,sourceType:'codebase'})
          RETURN source.graphKey,type(r),r.kind,target.graphKey LIMIT 20000""", {"repo": identity.repository}), ["source", "edgeType", "kind", "target"])
        snapshot_rows = rows(await graph.query("""MATCH (s:CodebaseSnapshot {repository:$repo,sourceType:'codebase'})
          RETURN properties(s) LIMIT 1""", {"repo": identity.repository}), ["snapshot"])
        output_nodes = []
        for item in nodes:
            properties = item.get("node") or {}
            labels = item.get("labels") or ["CodeFile"]
            key = str(properties.get("graphKey", item.get("nodeId")))
            label = properties.get("name") or properties.get("path") or key
            if properties.get("kind"):
                label = f"{properties['kind']} {label}"
            output_nodes.append({"id": key, "type": labels[0], "label": str(label), "properties": properties})
        output_edges = [{"id": f"code-edge-{index}", "source": str(item.get("source")),
                         "target": str(item.get("target")), "type": str(item.get("kind") or "RELATED")}
                        for index, item in enumerate(edges)]
        meta = (snapshot_rows[0].get("snapshot") if snapshot_rows else None) or {}
        return {"nodes": output_nodes, "edges": output_edges, "meta": {"repository": identity.repository,
                "source": "falkordb", "importedAt": meta.get("importedAt"), "filesScanned": meta.get("filesScanned", 0),
                "truncated": meta.get("truncated", False), "branch": meta.get("branch", ""), "commit": meta.get("commit", "")}}
    except Exception as error:
        if isinstance(error, HTTPException):
            raise
        print(f"Code graph query failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="Could not read the code graph from FalkorDB.") from error


@app.post("/v1/codebase/neighborhood")
async def codebase_neighborhood(body: CodebaseNeighborhoodRequest, identity: Annotated[Principal, Depends(principal)]):
    paths = list(dict.fromkeys(path for path in body.paths if len(path) <= 300 and not path.startswith("/") and ".." not in path.split("/")))
    if not paths:
        raise HTTPException(status_code=400, detail="Provide repository-relative code paths.")
    try:
        graph = graph_for(identity.user_id, identity.repository)
        result = rows(await graph.query("""MATCH (n {repository:$repo,sourceType:'codebase'})
          WHERE n.path IN $paths
          WITH n LIMIT 60
          OPTIONAL MATCH (n)-[r:CODE_RELATION]->(neighbor {repository:$repo,sourceType:'codebase'})
          RETURN labels(n),properties(n),r.kind,labels(neighbor),properties(neighbor) LIMIT 300""", {"repo": identity.repository, "paths": paths}), ["nodeLabels", "node", "kind", "neighborLabels", "neighbor"])
        nodes_by_id: dict[str, dict] = {}
        edges_by_id: dict[str, dict] = {}
        for row in result:
            for item, labels in ((row.get("node"), row.get("nodeLabels")), (row.get("neighbor"), row.get("neighborLabels"))):
                if not isinstance(item, dict) or not item.get("graphKey"):
                    continue
                key = str(item["graphKey"])
                nodes_by_id[key] = {"id": key, "type": (labels or ["CodeFile"])[0],
                                    "label": str(item.get("name") or item.get("path") or key), "path": item.get("path", "")}
            source, neighbor = row.get("node"), row.get("neighbor")
            if isinstance(source, dict) and isinstance(neighbor, dict) and source.get("graphKey") and neighbor.get("graphKey"):
                kind = str(row.get("kind") or "RELATED")
                edge_id = str(source["graphKey"]) + "|" + kind + "|" + str(neighbor["graphKey"])
                edges_by_id[edge_id] = {"id": edge_id, "source": str(source["graphKey"]), "target": str(neighbor["graphKey"]), "type": kind}
        return {"nodes": list(nodes_by_id.values()), "edges": list(edges_by_id.values()), "source": "falkordb"}
    except Exception as error:
        print(f"Code graph neighborhood query failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="Could not trace changed files in the code graph.") from error


@app.get("/health")
async def health():
    return {"ok": True, "service": "engram-core", "databaseConfigured": bool(os.getenv("FALKORDB_URL"))}


@app.post("/internal/graph/query")
async def graph_query(body: GraphQuery, internal_key: Annotated[str | None, Header(alias="X-Engram-Core-Key")] = None):
    expected = os.environ.get("ENGRAM_INTERNAL_API_KEY", "")
    if not expected or not internal_key or not hmac.compare_digest(expected, internal_key):
        raise HTTPException(status_code=401, detail="Internal service authentication failed")
    try:
        result = await graph_named(body.graph_name).query(body.query, body.params)
        columns = []
        for entry in getattr(result, "header", []) or []:
            if isinstance(entry, (list, tuple)) and entry:
                # FalkorDB Python returns [type, column_name] pairs.
                columns.append(str(entry[1] if len(entry) > 1 else entry[0]))
            else:
                columns.append(str(getattr(entry, "name", entry)))
        data = [
            {column: normalize(value) for column, value in zip(columns, row)}
            for row in (getattr(result, "result_set", []) or [])
        ]
        return {"data": data}
    except Exception as error:
        print(f"Graph query failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="FalkorDB query failed") from error


@app.post("/v1/chat")
async def chat(body: ChatRequest, identity: Annotated[Principal, Depends(principal)]):
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Ask a question about the connected repository.")
    if not os.getenv("FALKORDB_URL"):
        raise HTTPException(status_code=503, detail="FalkorDB is not configured")
    if re.search(r"\b(decision|decided|rationale|why did|why was|why do we)\b", prompt, re.I):
        stripped = re.sub(r"[^a-zA-Z0-9 ]", " ", prompt.lower())
        if not re.sub(r"\b(what|decision|decided|rationale|why|did|was|do|we|about|the|for|in|this|repo|repository)\b", " ", stripped).strip():
            raise HTTPException(status_code=400, detail="Add a topic or repository term to trace the related discussion.")
    try:
        return await ask(identity.user_id, identity.login, identity.repository, prompt, remember=body.remember, target_number=body.target_number,
                         model_config=body.user_model.model_dump(by_alias=True) if body.user_model else None)
    except Exception as error:
        print(f"Agent run failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="The graph agent could not complete this request. Check FalkorDB and try again.") from error


@app.get("/v1/memories")
async def list_memories(identity: Annotated[Principal, Depends(principal)]):
    try:
        result = await graph_for(identity.user_id, identity.repository).query("""MATCH (repo:Repository {fullName:$repo})-[:HAS_MEMORY]->(memory:ProjectMemory)
          WHERE memory.userId=$userId
          RETURN id(memory),memory.id,memory.question,memory.answer,memory.agent,memory.intent,memory.savedAt,memory.sourcesJson
          ORDER BY memory.savedAt DESC LIMIT 100""", {"repo": identity.repository, "userId": identity.user_id})
        items = rows(result, ["nodeId", "id", "question", "answer", "agent", "intent", "savedAt", "sourcesJson"])
        for item in items:
            try:
                item["sources"] = json.loads(str(item.pop("sourcesJson", "[]")))
            except (TypeError, ValueError):
                item["sources"] = []
        return {"repository": identity.repository, "items": items}
    except Exception as error:
        print(f"Saved memory read failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="Could not read saved project memory.") from error


@app.post("/v1/memories")
async def save_memory(body: MemorySaveRequest, identity: Annotated[Principal, Depends(principal)]):
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", body.episode_id):
        raise HTTPException(status_code=400, detail="Choose a valid investigation to save.")
    graph = graph_for(identity.user_id, identity.repository)
    try:
        episode_rows = rows(await graph.query("""MATCH (repo:Repository {fullName:$repo})-[:HAS_MEMORY]->(episode:Episode {id:$episodeId})
          WHERE episode.userId=$userId
          RETURN episode.question,episode.answer,episode.agent,episode.intent,episode.createdAt,episode.sourcesJson""", {
            "repo": identity.repository, "episodeId": body.episode_id, "userId": identity.user_id,
        }), ["question", "answer", "agent", "intent", "createdAt", "sourcesJson"])
        if not episode_rows:
            raise HTTPException(status_code=404, detail="This investigation is no longer available in this repository.")
        episode = episode_rows[0]
        try:
            sources = json.loads(str(episode.get("sourcesJson", "[]")))
        except (TypeError, ValueError):
            sources = []
        if not isinstance(sources, list) or not sources:
            raise HTTPException(status_code=409, detail="Only an investigation with source evidence can be saved.")
        sources = [source for source in sources[:6] if isinstance(source, dict) and re.match(r"^https://github\.com/", str(source.get("url", "")))]
        if not sources:
            raise HTTPException(status_code=409, detail="This investigation has no GitHub sources to preserve.")

        memory_id = f"memory-{body.episode_id}"
        await graph.query("""MATCH (repo:Repository {fullName:$repo})-[:HAS_MEMORY]->(episode:Episode {id:$episodeId})
          WHERE episode.userId=$userId
          MERGE (memory:ProjectMemory {id:$memoryId})
          SET memory.userId=$userId,memory.repository=$repo,memory.question=episode.question,
            memory.answer=episode.answer,memory.agent=episode.agent,memory.intent=episode.intent,
            memory.savedAt=$savedAt,memory.sourcesJson=$sourcesJson,memory.title=substring(episode.question,0,160)
          MERGE (repo)-[:HAS_MEMORY]->(memory)
          MERGE (memory)-[:PRESERVES]->(episode)""", {
            "repo": identity.repository, "episodeId": body.episode_id, "userId": identity.user_id,
            "memoryId": memory_id, "savedAt": datetime.now(timezone.utc).isoformat(),
            "sourcesJson": json.dumps(sources, ensure_ascii=False),
        })
        for source in sources:
            await graph.query("""MATCH (memory:ProjectMemory {id:$memoryId})
              MATCH (record {url:$url})
              MERGE (memory)-[grounded:GROUNDED_IN]->(record)
              SET grounded.title=$title,grounded.role=$role""", {
                "memoryId": memory_id, "url": source["url"], "title": str(source.get("title", "GitHub source"))[:200],
                "role": str(source.get("role", "Evidence"))[:80],
            })
        return {"saved": True, "id": memory_id, "repository": identity.repository, "sources": sources}
    except HTTPException:
        raise
    except Exception as error:
        print(f"Saved memory write failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="Could not save this investigation to FalkorDB.") from error


@app.delete("/v1/memories")
async def delete_memory(body: MemoryDeleteRequest, identity: Annotated[Principal, Depends(principal)]):
    if not re.fullmatch(r"memory-[0-9a-fA-F-]{36}", body.memory_id):
        raise HTTPException(status_code=400, detail="Choose a valid saved memory.")
    try:
        result = await graph_for(identity.user_id, identity.repository).query("""MATCH (repo:Repository {fullName:$repo})-[:HAS_MEMORY]->(memory:ProjectMemory {id:$memoryId})
          WHERE memory.userId=$userId
          WITH memory DETACH DELETE memory RETURN 1""", {
            "repo": identity.repository, "memoryId": body.memory_id, "userId": identity.user_id,
        })
        deleted = rows(result, ["deleted"])
        if not deleted or not deleted[0].get("deleted"):
            raise HTTPException(status_code=404, detail="Saved memory not found in this repository.")
        return {"deleted": True, "id": body.memory_id}
    except HTTPException:
        raise
    except Exception as error:
        print(f"Saved memory delete failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="Could not remove saved project memory.") from error


@app.post("/v1/guest/chat")
async def guest_chat(body: ChatRequest, identity: Annotated[Principal, Depends(principal)]):
    if identity.user_id != "0" or identity.login != "guest":
        raise HTTPException(status_code=403, detail="Guest queries must use the public repository scope.")
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Ask a question about this public repository.")
    if not os.getenv("FALKORDB_URL"):
        raise HTTPException(status_code=503, detail="FalkorDB is not configured")
    try:
        return await ask(identity.user_id, identity.login, identity.repository, prompt, remember=False, target_number=body.target_number)
    except Exception as error:
        print(f"Guest graph agent run failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="The graph agent could not complete this request. Check the public graph and try again.") from error


def _node_label(properties: dict, kind: str, node_id: str) -> str:
    if kind == "WorkItem":
        state = "Merged" if properties.get("mergedAt") else "Open" if str(properties.get("state", "")).lower() == "open" else "Closed"
        type_name = "PR" if properties.get("kind") == "PR" else "issue"
        return f"{state} {type_name} #{properties.get('number', node_id)} · {str(properties.get('title', ''))[:42]}"
    content = properties.get("message", properties.get("body", ""))
    return str(properties.get("title") or properties.get("login") or properties.get("fullName") or properties.get("name") or properties.get("path") or (str(content).splitlines()[0][:58] if content else f"{kind} {properties.get('number', node_id)}"))


async def _add_second_hop(graph, nodes: dict, edges: list, focus_id: str, neighbor_ids: list[int]) -> None:
    """Add a bounded second hop so the explorer can show paths between records."""
    if not neighbor_ids:
        return
    expanded = rows(await graph.query("""MATCH (neighbor)-[r]-(other)
        WHERE id(neighbor) IN $neighborIds AND id(other)<>$focusId
          AND NOT (id(other) IN $neighborIds)
          AND NOT ('Repository' IN labels(neighbor))
          AND NOT ('Contributor' IN labels(neighbor))
          AND NOT ('Episode' IN labels(neighbor))
          AND NOT ('Repository' IN labels(other))
          AND NOT ('ProjectMemory' IN labels(other))
          AND NOT ('Episode' IN labels(other))
        RETURN id(neighbor),labels(neighbor),properties(neighbor),id(other),labels(other),properties(other),type(r),properties(r)
        LIMIT 100""", {"neighborIds": neighbor_ids, "focusId": int(focus_id)}), [
        "neighborId", "neighborLabels", "neighbor", "otherId", "otherLabels", "other", "relation", "relationProperties"
    ])
    seen = {(edge["source"], edge["target"], edge["type"]) for edge in edges}
    for index, item in enumerate(expanded):
        neighbor_id = str(item["neighborId"])
        other_id = str(item["otherId"])
        other_props = item.get("other") or {}
        other_kind = (item.get("otherLabels") or ["Node"])[0]
        nodes.setdefault(other_id, {"id": other_id, "label": _node_label(other_props, other_kind, other_id), "type": other_kind, "properties": other_props})
        key = (neighbor_id, other_id, item["relation"])
        reverse_key = (other_id, neighbor_id, item["relation"])
        if key in seen or reverse_key in seen:
            continue
        seen.add(key)
        edges.append({"id": f"edge-hop2-{index}", "source": neighbor_id, "target": other_id, "type": item["relation"], "properties": item.get("relationProperties") or {}})


@app.get("/v1/graph/explore")
async def explore(identity: Annotated[Principal, Depends(principal)], node_id: Annotated[str | None, Query(alias="nodeId")] = None):
    if node_id and not node_id.isdigit():
        raise HTTPException(status_code=400, detail="Choose a graph node to follow.")
    try:
        graph = graph_for(identity.user_id, identity.repository)
        if node_id:
            cypher = """MATCH (focus) WHERE id(focus)=$nodeId OPTIONAL MATCH (focus)-[r]-(other)
            WITH focus,r,other ORDER BY coalesce(other.updatedAt,other.createdAt,other.date,other.submittedAt,'') DESC LIMIT 61
            RETURN id(focus),labels(focus),properties(focus),id(other),labels(other),properties(other),type(r),properties(r) LIMIT 101"""
            params = {"nodeId": int(node_id)}
        else:
            cypher = """MATCH (focus:Contributor {login:$login}) OPTIONAL MATCH (focus)-[r]-(other)
            WITH focus,r,other ORDER BY coalesce(other.updatedAt,other.createdAt,other.date,other.submittedAt,'') DESC LIMIT 61
            RETURN id(focus),labels(focus),properties(focus),id(other),labels(other),properties(other),type(r),properties(r) LIMIT 101"""
            params = {"login": identity.login}
        data = rows(await graph.query(cypher, params), ["focusId", "focusLabels", "focus", "otherId", "otherLabels", "other", "relation", "relationProperties"])
        if not data:
            raise HTTPException(status_code=404, detail="No indexed connections were found in this repository graph yet.")
        focus = data[0]
        focus_id = str(focus["focusId"])
        focus_props = focus.get("focus") or {}
        focus_kind = (focus.get("focusLabels") or ["Contributor"])[0]
        nodes = {focus_id: {"id": focus_id, "label": _node_label(focus_props, focus_kind, focus_id), "type": focus_kind, "properties": focus_props}}
        edges = []
        for index, item in enumerate(data):
            if item.get("otherId") is None or not item.get("relation"):
                continue
            other_id = str(item["otherId"])
            properties = item.get("other") or {}
            kind = (item.get("otherLabels") or ["Node"])[0]
            nodes.setdefault(other_id, {"id": other_id, "label": _node_label(properties, kind, other_id), "type": kind, "properties": properties})
            edges.append({"id": f"edge-{index}", "source": focus_id, "target": other_id, "type": item["relation"], "properties": item.get("relationProperties") or {}})
        neighbor_ids = list(dict.fromkeys(int(item["otherId"]) for item in data if item.get("otherId") is not None))
        await _add_second_hop(graph, nodes, edges, focus_id, neighbor_ids)
        return {"nodes": list(nodes.values()), "edges": edges, "focus": {"id": focus_id, "label": nodes[focus_id]["label"], "type": focus_kind}, "meta": {"source": "falkordb", "repository": identity.repository, "viewer": identity.login, "mode": "neighborhood" if node_id else "my-connections", "truncated": len(data) > 60}}
    except HTTPException:
        raise
    except Exception as error:
        print(f"Graph explorer query failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="FalkorDB graph exploration failed.") from error


@app.get("/v1/guest/graph")
async def guest_explore(identity: Annotated[Principal, Depends(principal)], node_id: Annotated[str | None, Query(alias="nodeId")] = None):
    if identity.user_id != "0" or identity.login != "guest":
        raise HTTPException(status_code=403, detail="Guest graph access must use the public repository scope.")
    if node_id and not node_id.isdigit():
        raise HTTPException(status_code=400, detail="Choose a graph node to follow.")
    try:
        graph = graph_for(identity.user_id, identity.repository)
        if node_id:
            cypher = """MATCH (focus) WHERE id(focus)=$nodeId OPTIONAL MATCH (focus)-[r]-(other)
            WITH focus,r,other ORDER BY CASE WHEN other IS NULL THEN 4 WHEN 'Contributor' IN labels(other) THEN 0 WHEN 'WorkItem' IN labels(other) THEN 1 WHEN 'Commit' IN labels(other) THEN 2 ELSE 3 END, coalesce(other.updatedAt,other.createdAt,other.date,other.submittedAt,'') DESC LIMIT 61
            RETURN id(focus),labels(focus),properties(focus),id(other),labels(other),properties(other),type(r),properties(r) LIMIT 101"""
            params = {"nodeId": int(node_id)}
        else:
            params = {"repo": identity.repository}
            columns = ["focusId", "focusLabels", "focus", "otherId", "otherLabels", "other", "relation", "relationProperties"]
            data = []
            # Sample each useful relationship class so a busy repository does not
            # let commits crowd every contributor and pull request off the canvas.
            for label, limit in (("Contributor", 20), ("WorkItem", 24), ("Commit", 12), ("RepositoryBranch", 5), ("ProjectMemory", 12)):
                cypher = f"""MATCH (focus:Repository {{fullName:$repo}})-[r]-(other:{label})
                WITH focus,r,other ORDER BY coalesce(other.updatedAt,other.createdAt,other.date,other.latestCommitAt,other.submittedAt,'') DESC LIMIT {limit}
                RETURN id(focus),labels(focus),properties(focus),id(other),labels(other),properties(other),type(r),properties(r)"""
                data.extend(rows(await graph.query(cypher, params), columns))
        if node_id:
            data = rows(await graph.query(cypher, params), ["focusId", "focusLabels", "focus", "otherId", "otherLabels", "other", "relation", "relationProperties"])
        if not data:
            raise HTTPException(status_code=404, detail="No indexed public connections were found. Import this repository first.")
        first = data[0]
        focus_id = str(first["focusId"])
        focus_props = first.get("focus") or {}
        focus_kind = (first.get("focusLabels") or ["Repository"])[0]
        nodes = {focus_id: {"id": focus_id, "label": _node_label(focus_props, focus_kind, focus_id), "type": focus_kind, "properties": focus_props}}
        edges = []
        for index, item in enumerate(data):
            if item.get("otherId") is None or not item.get("relation"):
                continue
            other_id = str(item["otherId"])
            properties = item.get("other") or {}
            kind = (item.get("otherLabels") or ["Node"])[0]
            nodes.setdefault(other_id, {"id": other_id, "label": _node_label(properties, kind, other_id), "type": kind, "properties": properties})
            edges.append({"id": f"edge-{index}", "source": focus_id, "target": other_id, "type": item["relation"], "properties": item.get("relationProperties") or {}})
        neighbor_ids = list(dict.fromkeys(int(item["otherId"]) for item in data if item.get("otherId") is not None))
        await _add_second_hop(graph, nodes, edges, focus_id, neighbor_ids)
        return {"nodes": list(nodes.values()), "edges": edges, "focus": {"id": focus_id, "label": nodes[focus_id]["label"], "type": focus_kind}, "meta": {"source": "falkordb", "repository": identity.repository, "mode": "repository-overview" if not node_id else "neighborhood", "truncated": len(data) > 60}}
    except HTTPException:
        raise
    except Exception as error:
        print(f"Guest graph explorer query failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="FalkorDB graph exploration failed.") from error


@app.get("/v1/guest/node/{node_id}")
async def guest_node_detail(node_id: str, identity: Annotated[Principal, Depends(principal)]):
    if identity.user_id != "0" or identity.login != "guest":
        raise HTTPException(status_code=403, detail="Guest node access must use the public repository scope.")
    return await node_detail(node_id, identity)


@app.get("/v1/node/{node_id}")
async def node_detail(node_id: str, identity: Annotated[Principal, Depends(principal)]):
    if not node_id.isdigit():
        raise HTTPException(status_code=404, detail="Node not found in this repository graph.")
    try:
        graph = graph_for(identity.user_id, identity.repository)
        cypher = """MATCH (node) WHERE id(node)=$nodeId OPTIONAL MATCH (node)-[relationship]-(other)
        RETURN labels(node),properties(node),type(relationship),properties(relationship),id(other),labels(other),properties(other) LIMIT 40"""
        data = rows(await graph.query(cypher, {"nodeId": int(node_id)}), ["labels", "node", "relationshipType", "relationshipProperties", "otherId", "otherLabels", "other"])
        if not data:
            raise HTTPException(status_code=404, detail="Node not found in this repository graph.")
        current = data[0]
        kind = (current.get("labels") or ["Node"])[0]
        properties = current.get("node") or {}
        relationships = []
        for item in data:
            if item.get("otherId") is None:
                continue
            other_id = str(item["otherId"])
            other_properties = item.get("other") or {}
            labels = item.get("otherLabels") or ["Node"]
            relationships.append({"id": other_id, "type": item.get("relationshipType") or "", "label": _node_label(other_properties, labels[0], other_id), "labels": labels, "properties": other_properties, "edgeProperties": item.get("relationshipProperties") or {}})
        return {"id": node_id, "type": kind, "label": _node_label(properties, kind, node_id), "properties": properties, "relationships": relationships, "graph": "falkordb"}
    except HTTPException:
        raise
    except Exception as error:
        print(f"Node detail query failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="Could not load node details from FalkorDB.") from error
