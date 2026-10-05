"""
Pre-deployment check for the portal database. Read-only: it opens one
transaction to prove it can write and rolls it back.

    cd backend
    python scripts/preflight.py                # one uvicorn worker, as the portal runs
    python scripts/preflight.py --workers 2

Each line is OK, WARN (works, but look at it) or FAIL (fix before going live).
Exit code is 1 if anything failed.
"""

import argparse
import hashlib
import os
import statistics
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

# The reviewed version of every file this change touched. A mismatch means the
# copy here is older (or newer) than the one that was tested.
EXPECTED = {
    "Readme.md": "4debec5272a99db3029b76ffcf56edcc77fe8e9736c76932d62a3d94b6fd3600",
    "backend/.env.example": "d27a6625ce6740f5fb71e2491b723c109d9e6e6749ed774baf94fa7711388b83",
    "backend/app.py": "b3fd1fb0b7f10701ce5b520749fc98501f9211a5f274b854bcba7e784de31dd5",
    "backend/assistant/memory.py": "06ba66fe711846ddc7ed79e7fb27d8d8a56752f5cfd5182580dc887b43e52880",
    "backend/assistant/portal_map.py": "ab992a58678b16c2aae51e56f1b1493b98fa9cd26a53abbb2b743c26ee422d1a",
    "backend/assistant/tests/test_prompt_regression.py": "230f31ed42f1280ff8a4e6cfe6f1d96d1553315cb9627d2999df38013f55f7cc",
    "backend/audit.py": "e47ec51ff7b34d516aebd9b01b6c382467a75b69a055271341a8f75c53657aba",
    "backend/auth.py": "e60517ae8c86d4764cc0341e44a349747faa7308c8d08aa34e6fe02ea71066e8",
    "backend/communication_center.py": "656013b27b620bca227979a6bc9f25c23e4fe872ee6437dc6efa4459c577607b",
    "backend/data_api.py": "7e492d26fee96c0c8497143987e0f429bbc0f2eaa59f055c3e28424a8fbca66f",
    "backend/data_api_mcp.py": "1e9338966edbc897ccefe9786814cace1128a81ce9e05ce2021a865937b41852",
    "backend/data_api_store.py": "514f39809567e6c057c91d4e81832773af5a1cb7a246bec2c99dd4c8aec87af3",
    "backend/db.py": "2f57e871e9dc4b14773e57301b729e5ee95fbe3cbeba84239a1979d609d7716a",
    "backend/migrations/smarthub_core/V001__core_schema.sql": "b23ad4e2748c3edd1a69526b8396669a7940aa04dd22a07548c80237765d328f",
    "backend/migrations/smarthub_core/V002__audit_search_index.sql": "a73e0da8586c9ce7fb37a13c20ad9fdc565e63fb91c29299e564996fd0957bec",
    "backend/migrations/smarthub_core/V003__it_validation_runs.sql": "58f912c50226d89b2fb0761e42141bd8926abd60edfdd8cc6cf4a8ec98d07bcd",
    "backend/release_notes.py": "f1114f94d9ea1bc740b3048e6e38fc7cff767d6a0adc132a6e1ca38da9d28cb9",
    "backend/scripts/check_timestamps.py": "78f4df3012ea5e75c1d8682497f06b9edd68c80a9d84248d34e3fa12058a94fd",
    "backend/scripts/migrate_sqlite_to_postgres.py": "85c73dc2ae5b83f1dffe1df4ae35766f1011fc79929dfac1742c5308cdedd97e",
    "backend/scripts/retrieval_demo.py": "50f2fddfa35ed2015c7bd45028b79ad594a307da6628e3380455fbb188e98232",
    "backend/snowflake_query_runner.py": "476c03bb1196970e609e4a29b9aeb7ba7faba0a26646da9a4d965a1f3a88b966",
    "backend/tests/test_data_api_retrieval_pg.py": "6e4ac49b22991bf2375e54254870243fbd1ed0671634c2380f07ea09d5589ccf",
    "frontend/src/assistant/FloatingAssistant.jsx": "8e5b36bfc169e44a1ba0e6a4276cb41d4f5778b4ad9ba9a6c49e3eaaa278fdc2",
    "frontend/src/pages/AuditPage.jsx": "3a0fc0f64eed7a2f9c31e55b4adeead728442083b61c8a798bb9493703b347f3",
    "frontend/src/pages/components/CommunicationParts.jsx": "9946932d67118363a2f639f7179873f4f0df00b8cf8c07aa40bd16316f5fd705",
    "frontend/src/pages/dataApiDocs.js": "57dca1cf847121ef4049bdc0d7f5c4f852d06ea691a98b551c962ce98a1e6879",
}

