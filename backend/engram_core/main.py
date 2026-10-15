from __future__ import annotations

import hmac
import json
import os
import re
from datetime import datetime, timezone
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field

from .agent import ask, mcp
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


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    target_number: int = Field(default=0, ge=0, le=10_000_000, alias="targetNumber")


class MemorySaveRequest(BaseModel):
    episode_id: str = Field(min_length=36, max_length=36, alias="episodeId")


class MemoryDeleteRequest(BaseModel):
    memory_id: str = Field(min_length=36, max_length=64, alias="memoryId")


class GraphQuery(BaseModel):
    graph_name: str = Field(pattern=r"^engram_u[0-9]+_[a-f0-9]{12}$", alias="graphName")
    query: str = Field(min_length=1, max_length=64_000)
    params: dict = Field(default_factory=dict)


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
        return await ask(identity.user_id, identity.login, identity.repository, prompt, target_number=body.target_number)
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
