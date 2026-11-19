#!/usr/bin/env python3
"""Print a content manifest of a Legendary Memory SQLite file: row counts and a SHA-256 per
canonical table, plus a whole-memory hash. Read-only (opens the file with mode=ro).

Rows are hashed in a stable order on their portable identity, so two homes holding the same
memories match even when local autoincrement ids differ (brief_versions, messages).
Derived tables (search_map, search_fts) are counted but never hashed: they can be rebuilt.

Usage: python3 -I manifest.py memory.db [--json]
"""
import hashlib
import json
import sqlite3
import sys

# table -> (columns to hash, ORDER BY)
CANONICAL = {
    "projects": ("id, slug, name, aliases, status, brief, created_at, updated_at", "id"),
    "brief_versions": ("project_id, brief, replaced_at", "project_id, replaced_at, brief"),
    "checkpoints": ("id, project_id, source, title, summary, decisions, next_steps, created_at", "id"),
    "artifacts": ("id, project_id, name, kind, content, version, source, created_at, updated_at", "id"),
    "profile": ("key, value, updated_at", "key"),
    "conversations": ("id, source, external_id, project_id, title, url, started_at, updated_at, message_count", "source, external_id"),
    "messages": ("(SELECT source || char(0) || external_id FROM conversations c WHERE c.id = m.conversation_id) AS conv, seq, role, text", "conv, seq"),
}
DERIVED = ("search_map", "search_fts")


def manifest(path: str) -> dict:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    out = {"file": path, "tables": {}, "derived": {}}
    total = hashlib.sha256()
    for table, (cols, order) in CANONICAL.items():
        alias = " m" if table == "messages" else ""
        h = hashlib.sha256()
        n = 0
        for row in db.execute(f"SELECT {cols} FROM {table}{alias} ORDER BY {order}"):
            h.update(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode())
            h.update(b"\n")
            n += 1
        out["tables"][table] = {"rows": n, "sha256": h.hexdigest()}
        total.update(f"{table}:{h.hexdigest()}\n".encode())
    for table in DERIVED:
        out["derived"][table] = db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    out["memory_sha256"] = total.hexdigest()
    out["integrity_check"] = db.execute("PRAGMA integrity_check").fetchone()[0]
    db.close()
    return out


if __name__ == "__main__":
    m = manifest(sys.argv[1])
    if "--json" in sys.argv:
        print(json.dumps(m, indent=2))
    else:
        print(m["file"])
        for t, v in m["tables"].items():
            print(f"  {t:15} {v['rows']:>6}  {v['sha256'][:16]}")
        for t, n in m["derived"].items():
            print(f"  {t:15} {n:>6}  (derived)")
        print(f"  memory sha256   {m['memory_sha256']}")
        print(f"  integrity       {m['integrity_check']}")