TABLES = [
    "audit_log", "assistant_settings", "rbac_custom_roles", "rbac_user_overrides",
    "rbac_user_permissions", "rbac_meta", "email_templates", "email_history", "email_scheduled",
    "sf_query_history", "sf_saved_queries", "release_notes", "release_note_snapshots",
    "data_apis", "data_api_tables", "data_api_requests", "data_api_rate_windows",
    "data_api_embedding_models", "data_api_vector_registrations", "data_api_contracts",
    "data_api_search_settings", "assistant_user_memory", "schema_migrations",
    "it_runs", "it_run_logs",
]

results = []


def report(level, what, detail=""):
    results.append(level)
    print(f"{level:<5} {what}" + (f" — {detail}" if detail else ""))


def file_hash(path: Path) -> str:
    # Same normalisation as the migration checksums: line endings, a byte-order
    # mark and trailing whitespace at the end of the file don't count.
    text = path.read_bytes().decode("utf-8-sig").replace("\r\n", "\n").rstrip()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_files():
    for rel, digest in EXPECTED.items():
        path = BACKEND.parent / rel
        if not path.exists():
            report("FAIL", f"{rel}", "missing")
        elif file_hash(path) != digest:
            report("FAIL", f"{rel}", "differs from the reviewed version - copy the latest one in")
    gone = BACKEND / "migrations" / "data_api_search_pg.sql"
    if gone.exists():
        report("WARN", "migrations/data_api_search_pg.sql", "obsolete, delete it")
    broken = []
    for py in sorted(BACKEND.rglob("*.py")):
        if any(part in (".venv", "venv", "node_modules", "__pycache__") for part in py.parts):
            continue
        try:
            compile(py.read_bytes(), str(py), "exec")
        except SyntaxError as e:
            broken.append(f"{py.relative_to(BACKEND)}: line {e.lineno}: {e.msg}")
    if broken:
        for b in broken:
            report("FAIL", "syntax error", b)
    if not any(level == "FAIL" for level in results):
        report("OK", "code", f"{len(EXPECTED)} changed files match the reviewed version; everything compiles")


def check_env():
    import db
    s = db.settings()
    if not s.dsn:
        report("FAIL", "SMARTHUB_DB_DSN", "not set (environment or backend/.env)")
        return False
    dsn = s.dsn.lower()
    local = any(h in dsn for h in ("localhost", "127.0.0.1"))
    if not local and "sslmode=require" not in dsn and "sslmode=verify" not in dsn:
        report("WARN", "SMARTHUB_DB_DSN", "no sslmode=require - add it for RDS")
    else:
        report("OK", "SMARTHUB_DB_DSN", f"schema {s.schema}, pool {s.pool_max}, auto-migrate {s.auto_migrate}")
    stale = [v for v in ("ASSISTANT_PG_DSN", "DATABASE_URL", "PG_HOST", "PG_SCHEMA", "DATA_API_METADATA_DSN")
             if os.environ.get(v)]
    if stale:
        report("WARN", "old variables still set", ", ".join(stale) + " (no longer used; remove)")
    return True


