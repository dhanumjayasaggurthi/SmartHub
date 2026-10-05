from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import require_permission
from cryptography.hazmat.primitives import serialization

logger = logging.getLogger(__name__)

unstructured_router = APIRouter(prefix="/api/unstructured", tags=["Unstructured"])

# Wired in from app.py via set_unstructured_dependencies()
_config: Optional[Dict[str, Any]] = None

# Table is ~2.8M rows — we never pull it whole. Everything below is done with
# WHERE / GROUP BY / LIMIT in Snowflake, and only a page (or a small aggregate)
# ever crosses the wire.

ALL_COLUMNS = [
    "FILE_NAME", "OBJ_ID", "A_STATUS", "STATUS", "R_VERSION_LABEL", "R_VERSION_LABEL_VIZ",
    "OBJECT_NAME", "ARTIFACT_NAME", "PRODUCT_CODE", "DOMAIN", "JJ_NUMBER", "JJ_TITLE",
    "INSIGHT_FAMILY_CODE", "INSIGHT_FAMILY_NAME", "INSIGHT_THERAPEUTIC_AREA", "CLINICAL_TRIAL_ID",
]

# Equality/IN-style filters (checkbox dropdowns in the UI).
FILTERABLE_COLUMNS = [
    "A_STATUS", "STATUS", "DOMAIN", "PRODUCT_CODE", "ARTIFACT_NAME",
    "INSIGHT_FAMILY_CODE", "INSIGHT_FAMILY_NAME", "INSIGHT_THERAPEUTIC_AREA", "CLINICAL_TRIAL_ID",
]

# Free-text "contains" filters.
SEARCHABLE_COLUMNS = ["FILE_NAME", "OBJECT_NAME", "JJ_TITLE", "ARTIFACT_NAME", "JJ_NUMBER"]

MAX_PAGE_SIZE = 250
MAX_PAGE = 100_000  # keeps OFFSET sane on a ~2.8M row table

# ============================================================================
# Query Runner - free-form, read-only SQL against anything the configured
# key pair's role can see (not just this page's view). Runs async so large
# scans (multi-million row tables) don't sit on an HTTP request and hit a
# gateway timeout; results are paged/downloaded afterwards straight out of
# Snowflake's own result cache via RESULT_SCAN, so a 3-5M row result is never
# pulled into this process's memory in one shot.
# ============================================================================

# Still read-only, still single-statement. That is a data-safety rule, not a
# row/table scope limit - Query Runner can SELECT from anything the role can
# see, it just can never mutate anything.
_QUERY_RUNNER_BLOCKED_KEYWORDS = [
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE",
    "MERGE", "GRANT", "REVOKE", "CALL", "EXECUTE", "COPY", "PUT", "GET",
    "UNLOAD", "USE", "SET", "COMMIT", "ROLLBACK", "BEGIN",
]

QUERY_RUNNER_STATEMENT_TIMEOUT_SECONDS = 1800  # 30 min - enough headroom for a 3-5M row scan/join
QUERY_RUNNER_PAGE_MAX_SIZE = 500               # on-screen paging cap; the table can't render millions of rows either way
QUERY_RUNNER_DOWNLOAD_CHUNK_ROWS = 10_000      # rows per fetch while streaming a CSV download
QUERY_RUNNER_JOB_TTL_SECONDS = 4 * 60 * 60     # job bookkeeping cleanup; Snowflake's own result cache outlives this (24h)


