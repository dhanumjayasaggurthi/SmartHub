from __future__ import annotations

import csv
import io
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, time as time_, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import require_permission

logger = logging.getLogger(__name__)

postgres_router = APIRouter(prefix="/api/postgres", tags=["Postgres Query Runner"])

# Wired in from app.py via set_postgres_dependencies()
_config: Optional[Dict[str, Any]] = None

# ============================================================================
# Config
# ============================================================================

DEFAULT_MAX_CONCURRENT_JOBS = 6              # dedicated connections held at once
DEFAULT_JOB_TTL_SECONDS = 45 * 60            # jobs (and their held cursor/connection) are GC'd after this
ROWS_PAGE_MAX_SIZE = 500                     # on-screen paging cap
DOWNLOAD_CHUNK_ROWS = 10_000                 # rows per FETCH while streaming a CSV download
META_CACHE_TTL_SECONDS = 300                 # explorer (databases/schemas/tables/columns) cache


def _cfg_value(key: str, env_var: str, default=None):
    if _config and _config.get(key) not in (None, ""):
        return _config[key]
    if os.environ.get(env_var):
        return os.environ[env_var]
    return default


def _require_config() -> Dict[str, Any]:
    if not _config and not os.environ.get("PGQR_HOST"):
        raise HTTPException(
            status_code=503,
            detail="Postgres Query Runner is not configured - missing 'postgres_query_runner' section in dq_config.json",
        )
    return {
        "host": _cfg_value("host", "PGQR_HOST"),
        "port": int(_cfg_value("port", "PGQR_PORT", 5432)),
        "user": _cfg_value("user", "PGQR_USER"),
        "password": _cfg_value("password", "PGQR_PASSWORD", ""),
        "maintenance_database": _cfg_value("maintenance_database", "PGQR_MAINTENANCE_DATABASE", "postgres"),
        "default_database": _cfg_value("default_database", "PGQR_DATABASE") or _cfg_value("maintenance_database", "PGQR_MAINTENANCE_DATABASE", "postgres"),
        "sslmode": _cfg_value("sslmode", "PGQR_SSLMODE", "prefer"),
        "connect_timeout": int(_cfg_value("connect_timeout_seconds", "PGQR_CONNECT_TIMEOUT", 10)),
        "max_concurrent_jobs": int(_cfg_value("max_concurrent_jobs", "PGQR_MAX_CONCURRENT_JOBS", DEFAULT_MAX_CONCURRENT_JOBS)),
        "job_ttl_seconds": int(_cfg_value("job_ttl_seconds", "PGQR_JOB_TTL_SECONDS", DEFAULT_JOB_TTL_SECONDS)),
    }


def set_postgres_dependencies(config: Optional[Dict[str, Any]]):
    """Called once from app.py with the 'postgres_query_runner' section of dq_config.json."""
    global _config
    _config = config
    if not _config:
        logger.warning("⚠️ postgres_query_runner config not found - Postgres Query Runner endpoints will be unavailable unless PGQR_* env vars are set")


