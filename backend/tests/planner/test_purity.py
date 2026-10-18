"""The planner is a pure function: it reads no clock, network or database."""

from __future__ import annotations

import ast
from pathlib import Path

PLANNER = Path(__file__).resolve().parents[2] / "app" / "services" / "planner"
FORBIDDEN_MODULES = {
    "socket",
    "http",
    "urllib",
    "requests",
    "httpx",
    "sqlalchemy",
    "redis",
    "pymongo",
    "time",
    "random",
    "os",
    "asyncio",
    "app.adapters",
    "app.db",
    "app.models",
}
FORBIDDEN_CALLS = {"now", "today", "utcnow", "time", "perf_counter", "monotonic"}


def _modules():
    for path in sorted(PLANNER.glob("*.py")):
        yield path, ast.parse(path.read_text(encoding="utf-8"))


def test_planner_imports_no_io_modules():
    for path, tree in _modules():
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module]
            for name in names:
                assert not any(name == m or name.startswith(m + ".") for m in FORBIDDEN_MODULES), f"{path.name} imports {name}"


def test_planner_reads_no_clock():
    for path, tree in _modules():
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                assert node.func.attr not in FORBIDDEN_CALLS, f"{path.name} calls .{node.func.attr}()"