def _strip_sql_comments(sql: str) -> str:
    """Remove -- line comments and /* */ block comments without touching
    quoted strings ('...' / \"...\"), so commented SQL pasted from a worksheet
    validates and runs instead of being rejected."""
    out = []
    i, n = 0, len(sql)
    in_sq = in_dq = False          # inside '...' / "..."
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if in_sq:
            out.append(ch)
            if ch == "'":
                if nxt == "'":  # escaped quote
                    out.append(nxt); i += 1
                else:
                    in_sq = False
        elif in_dq:
            out.append(ch)
            if ch == '"':
                in_dq = False
        elif ch == "'":
            in_sq = True; out.append(ch)
        elif ch == '"':
            in_dq = True; out.append(ch)
        elif ch == "-" and nxt == "-":
            while i < n and sql[i] != "\n":
                i += 1
            continue  # keep the newline itself
        elif ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (sql[i] == "*" and sql[i + 1] == "/"):
                i += 1
            i += 2
            out.append(" ")
            continue
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def _validate_query_runner_sql(sql: str) -> str:
    """Only a single, read-only SELECT (optionally CTE-prefixed: WITH … SELECT
    …) is allowed. Comments are stripped rather than rejected. Raises
    HTTPException (400) on anything else - stacked statements, DML/DDL, etc.
    Table/schema/database scope is NOT restricted here; that's governed
    entirely by what the Snowflake role can see."""
    cleaned = _strip_sql_comments(sql).strip().rstrip(";").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Query is empty")
    if ";" in cleaned:
        raise HTTPException(status_code=400, detail="Only a single statement is allowed")
    if not re.match(r"^\s*(WITH|SELECT)\b", cleaned, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Only SELECT statements (optionally starting with a WITH clause) are allowed")
    for kw in _QUERY_RUNNER_BLOCKED_KEYWORDS:
        if re.search(rf"\b{kw}\b", cleaned, re.IGNORECASE):
            raise HTTPException(status_code=400, detail=f"'{kw}' is not allowed in the query")
    return cleaned

# Short-lived cache so identical requests (repeat page views, two people on the
# same filter, a debounced keystroke that duplicates the previous one) don't
# each trigger a fresh full-table scan. The "Refresh from Snowflake" button on
# the frontend sends bypass_cache=true to force a real pull.
CACHE_TTL_SECONDS = 300  # 5 minutes
CACHE_MAX_ENTRIES = 1000

# Base view, reused (as a CTE) by every query below.
BASE_CTE = """
WITH V AS (
    SELECT FILE_NAME,
           OBJ_ID,
           FILE_PATH,
           A_STATUS,
           STATUS,
           R_VERSION_LABEL,
           R_VERSION_LABEL_VIZ,
           OBJECT_NAME,
           ARTIFACT_NAME,
           PRODUCT_CODE,
           DOMAIN,
           JJ_NUMBER,
           JJ_TITLE,
           INSIGHT_FAMILY_CODE,
           INSIGHT_FAMILY_NAME,
           INSIGHT_THERAPEUTIC_AREA,
           CLINICAL_TRIAL_ID,
           INGESTED_AT,
           FILE_SIZE
    FROM (
        SELECT
            ID_IN_SOURCE_SYSTEM,
            CONTENT_LOCATION,
            A_STATUS,
            STATUS,
            OBJECT_NAME,
            GROUP_NAME,
            R_OBJECT_TYPE,
            PRIMARY_GROUP,
            ARTIFACT_NAME,
            CD_MIGRATED_SOURCE,
            DCTM_OBJ_LINK,
            SPLIT(DCTM_OBJ_LINK, '/')[2]::STRING AS PRODUCT_CODE,
            R_VERSION_LABEL,
            FILE_NAME,
            FILE_PATH,
            DOMAIN,
            OBJ_ID,
            JJ_NUMBER,
            JJ_TITLE,
            R_VERSION_LABEL_VIZ,
            A_STATUS_VIZ,
            R_OBJECT_TYPE_VIZ,
            INSIGHT_FAMILY_CODE,
            INSIGHT_THERAPEUTIC_AREA,
            INSIGHT_FAMILY_NAME,
            CLINICAL_TRIAL_ID,
            INGESTED_AT,
            FILE_SIZE
        FROM DEV_RAW.RIMDOCS_CONTROL_STG.ALL_METADATA_JOINED_WITH_TA_CTI
    )
)
"""


def set_unstructured_dependencies(config: Optional[Dict[str, Any]]):
    """Called once from app.py with the 'unstructured' section of dq_config.json."""
    global _config
    _config = config
    if not _config:
        logger.warning("⚠️ unstructured config not found - Unstructured endpoints will be unavailable")


def _load_private_key(private_key_path: str, private_key_password: str) -> bytes:
    if not Path(private_key_path).exists():
        raise FileNotFoundError(f"Private key not found at {private_key_path}")
    with open(private_key_path, "rb") as f:
        key = serialization.load_pem_private_key(
            f.read(),
            password=private_key_password.encode() if private_key_password else None,
        )
    return key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


# ============================================================================
# Connection management
# ----------------------------------------------------------------------------
# One warm, TTL-refreshed Snowflake connection shared across requests, instead
# of paying a fresh key-pair handshake + TLS setup on every single API call.
# Same TTL-refresh-with-healthcheck shape as BDCConnectionManager in app.py.
# ============================================================================

class _UnstructuredConnectionManager:
    CONNECTION_TTL = 2 * 60 * 60  # 2 hours

    def __init__(self):
        self._client = None
        self._created_at = 0.0
        self._lock = threading.Lock()

    def _connect(self):
        # Imported here (not at module top) to dodge a circular import - app.py
        # imports this file, so this file can't import SnowflakeClient from app
        # until app has finished loading.
        from app import SnowflakeClient
        import snowflake.connector

        if not _config:
            raise HTTPException(status_code=503, detail="Unstructured not configured - missing 'unstructured' section in dq_config.json")

        private_key = _load_private_key(
            _config["private_key_path"],
            _config.get("private_key_password", ""),
        )
        conn = snowflake.connector.connect(
            user=_config["user"],
            account=_config["account"],
            private_key=private_key,
            role=_config["role"],
            warehouse=_config["warehouse"],
            database=_config["database"],
            schema=_config["schema"],
            session_parameters={"STATEMENT_TIMEOUT_IN_SECONDS": 60},
        )
        return SnowflakeClient(conn)

    def get_client(self):
        with self._lock:
            expired = (time.time() - self._created_at) > self.CONNECTION_TTL

            if self._client is not None and not expired:
                try:
                    self._client.execute("SELECT 1")
                    return self._client
                except Exception:
                    logger.info("Unstructured connection stale/expired, reconnecting")

            if self._client is not None:
                try:
                    self._client.close()
                except Exception:
                    pass

            self._client = self._connect()
            self._created_at = time.time()
            return self._client


_conn_manager = _UnstructuredConnectionManager()


def _get_client():
    return _conn_manager.get_client()


# ============================================================================
# Query Runner: its own dedicated connection (longer statement timeout, no
# periodic "SELECT 1" healthcheck) so it's never torn down mid-query by the
# TTL/healthcheck cycle the dashboard's shared connection uses above, and a
# slow analytical query here can never eat into the dashboard's 60s budget.
# ============================================================================

class _QueryRunnerConnectionManager:
    CONNECTION_TTL = 8 * 60 * 60  # 8 hours - long-lived, only recycled when actually idle

    def __init__(self):
        self._client = None
        self._created_at = 0.0
        self._active_jobs = 0
        self._lock = threading.Lock()

    def _connect(self):
        from app import SnowflakeClient
        import snowflake.connector

        if not _config:
            raise HTTPException(status_code=503, detail="Unstructured not configured - missing 'unstructured' section in dq_config.json")

        private_key = _load_private_key(
            _config["private_key_path"],
            _config.get("private_key_password", ""),
        )
        conn = snowflake.connector.connect(
            user=_config["user"],
            account=_config["account"],
            private_key=private_key,
            role=_config["role"],
            warehouse=_config["warehouse"],
            database=_config["database"],
            schema=_config["schema"],
            session_parameters={
                "STATEMENT_TIMEOUT_IN_SECONDS": QUERY_RUNNER_STATEMENT_TIMEOUT_SECONDS,
            },
        )
        try:
            conn.cursor().execute("ALTER SESSION SET QUERY_TAG = 'dqe_unstructured_query_runner'")
        except Exception:
            pass  # cosmetic (Snowflake query history tagging) - never worth failing a connection over
        return SnowflakeClient(conn)

    def get_client(self):
        with self._lock:
            expired = (time.time() - self._created_at) > self.CONNECTION_TTL
            can_recycle = expired and self._active_jobs == 0

            if self._client is not None and not can_recycle:
                return self._client

            if self._client is not None:
                try:
                    self._client.close()
                except Exception:
                    pass

            self._client = self._connect()
            self._created_at = time.time()
            return self._client

    def job_started(self):
        with self._lock:
            self._active_jobs += 1

    def job_finished(self):
        with self._lock:
            self._active_jobs = max(0, self._active_jobs - 1)

    def force_reconnect(self):
        """Called when a query on the current connection blows up in a way
        that suggests the session itself is dead (not just a bad query)."""
        with self._lock:
            if self._client is not None:
                try:
                    self._client.close()
                except Exception:
                    pass
            self._client = self._connect()
            self._created_at = time.time()
            return self._client


_query_runner_conn_manager = _QueryRunnerConnectionManager()


# ----------------------------------------------------------------------------
# In-process job registry. Each job = one async Snowflake query. Paging and
# CSV export both replay against Snowflake's own cached result set via
# RESULT_SCAN(query_id), so a 3-5M row result is fetched from Snowflake in
# small batches on demand - never materialized here in one go.
# ----------------------------------------------------------------------------

_query_runner_jobs: Dict[str, Dict[str, Any]] = {}
_query_runner_jobs_lock = threading.Lock()


def _cleanup_query_runner_jobs():
    cutoff = time.time() - QUERY_RUNNER_JOB_TTL_SECONDS
    with _query_runner_jobs_lock:
        stale = [jid for jid, j in _query_runner_jobs.items() if j["created_at"] < cutoff]
        for jid in stale:
            _query_runner_jobs.pop(jid, None)


def _get_job(job_id: str) -> Dict[str, Any]:
    with _query_runner_jobs_lock:
        job = _query_runner_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown or expired query job")
    return job


# ============================================================================
# Tiny in-process TTL cache for query results
# ============================================================================

_cache: Dict[str, tuple] = {}
_cache_lock = threading.Lock()


def _cache_key(name: str, params: Dict[str, Any]) -> str:
    raw = json.dumps({"name": name, "params": params}, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def _cache_get(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        ts, payload = entry
        if time.time() - ts > CACHE_TTL_SECONDS:
            return None
        return payload


def _cache_set(key: str, payload: Any):
    with _cache_lock:
        _cache[key] = (time.time(), payload)
        if len(_cache) > CACHE_MAX_ENTRIES:
            oldest_key = min(_cache, key=lambda k: _cache[k][0])
            _cache.pop(oldest_key, None)


def _to_json_safe(val):
    if hasattr(val, "isoformat"):
        return val.isoformat()
    if isinstance(val, float):
        # NaN / +-Infinity are legal in Snowflake results but not in JSON -
        # FastAPI's encoder raises "Out of range float values are not JSON
        # compliant". Surface them as null instead of 500ing the whole page.
        if val != val or val == float("inf") or val == float("-inf"):
            return None
    return val


def _parse_filters(filters: Optional[str]) -> Dict[str, List[str]]:
    """`filters` is a JSON object: {"COL": ["val1", "val2"], ...}. (Previously
    a hand-rolled "COL:v1||v2,COL2:v3" format with per-value percent-encoding
    on the frontend - that double-encoded anything with a space/quote/special
    char once URLSearchParams encoded the already-encoded string again, so
    those filters silently matched zero rows. JSON sidesteps both the
    delimiter-collision and the double-encoding problem.)"""
    parsed: Dict[str, List[str]] = {}
    if not filters:
        return parsed
    try:
        raw = json.loads(filters)
    except (ValueError, TypeError):
        return parsed
    if not isinstance(raw, dict):
        return parsed
    for col, values in raw.items():
        col = str(col).strip().upper()
        if col not in FILTERABLE_COLUMNS or not isinstance(values, list):
            continue
        values = [str(v) for v in values if v not in (None, "")]
        if values:
            parsed[col] = values
    return parsed


def _build_where(filters, search_file_name, search_object_name, search_jj_title, search_artifact_name="", search_jj_number=""):
    clauses = []
    params: Dict[str, Any] = {}

    for col, values in filters.items():
        placeholders = []
        for i, v in enumerate(values):
            key = f"{col}_{i}"
            placeholders.append(f"%({key})s")
            params[key] = v
        clauses.append(f'"{col}" IN ({", ".join(placeholders)})')

    if search_file_name:
        clauses.append('"FILE_NAME" ILIKE %(search_file_name)s')
        params["search_file_name"] = f"%{search_file_name}%"
    if search_object_name:
        clauses.append('"OBJECT_NAME" ILIKE %(search_object_name)s')
        params["search_object_name"] = f"%{search_object_name}%"
    if search_jj_title:
        clauses.append('"JJ_TITLE" ILIKE %(search_jj_title)s')
        params["search_jj_title"] = f"%{search_jj_title}%"
    if search_artifact_name:
        clauses.append('"ARTIFACT_NAME" ILIKE %(search_artifact_name)s')
        params["search_artifact_name"] = f"%{search_artifact_name}%"
    if search_jj_number:
        clauses.append('"JJ_NUMBER" ILIKE %(search_jj_number)s')
        params["search_jj_number"] = f"%{search_jj_number}%"
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return where_sql, params


def _run(sql: str, params: Optional[Dict[str, Any]] = None):
    """Execute against the shared connection; reconnect once and retry if it
    turns out to have gone stale between the healthcheck and this call."""
    client = _get_client()
    try:
        return client.execute(sql, params or {})
    except FileNotFoundError:
        raise
    except HTTPException:
        raise
    except Exception:
        logger.info("Unstructured query failed on shared connection, retrying once")
        client = _conn_manager._connect()
        with _conn_manager._lock:
            _conn_manager._client = client
            _conn_manager._created_at = time.time()
        return client.execute(sql, params or {})


def _render_sql_for_display(sql: str, params: Optional[Dict[str, Any]] = None) -> str:
    """Inlines bound params into the SQL text for display in the UI's 'View SQL'
    button. Never used for execution - _run always uses the parameterized
    version above, this is purely so a human can read what actually ran."""
    if not params:
        return sql.strip()
    rendered = sql
    for key, value in params.items():
        if isinstance(value, str):
            literal = "'" + value.replace("'", "''") + "'"
        elif value is None:
            literal = "NULL"
        else:
            literal = str(value)
        rendered = rendered.replace(f"%({key})s", literal)
    return rendered.strip()


class QueryRunnerRequest(BaseModel):
    sql: str


@unstructured_router.get("/rows")
def get_rows(
    page: int = Query(1, ge=1, le=MAX_PAGE),
    page_size: int = Query(50, ge=1, le=MAX_PAGE_SIZE),
    sort_col: str = Query("FILE_NAME"),
    sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
    filters: Optional[str] = Query(None, description="DOMAIN:val1||val2,A_STATUS:val3"),
    search_file_name: str = Query(""),
    search_object_name: str = Query(""),
    search_jj_title: str = Query(""),
    search_artifact_name: str = Query(""),
    search_jj_number: str = Query(""),
    distinct_only: bool = Query(False, description="One row per FILE_NAME instead of one row per version"),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("viewUnstructured")),
):
    """One page of rows, filtered/sorted in Snowflake. Never pulls the full table."""
    if sort_col not in ALL_COLUMNS:
        sort_col = "FILE_NAME"

    cache_key = _cache_key("rows", dict(
        page=page, page_size=page_size, sort_col=sort_col, sort_dir=sort_dir,
        filters=filters or "", search_file_name=search_file_name,
        search_object_name=search_object_name, search_jj_title=search_jj_title,
        search_artifact_name=search_artifact_name, search_jj_number=search_jj_number, distinct_only=distinct_only,
    ))
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    parsed_filters = _parse_filters(filters)
    where_sql, params = _build_where(parsed_filters, search_file_name, search_object_name, search_jj_title, search_artifact_name, search_jj_number)

    offset = (page - 1) * page_size
    params["limit"] = page_size
    params["offset"] = offset

    sort_direction = "ASC" if sort_dir == "asc" else "DESC"
    if distinct_only:
        # One row per FILE_NAME - picks the row Snowflake happens to keep for
        # that FILE_NAME (arbitrary among its versions), same as COUNT(DISTINCT
        # FILE_NAME) on the summary card. QUALIFY needs its own reference to
        # V, so the sort has to be re-applied on the deduped result.
        dedup_sql = f'{BASE_CTE} SELECT * FROM V {where_sql} QUALIFY ROW_NUMBER() OVER (PARTITION BY "FILE_NAME" ORDER BY "FILE_NAME") = 1'
        data_sql = f'{dedup_sql} ORDER BY "{sort_col}" {sort_direction} NULLS LAST LIMIT %(limit)s OFFSET %(offset)s'
        count_sql = f'{BASE_CTE} SELECT COUNT(DISTINCT "FILE_NAME") FROM V {where_sql}'
    else:
        data_sql = f'{BASE_CTE} SELECT * FROM V {where_sql} ORDER BY "{sort_col}" {sort_direction} NULLS LAST LIMIT %(limit)s OFFSET %(offset)s'
        count_sql = f"{BASE_CTE} SELECT COUNT(*) FROM V {where_sql}"
    count_params = {k: v for k, v in params.items() if k not in ("limit", "offset")}

    try:
        t0 = time.time()
        data_result = _run(data_sql, params)
        count_result = _run(count_sql, count_params)
        elapsed_ms = int((time.time() - t0) * 1000)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unstructured /rows failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query failed: {e}")

    columns = [c.upper() for c in data_result.columns]
    rows = [[_to_json_safe(v) for v in r] for r in data_result.rows]
    total_count = count_result.rows[0][0] if count_result.rows else 0

    payload = {
        "columns": columns,
        "rows": rows,
        "total_count": total_count,
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, -(-total_count // page_size)),
        "elapsed_ms": elapsed_ms,
        "query_id": data_result.query_id,
        # "sql" = the page-of-rows query. total_pages (and therefore "Current
        # page") is actually driven by count_sql, and elapsed_ms times BOTH
        # queries - so callers that want an accurate picture should use
        # count_sql too, not just sql.
        "sql": _render_sql_for_display(data_sql, params),
        "count_sql": _render_sql_for_display(count_sql, count_params),
        "cached": False,
    }
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.get("/rows/download")
def download_rows_csv(
    sort_col: str = Query("FILE_NAME"),
    sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
    filters: Optional[str] = Query(None),
    search_file_name: str = Query(""),
    search_object_name: str = Query(""),
    search_jj_title: str = Query(""),
    search_artifact_name: str = Query(""),
    search_jj_number: str = Query(""),
    distinct_only: bool = Query(False),
    auth: dict = Depends(require_permission("viewUnstructured")),
):
    """Streams every row matching the current filters as CSV - not just the
    page on screen. Fetched from Snowflake in chunks so this stays memory-flat
    even when the filtered set runs into the millions."""
    if sort_col not in ALL_COLUMNS:
        sort_col = "FILE_NAME"

    parsed_filters = _parse_filters(filters)
    where_sql, params = _build_where(parsed_filters, search_file_name, search_object_name, search_jj_title, search_artifact_name, search_jj_number)
    sort_direction = "ASC" if sort_dir == "asc" else "DESC"

    if distinct_only:
        sql = (
            f'{BASE_CTE} SELECT * FROM V {where_sql} '
            f'QUALIFY ROW_NUMBER() OVER (PARTITION BY "FILE_NAME" ORDER BY "FILE_NAME") = 1 '
            f'ORDER BY "{sort_col}" {sort_direction} NULLS LAST'
        )
    else:
        sql = f'{BASE_CTE} SELECT * FROM V {where_sql} ORDER BY "{sort_col}" {sort_direction} NULLS LAST'

    def generate():
        client = _get_client()
        cur = client.conn.cursor()
        try:
            cur.execute(sql, params)
            columns = [c[0] for c in cur.description]
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow(columns)
            yield buf.getvalue()
            while True:
                batch = cur.fetchmany(QUERY_RUNNER_DOWNLOAD_CHUNK_ROWS)
                if not batch:
                    break
                buf = io.StringIO()
                writer = csv.writer(buf)
                for row in batch:
                    writer.writerow(["" if v is None else _to_json_safe(v) for v in row])
                yield buf.getvalue()
        finally:
            cur.close()

    filename = f"unstructured{'_distinct' if distinct_only else ''}.csv"
    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _get_total_size_bytes(bypass_cache: bool = False) -> Optional[int]:
    """All-time SUM(FILE_SIZE) across the whole table, no filters applied -
    the denominator for the 'ingested so far / total' size cards. Deduped to
    one row per FILE_PATH first.

    FILE_PATH can't be referenced directly inside a window PARTITION BY/ORDER
    BY in this table - like OBJ_ID, it's some type Snowflake refuses to accept
    there at all ("is not a valid group by expression"), and the check applies
    to the column's lineage even through wrapping functions. The workaround:
    materialize it into a plain VARCHAR via TO_VARCHAR() in its own nested
    SELECT first, then partition on that already-materialized column in the
    outer query - that breaks the direct reference chain Snowflake is
    checking.

    Cached on its own key since it doesn't vary with filters, so filter
    changes don't force a rescan of the full table just to redraw an
    unrelated number. Returns None (not 0) on failure so the caller can tell
    "unknown" apart from "the table is genuinely empty"."""
    cache_key = _cache_key("total-size-bytes", {})
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached
    try:
        sql = (
            f'{BASE_CTE} '
            f'SELECT SUM(CASE WHEN "PATH_RN" = 1 THEN "FILE_SIZE" ELSE 0 END) FROM ('
            f'  SELECT "FILE_SIZE", ROW_NUMBER() OVER (PARTITION BY "FILE_PATH_KEY" ORDER BY "FILE_PATH_KEY") AS "PATH_RN" '
            f'  FROM (SELECT "FILE_SIZE", TO_VARCHAR("FILE_PATH") AS "FILE_PATH_KEY" FROM V)'
            f')'
        )
        result = _run(sql, {})
        total = int((result.rows[0][0] if result.rows and result.rows[0][0] is not None else 0))
    except Exception as e:
        logger.error(f"Unstructured total-size-bytes lookup failed: {e}")
        return None
    _cache_set(cache_key, total)
    return total


@unstructured_router.get("/summary")
def get_summary(
    filters: Optional[str] = Query(None),
    search_file_name: str = Query(""),
    search_object_name: str = Query(""),
    search_jj_title: str = Query(""),
    search_artifact_name: str = Query(""),
    search_jj_number: str = Query(""),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("viewUnstructured")),
):
    """Cheap headline numbers for the overview cards - COUNT(*) / COUNT(DISTINCT ...)
    plus SUM(FILE_SIZE) for the current filters (ingested-so-far) and, separately,
    the all-time SUM(FILE_SIZE) with no filters applied (grand total).

    ingested_size_bytes is deduped to one row per FILE_PATH (materialized via
    TO_VARCHAR in a nested SELECT first - FILE_PATH can't be referenced
    directly in a window PARTITION BY on this table, see _get_total_size_bytes
    for why) so multiple versions of the same object don't inflate the size
    sum, and only counts rows where STATUS = 'SUCCESS' - a document that's
    still RUNNING or came back ERROR hasn't actually finished ingesting, so
    its size shouldn't count toward "ingested so far" even though the row
    itself matches the current filters. total_count / distinct_file_names
    stay unrestricted (every row, every status), same as before - only the
    two size numbers are FILE_PATH-deduped."""
    cache_key = _cache_key("summary", dict(
        filters=filters or "", search_file_name=search_file_name,
        search_object_name=search_object_name, search_jj_title=search_jj_title,
        search_artifact_name=search_artifact_name,
        search_jj_number=search_jj_number,
    ))
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    parsed_filters = _parse_filters(filters)
    where_sql, params = _build_where(parsed_filters, search_file_name, search_object_name, search_jj_title, search_artifact_name, search_jj_number)
    sql = (
        f'{BASE_CTE} SELECT COUNT(*), COUNT(DISTINCT "FILE_NAME"), '
        f'SUM(CASE WHEN "FILE_RN" = 1 AND UPPER("STATUS") = \'SUCCESS\' THEN "FILE_SIZE" ELSE 0 END) '
        f'FROM ('
        f'  SELECT *, ROW_NUMBER() OVER (PARTITION BY "FILE_PATH_KEY" ORDER BY "FILE_PATH_KEY") AS "FILE_RN" '
        f'  FROM (SELECT *, TO_VARCHAR("FILE_PATH") AS "FILE_PATH_KEY" FROM V {where_sql})'
        f')'
    )

    try:
        result = _run(sql, params)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unstructured /summary failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query failed: {e}")

    total_count, distinct_file_names, ingested_size_bytes = result.rows[0] if result.rows else (0, 0, 0)
    total_size_bytes = _get_total_size_bytes(bypass_cache)

    payload = {
        "total_count": total_count,
        "distinct_file_names": distinct_file_names,
        "ingested_size_bytes": int(ingested_size_bytes or 0),
        "total_size_bytes": total_size_bytes,
        "sql": _render_sql_for_display(sql, params),
        "cached": False,
    }
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.get("/filter-options")
def get_filter_options(column: str = Query(...), bypass_cache: bool = Query(False), auth: dict = Depends(require_permission("viewUnstructured"))):
    """Distinct values for one filterable column, used to populate a checkbox dropdown."""
    column = column.upper()
    if column not in FILTERABLE_COLUMNS:
        raise HTTPException(status_code=400, detail=f"'{column}' is not a filterable column")

    cache_key = _cache_key("filter-options", {"column": column})
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    sql = f'{BASE_CTE} SELECT DISTINCT "{column}" FROM V WHERE "{column}" IS NOT NULL ORDER BY "{column}"'

    try:
        result = _run(sql)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unstructured /filter-options failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query failed: {e}")

    payload = {"column": column, "values": [r[0] for r in result.rows], "cached": False}
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.get("/chart/domain-status")
def get_domain_status_chart(
    filters: Optional[str] = Query(None),
    search_file_name: str = Query(""),
    search_object_name: str = Query(""),
    search_jj_title: str = Query(""),
    search_artifact_name: str = Query(""),
    search_jj_number: str = Query(""),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("viewUnstructured")),
):
    cache_key = _cache_key("chart-domain-status", dict(
        filters=filters or "", search_file_name=search_file_name,
        search_object_name=search_object_name, search_jj_title=search_jj_title,
        search_artifact_name=search_artifact_name,
        search_jj_number=search_jj_number,
    ))
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    parsed_filters = _parse_filters(filters)
    where_sql, params = _build_where(parsed_filters, search_file_name, search_object_name, search_jj_title, search_artifact_name, search_jj_number)
    sql = f'{BASE_CTE} SELECT "DOMAIN", "A_STATUS", COUNT(*) FROM V {where_sql} GROUP BY "DOMAIN", "A_STATUS" ORDER BY "DOMAIN"'

    try:
        result = _run(sql, params)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unstructured /chart/domain-status failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query failed: {e}")

    payload = {"rows": [[r[0], r[1], r[2]] for r in result.rows], "sql": _render_sql_for_display(sql, params), "cached": False}
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.get("/chart/ingestion-status")
def get_ingestion_status_chart(
    filters: Optional[str] = Query(None),
    search_file_name: str = Query(""),
    search_object_name: str = Query(""),
    search_jj_title: str = Query(""),
    search_artifact_name: str = Query(""),
    search_jj_number: str = Query(""),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("viewUnstructured")),
):
    """Distinct-file count per STATUS value (the raw ingestion-status column -
    distinct from A_STATUS). Feeds the 'Ingestion Status' KPI donut, which
    sits inside the Distinct Files card - so this counts DISTINCT FILE_NAME,
    not COUNT(*), to match what that card actually means."""
    cache_key = _cache_key("chart-ingestion-status", dict(
        filters=filters or "", search_file_name=search_file_name,
        search_object_name=search_object_name, search_jj_title=search_jj_title,
        search_artifact_name=search_artifact_name,
        search_jj_number=search_jj_number,
    ))
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    parsed_filters = _parse_filters(filters)
    where_sql, params = _build_where(parsed_filters, search_file_name, search_object_name, search_jj_title, search_artifact_name, search_jj_number)
    sql = (
        f'{BASE_CTE} SELECT "STATUS", COUNT(DISTINCT "FILE_NAME") FROM V {where_sql} '
        f'GROUP BY "STATUS" ORDER BY COUNT(DISTINCT "FILE_NAME") DESC'
    )

    try:
        result = _run(sql, params)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unstructured /chart/ingestion-status failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query failed: {e}")

    payload = {"rows": [[r[0], r[1]] for r in result.rows], "sql": _render_sql_for_display(sql, params), "cached": False}
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.get("/chart/domain-distinct-objects")
def get_domain_distinct_objects_chart(
    filters: Optional[str] = Query(None),
    search_file_name: str = Query(""),
    search_object_name: str = Query(""),
    search_jj_title: str = Query(""),
    search_artifact_name: str = Query(""),
    search_jj_number: str = Query(""),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("viewUnstructured")),
):
    """Count of distinct OBJ_ID per domain - a row can repeat OBJ_ID
    across versions, so this is a different number than COUNT(*) by domain."""
    cache_key = _cache_key("chart-domain-distinct-objects", dict(
        filters=filters or "", search_file_name=search_file_name,
        search_object_name=search_object_name, search_jj_title=search_jj_title,
        search_artifact_name=search_artifact_name,
        search_jj_number=search_jj_number,
    ))
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    parsed_filters = _parse_filters(filters)
    where_sql, params = _build_where(parsed_filters, search_file_name, search_object_name, search_jj_title, search_artifact_name, search_jj_number)
    sql = (
        f'{BASE_CTE} SELECT "DOMAIN", COUNT(DISTINCT "OBJ_ID") AS CNT FROM V {where_sql} '
        f'GROUP BY "DOMAIN" ORDER BY CNT DESC'
    )

    try:
        result = _run(sql, params)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unstructured /chart/domain-distinct-objects failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query failed: {e}")

    payload = {"rows": [[r[0], r[1]] for r in result.rows], "sql": _render_sql_for_display(sql, params), "cached": False}
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.get("/chart/documents-over-time")
def get_documents_over_time_chart(
    filters: Optional[str] = Query(None),
    search_file_name: str = Query(""),
    search_object_name: str = Query(""),
    search_jj_title: str = Query(""),
    search_artifact_name: str = Query(""),
    search_jj_number: str = Query(""),
    granularity: str = Query("hour"),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("viewUnstructured")),
):
    """Distinct-file count bucketed by INGESTED_AT, for the 'documents ingested over
    time' trend line. granularity is 'hour' (default), 'day', 'week', or 'month'."""
    granularity = granularity.lower()
    if granularity not in ("hour", "day", "week", "month"):
        granularity = "hour"

    cache_key = _cache_key("chart-documents-over-time", dict(
        filters=filters or "", search_file_name=search_file_name,
        search_object_name=search_object_name, search_jj_title=search_jj_title,
        search_artifact_name=search_artifact_name,
        search_jj_number=search_jj_number, granularity=granularity,
    ))
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    parsed_filters = _parse_filters(filters)
    where_sql, params = _build_where(parsed_filters, search_file_name, search_object_name, search_jj_title, search_artifact_name, search_jj_number)
    not_null_clause = "AND" if where_sql else "WHERE"
    sql = (
        f'{BASE_CTE} SELECT DATE_TRUNC(\'{granularity}\', "INGESTED_AT") AS PERIOD, '
        f'COUNT(DISTINCT "FILE_NAME") FROM V {where_sql} {not_null_clause} "INGESTED_AT" IS NOT NULL '
        f'GROUP BY PERIOD ORDER BY PERIOD'
    )

    try:
        result = _run(sql, params)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unstructured /chart/documents-over-time failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query failed: {e}")

    payload = {
        "rows": [[r[0].isoformat() if hasattr(r[0], "isoformat") else r[0], r[1]] for r in result.rows],
        "sql": _render_sql_for_display(sql, params),
        "cached": False,
    }
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.get("/chart/therapeutic-area")
def get_therapeutic_area_chart(
    filters: Optional[str] = Query(None),
    search_file_name: str = Query(""),
    search_object_name: str = Query(""),
    search_jj_title: str = Query(""),
    search_artifact_name: str = Query(""),
    search_jj_number: str = Query(""),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("viewUnstructured")),
):
    cache_key = _cache_key("chart-therapeutic-area", dict(
        filters=filters or "", search_file_name=search_file_name,
        search_object_name=search_object_name, search_jj_title=search_jj_title,
        search_artifact_name=search_artifact_name,
        search_jj_number=search_jj_number,
    ))
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    parsed_filters = _parse_filters(filters)
    where_sql, params = _build_where(parsed_filters, search_file_name, search_object_name, search_jj_title, search_artifact_name, search_jj_number)
    sql = (
        f'{BASE_CTE} SELECT "INSIGHT_THERAPEUTIC_AREA", COUNT(*) AS CNT FROM V {where_sql} '
        f'GROUP BY "INSIGHT_THERAPEUTIC_AREA" ORDER BY CNT DESC LIMIT 15'
    )

    try:
        result = _run(sql, params)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unstructured /chart/therapeutic-area failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query failed: {e}")

    payload = {"rows": [[r[0], r[1]] for r in result.rows], "sql": _render_sql_for_display(sql, params), "cached": False}
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.get("/chart/therapeutic-area-domain")
def get_therapeutic_area_domain_chart(
    filters: Optional[str] = Query(None),
    search_file_name: str = Query(""),
    search_object_name: str = Query(""),
    search_jj_title: str = Query(""),
    search_artifact_name: str = Query(""),
    search_jj_number: str = Query(""),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("viewUnstructured")),
):
    """Record volume per therapeutic area split by domain - the stacked
    companion to /chart/therapeutic-area (same totals, one more dimension).
    The frontend ranks areas by total and keeps the top 15 client-side."""
    cache_key = _cache_key("chart-therapeutic-area-domain", dict(
        filters=filters or "", search_file_name=search_file_name,
        search_object_name=search_object_name, search_jj_title=search_jj_title,
        search_artifact_name=search_artifact_name,
        search_jj_number=search_jj_number,
    ))
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    parsed_filters = _parse_filters(filters)
    where_sql, params = _build_where(parsed_filters, search_file_name, search_object_name, search_jj_title, search_artifact_name, search_jj_number)
    sql = (
        f'{BASE_CTE} SELECT "INSIGHT_THERAPEUTIC_AREA", "DOMAIN", COUNT(*) AS CNT FROM V {where_sql} '
        f'GROUP BY "INSIGHT_THERAPEUTIC_AREA", "DOMAIN" ORDER BY "INSIGHT_THERAPEUTIC_AREA"'
    )

    try:
        result = _run(sql, params)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unstructured /chart/therapeutic-area-domain failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query failed: {e}")

    payload = {"rows": [[r[0], r[1], r[2]] for r in result.rows], "sql": _render_sql_for_display(sql, params), "cached": False}
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.get("/chart/breakdown")
def get_breakdown_chart(
    filters: Optional[str] = Query(None),
    search_file_name: str = Query(""),
    search_object_name: str = Query(""),
    search_jj_title: str = Query(""),
    search_artifact_name: str = Query(""),
    search_jj_number: str = Query(""),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(require_permission("viewUnstructured")),
):
    """DOMAIN -> INSIGHT_THERAPEUTIC_AREA -> ARTIFACT_NAME drill-down, counted
    by distinct OBJ_ID. Follows the same filters/search as the rest of the
    page, same as every other chart endpoint."""
    cache_key = _cache_key("chart-breakdown", dict(
        filters=filters or "", search_file_name=search_file_name,
        search_object_name=search_object_name, search_jj_title=search_jj_title,
        search_artifact_name=search_artifact_name,
        search_jj_number=search_jj_number,
    ))
    if not bypass_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

    parsed_filters = _parse_filters(filters)
    where_sql, params = _build_where(parsed_filters, search_file_name, search_object_name, search_jj_title, search_artifact_name, search_jj_number)
    sql = (
        f'{BASE_CTE} SELECT "DOMAIN", "INSIGHT_THERAPEUTIC_AREA", "ARTIFACT_NAME", '
        f'COUNT(DISTINCT "OBJ_ID") AS CNT FROM V {where_sql} '
        f'GROUP BY "DOMAIN", "INSIGHT_THERAPEUTIC_AREA", "ARTIFACT_NAME" ORDER BY 1, 2, 3'
    )

    try:
        result = _run(sql, params)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unstructured /chart/breakdown failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query failed: {e}")

    payload = {"rows": [[r[0], r[1], r[2], r[3]] for r in result.rows], "sql": _render_sql_for_display(sql, params), "cached": False}
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.post("/query-runner")
def start_query_runner_job(body: QueryRunnerRequest, auth: dict = Depends(require_permission("runUnstructuredQueryRunner"))):
    """Kicks off a free-form, read-only SELECT against anything the
    configured role can see - not limited to this page's table. Runs async
    (execute_async) and returns immediately with a job_id; the query keeps
    running in Snowflake regardless of how long it takes, so a 3-5M row scan
    never sits on this HTTP request. Gated behind runUnstructuredQueryRunner on
    the frontend - this endpoint re-validates too, since that gate isn't a
    security boundary."""
    _cleanup_query_runner_jobs()
    user_sql = _validate_query_runner_sql(body.sql)

    client = _query_runner_conn_manager.get_client()
    _query_runner_conn_manager.job_started()
    try:
        cur = client.conn.cursor()
        cur.execute_async(user_sql)
        sfqid = cur.sfqid
        cur.close()
    except Exception as e:
        _query_runner_conn_manager.job_finished()
        logger.error(f"Unstructured query-runner failed to start: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to start query: {e}")

    job_id = str(uuid.uuid4())
    with _query_runner_jobs_lock:
        _query_runner_jobs[job_id] = {
            "sfqid": sfqid,
            "sql": user_sql,
            "status": "running",
            "columns": None,
            "row_count": None,
            "error": None,
            "created_at": time.time(),
            "started_at": time.time(),
            "finished_at": None,
        }
    return {"job_id": job_id, "query_id": sfqid, "status": "running"}