def _connect(database: Optional[str] = None):
    """Fresh psycopg2 connection. Imported lazily so this module can be
    imported even in environments where psycopg2 isn't installed (it's an
    optional feature, gated by config presence)."""
    import psycopg2

    cfg = _require_config()
    try:
        return psycopg2.connect(
            host=cfg["host"],
            port=cfg["port"],
            user=cfg["user"],
            password=cfg["password"],
            dbname=database or cfg["default_database"],
            sslmode=cfg["sslmode"],
            connect_timeout=cfg["connect_timeout"],
            application_name="dqe_postgres_query_runner",
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not connect to Postgres: {e}")


# ============================================================================
# Small per-database connection pool for metadata/explorer calls - these are
# cheap catalog lookups, so one warm, TTL-refreshed connection per database is
# reused across requests instead of reconnecting every click while browsing
# the schema tree.
# ============================================================================

class _MetaConnectionManager:
    CONNECTION_TTL = 2 * 60 * 60  # 2 hours

    def __init__(self):
        self._conns: Dict[str, Any] = {}
        self._created_at: Dict[str, float] = {}
        self._lock = threading.Lock()

    def get(self, database: Optional[str]):
        key = database or "__default__"
        with self._lock:
            conn = self._conns.get(key)
            expired = (time.time() - self._created_at.get(key, 0)) > self.CONNECTION_TTL
            if conn is not None and not expired:
                try:
                    cur = conn.cursor()
                    cur.execute("SELECT 1")
                    cur.close()
                    return conn
                except Exception:
                    logger.info("Postgres meta connection stale, reconnecting (db=%s)", key)
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
            conn = _connect(database)
            conn.autocommit = True
            self._conns[key] = conn
            self._created_at[key] = time.time()
            return conn

    def close_all(self):
        with self._lock:
            for conn in self._conns.values():
                try:
                    conn.close()
                except Exception:
                    pass
            self._conns.clear()
            self._created_at.clear()


_meta_conn_manager = _MetaConnectionManager()

# ============================================================================
# Tiny in-process TTL cache, mirrors the pattern used by unstructured.py -
# kept as a local, independent copy on purpose so this module has no runtime
# dependency on that one.
# ============================================================================

_cache: Dict[str, tuple] = {}
_cache_lock = threading.Lock()


def _cache_get(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        ts, payload = entry
        if time.time() - ts > META_CACHE_TTL_SECONDS:
            return None
        return payload


def _cache_set(key: str, payload: Any):
    with _cache_lock:
        _cache[key] = (time.time(), payload)
        if len(_cache) > 2000:
            oldest_key = min(_cache, key=lambda k: _cache[k][0])
            _cache.pop(oldest_key, None)


def _to_json_safe(val):
    """Coerce Postgres/psycopg2 result values into something json-encodable.
    Numeric/temporal precision is preserved by rendering as text rather than
    float, since a browser round-tripping a NUMERIC(38,10) through a JS
    number would silently corrupt it."""
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    if isinstance(val, Decimal):
        return str(val)
    if isinstance(val, (datetime, date, time_)):
        return val.isoformat()
    if isinstance(val, timedelta):
        return str(val)
    if isinstance(val, UUID):
        return str(val)
    if isinstance(val, (bytes, bytearray, memoryview)):
        return "\\x" + bytes(val).hex()
    if isinstance(val, float):
        if val != val or val in (float("inf"), float("-inf")):
            return None
        return val
    if isinstance(val, (list, tuple)):
        return [_to_json_safe(v) for v in val]
    if isinstance(val, dict):
        return {k: _to_json_safe(v) for k, v in val.items()}
    if isinstance(val, (int, str)):
        return val
    # Ranges, custom composite types, etc.
    try:
        return str(val)
    except Exception:
        return None


# ============================================================================
# SQL validation / classification
# ----------------------------------------------------------------------------
# Full PostgreSQL is allowed (SELECT, INSERT, UPDATE, DELETE, DDL, DO blocks,
# ...) - this is NOT a read-only runner. Two safety rules are enforced
# instead: only a single statement per run (stacked-statement injection is
# never possible), and anything that mutates data/schema requires an explicit
# `confirm: true` from the caller, with an extra warning surfaced when an
# UPDATE/DELETE has no WHERE clause.
# ============================================================================

_ALWAYS_BLOCKED = [
    # Filesystem / program execution surface - never worth the risk from a
    # web query box regardless of confirmation.
    r"\bCOPY\b.*\bPROGRAM\b",
    r"\bLO_IMPORT\b",
    r"\bLO_EXPORT\b",
    r"\bPG_READ_FILE\b",
    r"\bPG_READ_BINARY_FILE\b",
    r"\bPG_LS_DIR\b",
]

_DESTRUCTIVE_LEAD_KEYWORDS = {
    "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER",
    "CREATE", "GRANT", "REVOKE", "VACUUM", "REINDEX", "CLUSTER", "REFRESH",
    "DO", "CALL", "COMMENT", "SECURITY", "LOCK", "IMPORT",
}

_DQL_LEAD_KEYWORDS = {"SELECT", "TABLE", "VALUES", "SHOW"}


def _strip_sql_comments_and_dollar_quotes(sql: str) -> str:
    """Removes '--' and block comments (keeping their newlines) without
    touching quoted strings, dollar-quoted strings/bodies ($$...$$ or
    $tag$...$tag$ - used by DO blocks and function bodies), or quoted
    identifiers."""
    out = []
    i, n = 0, len(sql)
    in_sq = in_dq = False
    dollar_tag = None  # the $tag$ currently open, or None
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if dollar_tag is not None:
            out.append(ch)
            if sql.startswith(dollar_tag, i):
                out.append(sql[i + 1: i + len(dollar_tag)])
                i += len(dollar_tag)
                dollar_tag = None
                continue
            i += 1
            continue
        if in_sq:
            out.append(ch)
            if ch == "'":
                if nxt == "'":
                    out.append(nxt); i += 1
                else:
                    in_sq = False
            i += 1
            continue
        if in_dq:
            out.append(ch)
            if ch == '"':
                in_dq = False
            i += 1
            continue
        if ch == "'":
            in_sq = True; out.append(ch); i += 1; continue
        if ch == '"':
            in_dq = True; out.append(ch); i += 1; continue
        if ch == "$":
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if m:
                dollar_tag = m.group(0)
                out.append(dollar_tag)
                i += len(dollar_tag)
                continue
        if ch == "-" and nxt == "-":
            while i < n and sql[i] != "\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            depth = 1
            while i < n and depth > 0:
                if sql[i] == "/" and sql[i + 1: i + 2] == "*":
                    depth += 1; i += 2; continue
                if sql[i] == "*" and sql[i + 1: i + 2] == "/":
                    depth -= 1; i += 2; continue
                i += 1
            out.append(" ")
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _split_top_level_statements(sql: str) -> List[str]:
    """Splits on ';' that are not inside a string/identifier/dollar-quote.
    Operates on the ALREADY comment-stripped text."""
    stmts, cur = [], []
    in_sq = in_dq = False
    dollar_tag = None
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if dollar_tag is not None:
            cur.append(ch)
            if sql.startswith(dollar_tag, i):
                cur.append(sql[i + 1: i + len(dollar_tag)])
                i += len(dollar_tag)
                dollar_tag = None
                continue
            i += 1; continue
        if in_sq:
            cur.append(ch)
            if ch == "'":
                if sql[i + 1: i + 2] == "'":
                    cur.append("'"); i += 2; continue
                in_sq = False
            i += 1; continue
        if in_dq:
            cur.append(ch)
            if ch == '"':
                in_dq = False
            i += 1; continue
        if ch == "'":
            in_sq = True; cur.append(ch); i += 1; continue
        if ch == '"':
            in_dq = True; cur.append(ch); i += 1; continue
        if ch == "$":
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if m:
                dollar_tag = m.group(0)
                cur.append(dollar_tag)
                i += len(dollar_tag)
                continue
        if ch == ";":
            stmts.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(ch)
        i += 1
    stmts.append("".join(cur))
    return [s.strip() for s in stmts if s.strip()]


def _paren_depth_zero_search(sql: str, pattern: str) -> bool:
    """True if `pattern` (a compiled-ready regex fragment, word-bounded)
    appears at parenthesis depth 0 - i.e. not inside a subquery."""
    depth = 0
    in_sq = in_dq = False
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if in_sq:
            if ch == "'" and sql[i + 1: i + 2] != "'":
                in_sq = False
            elif ch == "'":
                i += 1
            i += 1; continue
        if in_dq:
            if ch == '"':
                in_dq = False
            i += 1; continue
        if ch == "'":
            in_sq = True; i += 1; continue
        if ch == '"':
            in_dq = True; i += 1; continue
        if ch == "(":
            depth += 1; i += 1; continue
        if ch == ")":
            depth = max(0, depth - 1); i += 1; continue
        if depth == 0:
            m = re.match(pattern, sql[i:], re.IGNORECASE)
            if m:
                return True
        i += 1
    return False


@dataclass
class SqlClassification:
    cleaned_sql: str
    lead_keyword: str
    is_destructive: bool
    returns_rows: bool
    cursorable: bool = True
    warning: Optional[str] = None


def classify_and_validate_sql(sql: str) -> SqlClassification:
    """Validates a single, well-formed statement and classifies it. Raises
    HTTPException(400) for anything structurally invalid (empty, multiple
    statements, blocked filesystem/program surface)."""
    cleaned_full = _strip_sql_comments_and_dollar_quotes(sql).strip()
    if not cleaned_full:
        raise HTTPException(status_code=400, detail="Query is empty")

    statements = _split_top_level_statements(cleaned_full)
    if len(statements) == 0:
        raise HTTPException(status_code=400, detail="Query is empty")
    if len(statements) > 1:
        raise HTTPException(status_code=400, detail="Only a single statement is allowed per run")

    # Re-slice the ORIGINAL sql (not the comment-stripped copy) so what
    # actually executes still contains the user's comments/formatting -
    # only the trailing ';' is trimmed.
    cleaned = sql.strip()
    if cleaned.endswith(";"):
        cleaned = cleaned[:-1].strip()

    for pattern in _ALWAYS_BLOCKED:
        if re.search(pattern, cleaned_full, re.IGNORECASE):
            raise HTTPException(status_code=400, detail="This statement touches server filesystem/program execution and is not allowed from the query runner")

    m = re.match(r"^\s*([A-Za-z]+)", cleaned_full)
    lead = m.group(1).upper() if m else ""

    # WITH ... can prefix a SELECT or a data-modifying statement
    # (WITH x AS (...) DELETE FROM t ...). Find the top-level command after
    # the CTE list to classify it correctly.
    effective_lead = lead
    if lead == "WITH":
        depth = 0
        in_sq = in_dq = False
        i, n = 0, len(cleaned_full)
        found = None
        while i < n:
            ch = cleaned_full[i]
            if in_sq:
                if ch == "'" and cleaned_full[i + 1: i + 2] != "'":
                    in_sq = False
                i += 1; continue
            if in_dq:
                if ch == '"':
                    in_dq = False
                i += 1; continue
            if ch == "'":
                in_sq = True; i += 1; continue
            if ch == '"':
                in_dq = True; i += 1; continue
            if ch == "(":
                depth += 1; i += 1; continue
            if ch == ")":
                depth = max(0, depth - 1); i += 1; continue
            if depth == 0:
                mm = re.match(r"\b(SELECT|INSERT|UPDATE|DELETE|MERGE)\b", cleaned_full[i:], re.IGNORECASE)
                if mm and i > 0:  # skip the WITH's own leading match
                    found = mm.group(1).upper()
                    break
            i += 1
        effective_lead = found or "SELECT"

    if lead == "EXPLAIN":
        # EXPLAIN ANALYZE (either "EXPLAIN ANALYZE ..." or the modern
        # "EXPLAIN (ANALYZE, ...) ..." option-list form) actually executes
        # the inner statement, so it inherits that statement's destructiveness.
        rest = cleaned_full[len("EXPLAIN"):].lstrip()
        analyzes = False
        if rest.startswith("("):
            close = rest.find(")")
            opts = rest[1:close] if close != -1 else ""
            analyzes = bool(re.search(r"\bANALYZE\b", opts, re.IGNORECASE)) and not re.search(r"\bANALYZE\s+(FALSE|OFF|0)\b", opts, re.IGNORECASE)
            rest = rest[close + 1:].lstrip() if close != -1 else rest
        else:
            m2 = re.match(r"ANALYZE\b\s*", rest, re.IGNORECASE)
            if m2:
                analyzes = True
                rest = rest[m2.end():].lstrip()
        if analyzes:
            inner_m = re.match(r"^\s*([A-Za-z]+)", rest)
            effective_lead = (inner_m.group(1).upper() if inner_m else "SELECT")
        else:
            effective_lead = "EXPLAIN"

    is_destructive = effective_lead in _DESTRUCTIVE_LEAD_KEYWORDS
    returns_rows = effective_lead in _DQL_LEAD_KEYWORDS or effective_lead == "EXPLAIN"

    # DECLARE ... CURSOR only accepts a plain SELECT/VALUES/TABLE query.
    # EXPLAIN (including EXPLAIN ANALYZE, which classifies as its inner
    # statement) and DML ... RETURNING return rows but cannot be wrapped in a
    # cursor, so those results get read straight into memory instead.
    cursorable = lead in ("SELECT", "VALUES", "TABLE") or (lead == "WITH" and effective_lead == "SELECT")

    warning = None
    if effective_lead in ("INSERT",):
        returns_rows = bool(_paren_depth_zero_search(cleaned_full, r"\bRETURNING\b"))
    elif effective_lead in ("UPDATE", "DELETE"):
        returns_rows = bool(_paren_depth_zero_search(cleaned_full, r"\bRETURNING\b"))
        if not _paren_depth_zero_search(cleaned_full, r"\bWHERE\b"):
            warning = f"This {effective_lead} has no WHERE clause and will affect every row in the target table."
    elif effective_lead == "TRUNCATE":
        warning = "TRUNCATE removes every row in the target table and cannot be filtered."
    elif effective_lead == "DROP":
        warning = "DROP permanently removes the object and its data."
    elif effective_lead == "ALTER" and re.search(r"\bDROP\s+COLUMN\b", cleaned_full, re.IGNORECASE):
        warning = "This ALTER drops a column, which permanently discards its data."

    return SqlClassification(
        cleaned_sql=cleaned,
        lead_keyword=effective_lead,
        is_destructive=is_destructive,
        returns_rows=returns_rows,
        cursorable=cursorable,
        warning=warning,
    )


# ============================================================================
# Job registry
# ============================================================================

_executor = ThreadPoolExecutor(max_workers=32, thread_name_prefix="pgqr")
_job_slots = threading.Semaphore(DEFAULT_MAX_CONCURRENT_JOBS)
_job_slots_size = DEFAULT_MAX_CONCURRENT_JOBS
_job_slots_lock = threading.Lock()

_jobs: Dict[str, Dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def _resize_job_slots(new_size: int):
    global _job_slots, _job_slots_size
    with _job_slots_lock:
        if new_size != _job_slots_size:
            _job_slots = threading.Semaphore(new_size)
            _job_slots_size = new_size


def _new_job(sql: str, database: Optional[str], classification: SqlClassification) -> Dict[str, Any]:
    job_id = uuid.uuid4().hex
    job = {
        "job_id": job_id,
        "sql": classification.cleaned_sql,
        "database": database,
        "lead_keyword": classification.lead_keyword,
        "is_destructive": classification.is_destructive,
        "returns_rows": classification.returns_rows,
        "cursorable": classification.cursorable,
        "status": "running",           # running | success | failed | cancelled
        "conn": None,
        "cursor_name": None,
        "rows": None,                  # populated only for non-cursorable result sets
        "columns": None,
        "row_count": None,
        "row_count_is_estimate": False,
        "rows_affected": None,
        "sort": None,                  # {"col": ..., "dir": "asc"|"desc"} | None
        "error": None,
        "notices": [],
        "created_at": time.time(),
        "started_at": time.time(),
        "finished_at": None,
        "job_lock": threading.Lock(),  # guards cursor MOVE/FETCH + re-sort
        "cancel_requested": False,
    }
    with _jobs_lock:
        _jobs[job_id] = job
    return job


def _get_job(job_id: str) -> Dict[str, Any]:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown or expired query job")
    return job


def _close_job(job: Dict[str, Any]):
    conn = job.get("conn")
    cursor_name = job.get("cursor_name")
    if conn is not None:
        try:
            if cursor_name:
                cur = conn.cursor()
                try:
                    cur.execute(f'CLOSE "{cursor_name}"')
                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                finally:
                    cur.close()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
    job["conn"] = None


def cleanup_jobs():
    cfg = _require_config() if (_config or os.environ.get("PGQR_HOST")) else {"job_ttl_seconds": DEFAULT_JOB_TTL_SECONDS}
    cutoff = time.time() - cfg.get("job_ttl_seconds", DEFAULT_JOB_TTL_SECONDS)
    with _jobs_lock:
        stale = [jid for jid, j in _jobs.items() if j["created_at"] < cutoff]
    for jid in stale:
        with _jobs_lock:
            job = _jobs.pop(jid, None)
        if job:
            _close_job(job)


def _run_job(job_id: str):
    job = _get_job(job_id)
    try:
        conn = _connect(job["database"])
    except HTTPException as e:
        job["status"] = "failed"
        job["error"] = e.detail
        job["finished_at"] = time.time()
        _job_slots.release()
        return

    job["conn"] = conn
    try:
        cur = conn.cursor()
        try:
            # 0 = no timeout, queries run as long as they need. Set explicitly
            # so a server- or role-level statement_timeout can't kill them.
            cur.execute("SET statement_timeout = 0")
        except Exception:
            pass
        conn.commit()

        if job["cancel_requested"]:
            raise _Cancelled()

        if job["returns_rows"] and not job["cursorable"]:
            # EXPLAIN / DML ... RETURNING - no cursor possible, so run it and
            # keep the result in memory. These result sets are small by nature
            # (a plan, or the rows one statement touched).
            conn.autocommit = True
            cur = conn.cursor()
            cur.execute(job["sql"])
            job["columns"] = [d[0] for d in (cur.description or [])]
            job["rows"] = [[_to_json_safe(v) for v in r] for r in cur.fetchall()]
            job["row_count"] = len(job["rows"])
            job["row_count_is_estimate"] = False
            job["rows_affected"] = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0
            cur.close()
            job["status"] = "success"
        elif job["returns_rows"]:
            conn.autocommit = False
            cursor_name = f"pgqr_{job_id}"
            job["cursor_name"] = cursor_name
            cur = conn.cursor()
            cur.execute(f'DECLARE "{cursor_name}" SCROLL CURSOR WITH HOLD FOR {job["sql"]}')
            # Zero-row fetch to learn column names without pulling data.
            cur.execute(f'FETCH FORWARD 0 FROM "{cursor_name}"')
            columns = [d[0] for d in (cur.description or [])]
            conn.commit()
            job["columns"] = columns

            # Cheap, non-scanning row estimate from the planner so the UI can
            # render pagination immediately, even on a billion-row table. An
            # exact count is available on request via /count.
            try:
                est_cur = conn.cursor()
                est_cur.execute(f"EXPLAIN (FORMAT JSON) {job['sql']}")
                plan = est_cur.fetchone()[0]
                est_cur.close()
                conn.commit()
                job["row_count"] = int(plan[0]["Plan"]["Plan Rows"])
                job["row_count_is_estimate"] = True
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                job["row_count"] = None
                job["row_count_is_estimate"] = True
            job["status"] = "success"
        else:
            # DDL/DML - transactional statements roll back cleanly on error;
            # a few Postgres commands (VACUUM, CREATE INDEX CONCURRENTLY,
            # ALTER SYSTEM, REINDEX CONCURRENTLY, ...) simply cannot run
            # inside a transaction block at all, so destructive statements
            # always run with autocommit on.
            conn.autocommit = True
            cur = conn.cursor()
            cur.execute(job["sql"])
            job["rows_affected"] = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0
            job["columns"] = []
            job["row_count"] = 0
            job["status"] = "success"
        job["finished_at"] = time.time()
        if not job["cursorable"]:
            # Nothing is being held server-side, so hand the connection back.
            _close_job(job)
    except _Cancelled:
        job["status"] = "cancelled"
        job["finished_at"] = time.time()
        try:
            conn.rollback()
        except Exception:
            pass
    except Exception as e:
        import psycopg2
        try:
            conn.rollback()
        except Exception:
            pass
        cancelled = isinstance(e, psycopg2.extensions.QueryCanceledError) or "canceling statement" in str(e).lower()
        if cancelled and job["cancel_requested"]:
            job["status"] = "cancelled"
        else:
            job["status"] = "failed"
            job["error"] = str(e)
        job["finished_at"] = time.time()
        if not job["returns_rows"] or not job["cursorable"] or job["status"] != "success":
            _close_job(job)
    finally:
        _job_slots.release()


class _Cancelled(Exception):
    pass


# ============================================================================
# Request/response models
# ============================================================================

class PostgresQueryRequest(BaseModel):
    sql: str
    database: Optional[str] = None
    confirm: bool = False


# ============================================================================
# Endpoints - explorer
# ============================================================================

@postgres_router.get("/databases")
def list_databases(bypass_cache: bool = Query(False), auth: dict = Depends(require_permission("runPostgresQueryRunner"))):
    cache_key = "pg-databases"
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}
    cfg = _require_config()
    conn = _meta_conn_manager.get(cfg["maintenance_database"])
    cur = conn.cursor()
    try:
        cur.execute("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
        databases = [r[0] for r in cur.fetchall()]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list databases: {e}")
    finally:
        cur.close()
    payload = {"databases": databases, "cached": False}
    _cache_set(cache_key, payload)
    return payload


@postgres_router.get("/schemas")
def list_schemas(database: Optional[str] = Query(None), bypass_cache: bool = Query(False), auth: dict = Depends(require_permission("runPostgresQueryRunner"))):
    cache_key = f"pg-schemas:{database or ''}"
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}
    conn = _meta_conn_manager.get(database)
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT schema_name FROM information_schema.schemata "
            "WHERE schema_name NOT IN ('pg_catalog', 'information_schema') "
            "AND schema_name NOT LIKE 'pg_toast%' AND schema_name NOT LIKE 'pg_temp%' "
            "ORDER BY schema_name"
        )
        schemas = [r[0] for r in cur.fetchall()]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list schemas: {e}")
    finally:
        cur.close()
    payload = {"schemas": schemas, "cached": False}
    _cache_set(cache_key, payload)
    return payload


@postgres_router.get("/tables")
def list_tables(
    schema: str = Query(...),
    database: Optional[str] = Query(None),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("runPostgresQueryRunner")),
):
    """Table/view listing with an approximate row count and size straight
    from Postgres' own catalog stats (pg_class.reltuples / pg_relation_size)
    - never a live COUNT(*) or scan, so this stays instant even against
    schemas full of billion-row tables."""
    cache_key = f"pg-tables:{database or ''}:{schema}"
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}
    conn = _meta_conn_manager.get(database)
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT c.relname,
                   CASE c.relkind
                       WHEN 'r' THEN 'table' WHEN 'p' THEN 'table'
                       WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
                       WHEN 'f' THEN 'foreign_table' ELSE 'other'
                   END AS kind,
                   GREATEST(c.reltuples, 0)::bigint AS est_rows,
                   pg_total_relation_size(c.oid) AS size_bytes
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = %s AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            ORDER BY c.relname
            """,
            (schema,),
        )
        tables = [{"name": r[0], "kind": r[1], "est_rows": r[2], "size_bytes": r[3]} for r in cur.fetchall()]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list tables: {e}")
    finally:
        cur.close()
    payload = {"tables": tables, "cached": False}
    _cache_set(cache_key, payload)
    return payload


@postgres_router.get("/columns")
def list_columns(
    schema: str = Query(...),
    table: str = Query(...),
    database: Optional[str] = Query(None),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("runPostgresQueryRunner")),
):
    cache_key = f"pg-columns:{database or ''}:{schema}:{table}"
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}
    conn = _meta_conn_manager.get(database)
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT column_name, data_type, is_nullable, column_default, ordinal_position
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            ORDER BY ordinal_position
            """,
            (schema, table),
        )
        rows = cur.fetchall()
        cur.execute(
            """
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = %s AND tc.table_name = %s
            """,
            (schema, table),
        )
        pk_cols = {r[0] for r in cur.fetchall()}
        columns = [
            {
                "name": r[0],
                "data_type": r[1],
                "nullable": r[2] == "YES",
                "default": r[3],
                "position": r[4],
                "is_primary_key": r[0] in pk_cols,
            }
            for r in rows
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list columns: {e}")
    finally:
        cur.close()
    payload = {"columns": columns, "cached": False}
    _cache_set(cache_key, payload)
    return payload


# ============================================================================
# Endpoints - query execution
# ============================================================================

@postgres_router.post("/query")
def start_query(body: PostgresQueryRequest, auth: dict = Depends(require_permission("runPostgresQueryRunner"))):
    cleanup_jobs()
    cfg = _require_config()
    _resize_job_slots(cfg["max_concurrent_jobs"])

    classification = classify_and_validate_sql(body.sql)

    if classification.is_destructive and not body.confirm:
        raise HTTPException(
            status_code=409,
            detail={
                "message": f"This is a {classification.lead_keyword} statement and will modify data or schema.",
                "requires_confirmation": True,
                "statement_type": classification.lead_keyword,
                "warning": classification.warning,
            },
        )

    acquired = _job_slots.acquire(blocking=False)
    if not acquired:
        raise HTTPException(
            status_code=429,
            detail=f"Too many queries already running (max {cfg['max_concurrent_jobs']} concurrent). Cancel one or wait for it to finish.",
        )

    job = _new_job(body.sql, body.database, classification)
    _executor.submit(_run_job, job["job_id"])
    return {
        "job_id": job["job_id"],
        "status": "running",
        "statement_type": classification.lead_keyword,
        "is_destructive": classification.is_destructive,
        "returns_rows": classification.returns_rows,
        "warning": classification.warning,
    }


@postgres_router.get("/query/{job_id}/status")
def get_query_status(job_id: str, auth: dict = Depends(require_permission("runPostgresQueryRunner"))):
    job = _get_job(job_id)
    elapsed_ms = int(((job["finished_at"] or time.time()) - job["started_at"]) * 1000)
    return {
        "job_id": job_id,
        "status": job["status"],
        "statement_type": job["lead_keyword"],
        "returns_rows": job["returns_rows"],
        "is_destructive": job["is_destructive"],
        "columns": job["columns"],
        "row_count": job["row_count"],
        "row_count_is_estimate": job["row_count_is_estimate"],
        "rows_affected": job["rows_affected"],
        "error": job["error"],
        "elapsed_ms": elapsed_ms,
    }


@postgres_router.post("/query/{job_id}/count")
def get_exact_count(job_id: str, auth: dict = Depends(require_permission("runPostgresQueryRunner"))):
    """Computes an exact COUNT(*) for a finished SELECT-like job, on demand.
    Not run automatically - on a billion-row table a real count is a full
    scan, so the UI only pays for it when the person actually asks."""
    job = _get_job(job_id)
    if job["status"] != "success" or not job["returns_rows"]:
        raise HTTPException(status_code=409, detail="No result set to count")
    if not job["cursorable"]:
        # Already fully in memory, so the count is exact and free.
        count = len(job["rows"] or [])
        job["row_count"] = count
        job["row_count_is_estimate"] = False
        return {"job_id": job_id, "row_count": count, "row_count_is_estimate": False}
    conn = job.get("conn")
    if conn is None:
        raise HTTPException(status_code=409, detail="Query connection is no longer open")
    with job["job_lock"]:
        cur = conn.cursor()
        try:
            cur.execute(f"SELECT COUNT(*) FROM ({job['sql']}) AS __pgqr_count")
            count = cur.fetchone()[0]
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            raise HTTPException(status_code=500, detail=f"Count failed: {e}")
        finally:
            cur.close()
    job["row_count"] = count
    job["row_count_is_estimate"] = False
    return {"job_id": job_id, "row_count": count, "row_count_is_estimate": False}


@postgres_router.get("/query/{job_id}/rows")
def get_query_rows(
    job_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=ROWS_PAGE_MAX_SIZE),
    sort_col: Optional[str] = Query(None),
    sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
    auth: dict = Depends(require_permission("runPostgresQueryRunner")),
):
    job = _get_job(job_id)
    if job["status"] != "success":
        raise HTTPException(status_code=409, detail=f"Query is not ready (status: {job['status']})")
    if not job["returns_rows"]:
        return {"columns": [], "rows": [], "page": 1, "page_size": page_size, "total_rows": 0, "total_pages": 1, "row_count_is_estimate": False}

    if not job["cursorable"]:
        all_rows = job["rows"] or []
        if sort_col:
            columns = job["columns"] or []
            if sort_col not in columns:
                raise HTTPException(status_code=400, detail=f"'{sort_col}' is not a column of this result")
            idx = columns.index(sort_col)
            all_rows = sorted(
                all_rows,
                key=lambda r: (r[idx] is None, str(r[idx]) if r[idx] is not None else ""),
                reverse=(sort_dir == "desc"),
            )
        offset = (page - 1) * page_size
        total_rows = len(all_rows)
        return {
            "columns": job["columns"],
            "rows": all_rows[offset:offset + page_size],
            "page": page,
            "page_size": page_size,
            "total_rows": total_rows,
            "total_pages": max(1, -(-total_rows // page_size)),
            "row_count_is_estimate": False,
        }

    conn = job.get("conn")
    if conn is None:
        raise HTTPException(status_code=409, detail="Query connection is no longer open (the job may have expired) - re-run the query")

    with job["job_lock"]:
        try:
            requested_sort = {"col": sort_col, "dir": sort_dir} if sort_col else None
            if requested_sort != job["sort"]:
                _resort_cursor(job, conn, sort_col, sort_dir)

            cursor_name = job["cursor_name"]
            cur = conn.cursor()
            offset = (page - 1) * page_size
            cur.execute(f'MOVE ABSOLUTE {offset} FROM "{cursor_name}"')
            cur.execute(f'FETCH FORWARD {page_size} FROM "{cursor_name}"')
            rows = [[_to_json_safe(v) for v in r] for r in cur.fetchall()]
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            raise HTTPException(status_code=500, detail=f"Failed to fetch rows: {e}")
        finally:
            cur.close()

    total_rows = job["row_count"] or 0
    total_pages = max(1, -(-total_rows // page_size)) if total_rows else max(page, 1)
    return {
        "columns": job["columns"],
        "rows": rows,
        "page": page,
        "page_size": page_size,
        "total_rows": total_rows,
        "total_pages": total_pages,
        "row_count_is_estimate": job["row_count_is_estimate"],
    }


def _resort_cursor(job: Dict[str, Any], conn, sort_col: Optional[str], sort_dir: str):
    """Re-declares the job's cursor wrapped with an ORDER BY. Must be called
    with job['job_lock'] held."""
    old_name = job["cursor_name"]
    cur = conn.cursor()
    try:
        try:
            cur.execute(f'CLOSE "{old_name}"')
        except Exception:
            pass
        if sort_col:
            matched = next((c for c in (job["columns"] or []) if c == sort_col), None)
            if matched is None:
                raise HTTPException(status_code=400, detail=f"'{sort_col}' is not a column of this result")
            quoted = '"' + matched.replace('"', '""') + '"'
            wrapped = f'SELECT * FROM ({job["sql"]}) AS __pgqr_sort ORDER BY {quoted} {"ASC" if sort_dir == "asc" else "DESC"} NULLS LAST'
        else:
            wrapped = job["sql"]
        new_name = f'pgqr_{uuid.uuid4().hex[:12]}'
        cur.execute(f'DECLARE "{new_name}" SCROLL CURSOR WITH HOLD FOR {wrapped}')
        conn.commit()
        job["cursor_name"] = new_name
        job["sort"] = {"col": sort_col, "dir": sort_dir} if sort_col else None
    except HTTPException:
        conn.rollback()
        raise
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to sort results: {e}")
    finally:
        cur.close()


@postgres_router.post("/query/{job_id}/cancel")
def cancel_query(job_id: str, auth: dict = Depends(require_permission("runPostgresQueryRunner"))):
    job = _get_job(job_id)
    if job["status"] != "running":
        return {"job_id": job_id, "status": job["status"]}
    job["cancel_requested"] = True
    conn = job.get("conn")
    if conn is not None:
        try:
            conn.cancel()
        except Exception as e:
            logger.info(f"Postgres query-runner cancel failed for job {job_id}: {e}")
    return {"job_id": job_id, "status": "cancelling"}


@postgres_router.delete("/query/{job_id}")
def close_query(job_id: str, auth: dict = Depends(require_permission("runPostgresQueryRunner"))):
    with _jobs_lock:
        job = _jobs.pop(job_id, None)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown or expired query job")
    _close_job(job)
    return {"job_id": job_id, "status": "closed"}


@postgres_router.get("/query/{job_id}/download")
def download_query_csv(job_id: str, auth: dict = Depends(require_permission("runPostgresQueryRunner"))):
    """Streams the FULL result as CSV via its own dedicated named cursor,
    fetched in DOWNLOAD_CHUNK_ROWS batches so memory stays flat even for a
    multi-billion row result - nothing is ever materialized here in one go."""
    job = _get_job(job_id)
    if job["status"] != "success":
        raise HTTPException(status_code=409, detail=f"Query is not ready (status: {job['status']})")
    if not job["returns_rows"]:
        raise HTTPException(status_code=409, detail="This statement did not return rows")

    sql = job["sql"]
    database = job["database"]
    columns_hint = job["columns"]
    filename = f"postgres_query_{job_id[:8]}.csv"

    if not job["cursorable"]:
        # Already in memory - re-running an EXPLAIN ANALYZE or a RETURNING
        # statement to stream it would execute it a second time.
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(columns_hint or [])
        for row in (job["rows"] or []):
            writer.writerow(["" if v is None else v for v in row])
        return StreamingResponse(
            iter([buf.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    def generate():
        conn = _connect(database)
        try:
            conn.autocommit = False
            cur = conn.cursor(name=f"pgqr_dl_{uuid.uuid4().hex[:12]}")
            cur.itersize = DOWNLOAD_CHUNK_ROWS
            cur.execute(sql)
            columns = [d[0] for d in cur.description] if cur.description else (columns_hint or [])
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow(columns)
            yield buf.getvalue()
            while True:
                batch = cur.fetchmany(DOWNLOAD_CHUNK_ROWS)
                if not batch:
                    break
                buf = io.StringIO()
                writer = csv.writer(buf)
                for row in batch:
                    writer.writerow(["" if v is None else _to_json_safe(v) for v in row])
                yield buf.getvalue()
        finally:
            try:
                conn.close()
            except Exception:
                pass

    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )