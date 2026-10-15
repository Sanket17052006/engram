from __future__ import annotations

import hashlib
import os
import re
from functools import lru_cache
from urllib.parse import urlparse

from falkordb.asyncio import FalkorDB
from redis.asyncio import BlockingConnectionPool


def private_graph_name(user_id: str, repository: str) -> str:
    if not user_id.isdigit() or repository.count("/") != 1:
        raise ValueError("Invalid user or repository scope")
    owner, name = repository.split("/", 1)
    if not owner or not name or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-" for char in owner + name):
        raise ValueError("Invalid repository scope")
    digest = hashlib.sha256(repository.lower().encode()).hexdigest()[:12]
    return f"engram_u{user_id}_{digest}"


@lru_cache(maxsize=1)
def _client() -> FalkorDB:
    raw_url = os.environ.get("FALKORDB_URL", "")
    if not raw_url:
        raise RuntimeError("FALKORDB_URL is not configured")
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"redis", "rediss"} or not parsed.hostname:
        raise RuntimeError("FALKORDB_URL must use redis:// or rediss://")
    connection_options = dict(
        host=parsed.hostname,
        port=parsed.port or 6379,
        username=parsed.username,
        password=parsed.password,
        decode_responses=True,
        max_connections=32,
        timeout=5,
    )
    if parsed.scheme == "rediss":
        connection_options["ssl"] = True
    pool = BlockingConnectionPool(**connection_options)
    return FalkorDB(connection_pool=pool)


def graph_for(user_id: str, repository: str):
    return _client().select_graph(private_graph_name(user_id, repository))


def graph_named(name: str):
    if not re.fullmatch(r"engram_u[0-9]+_[a-f0-9]{12}", name):
        raise ValueError("Invalid private graph name")
    return _client().select_graph(name)


def rows(result, columns: list[str]) -> list[dict]:
    output = []
    for row in getattr(result, "result_set", []) or []:
        output.append({key: normalize(value) for key, value in zip(columns, row)})
    return output


def normalize(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): normalize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize(item) for item in value]
    properties = getattr(value, "properties", None)
    if properties is not None:
        return normalize(properties)
    return str(value)