def _finalize_job_if_done(job_id: str, job: Dict[str, Any]) -> Dict[str, Any]:
    """Checks an in-flight job's status with Snowflake; on first observed
    completion, resolves column names + total row count once (both cheap -
    LIMIT 0 and COUNT(*) over the already-computed RESULT_SCAN, no data
    transfer) and caches them on the job so later calls are instant."""
    from snowflake.connector.errors import ProgrammingError

    client = _query_runner_conn_manager.get_client()
    conn = client.conn
    sfqid = job["sfqid"]

    try:
        status = conn.get_query_status(sfqid)
        still_running = conn.is_still_running(status)
    except Exception as e:
        job["status"] = "failed"
        job["error"] = f"Lost track of query status: {e}"
        job["finished_at"] = time.time()
        _query_runner_conn_manager.job_finished()
        return job

    if still_running:
        return job

    try:
        conn.get_query_status_throw_if_error(sfqid)
    except ProgrammingError as e:
        job["status"] = "failed"
        job["error"] = str(e)
        job["finished_at"] = time.time()
        _query_runner_conn_manager.job_finished()
        return job
    except Exception as e:
        job["status"] = "failed"
        job["error"] = str(e)
        job["finished_at"] = time.time()
        _query_runner_conn_manager.job_finished()
        return job

    # Finished with no error - resolve columns + row count once.
    try:
        cur = conn.cursor()
        try:
            cur.execute("SELECT * FROM TABLE(RESULT_SCAN(%(qid)s)) LIMIT 0", {"qid": sfqid})
            columns = [c[0] for c in cur.description]
            cur.execute("SELECT COUNT(*) FROM TABLE(RESULT_SCAN(%(qid)s))", {"qid": sfqid})
            row_count = cur.fetchone()[0]
        finally:
            cur.close()
        job["status"] = "success"
        job["columns"] = columns
        job["row_count"] = row_count
        job["finished_at"] = time.time()
    except Exception as e:
        job["status"] = "failed"
        job["error"] = f"Query finished but result could not be read: {e}"
        job["finished_at"] = time.time()
    finally:
        _query_runner_conn_manager.job_finished()

    return job


