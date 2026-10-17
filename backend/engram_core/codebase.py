"""Read-only, bounded source indexer for repository code graphs.

The importer parses source text only; it never imports or executes repository code.
"""
from __future__ import annotations

import ast
import hashlib
import os
from pathlib import Path
from typing import Union

MAX_FILES = 2_500
MAX_FILE_BYTES = 1_000_000
SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", "build", "dist", "vendor", "static"}
SOURCE_SUFFIXES = {".py", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs", ".java", ".rb"}


def _python_symbols(source: str) -> list[dict[str, str]]:
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return []
    output = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            output.append({
                "name": node.name,
                "kind": "Class" if isinstance(node, ast.ClassDef) else "Function",
                "line": str(getattr(node, "lineno", 1)),
                "summary": ((ast.get_docstring(node) or "").strip().splitlines() or [""])[0][:240],
            })
    return output


def _python_imports(source: str, path: str) -> list[str]:
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return []
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                package = path.rsplit("/", 1)[0].replace("/", ".")
                parts = package.split(".") if package else []
                if node.level > 1:
                    parts = parts[:max(0, len(parts) - node.level + 1)]
                if node.module:
                    parts.extend(node.module.split("."))
                base = ".".join(parts)
                names.add(base) if base else None
                for alias in node.names:
                    if alias.name != "*":
                        names.add(f"{base}.{alias.name}" if base else alias.name)
            elif node.module:
                names.add(node.module)
    return sorted(names)


def scan_codebase(root: Union[str, Path]) -> dict:
    base = Path(root).resolve(strict=True)
    if not base.is_dir():
        raise ValueError("Configured codebase path is not a directory")
    files: list[dict] = []
    for current, dirs, names in os.walk(base, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not (Path(current) / d).is_symlink())
        for name in sorted(names):
            path = Path(current) / name
            if path.suffix.lower() not in SOURCE_SUFFIXES or path.is_symlink():
                continue
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    continue
                source = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            rel = path.relative_to(base).as_posix()
            is_python = path.suffix.lower() == ".py"
            is_test = "test" in path.parts or path.name.startswith("test_") or path.stem.endswith("_test")
            try:
                module_doc = ast.get_docstring(ast.parse(source)) if is_python else None
            except (SyntaxError, ValueError):
                module_doc = None
            files.append({
                "id": f"file:{rel}", "path": rel, "language": path.suffix[1:].lower(),
                "isTest": is_test, "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
                "summary": (module_doc or "").strip().splitlines()[0][:240] if module_doc else "",
                "symbols": _python_symbols(source) if is_python else [],
                "imports": _python_imports(source, rel) if is_python else [],
            })
            if len(files) >= MAX_FILES:
                break
        if len(files) >= MAX_FILES:
            break

    by_module: dict[str, str] = {}
    by_stem: dict[str, list[str]] = {}
    for item in files:
        rel = item["path"]
        stem = rel[:-3] if rel.endswith(".py") else rel.rsplit(".", 1)[0]
        module = stem.replace("/", ".")
        by_module[module] = item["id"]
        if module.endswith(".__init__"):
            by_module[module[:-len(".__init__")]] = item["id"]
        elif module == "__init__":
            by_module[""] = item["id"]
        by_stem.setdefault(Path(rel).stem.lower(), []).append(item["id"])

    nodes: list[dict] = []
    edges: list[dict] = []
    for item in files:
        file_node = {key: item[key] for key in ("id", "path", "language", "isTest", "bytes", "sha256", "summary")}
        file_node["type"] = "TestFile" if item["isTest"] else "CodeFile"
        nodes.append(file_node)
        for symbol in item["symbols"]:
            symbol_id = f"symbol:{item['path']}:{symbol['kind']}:{symbol['name']}:{symbol['line']}"
            nodes.append({"id": symbol_id, "type": "CodeSymbol", **symbol, "path": item["path"]})
            edges.append({"source": item["id"], "target": symbol_id, "type": "DEFINES"})
        for imported in item["imports"]:
            target = by_module.get(imported)
            if not target:
                pieces = imported.split(".")
                for index in range(len(pieces), 0, -1):
                    target = by_module.get(".".join(pieces[:index]))
                    if target:
                        break
            if target and target != item["id"]:
                edges.append({"source": item["id"], "target": target, "type": "IMPORTS"})
        if item["isTest"]:
            stem = Path(item["path"]).stem.lower().removeprefix("test_").removesuffix("_test")
            candidates = by_stem.get(stem, [])
            if len(candidates) == 1 and candidates[0] != item["id"]:
                edges.append({"source": item["id"], "target": candidates[0], "type": "TESTS"})
    return {"nodes": nodes, "edges": edges, "filesScanned": len(files), "truncated": len(files) >= MAX_FILES, "root": str(base)}