def check_database(workers: int):
    import db
    try:
        raw = db.open_connection(application_name="smarthub-preflight")
    except Exception as e:
        report("FAIL", "connect", str(e))
        return
    try:
        raw.autocommit = True
        cur = raw.cursor()

        cur.execute("SHOW server_version_num")
        version = int(cur.fetchone()[0])
        if version < 120000:
            report("FAIL", "PostgreSQL version", f"{version // 10000} - 12 or newer is required")
        else:
            report("OK", "PostgreSQL version", str(version // 10000))

        times = []
        for _ in range(10):
            t = time.perf_counter()
            cur.execute("SELECT 1")
            cur.fetchone()
            times.append((time.perf_counter() - t) * 1000)
        rtt = statistics.median(times)
        if rtt > 20:
            report("WARN", "round trip to the database", f"{rtt:.1f} ms - the backend should run in the same "
                   "region/VPC as the database (expect ~1 ms)")
        else:
            report("OK", "round trip to the database", f"{rtt:.1f} ms")

        pending = db.pending()
        if pending:
            report("FAIL" if not db.settings().auto_migrate else "WARN", "migrations pending",
                   ", ".join(f"V{m.version:03d}" for m in pending)
                   + ("" if db.settings().auto_migrate else " - run python db.py migrate"))
        else:
            cur.execute(f'SELECT version, checksum FROM "{db.schema()}".schema_migrations')
            applied = dict(cur.fetchall())
            edited = [m for m in db.migrations() if applied.get(m.version) not in m.accepted]
            if edited:
                report("FAIL", "migrations", "applied files differ from the ones here: "
                       + ", ".join(f"V{m.version:03d}" for m in edited))
            else:
                report("OK", "migrations", f"all {len(applied)} applied, checksums match")

        cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = %s", (db.schema(),))
        have = {r[0] for r in cur.fetchall()}
        missing = [t for t in TABLES if t not in have]
        if missing:
            report("FAIL", "tables", "missing: " + ", ".join(missing))
        else:
            report("OK", "tables", f"all {len(TABLES)} present")

        cur.execute("SELECT to_regclass(%s)", (f"{db.schema()}.audit_log_search_trgm_idx",))
        if cur.fetchone()[0] is None:
            report("WARN", "audit search index", "pg_trgm wasn't available, so Audit Log search scans the "
                   "table. Ask the DBA to run CREATE EXTENSION pg_trgm, then CREATE INDEX from "
                   "migrations/smarthub_core/V002")
        else:
            report("OK", "audit search index", "present")

        cur.execute("SELECT has_schema_privilege(%s, 'CREATE'), has_schema_privilege(%s, 'USAGE')",
                    (db.schema(), db.schema()))
        can_create, can_use = cur.fetchone()
        if not can_use:
            report("FAIL", "privileges", f"no USAGE on schema {db.schema()}")
        elif not can_create:
            report("WARN", "privileges", "no CREATE on the schema - future migrations need a role that has it")
        else:
            report("OK", "privileges", "USAGE and CREATE on the schema")

        cur.execute("SHOW max_connections")
        max_conn = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM pg_stat_activity")
        in_use = cur.fetchone()[0]
        per_worker = db.settings().pool_max + 8 + 1          # portal pool + Data API pools + migrator
        need = workers * per_worker
        headroom = max_conn - in_use
        level = "OK" if need <= headroom * 0.8 else ("WARN" if need <= headroom else "FAIL")
        report(level, "connections", f"{workers} workers can open up to {need}; server allows {max_conn}, "
               f"{in_use} in use now")

        cur.execute("SELECT to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI'), "
                    "current_setting('TimeZone')")
        eastern, zone = cur.fetchone()
        report("OK" if zone == "America/New_York" else "FAIL", "session time zone", f"{zone}, now {eastern} ET")

        counts = []
        for table in TABLES:
            if table in have:
                cur.execute(f'SELECT count(*) FROM "{db.schema()}"."{table}"')
                counts.append(f"{table}={cur.fetchone()[0]}")
        report("OK", "rows", ", ".join(counts))

        raw.autocommit = False
        cur.execute("INSERT INTO audit_log (id, action, performed_by) VALUES ('preflight', 'preflight', 'preflight')")
        cur.execute("DELETE FROM audit_log WHERE id = 'preflight'")
        raw.rollback()
        report("OK", "write access", "insert/delete work (rolled back)")
    except Exception as e:
        report("FAIL", "database check", f"{type(e).__name__}: {e}")
    finally:
        raw.close()


def check_leftovers():
    old = [n for n in ("audit_log.db", "rbac.db", "communication_center.db", "data_api_exports.db",
                       "snowflake_query_runner.db", "release_notes.db") if (BACKEND / n).exists()]
    if old:
        report("OK", "old SQLite files", f"{', '.join(old)} still here - no longer read; archive after go-live")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=1, help="uvicorn workers you will run (the portal runs one)")
    args = parser.parse_args()
    check_files()
    if check_env():
        check_database(args.workers)
    check_leftovers()
    failed = results.count("FAIL")
    print(f"\n{failed} failure(s), {results.count('WARN')} warning(s).")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()