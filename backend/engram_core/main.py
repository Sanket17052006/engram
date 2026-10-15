from __future__ import annotations

import hmac
import os
import re
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
        return await ask(identity.user_id, identity.login, identity.repository, prompt)
    except Exception as error:
        print(f"Agent run failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="The graph agent could not complete this request. Check FalkorDB and try again.") from error


def _node_label(properties: dict, kind: str, node_id: str) -> str:
    if kind == "WorkItem":
        state = "Merged" if properties.get("mergedAt") else "Open" if str(properties.get("state", "")).lower() == "open" else "Closed"
        type_name = "PR" if properties.get("kind") == "PR" else "issue"
        return f"{state} {type_name} #{properties.get('number', node_id)} · {str(properties.get('title', ''))[:42]}"
    content = properties.get("message", properties.get("body", ""))
    return str(properties.get("title") or properties.get("login") or properties.get("fullName") or properties.get("name") or properties.get("path") or (str(content).splitlines()[0][:58] if content else f"{kind} {properties.get('number', node_id)}"))


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
        return {"nodes": list(nodes.values()), "edges": edges, "focus": {"id": focus_id, "label": nodes[focus_id]["label"], "type": focus_kind}, "meta": {"source": "falkordb", "repository": identity.repository, "viewer": identity.login, "mode": "neighborhood" if node_id else "my-connections", "truncated": len(data) > 60}}
    except HTTPException:
        raise
    except Exception as error:
        print(f"Graph explorer query failed ({type(error).__name__}): {error}")
        raise HTTPException(status_code=503, detail="FalkorDB graph exploration failed.") from error


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