@unstructured_router.get("/query-runner/{job_id}/status")
def get_query_runner_status(job_id: str, auth: dict = Depends(require_permission("runUnstructuredQueryRunner"))):
    job = _get_job(job_id)
    if job["status"] == "running":
        job = _finalize_job_if_done(job_id, job)
    elapsed_ms = int(((job["finished_at"] or time.time()) - job["started_at"]) * 1000)
    return {
        "job_id": job_id,
        "query_id": job["sfqid"],
        "status": job["status"],
        "columns": job["columns"],
        "row_count": job["row_count"],
        "error": job["error"],
        "elapsed_ms": elapsed_ms,
    }


@unstructured_router.get("/query-runner/{job_id}/rows")
def get_query_runner_rows(
    job_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=QUERY_RUNNER_PAGE_MAX_SIZE),
    sort_col: Optional[str] = Query(None),
    sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
    auth: dict = Depends(require_permission("runUnstructuredQueryRunner")),
):
    """Pages through a finished job's result straight out of Snowflake's
    result cache (RESULT_SCAN) - cheap regardless of how big the full result
    is, since Snowflake already computed and cached it once. Optional
    sort_col/sort_dir order the cached result before paging; sort_col is
    validated against the job's own column list (identifier-quoted, so no
    injection surface)."""
    job = _get_job(job_id)
    if job["status"] != "success":
        raise HTTPException(status_code=409, detail=f"Query is not ready (status: {job['status']})")

    order_sql = ""
    if sort_col:
        matched = next((c for c in (job["columns"] or []) if c.upper() == sort_col.upper()), None)
        if matched is None:
            raise HTTPException(status_code=400, detail=f"'{sort_col}' is not a column of this result")
        quoted = '"' + matched.replace('"', '""') + '"'
        order_sql = f" ORDER BY {quoted} {'ASC' if sort_dir == 'asc' else 'DESC'} NULLS LAST"

    offset = (page - 1) * page_size
    client = _query_runner_conn_manager.get_client()
    cur = client.conn.cursor()
    try:
        cur.execute(
            f"SELECT * FROM TABLE(RESULT_SCAN(%(qid)s)){order_sql} LIMIT %(limit)s OFFSET %(offset)s",
            {"qid": job["sfqid"], "limit": page_size, "offset": offset},
        )
        rows = [[_to_json_safe(v) for v in r] for r in cur.fetchall()]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch rows: {e}")
    finally:
        cur.close()

    total_pages = max(1, -(-job["row_count"] // page_size))
    return {
        "columns": job["columns"],
        "rows": rows,
        "page": page,
        "page_size": page_size,
        "total_rows": job["row_count"],
        "total_pages": total_pages,
    }


@unstructured_router.get("/query-runner/objects")
def get_query_runner_objects(context: str = Query(""), auth: dict = Depends(require_permission("runUnstructuredQueryRunner"))):
    """Name completion for the query editor, Snowflake-style:
      context=""            -> databases the role can see
      context="DB"          -> schemas in DB
      context="DB.SCHEMA"   -> tables + views in DB.SCHEMA
    Metadata only (SHOW commands), cached 5 min like the chart endpoints."""
    ctx = context.strip().strip(".")
    parts = [p.strip().strip('"') for p in ctx.split(".") if p.strip()] if ctx else []
    if len(parts) > 2:
        raise HTTPException(status_code=400, detail="context must be empty, DB, or DB.SCHEMA")
    for p in parts:
        if not re.match(r"^[A-Za-z0-9_$#]+$", p):
            raise HTTPException(status_code=400, detail="Invalid identifier in context")

    cache_key = _cache_key("qr-objects", {"context": ".".join(parts)})
    cached = _cache_get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    if len(parts) == 0:
        show_sql = "SHOW DATABASES"
        kind_fixed = "database"
    elif len(parts) == 1:
        show_sql = f'SHOW SCHEMAS IN DATABASE "{parts[0]}"'
        kind_fixed = "schema"
    else:
        show_sql = f'SHOW TERSE OBJECTS IN SCHEMA "{parts[0]}"."{parts[1]}"'
        kind_fixed = None  # kind column distinguishes TABLE vs VIEW

    client = _query_runner_conn_manager.get_client()
    cur = client.conn.cursor()
    try:
        cur.execute(show_sql)
        cols = [c[0].lower() for c in cur.description]
        name_idx = cols.index("name")
        kind_idx = cols.index("kind") if "kind" in cols else None
        objects = []
        for r in cur.fetchall():
            kind = kind_fixed or (str(r[kind_idx]).lower() if kind_idx is not None and r[kind_idx] else "table")
            objects.append({"name": r[name_idx], "kind": kind})
    except HTTPException:
        raise
    except Exception as e:
        # A context that doesn't exist (or isn't visible to the role) is a
        # normal occurrence while typing - e.g. the placeholder MY_DB. An
        # empty suggestion list is the right answer, not a 500 (which also
        # loses CORS headers and shows up as a scary console error).
        logger.info(f"Unstructured query-runner objects lookup failed for '{ctx}': {e}")
        payload = {"objects": [], "cached": False}
        _cache_set(cache_key, payload)
        return payload
    finally:
        cur.close()

    payload = {"objects": objects[:2000], "cached": False}
    _cache_set(cache_key, payload)
    return payload


@unstructured_router.post("/query-runner/{job_id}/cancel")
def cancel_query_runner_job(job_id: str, auth: dict = Depends(require_permission("runUnstructuredQueryRunner"))):
    job = _get_job(job_id)
    if job["status"] != "running":
        return {"job_id": job_id, "status": job["status"]}

    client = _query_runner_conn_manager.get_client()
    cur = client.conn.cursor()
    try:
        cur.execute("SELECT SYSTEM$CANCEL_QUERY(%(qid)s)", {"qid": job["sfqid"]})
    except Exception as e:
        logger.info(f"Unstructured query-runner cancel failed for {job['sfqid']}: {e}")
    finally:
        cur.close()

    job["status"] = "cancelled"
    job["finished_at"] = time.time()
    _query_runner_conn_manager.job_finished()
    return {"job_id": job_id, "status": "cancelled"}


@unstructured_router.get("/query-runner/{job_id}/download")
def download_query_runner_csv(job_id: str, auth: dict = Depends(require_permission("runUnstructuredQueryRunner"))):
    """Streams the FULL result (no row cap) as CSV, fetched from Snowflake in
    QUERY_RUNNER_DOWNLOAD_CHUNK_ROWS-row batches so memory stays flat even at
    3-5M+ rows - nothing is ever fully materialized in this process."""
    job = _get_job(job_id)
    if job["status"] != "success":
        raise HTTPException(status_code=409, detail=f"Query is not ready (status: {job['status']})")

    columns = job["columns"]
    sfqid = job["sfqid"]

    def generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(columns)
        yield buf.getvalue()

        client = _query_runner_conn_manager.get_client()
        cur = client.conn.cursor()
        try:
            cur.execute("SELECT * FROM TABLE(RESULT_SCAN(%(qid)s))", {"qid": sfqid})
            while True:
                batch = cur.fetchmany(QUERY_RUNNER_DOWNLOAD_CHUNK_ROWS)
                if not batch:
                    break
                buf = io.StringIO()
                writer = csv.writer(buf)
                for row in batch:
                    writer.writerow(["" if v is None else _to_json_safe(v) for v in row])
                yield buf.getvalue()
        finally:
            cur.close()

    filename = f"query_runner_{job_id[:8]}.csv"
    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )