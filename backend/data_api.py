from __future__ import annotations

import base64
import atexit
import hashlib
import json
import logging
import os
import re
import secrets
import threading
import time
import uuid

import pytz
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple, Literal, Union

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field, StrictFloat, StrictInt, StrictStr

import db as core_db
from audit import write_audit_event
from auth import require_permission
from data_validation import (
    DEFAULT_ENVIRONMENT,
    _empty_or_none,
    _source_cfg,
    _validate_identifier,
    get_sources as _dv_get_sources,
    get_source_databases as _dv_get_source_databases,
    get_source_schemas as _dv_get_source_schemas,
    get_source_tables as _dv_get_source_tables,
)
from data_validation_connectors import ConnectorError, create_connector

from data_api_runtime import (
    BoundedPool, CapacityError, DataAPIRoute, TTLCache, HTTP_GATE, EXACT_GATE,
    METRICS, MAX_RESPONSE_BYTES, env_int, env_bool,
)
from data_api_store import MetadataStore
from data_api_retrieval import (
    MAX_CANDIDATE_POOL, EmbeddingModel, EmbeddingUnavailable, RetrievalRequest, SearchConfigError,
    SearchProfile, allowed_embedding_hosts, build_match, clean_query, credential_configured, embed_queries,
    reciprocal_rank_fusion, validate_contract, validate_model, validate_settings,
)
from data_api_store import SEARCH_TABLES

logger = logging.getLogger(__name__)

data_api_router = APIRouter(prefix="/data-api", tags=["Data API Export"], route_class=DataAPIRoute)

# Metadata lives in the portal database (smarthub_core.data_api_*).
STORE = MetadataStore()

MAX_ROW_LIMIT = 10_000
DEFAULT_ROW_LIMIT = 1_000


# Every timestamp this module writes or reports is Eastern, matching audit.py.
# It also means a day bucket is an Eastern calendar day, so a 9pm ET call lands
# on the day the caller made it rather than the next UTC one.
EASTERN = pytz.timezone("America/New_York")


def _now() -> datetime:
    return datetime.now(EASTERN)


def _day_start(day: date) -> datetime:
    """Midnight Eastern at the start of a calendar day, with that day's own
    DST offset."""
    return EASTERN.localize(datetime(day.year, day.month, day.day))

# Every consumer call is logged as one row in data_api_requests. 400 days keeps a
# full year of history for the usage chart without letting the table grow forever.
REQUEST_LOG_RETENTION_DAYS = 400


# Operators a filter can use. Deliberately a closed set: anything richer needs
# a real expression parser, and every addition is another thing to get right.
FILTER_OPS = {
    "eq": "equals", "ne": "does not equal",
    "gt": "greater than", "gte": "greater than or equal",
    "lt": "less than", "lte": "less than or equal",
    "in": "one of", "not_in": "not one of",
    "is_null": "is empty", "not_null": "is not empty",
    "contains": "contains", "starts_with": "starts with",
}
NO_VALUE_OPS = {"is_null", "not_null"}
MULTI_VALUE_OPS = {"in", "not_in"}
MAX_FILTERS = 10
MAX_FILTER_VALUES = 100


def _parse_filters(raw: List[str], meta: "TableMeta") -> List[tuple]:
    """Turns `where=column:op:value` strings into (column, op, [values]).

    Format is `column:op:value`, and the value is everything after the second
    colon — so a timestamp like `2026-08-15T10:00:00` survives intact. `in` and
    `not_in` split their value on commas. `is_null` and `not_null` take none.

    Every column is checked against what this alias exposes, so a filter can
    never reach a column the API is not meant to reveal."""
    if not raw:
        return []
    if len(raw) > MAX_FILTERS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many filters ({len(raw)}); {MAX_FILTERS} is the limit.",
        )
    exposed = set(meta.exposed)
    parsed = []
    for item in raw:
        piece = (item or "").strip()
        if not piece:
            continue
        bits = piece.split(":", 2)
        if len(bits) < 2:
            raise HTTPException(
                status_code=400,
                detail=f"Filter {piece!r} is malformed. Use column:op:value, "
                       f"for example status:eq:approved.",
            )
        column, op = bits[0].strip(), bits[1].strip().lower()
        rest = bits[2] if len(bits) > 2 else ""

        if column not in exposed:
            raise HTTPException(
                status_code=400,
                detail=f"This API doesn't expose a column '{column}'. "
                       f"Available: {', '.join(meta.exposed)}.",
            )
        if op not in FILTER_OPS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown filter operator '{op}'. Available: {', '.join(sorted(FILTER_OPS))}.",
            )
        if op in NO_VALUE_OPS:
            values = []
        elif op in MULTI_VALUE_OPS:
            values = [v.strip() for v in rest.split(",") if v.strip()]
            if not values:
                raise HTTPException(
                    status_code=400,
                    detail=f"Filter '{column}:{op}' needs at least one value, comma separated.",
                )
            if len(values) > MAX_FILTER_VALUES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Filter '{column}:{op}' has {len(values)} values; "
                           f"{MAX_FILTER_VALUES} is the limit.",
                )
        else:
            if rest == "":
                raise HTTPException(
                    status_code=400,
                    detail=f"Filter '{column}:{op}' needs a value. Use {column}:is_null "
                           f"to match empty values instead.",
                )
            values = [rest]
        parsed.append((column, op, values))
    return parsed


def _check_mode(conn, mode: str) -> None:
    """Not every source can do every match mode. Better a 400 naming the
    limitation than a driver error the caller can't interpret."""
    if mode == "words" and not getattr(conn, "SUPPORTS_WORD_SEARCH", False):
        raise HTTPException(status_code=400, detail="This table's source doesn't support mode=words.")
    if mode == "exact" and not getattr(conn, "SUPPORTS_EXACT_SEARCH", True):
        raise HTTPException(status_code=400, detail="This table's source doesn't support mode=exact.")


def _resolve_search_columns(column: str, exposed: List[str], searchable: List[str]) -> List[str]:
    """Which column(s) a search actually scans: just `column` if given (after
    checking the API exposes it — 400 otherwise), or every searchable exposed
    column if not.

    Unsearchable columns — vectors, blobs, arrays — are left out of the
    unfiltered case on purpose. Casting a 1,536-float embedding to text on
    every row to substring-match it costs a fortune and never matches anything
    a human typed. Shared by exec_get_count and exec_get_rows so the validation
    only lives in one place."""
    if not column:
        return searchable or exposed
    if column not in exposed:
        raise HTTPException(status_code=400, detail=f"This API doesn't expose a column '{column}'.")
    return [column]


# ============================================================================
# DATABASE SETUP
# ============================================================================

def _get_connection(autocommit: bool = False):
    return STORE.connect(autocommit=autocommit)


@contextmanager
def _db(autocommit: bool = False):
    conn = _get_connection(autocommit)
    try:
        yield conn
        conn.commit()
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            METRICS.add("metadata_rollback_failures")
        code = str(getattr(exc, "pgcode", "") or "")
        transient = (code.startswith(("08", "53")) or code in {"57014", "57P01", "57P02", "57P03", "55P03"}
                     or isinstance(exc, core_db.DatabaseUnavailable))
        if transient:
            METRICS.add("metadata_operation_failures")
            raise HTTPException(503, "Metadata database is busy or unavailable. Retry with backoff.",
                                headers={"Retry-After": "1"}) from None
        raise
    finally:
        conn.close()


# The metadata pool's statement timeout is tuned for consumer calls (a quick
# 503 beats a hung client). The admin screens' usage and activity reads
# aggregate over the request log and get more room.
ADMIN_READ_TIMEOUT_MS = env_int("DATA_API_ADMIN_READ_TIMEOUT_MS", 30000, maximum=600000)


def _admin_read(conn) -> None:
    """Call first thing in an admin read transaction: repeatable-read snapshot,
    read only, with the longer admin timeout (for this transaction only)."""
    conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
    conn.execute("SELECT set_config('statement_timeout', ?, true)", (str(ADMIN_READ_TIMEOUT_MS),))


def _new_api_key() -> str:
    return f"smarthub_{secrets.token_urlsafe(32)}"


# ============================================================================
# SLUGS — friendly, url-safe stand-ins for the raw uuid api_id. Generated once
# at creation from the name and stored; renaming the API does not reslug it,
# so URLs already shared keep working.
# ============================================================================

# Literal first path segments on this router. A slug matching one of these
# would be shadowed by the route registered before it, so an API named "List"
# would get the slug "list" and then /data-api/list would return the admin
# listing instead of that API. Suffixed instead, so the name is still honoured.
RESERVED_SLUGS = {
    "list", "create", "sources", "source-databases", "source-schemas",
    "source-tables", "source-columns", "docs", "openapi", "redoc", "mcp", "search",
}


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    if not slug:
        return "api"
    return f"{slug}-api" if slug in RESERVED_SLUGS else slug


def _unique_slug(conn, name: str, exclude_id: Optional[str] = None) -> str:
    base = _slugify(name)
    slug = base
    n = 2
    while True:
        row = conn.execute("SELECT id FROM data_apis WHERE slug = ?", (slug,)).fetchone()
        if not row or row["id"] == exclude_id:
            return slug
        slug = f"{base}-{n}"
        n += 1


def _init_db() -> None:
    # The tables come from the core migrations (migrations/smarthub_core);
    # this only proves they are there before the first consumer call. An
    # unreachable database is logged, not fatal: calls answer 503 until it's
    # back.
    try:
        STORE.verify()
    except Exception as e:
        logger.error("Data API metadata check failed at startup: %s", getattr(e, "detail", e))


_init_db()


_last_purge = 0.0
_purge_lock = threading.Lock()
PURGE_MIN_INTERVAL = 3600.0


def _purge_old_requests(force: bool = False) -> None:
    """Delete at most 5000 expired request rows per invocation; run scheduled maintenance for large backlogs.

    Throttled to once an hour: the usage endpoint used to run this DELETE on
    every call, taking a write lock on a read path to delete nothing at all
    (rows only age out of a 400-day window once a day). Every open Overview tab
    polling usage was a writer queueing behind the consumer traffic."""
    global _last_purge
    now = time.monotonic()
    with _purge_lock:
        if not force and _last_purge and now - _last_purge < PURGE_MIN_INTERVAL:
            return
        _last_purge = now
    cutoff = _now() - timedelta(days=REQUEST_LOG_RETENTION_DAYS)
    try:
        with _db() as conn:
            conn.execute("DELETE FROM data_api_requests WHERE id IN "
                         "(SELECT id FROM data_api_requests WHERE ts < ? ORDER BY ts LIMIT 5000)", (cutoff,))
    except Exception as e:
        logger.warning("request-log purge failed: %s", e)


# Retention is also callable from scripts/data_api_maintenance.py; no startup mass DELETE.


# ============================================================================
# RESPONSE SERIALIZATION
#
# Returning a dict from a FastAPI route sends it through jsonable_encoder,
# which walks every value with pydantic's type dispatch. On a thousand-row
# page that is tens of thousands of dispatches and a meaningful slice of the
# response time. Handing back a Response we encoded ourselves skips all of it.
# ============================================================================

try:
    import orjson

    def _encode(payload: Any) -> bytes:
        return orjson.dumps(payload, default=_json_fallback, option=orjson.OPT_NAIVE_UTC)
except ImportError:  # orjson is a nice-to-have, not a hard dependency
    orjson = None

    def _encode(payload: Any) -> bytes:
        return json.dumps(payload, default=_json_fallback).encode()


def _json_fallback(value: Any):
    """Whatever the driver handed back that JSON has no opinion about —
    timestamps, numerics, UUIDs, bytes, pgvector values."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).decode("utf-8", "replace")
    return str(value)


def _json(payload: Any) -> Response:
    return Response(content=_encode(payload), media_type="application/json")


# ============================================================================
# CONNECTOR POOL
#
# Every consumer call used to open a fresh connection to the source, which on
# Postgres means a TCP connect, a TLS handshake and a backend fork before any
# data moves — tens to hundreds of milliseconds burned before the query starts.
# Connectors are not thread-safe, so this is a checkout pool rather than a
# shared object: one caller holds a connector for the length of its request and
# puts it back afterwards.
# ============================================================================

SOURCE_POOL = BoundedPool(
    max_total=env_int("DATA_API_SOURCE_POOL_MAX", 16, maximum=512),
    max_per_key=env_int("DATA_API_SOURCE_POOL_PER_DATABASE", 4, maximum=512),
    max_idle_per_key=env_int("DATA_API_SOURCE_POOL_IDLE", 2, minimum=0, maximum=512),
    wait_seconds=env_int("DATA_API_POOL_WAIT_MS", 100, minimum=0, maximum=10000) / 1000,
)
atexit.register(SOURCE_POOL.close)
STATEMENT_TIMEOUT_MS = env_int("DATA_API_SOURCE_TIMEOUT_MS", 15000, maximum=300000)
WORK_MEM = os.environ.get("DATA_API_WORK_MEM", "16MB")
if not re.fullmatch(r"[1-9][0-9]{0,5}(kB|MB|GB)", WORK_MEM):
    raise RuntimeError("DATA_API_WORK_MEM must be a positive amount with kB, MB or GB")


@contextmanager
def _connector(source_system: str, env: str, database: Optional[str] = None):
    cfg = _source_cfg(source_system, env)
    # Credential changes create a fresh pool identity; the global cap still
    # includes the old idle sockets, which are reclaimed as needed.
    fingerprint = hashlib.sha256(json.dumps(cfg, sort_keys=True, default=str).encode()).hexdigest()
    key = (source_system, env, database, fingerprint)

    def factory():
        source = create_connector(source_system, cfg)
        try:
            source._api_read_only = True
            if database and hasattr(source, "_ensure_conn"):
                source._ensure_conn(database)
            else:
                source.connect()
            source.apply_session_limits(statement_timeout_ms=STATEMENT_TIMEOUT_MS, work_mem=WORK_MEM)
            return source
        except BaseException:
            try:
                source.disconnect()
            except Exception:
                pass
            raise
    try:
        with SOURCE_POOL.connection(key, factory) as source:
            yield source
    except CapacityError:
        raise HTTPException(503, "Source capacity is busy; retry with backoff.", headers={"Retry-After": "1"}) from None


# ============================================================================
# TABLE METADATA CACHE
#
# Columns, the sort key and the row count do not change between two calls a
# second apart, but the old code re-read the column list from the source on
# every single request before it could even build the query. Cached per
# configured table, keyed by the row id so editing a table's config evicts it.
# ============================================================================

META_TTL = float(env_int("DATA_API_METADATA_TTL", 60, minimum=0, maximum=3600))
# A cached exact count is not a current count. Default to fresh explicit counts.
COUNT_TTL = float(env_int("DATA_API_COUNT_TTL", 0, minimum=0, maximum=3600))
_CACHE = TTLCache(env_int("DATA_API_METADATA_CACHE_ENTRIES", 2048, maximum=100000))
_META_STRIPES = [threading.Lock() for _ in range(64)]


def _meta_get(table_id: str, field: str, ttl: float):
    return _CACHE.get((table_id, field), ttl)


def _meta_put(table_id: str, field: str, value) -> None:
    _CACHE.put((table_id, field), value)


def _meta_evict(table_ids: Optional[List[str]] = None) -> None:
    _CACHE.evict(table_ids)


def _meta_field(t, field):
    current = [t[k] for k in ("source_system", "env", "database_name", "schema_name", "table_name", "columns_csv")]
    return field + ":" + hashlib.sha256(json.dumps(current, default=str).encode()).hexdigest()


# Bulk columns are excluded from ordinary text search and from the NEW vector
# endpoint's default projection. Existing /rows still returns every exposed
# column unless the consumer explicitly narrows its projection.
BULK_COLUMN_TYPES = {
    "vector", "halfvec", "sparsevec", "bytea", "blob", "clob", "nclob",
    "image", "varbinary", "binary", "geometry", "geography", "tsvector",
}

# Only these get searched when no `column` is given. Casting a vector or a blob
# to text just to substring-match it is pure waste.
SEARCHABLE_TYPE_HINTS = (
    "char", "text", "string", "uuid", "int", "numeric", "decimal", "float",
    "double", "real", "bool", "date", "time", "serial", "money", "json",
)


def _base_type(sql_type: str) -> str:
    """'character varying(255)' -> 'character varying', 'public.vector' -> 'vector'."""
    t = (sql_type or "").strip().lower()
    t = t.split("(")[0].strip()
    return t.split(".")[-1].strip().rstrip("[]").strip()


def _col_type(col: dict) -> str:
    """The most specific type name available for a column.

    Postgres reports an extension type as USER-DEFINED and any array as ARRAY
    in information_schema.data_type, which says nothing about what is in the
    column — an embedding and an enum look identical. The connector also hands
    back udt_name ("vector", "_text") where it can, so prefer that and keep
    data_type as the fallback for sources that don't."""
    udt = (col.get("udt") or "").strip()
    declared = (col.get("type") or "").strip()
    if udt and declared.upper() in {"USER-DEFINED", "ARRAY", ""}:
        return udt
    return declared or udt


def _is_bulk(sql_type: str) -> bool:
    base = _base_type(sql_type)
    # A leading underscore is how Postgres names an array type: _text is text[].
    return base in BULK_COLUMN_TYPES or base.startswith("_") or base == "array"


def _is_searchable(sql_type: str) -> bool:
    base = _base_type(sql_type)
    if _is_bulk(base):
        return False
    return any(hint in base for hint in SEARCHABLE_TYPE_HINTS)


# ============================================================================
# KEYSET CURSORS
#
# OFFSET makes the database read and discard every row before the page, so page
# 10,000 of a 15M row table costs 10,000 pages of work. A cursor carries the
# sort-key values of the last row instead, and the next page starts from there
# in one index seek. Opaque on purpose — it is an implementation detail, not
# something a caller should be hand-editing.
# ============================================================================

def _encode_cursor(values: list) -> str:
    raw = _encode([_json_fallback(v) if not isinstance(v, (str, int, float, bool, type(None))) else v
                   for v in values])
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> list:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        values = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        if not isinstance(values, list):
            raise ValueError
        return values
    except Exception:
        raise HTTPException(status_code=400, detail="That cursor isn't valid — drop it to start from the first page.")


# ============================================================================
# HELPERS
# ============================================================================

def _table_row(r) -> dict:
    keys = r.keys()
    csv = r["columns_csv"] if "columns_csv" in keys else None
    return {
        "id": r["id"],
        "source_system": r["source_system"],
        "env": r["env"],
        "database": r["database_name"],
        "schema": r["schema_name"],
        "table": r["table_name"],
        "alias": r["alias"],
        "row_limit": r["row_limit"],
        "columns": [c for c in (csv or "").split(",") if c],
    }


# What makes two table entries "the same table": where it points and what the
# alias is. row_limit and the column list are settings on that entry, so
# changing either updates the row in place rather than replacing it.
def _norm(v) -> str:
    return (v or "").strip()


# source_system and env are internal keys ("postgres", "DEV"), so they compare
# case-insensitively. database / schema / table are not: plenty of engines treat
# "Orders" and "orders" as different tables, and folding them here would make an
# edit that only changed a table's case look like no change at all.
def _table_identity(r) -> tuple:
    return (
        _norm(r["source_system"]).lower(), _norm(r["env"]).lower(), _norm(r["database_name"]),
        _norm(r["schema_name"]), _norm(r["table_name"]), _norm(r["alias"]).lower(),
    )


def _spec_identity(t: "TableSpec") -> tuple:
    return (
        _norm(t.source_system).lower(), _norm(t.env).lower(), _norm(t.database),
        _norm(t.db_schema), _norm(t.table), _norm(t.alias).lower(),
    )


def _api_row(r, tables: Optional[List[dict]] = None,
             with_key: bool = True) -> dict:
    """One API as JSON. `with_key=False` leaves the key out entirely, for the
    list endpoint: a key is a live credential and the browser has no use for
    fifty of them to draw a sidebar."""
    out = {
        "id": r["id"],
        "slug": r["slug"],
        "name": r["name"],
        "description": r["description"],
        "created_by": r["created_by"],
        "created_at": r["created_at"],
        "is_active": bool(r["is_active"]),
        "last_used_at": r["last_used_at"],
    }
    if with_key:
        out["api_key"] = r["api_key"]
    if tables is not None:
        out["tables"] = tables
    return out


def _get_api(conn, api_id: str):
    """Look up an API by its uuid id OR its friendly slug — either works as
    the {api_id} path segment, so old raw-uuid links never break."""
    row = conn.execute("SELECT * FROM data_apis WHERE id = ? OR slug = ?", (api_id, api_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="No API found with that ID.")
    return row


def _get_tables(conn, api_id: str) -> List[core_db.Row]:
    return conn.execute(
        "SELECT * FROM data_api_tables WHERE api_id = ? ORDER BY alias", (api_id,)
    ).fetchall()


# ============================================================================
# REQUEST LOGGING — consumer calls are the only source of usage data, so every
# one of them, including rejected ones, gets a row here.
# ============================================================================

_TIMEOUT_DETAIL = (
    "That query ran past the time limit and was stopped. An unfiltered search "
    "has to scan the whole table; narrow it with `column=` so an index can be "
    "used, ask for fewer `columns=`, or use a more specific search term."
)


def _is_timeout(e: Exception) -> bool:
    """psycopg2 raises QueryCanceledError for statement_timeout, but the pool
    can hand back a driver-specific error too, so match on the message rather
    than importing every driver's exception class."""
    name = type(e).__name__.lower()
    text = str(e).lower()
    return (
        "querycanceled" in name
        or "timeout" in name
        or "statement timeout" in text
        or "canceling statement due to" in text
    )


# What each engine says when a filter/search value doesn't fit the column's
# type — "abc" against a number, "tomorrow" against a date. That's the caller's
# input, not a broken source, so it's a 400 and the connection stays pooled.
_BAD_VALUE_HINTS = (
    "invalid input syntax",          # postgres
    "invalid input value",           # postgres enums
    "date/time field value out of range",
    "ora-01722", "ora-01858", "ora-01861", "ora-01843", "ora-01840",  # oracle number/date
    "conversion failed",             # sql server
    "error converting data type",    # sql server
    "is not recognized",             # snowflake: numeric/date value '...' is not recognized
    "cannot be cast",                # databricks / spark ansi
    "cast_invalid_input",            # databricks
)


def _is_bad_value(e: Exception) -> bool:
    code = str(getattr(e, "pgcode", "") or "")
    if code.startswith("22"):  # SQLSTATE class 22: data exception
        return True
    text = str(e).lower()
    return any(h in text for h in _BAD_VALUE_HINTS)


def _bad_value_detail(e: Exception) -> str:
    first = str(e).strip().splitlines()[0] if str(e).strip() else "value doesn't match the column type"
    return f"A search or filter value doesn't fit its column's type: {first}"


def _client_ip(request: Optional[Request]) -> str:
    if request is None:
        return ""
    forwarded = request.headers.get("x-forwarded-for") or ""
    if forwarded:
        return forwarded.split(",")[0].strip()
    return getattr(getattr(request, "client", None), "host", "") or ""


def _log_request(api_id: str, endpoint: str, alias: Optional[str] = None,
                 request: Optional[Request] = None, status: int = 200,
                 row_count: Optional[int] = None, duration_ms: Optional[int] = None,
                 mark_used: bool = True) -> None:
    """Bounded synchronous telemetry. Failures are counted, never silently hidden.

    This is activity telemetry, not an exactly-once audit ledger. A logging
    outage does not turn a successful source query into a data-query failure.
    """
    conn = None
    try:
        now = _now()
        conn = STORE.connect(purpose="log", autocommit=True)
        # One statement, one round trip: the log row, plus last_used_at at most
        # once every 5 seconds per API however busy it is. A concurrently
        # deleted API must not produce an orphan or FK error.
        conn.execute(
            "WITH logged AS ("
            "  INSERT INTO data_api_requests (api_id, alias, endpoint, ts, ip, user_agent, status, row_count, duration_ms) "
            "  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM data_apis WHERE id = ?) RETURNING 1"
            ") "
            "UPDATE data_apis SET last_used_at = ? WHERE id = ? AND ? "
            "AND (last_used_at IS NULL OR last_used_at < ?)",
            (api_id, alias, endpoint, now, _rate_caller(request),
             ((request.headers.get("user-agent") if request else "") or "")[:300],
             int(status), row_count, duration_ms, api_id,
             now, api_id, bool(mark_used and 200 <= int(status) < 300), now - timedelta(seconds=5)),
        )
        conn.commit()
        METRICS.add("request_logs_committed")
    except Exception as exc:
        METRICS.add("request_log_failures")
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        logger.warning("data-api request logging failed (%s)", type(exc).__name__)
    finally:
        if conn is not None:
            conn.close()


def _iso_ts(ts: str) -> str:
    """Rows written by this module carry an Eastern offset already. Rows written
    before that change are naive UTC, so tag those with Z rather than letting a
    reader guess."""
    if not ts:
        return ts
    return ts if (ts.endswith("Z") or "+" in ts[10:] or "-" in ts[10:]) else ts + "Z"


def _sort_key(ts: str) -> datetime:
    """Offset-aware and legacy naive rows both have to land on one timeline
    before the merged feed can be sorted."""
    try:
        dt = datetime.fromisoformat((ts or "").replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return datetime.min.replace(tzinfo=timezone.utc)


def _read_audit_events(api_id: str, name: str, limit: int = 40) -> List[dict]:
    """Management events for one API, read straight out of the audit log.

    Matches on the api_id stamped into the details column, which this module
    has written since the stamp existed. The fallback onto the API's current
    name only applies to rows with no stamp at all — API names are not unique,
    so matching on name alone would show one API another API's history."""
    try:
        with core_db.transaction(read_only=True) as conn:
            rows = conn.execute(
                "SELECT timestamp, action, performed_by, target, details, ip_address FROM audit_log "
                "WHERE action LIKE 'data\\_api%' ESCAPE '\\' AND ("
                "  details LIKE ?"
                "  OR (target = ? AND details NOT LIKE '%api_id=%')"
                ") ORDER BY timestamp DESC LIMIT ?",
                (f"%api_id={api_id}%", name or "", limit),
            ).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning("could not read audit events for data-api %s: %s", api_id, e)
        return []


class TableSpec(BaseModel):
    source_system: str
    env: str = DEFAULT_ENVIRONMENT
    database: Optional[str] = None
    db_schema: Optional[str] = None
    table: str
    alias: str
    row_limit: int = DEFAULT_ROW_LIMIT
    # Empty means "every column the source has, minus bulk ones like vectors
    # and blobs". Naming columns here is both a speed and a privacy control:
    # unlisted columns can't be selected or searched by any caller.
    columns: List[str] = []


class CreateAPIRequest(BaseModel):
    name: str
    description: str = ""
    tables: List[TableSpec]


class UpdateAPIRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None
    tables: Optional[List[TableSpec]] = None


def _validate_tables(tables: List[TableSpec], unchanged: Optional[set] = None) -> None:
    """Shape checks on every table; the reachability probe only on ones that are
    new or have moved.

    `unchanged` holds identities already stored with the same column list. They
    were reachable when they were added, and re-probing them means one live
    connection per table on every edit — so removing a single alias would fail
    outright because some unrelated table's source happened to be down."""
    if not tables:
        raise HTTPException(status_code=400, detail="At least one table is required.")
    skip = unchanged or set()
    seen_aliases = set()
    for t in tables:
        alias = (t.alias or "").strip()
        if not alias:
            raise HTTPException(status_code=400, detail="Every table needs an alias.")
        if not alias.replace("_", "").replace("-", "").isalnum():
            raise HTTPException(status_code=400, detail=f"Alias '{alias}' can only contain letters, numbers, _ and -.")
        if alias.lower() in seen_aliases:
            raise HTTPException(status_code=400, detail=f"Alias '{alias}' is used more than once — aliases must be unique within an API.")
        seen_aliases.add(alias.lower())
        _validate_identifier(t.database, "database")
        _validate_identifier(t.db_schema, "schema")
        _validate_identifier(t.table, "table")
        if t.row_limit < 1 or t.row_limit > MAX_ROW_LIMIT:
            raise HTTPException(status_code=400, detail=f"row_limit must be between 1 and {MAX_ROW_LIMIT}.")
        if _spec_identity(t) in skip:
            continue
        # Fail fast if the table doesn't actually exist / isn't reachable.
        try:
            with _connector(t.source_system, t.env) as conn:
                found = conn.get_columns(_empty_or_none(t.database), _empty_or_none(t.db_schema), t.table)
        except ConnectorError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not read '{t.table}': {e}")
        real = {c["name"] for c in found}
        unknown = [c for c in t.columns if c not in real]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"'{t.table}' has no column(s): {', '.join(unknown)}.",
            )


# ============================================================================
# TABLE PICKER — thin proxies onto the Data Validation source browser so this
# page doesn't need its own copy of the connector-listing logic.
# ============================================================================

@data_api_router.get("/sources")
def list_sources(auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """List source systems available to build a Data API Export from — proxies the
    Data Validation source picker so this feature doesn't duplicate that logic."""
    return _dv_get_sources(auth=auth)


@data_api_router.get("/source-databases")
def list_source_databases(
    source_system: str = Query(...),
    env: str = Query(DEFAULT_ENVIRONMENT),
    auth: dict = Depends(require_permission("manageDataAPIExports")),
):
    """List databases available on a given source system/environment, for the
    Data API Export table picker."""
    return _dv_get_source_databases(source_system=source_system, env=env, auth=auth)


@data_api_router.get("/source-schemas")
def list_source_schemas(
    source_system: str = Query(...),
    database: Optional[str] = Query(None),
    env: str = Query(DEFAULT_ENVIRONMENT),
    auth: dict = Depends(require_permission("manageDataAPIExports")),
):
    """List schemas within a source database, for the Data API Export table picker."""
    return _dv_get_source_schemas(source_system=source_system, database=database, env=env, auth=auth)


@data_api_router.get("/source-columns")
def list_source_columns(
    source_system: str = Query(...),
    table: str = Query(...),
    database: Optional[str] = Query(None),
    schema: Optional[str] = Query(None),
    env: str = Query(DEFAULT_ENVIRONMENT),
    auth: dict = Depends(require_permission("manageDataAPIExports")),
):
    """Columns on a source table, for the Data API Export table picker — so an
    admin can choose what an alias exposes before creating it. `bulk` flags the
    ones (embeddings, blobs, arrays) that are excluded by default because they
    dominate the payload; `searchable` flags the ones a search would scan."""
    _validate_identifier(database, "database")
    _validate_identifier(schema, "schema")
    _validate_identifier(table, "table")
    try:
        with _connector(source_system, env) as conn:
            columns = conn.get_columns(_empty_or_none(database), _empty_or_none(schema), table)
    except HTTPException:
        raise
    except ConnectorError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read columns for '{table}': {e}")
    return {
        "table": table,
        "columns": [
            {
                "name": c["name"],
                "type": _col_type(c),
                "bulk": _is_bulk(_col_type(c)),
                "searchable": _is_searchable(_col_type(c)),
            }
            for c in columns
        ],
    }


@data_api_router.get("/source-tables")
def list_source_tables(
    source_system: str = Query(...),
    database: Optional[str] = Query(None),
    schema: Optional[str] = Query(None),
    env: str = Query(DEFAULT_ENVIRONMENT),
    auth: dict = Depends(require_permission("manageDataAPIExports")),
):
    """List tables within a source schema, for the Data API Export table picker."""
    return _dv_get_source_tables(source_system=source_system, database=database, schema=schema, env=env, auth=auth)


# ============================================================================
# MANAGEMENT — create / list / edit / delete API definitions
# ============================================================================

@data_api_router.get("/list")
def list_apis(auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """List every Data API Export definition (name, description, active status,
    table count, exposed aliases, calls in the last 7 days) most recently created
    first. Deliberately does NOT include api_key — a key is a live credential and
    nothing on the list screen needs one; call get_api for a single API's key."""
    since_7d = _day_start((_now() - timedelta(days=6)).date())
    # One statement for the whole page (its first call, on every load): each
    # API's aliases and its 7-day call count come from correlated subqueries,
    # the count walking data_api_requests_api_ts_idx for just that API.
    with _db(autocommit=True) as conn:
        rows = conn.execute(
            """SELECT a.*,
                      (SELECT json_agg(t.alias ORDER BY t.alias) FROM data_api_tables t
                        WHERE t.api_id = a.id) AS aliases,
                      (SELECT COUNT(*) FROM data_api_requests r
                        WHERE r.api_id = a.id AND r.ts >= ?) AS requests_7d
                 FROM data_apis a
                ORDER BY a.created_at DESC""",
            (since_7d,),
        ).fetchall()
    out = []
    for r in rows:
        mine = json.loads(r["aliases"]) if r["aliases"] else []
        item = _api_row(r, with_key=False)
        item["table_count"] = len(mine)
        # Returned so the list screen's search can match on alias, which is
        # how people actually refer to these ("who owns /shipments?").
        item["aliases"] = mine
        item["requests_7d"] = r["requests_7d"] or 0
        out.append(item)
    return {"apis": out}


@data_api_router.post("/create")
def create_api(body: CreateAPIRequest, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Create a new Data API Export: a named, key-authenticated bundle of one or
    more source tables (each given an alias and a per-request row_limit). Each
    table is checked for reachability before creation. Returns the new api_key —
    shown only here and on the page; it can be regenerated later if lost/rotated."""
    _validate_tables(body.tables)
    api_id = str(uuid.uuid4())
    key = _new_api_key()
    now = _now().isoformat()
    creator = auth.get("user", {}).get("email") or auth.get("user", {}).get("name") or "unknown"

    # _unique_slug reads then writes, so two creates with the same name racing
    # each other can both pick the same slug and one loses to the UNIQUE index.
    # Cheaper to retry than to serialise every create behind a lock.
    for attempt in range(5):
        try:
            with _db() as conn:
                slug = _unique_slug(conn, body.name.strip())
                conn.execute(
                    "INSERT INTO data_apis (id, slug, name, description, api_key, created_by, created_at, is_active) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, true)",
                    (api_id, slug, body.name.strip(), body.description.strip(), key, creator, now),
                )
                for t in body.tables:
                    conn.execute(
                        "INSERT INTO data_api_tables (id, api_id, source_system, env, database_name, schema_name, "
                        "table_name, alias, row_limit, columns_csv) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (str(uuid.uuid4()), api_id, t.source_system, t.env, t.database, t.db_schema, t.table,
                         t.alias.strip(), t.row_limit, ",".join(t.columns) if t.columns else None),
                    )
                row = _get_api(conn, api_id)
                tables = [_table_row(t) for t in _get_tables(conn, api_id)]
            break
        except core_db.UniqueViolation as e:
            constraint = getattr(getattr(e, "diag", None), "constraint_name", "") or str(e)
            if "slug" not in constraint.lower() or attempt == 4:
                raise
            logger.info("slug collision creating '%s', retrying: %s", body.name.strip(), e)

    write_audit_event(
        action="data_api_created",
        performed_by=creator,
        target=body.name.strip(),
        details=f"Created API '{body.name.strip()}' with {len(body.tables)} table(s) (api_id={api_id})",
    )

    return _api_row(row, tables)


@data_api_router.get("/{api_id}")
def get_api(api_id: str, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Full detail for one Data API Export, including its tables and its live api_key."""
    with _db() as conn:
        row = _get_api(conn, api_id)
        tables = [_table_row(t) for t in _get_tables(conn, row["id"])]
    return _api_row(row, tables)


@data_api_router.get("/{api_id}/usage")
def get_api_usage(
    api_id: str,
    days: int = Query(14, ge=1, le=365),
    auth: dict = Depends(require_permission("manageDataAPIExports")),
):
    """Real call history for one Data API Export, straight from the request log:
    one bucket per day (including days with no calls), totals, a breakdown by
    endpoint and alias, and the distinct callers seen in the window. Days are
    Eastern calendar days. Everything here comes from consumer calls actually
    served — an API nobody has called reports zeroes, not estimates."""
    _purge_old_requests()
    since_date = _day_start((_now() - timedelta(days=days - 1)).date())

    with _db() as conn:
        # Seven reads that should describe the same moment.
        _admin_read(conn)
        row = _get_api(conn, api_id)
        real_id = row["id"]

        daily = conn.execute(
            "SELECT to_char(ts AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d, COUNT(*) AS calls, "
            "COALESCE(SUM(row_count), 0) AS rows_served "
            "FROM data_api_requests WHERE api_id = ? AND ts >= ? "
            "GROUP BY 1",
            (real_id, since_date),
        ).fetchall()

        totals = conn.execute(
            "SELECT COUNT(*) AS calls, COALESCE(SUM(row_count), 0) AS rows_served, "
            "SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors, "
            "MIN(ts) AS first_call, MAX(ts) AS last_call "
            "FROM data_api_requests WHERE api_id = ? AND ts >= ?",
            (real_id, since_date),
        ).fetchone()

        lifetime = conn.execute(
            "SELECT COUNT(*) AS calls, MIN(ts) AS first_call FROM data_api_requests WHERE api_id = ?",
            (real_id,),
        ).fetchone()

        by_endpoint = conn.execute(
            "SELECT endpoint, COUNT(*) AS calls FROM data_api_requests "
            "WHERE api_id = ? AND ts >= ? GROUP BY endpoint ORDER BY calls DESC, endpoint",
            (real_id, since_date),
        ).fetchall()

        by_alias = conn.execute(
            "SELECT alias, COUNT(*) AS calls, COALESCE(SUM(row_count), 0) AS rows_served "
            "FROM data_api_requests WHERE api_id = ? AND ts >= ? AND alias IS NOT NULL "
            "GROUP BY alias ORDER BY calls DESC, alias",
            (real_id, since_date),
        ).fetchall()

        # A caller is a source IP: the key is the only credential these endpoints
        # take, so the host is the closest thing to an identity. The per-agent
        # split below is kept as detail on the caller rather than as separate
        # callers, so one machine driving two clients counts once. (Collapsing in
        # SQL with MAX(user_agent) would report the lexicographically largest
        # agent string instead of the one that actually called last.)
        agent_rows = conn.execute(
            "SELECT COALESCE(NULLIF(ip, ''), 'unknown') AS ip, "
            "COALESCE(user_agent, '') AS user_agent, COUNT(*) AS calls, "
            "COALESCE(SUM(row_count), 0) AS rows_served, MAX(ts) AS last_call "
            "FROM data_api_requests WHERE api_id = ? AND ts >= ? "
            "GROUP BY COALESCE(NULLIF(ip, ''), 'unknown'), COALESCE(user_agent, '') "
            "ORDER BY calls DESC LIMIT 60",
            (real_id, since_date),
        ).fetchall()

        avg_ms = conn.execute(
            "SELECT AVG(duration_ms) AS ms FROM data_api_requests "
            "WHERE api_id = ? AND ts >= ? AND duration_ms IS NOT NULL",
            (real_id, since_date),
        ).fetchone()["ms"]

    by_ip: Dict[str, dict] = {}
    for r in agent_rows:
        entry = by_ip.setdefault(r["ip"], {
            "ip": r["ip"], "calls": 0, "rows_served": 0, "last_call": None, "agents": [],
        })
        entry["calls"] += r["calls"]
        entry["rows_served"] += r["rows_served"]
        if entry["last_call"] is None or r["last_call"] > entry["last_call"]:
            entry["last_call"] = r["last_call"]
        if r["user_agent"]:
            entry["agents"].append({
                "user_agent": r["user_agent"],
                "calls": r["calls"],
                "rows_served": r["rows_served"],
                "last_call": _iso_ts(r["last_call"]),
            })

    callers = sorted(by_ip.values(), key=lambda c: c["calls"], reverse=True)[:10]
    for c in callers:
        # Most recently used client first — that is the one worth showing when
        # there is only room for a short summary.
        c["agents"].sort(key=lambda a: a["last_call"], reverse=True)
        c["user_agent"] = c["agents"][0]["user_agent"] if c["agents"] else ""
        c["last_call"] = _iso_ts(c["last_call"])

    seen = {r["d"]: r for r in daily}
    buckets = []
    for offset_days in range(days - 1, -1, -1):
        day = (_now() - timedelta(days=offset_days)).date().isoformat()
        hit = seen.get(day)
        buckets.append({
            "date": day,
            "calls": hit["calls"] if hit else 0,
            "rows_served": hit["rows_served"] if hit else 0,
        })

    return {
        "api_id": real_id,
        "days": days,
        "buckets": buckets,
        "total_calls": totals["calls"] or 0,
        "total_rows_served": totals["rows_served"] or 0,
        "errors": totals["errors"] or 0,
        "first_call": _iso_ts(totals["first_call"]) if totals["first_call"] else None,
        "last_call": _iso_ts(totals["last_call"]) if totals["last_call"] else None,
        "lifetime_calls": lifetime["calls"] or 0,
        "logging_since": _iso_ts(lifetime["first_call"]) if lifetime["first_call"] else None,
        "avg_duration_ms": int(avg_ms) if avg_ms is not None else None,
        "by_endpoint": [dict(r) for r in by_endpoint],
        "by_alias": [dict(r) for r in by_alias],
        "callers": callers,
    }


_ACTION_PHRASES = {
    "data_api_created": "API created",
    "data_api_updated": "Configuration changed",
    "data_api_key_regenerated": "API key rotated — previous key revoked",
    "data_api_deleted": "API deleted",
}


@data_api_router.get("/{api_id}/activity")
def get_api_activity(
    api_id: str,
    limit: int = Query(40, ge=1, le=200),
    auth: dict = Depends(require_permission("manageDataAPIExports")),
):
    """One merged, newest-first feed for an API: management events from the audit
    log (created, edited, key rotated) and consumer calls from the request log,
    on a single timeline."""
    with _db() as conn:
        row = _get_api(conn, api_id)
        real_id = row["id"]
        calls = conn.execute(
            "SELECT ts, endpoint, alias, ip, status, row_count, user_agent "
            "FROM data_api_requests WHERE api_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
            (real_id, limit),
        ).fetchall()

    events = []
    for r in calls:
        target = f"/{r['alias']}" if r["alias"] else "/tables"
        if r["status"] >= 400:
            what = f"Call to {target} rejected — HTTP {r['status']}"
        elif r["row_count"] is not None and r["endpoint"] == "rows":
            what = f"{r['row_count']:,} rows served from {target}"
        else:
            what = f"{r['endpoint']} read on {target}"
        events.append({
            "ts": _iso_ts(r["ts"]),
            "kind": "request",
            "action": r["endpoint"],
            "status": r["status"],
            "what": what,
            "who": f"key holder · {r['ip'] or 'unknown IP'}",
        })

    for a in _read_audit_events(real_id, row["name"], limit=limit):
        events.append({
            "ts": a["timestamp"],
            "kind": "management",
            "action": a["action"],
            "status": 200,
            "what": _ACTION_PHRASES.get(a["action"], a["action"].replace("_", " ")),
            "who": a["performed_by"] or "unknown",
            "details": a["details"] or "",
        })

    events.sort(key=lambda e: _sort_key(e["ts"]), reverse=True)
    return {"api_id": real_id, "events": events[:limit]}


@data_api_router.patch("/{api_id}")
def update_api(api_id: str, body: UpdateAPIRequest, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Partially update a Data API Export: rename it, edit its description,
    activate/deactivate it, or replace its whole table list (a table list
    replaces every existing table for this API, it doesn't merge). Renaming
    does not change the slug already baked into shared URLs."""
    editor = auth.get("user", {}).get("email") or auth.get("user", {}).get("name") or "unknown"
    changed = []
    if body.tables is not None:
        # Identities already stored with this exact column list don't need the
        # source probing again — see _validate_tables.
        with _db() as conn:
            prior_rows = _get_tables(conn, _get_api(conn, api_id)["id"])
        unchanged = {
            _table_identity(r) for r in prior_rows
            if any(
                _spec_identity(t) == _table_identity(r)
                and (",".join(t.columns) if t.columns else None) == (r["columns_csv"] or None)
                for t in body.tables
            )
        }
        _validate_tables(body.tables, unchanged=unchanged)
    with _db() as conn:
        existing = _get_api(conn, api_id)  # 404 if missing
        real_id = existing["id"]
        # One edit per API at a time: two admins saving table lists together
        # would otherwise each diff against a list the other is replacing.
        # NO KEY UPDATE, so consumer calls being logged against this API (a
        # foreign-key check takes KEY SHARE) don't queue behind the edit.
        conn.execute("SELECT 1 FROM data_apis WHERE id = ? FOR NO KEY UPDATE", (real_id,))
        if body.name is not None:
            conn.execute("UPDATE data_apis SET name = ? WHERE id = ?", (body.name.strip(), real_id))
            changed.append("name")
        if body.description is not None:
            conn.execute("UPDATE data_apis SET description = ? WHERE id = ?", (body.description.strip(), real_id))
            changed.append("description")
        if body.is_active is not None:
            conn.execute("UPDATE data_apis SET is_active = ? WHERE id = ?", (bool(body.is_active), real_id))
            changed.append("activated" if body.is_active else "deactivated")
        if body.tables is not None:
            # Match incoming tables to existing rows by what they point at, and
            # keep the row (and its id) where that hasn't moved. Deleting and
            # re-inserting everything would re-key every table on this API on a
            # one-alias edit, throwing away each one's cached column list and
            # row count for no reason.
            prior_all = _get_tables(conn, real_id)
            # First row wins per identity. Rows beyond the first are duplicates
            # that predate alias uniqueness being enforced; they aren't matched,
            # so they fall into the delete pass below and get cleaned up.
            current: Dict[tuple, core_db.Row] = {}
            for r in prior_all:
                current.setdefault(_table_identity(r), r)
            kept, evict, to_insert = set(), [], []
            for t in body.tables:
                ident = _spec_identity(t)
                csv = ",".join(t.columns) if t.columns else None
                prior = current.get(ident) if ident not in kept else None
                if prior is not None:
                    kept.add(ident)
                    if prior["row_limit"] != t.row_limit or (prior["columns_csv"] or None) != csv:
                        conn.execute(
                            "UPDATE data_api_tables SET row_limit = ?, columns_csv = ? WHERE id = ?",
                            (t.row_limit, csv, prior["id"]),
                        )
                        # Which columns are exposed feeds the cached TableMeta,
                        # so that entry is now wrong for this table only.
                        evict.append(prior["id"])
                    continue
                to_insert.append((t, csv))
            # Delete by id rather than by walking `current`, which holds one row
            # per identity — anything not explicitly kept goes, duplicates
            # included, so this can't leave an orphan behind. Deletes go before
            # inserts: an alias moved to a different table is a new row with
            # the old row's (api_id, alias), which is UNIQUE.
            kept_ids = {current[i]["id"] for i in kept}
            doomed = [r["id"] for r in prior_all if r["id"] not in kept_ids]
            if doomed:
                conn.execute("DELETE FROM data_api_tables WHERE id = ANY(?)", (doomed,))
                # A new table reusing one of these aliases must not inherit its cache.
                evict.extend(doomed)
            for t, csv in to_insert:
                conn.execute(
                    "INSERT INTO data_api_tables (id, api_id, source_system, env, database_name, schema_name, "
                    "table_name, alias, row_limit, columns_csv) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), real_id, t.source_system, t.env, t.database, t.db_schema, t.table,
                     t.alias.strip(), t.row_limit, csv),
                )
            changed.append("tables")
            _meta_evict(evict)
        row = _get_api(conn, real_id)
        tables = [_table_row(t) for t in _get_tables(conn, real_id)]

    write_audit_event(
        action="data_api_updated",
        performed_by=editor,
        target=row["name"] or existing["name"],
        details=f"Updated: {', '.join(changed) if changed else 'no fields changed'} (api_id={real_id})",
    )

    return _api_row(row, tables)


@data_api_router.post("/{api_id}/regenerate-key")
def regenerate_key(api_id: str, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Issue a brand new api_key for this Data API Export and immediately revoke
    the old one — any URL built with the previous key stops working."""
    key = _new_api_key()
    performer = auth.get("user", {}).get("email") or auth.get("user", {}).get("name") or "unknown"
    with _db() as conn:
        row = _get_api(conn, api_id)
        conn.execute(
            "UPDATE data_apis SET api_key = ? WHERE id = ?",
            (key, row["id"]),
        )

    write_audit_event(
        action="data_api_key_regenerated",
        performed_by=performer,
        target=row["name"],
        details=f"API key regenerated — previous key revoked (api_id={row['id']})",
    )

    return {"id": row["id"], "slug": row["slug"], "api_key": key}


@data_api_router.delete("/{api_id}")
def delete_api(api_id: str, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Permanently delete a Data API Export and every table entry on it. Its
    api_key stops working immediately; this cannot be undone."""
    performer = auth.get("user", {}).get("email") or auth.get("user", {}).get("name") or "unknown"
    with _db() as conn:
        row = _get_api(conn, api_id)
        # Only this API's tables lose their cache — clearing all of it would
        # make every other API re-read columns and re-count rows on its next
        # call, for a delete that has nothing to do with them.
        doomed = [t["id"] for t in _get_tables(conn, row["id"])]
        # Tables, their search settings and the request log go with it
        # (ON DELETE CASCADE); the rate window is keyed by id, not linked.
        conn.execute("DELETE FROM data_apis WHERE id = ?", (row["id"],))
        conn.execute("DELETE FROM data_api_rate_windows WHERE bucket = ?", (row["id"],))
        _meta_evict(doomed)

    write_audit_event(
        action="data_api_deleted",
        performed_by=performer,
        target=row["name"],
        details=f"Deleted API '{row['name']}' (api_id={row['id']})",
    )

    return {"deleted": True}


# ============================================================================
# RATE LIMITING
#
# These endpoints take a key and nothing else, so a leaked key — or a consumer
# whose retry loop has no backoff — can point unlimited traffic at a production
# source. The budget is an atomic fixed window per API in the metadata
# database, shared by every worker and replica.
#
# It doesn't replace perimeter authentication/abuse controls. Set
# DATA_API_RATE_LIMIT=0 only when equivalent quotas are enforced upstream.
# ============================================================================

RATE_LIMIT_MAX = env_int("DATA_API_RATE_LIMIT", 700, minimum=0)       # calls per window
RATE_LIMIT_WINDOW = env_int("DATA_API_RATE_WINDOW", 20, maximum=3600)    # seconds

# X-Forwarded-For is set by whatever sits in front of this app, but a client can
# also send it. Behind a proxy that overwrites it (the normal setup) trusting it
# is right and necessary. Directly exposed, it lets a caller put any address in
# the request log — so it can be turned off.
TRUST_FORWARDED_FOR = (os.environ.get("DATA_API_TRUST_PROXY", "0").strip().lower()
                       not in {"0", "false", "no"})


def _rate_caller(request: Optional[Request]) -> str:
    if TRUST_FORWARDED_FOR:
        return _client_ip(request) or "unknown"
    return getattr(getattr(request, "client", None), "host", "") or "unknown"


def _rate_check(api_id: str, request: Optional[Request], conn=None) -> Optional[int]:
    """None when the call is allowed, else seconds to wait before retrying.
    Runs on the caller's metadata connection."""
    if RATE_LIMIT_MAX <= 0:
        return None
    if conn is None:
        raise RuntimeError("Shared rate limit needs the caller's metadata transaction")
    return STORE.shared_rate_check(conn, api_id, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW)


# ============================================================================
# EXECUTE — this is what a consumer actually calls to pull data. The API key
# alone is the authorization here, so these URLs work as plain links pasted
# into any browser — no app login required.
# ============================================================================

def _lookup_alias(real_id: str, alias: str):
    with _db(autocommit=True) as conn:
        t = conn.execute(
            "SELECT * FROM data_api_tables WHERE api_id = ? AND alias = ?", (real_id, alias)
        ).fetchone()
    return t


class TableMeta:
    """Everything about one exposed table that the query builder needs, resolved
    once and then cached: the real column list, which of them this alias
    exposes, which are worth searching, and the sort key to page by."""

    def __init__(self, all_columns: List[dict], exposed: List[str], searchable: List[str],
                 sort_key: List[str], key_is_unique: bool):
        self.all_columns = all_columns
        self.exposed = exposed
        self.searchable = searchable
        self.sort_key = sort_key
        # False when sort_key is the "order by everything" fallback. Keyset
        # paging on a non-unique order silently skips or repeats rows wherever
        # two rows tie, so it is only safe on a real unique key.
        self.key_is_unique = key_is_unique


def _table_meta(t, conn) -> TableMeta:
    field = _meta_field(t, "meta")
    cached = _meta_get(t["id"], field, META_TTL)
    if cached is not None:
        return cached
    lock = _META_STRIPES[hash((t["id"], field)) % len(_META_STRIPES)]
    if not lock.acquire(timeout=0.1):
        raise HTTPException(503, "Table metadata is being refreshed. Retry shortly.", headers={"Retry-After": "1"})
    try:
        return _load_table_meta(t, conn)
    finally:
        lock.release()


def _load_table_meta(t: core_db.Row, conn) -> TableMeta:
    field = _meta_field(t, "meta")
    cached = _meta_get(t["id"], field, META_TTL)
    if cached:
        return cached

    db, schema, table = t["database_name"], t["schema_name"], t["table_name"]
    all_columns = conn.get_columns(db, schema, table)
    by_name = {c["name"]: _col_type(c) for c in all_columns}

    configured = [c for c in ((t["columns_csv"] if "columns_csv" in t.keys() else None) or "").split(",") if c]
    if configured:
        # Trust the stored list but drop anything the source has since removed,
        # so a dropped column turns into a smaller response instead of a 502.
        exposed = [c for c in configured if c in by_name]
    else:
        # Every column. Dropping the bulk ones here would be faster, but it
        # changes what an existing consumer receives without them asking —
        # an admin opts into that per table in the picker, and a caller opts
        # into it per request with `columns=`.
        exposed = list(by_name)
    if not exposed:
        raise HTTPException(409, "No configured columns remain available. An administrator must review the alias.")

    # Which columns an unfiltered `search` scans. Bulk columns are left out:
    # casting an embedding to text to substring-match it costs a fortune and
    # cannot match anything a person typed, so no row's fate changes.
    searchable = [c for c in exposed if not _is_bulk(by_name[c])]

    try:
        sort_key = [c for c in conn.get_sort_key(db, schema, table) if c in by_name]
    except Exception:
        sort_key = []
    key_is_unique = bool(sort_key)
    if not sort_key:
        # No unique index to lean on, so fall back to ordering by every exposed
        # column — slow, but it's the only thing that makes paging repeatable.
        sort_key = [c for c in exposed if not _is_bulk(by_name[c])] or exposed

    meta = TableMeta(all_columns, exposed, searchable, sort_key, key_is_unique)
    _meta_put(t["id"], field, meta)
    return meta


def _resolve_projection(requested: str, meta: TableMeta) -> List[str]:
    """The `columns` query param, validated against what this alias exposes.
    Asking for a column the API doesn't expose is an error, not a silent drop —
    a caller that quietly gets fewer columns than it asked for builds a broken
    pipeline and doesn't find out for weeks."""
    if not requested:
        return meta.exposed
    wanted = [c.strip() for c in requested.split(",") if c.strip()]
    if not wanted:
        return meta.exposed
    unknown = [c for c in wanted if c not in meta.exposed]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"This API doesn't expose column(s): {', '.join(unknown)}. "
                   f"Available: {', '.join(meta.exposed)}.",
        )
    seen, out = set(), []
    for c in wanted:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _sortable_columns(meta: TableMeta, conn) -> List[str]:
    """Exposed columns the source can ORDER BY. Bulk columns (vectors, blobs,
    arrays) and types the engine refuses to sort are left out."""
    by_name = {c["name"]: _col_type(c) for c in meta.all_columns}
    blocked = {t.upper() for t in getattr(conn, "NON_SORTABLE_TYPES", set())}
    out = []
    for c in meta.exposed:
        declared = by_name.get(c, "")
        if _is_bulk(declared):
            continue
        if declared.upper() in blocked or _base_type(declared).upper() in blocked:
            continue
        out.append(c)
    return out


def _resolve_sort(sort_by: str, sort_dir: str, meta: TableMeta, conn) -> Optional[tuple]:
    sort_by = (sort_by or "").strip()
    if not sort_by:
        return None
    direction = (sort_dir or "asc").strip().lower()
    if direction not in ("asc", "desc"):
        raise HTTPException(status_code=400, detail="sort_dir must be 'asc' or 'desc'.")
    if sort_by not in meta.exposed:
        raise HTTPException(status_code=400, detail=f"This API doesn't expose a column '{sort_by}'.")
    if sort_by not in _sortable_columns(meta, conn):
        raise HTTPException(status_code=400, detail=f"Column '{sort_by}' can't be sorted on this source.")
    return (sort_by, direction.upper())


def _authorize_key(
    conn: core_db.Connection,
    api_id: str,
    api_key: str,
    request: Optional[Request] = None,
    endpoint: str = "",
    alias: Optional[str] = None,
) -> core_db.Row:
    """Rejected calls are logged too — a spike of 401s or 429s on a key is
    exactly what the owner needs to see on the Activity tab."""
    header_key = request.headers.get("x-api-key", "") if request else ""
    if api_key and header_key and api_key != header_key:
        raise HTTPException(400, "Query and header API keys must match.")
    api_key = api_key or header_key
    row = _get_api(conn, api_id)
    if not row["is_active"]:
        _log_request(row["id"], endpoint or "auth", alias=alias, request=request, status=403, mark_used=False)
        raise HTTPException(status_code=403, detail="This API has been deactivated.")
    # compare_digest rather than ==, which returns as soon as two bytes differ
    # and so leaks the length of the matching prefix to anyone timing it.
    if not api_key or not secrets.compare_digest(str(api_key).encode(), str(row["api_key"] or "").encode()):
        _log_request(row["id"], endpoint or "auth", alias=alias, request=request, status=401, mark_used=False)
        raise HTTPException(status_code=401, detail="Invalid API key.")
    # Checked after the key so a wrong key can't be used to probe, or to exhaust,
    # a real API's budget.
    retry_after = _rate_check(row["id"], request, conn)
    if retry_after is not None:
        _log_request(row["id"], endpoint or "auth", alias=alias, request=request, status=429, mark_used=False)
        raise HTTPException(
            status_code=429,
            detail=(
                f"Too many requests — this API accepts {RATE_LIMIT_MAX} calls per "
                f"{RATE_LIMIT_WINDOW}s for this rate-limit budget. Retry in {retry_after}s, and "
                "pull larger pages rather than more of them if you need more throughput."
            ),
            headers={"Retry-After": str(retry_after)},
        )
    return row


@data_api_router.get("/{api_id}/tables")
def exec_list_tables(api_id: str, request: Request, api_key: str = Query("")):
    """Consumer endpoint: list the table aliases exposed by a Data API Export.
    Authenticated by api_key alone — no portal login required, works as a plain
    URL. Works with either the raw uuid or the friendly slug. 401 on a wrong/missing
    key, 403 if the API has been deactivated."""
    with _db(autocommit=True) as conn:
        row = _authorize_key(conn, api_id, api_key, request=request, endpoint="tables")
        tables = [_table_row(t) for t in _get_tables(conn, row["id"])]
    _log_request(row["id"], "tables", request=request, row_count=len(tables))
    return {"api_id": api_id, "tables": tables}


MAX_VECTOR_TOP_K = env_int("DATA_API_VECTOR_MAX_TOP_K", 100, maximum=1000)
VECTOR_TIMEOUT_MS = env_int("DATA_API_VECTOR_TIMEOUT_MS", 5000, maximum=120000)
VECTOR_REQUIRE_INDEX = env_bool("DATA_API_VECTOR_REQUIRE_INDEX", True)
VECTOR_EF_SEARCH = env_int("DATA_API_VECTOR_EF_SEARCH", 100, maximum=1000)
VECTOR_MAX_SCAN = env_int("DATA_API_VECTOR_MAX_SCAN_TUPLES", 20000, maximum=1000000)
VECTOR_PROBES = env_int("DATA_API_VECTOR_PROBES", 10, maximum=32768)
VECTOR_MAX_PROBES = env_int("DATA_API_VECTOR_MAX_PROBES", 100, maximum=32768)


class VectorSearchRequest(BaseModel):
    vector_column: StrictStr
    # Exactly one of these. query_text is embedded server-side with the model
    # registered for this table's column (portal: Semantic search tab).
    query_vector: List[Union[StrictFloat, StrictInt]] = Field(default_factory=list)
    query_text: Optional[StrictStr] = None
    top_k: StrictInt = 10
    metric: Literal["cosine", "l2", "inner_product"] = "cosine"
    columns: List[StrictStr] = Field(default_factory=list)
    where: List[StrictStr] = Field(default_factory=list)
    search_mode: Literal["auto", "exact"] = "auto"

    if hasattr(BaseModel, "model_validate"):
        model_config = {"extra": "forbid"}
    else:  # Pydantic 1.x compatibility with older existing deployments
        class Config:
            extra = "forbid"


def _vector_columns(t: core_db.Row, conn, meta: TableMeta) -> List[dict]:
    """Vector metadata limited to this alias's currently authorized columns."""
    if not getattr(conn, "SUPPORTS_VECTOR_SEARCH", False):
        return []
    exposed = set(meta.exposed)
    configured = ((t["columns_csv"] if "columns_csv" in t.keys() else None) or "").split(",")
    if any(configured):
        # Do not inherit _table_meta's legacy fallback-to-all if every
        # explicitly configured column has disappeared from the source.
        exposed.intersection_update(configured)
    candidates = [c for c in meta.all_columns if c["name"] in exposed
                  and _base_type(_col_type(c)) in {"vector", "halfvec", "sparsevec"}]
    if not candidates:
        return []
    found = _meta_get(t["id"], _meta_field(t, "vector_columns"), META_TTL)
    if found is None:
        found = conn.get_vector_columns(t["database_name"], t["schema_name"], t["table_name"])
        _meta_put(t["id"], _meta_field(t, "vector_columns"), found)
    return [c for c in found if c["name"] in exposed]


@data_api_router.get("/{api_id}/{alias}/columns")
def exec_get_columns(api_id: str, alias: str, request: Request, api_key: str = Query("")):
    """Consumer endpoint: column names/types for one exposed table alias — only
    the columns this API actually exposes, in the order rows come back in.
    Key-only auth, same as exec_list_tables."""
    with _db(autocommit=True) as conn:
        row = _authorize_key(conn, api_id, api_key, request=request, endpoint="columns", alias=alias)
    t = _lookup_alias(row["id"], alias)
    if not t:
        _log_request(row["id"], "columns", alias=alias, request=request, status=404, mark_used=False)
        raise HTTPException(status_code=404, detail=f"No table with alias '{alias}' on this API.")
    try:
        with _connector(t["source_system"], t["env"], t["database_name"]) as conn2:
            meta = _table_meta(t, conn2)
            sortable = _sortable_columns(meta, conn2)
            vector_error = None
            try:
                vectors = _vector_columns(t, conn2, meta)
            except Exception:
                vectors = []
                vector_error = "Vector catalog metadata is unavailable; ask an administrator to check privileges."
            modes = ["substring"]
            if getattr(conn2, "SUPPORTS_EXACT_SEARCH", True):
                modes.append("exact")
            if getattr(conn2, "SUPPORTS_WORD_SEARCH", False):
                modes.append("words")
    except HTTPException:
        raise
    except ConnectorError as e:
        _log_request(row["id"], "columns", alias=alias, request=request, status=400, mark_used=False)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error reading columns for data-api {api_id}/{alias}: {e}")
        _log_request(row["id"], "columns", alias=alias, request=request, status=502, mark_used=False)
        raise HTTPException(status_code=502, detail=f"Could not read columns: {e}")

    # Shape here is exactly what it always was — name and the source's own
    # declared type — because consumers build schemas off it. The keys after
    # `columns` are additions; nothing that was there has moved or changed.
    exposed = set(meta.exposed)
    columns = [{"name": c["name"], "type": c.get("type", "")} for c in meta.all_columns if c["name"] in exposed]
    hidden = [c["name"] for c in meta.all_columns if c["name"] not in exposed]
    try:
        profile = _load_profile(t)
    except HTTPException:
        profile = None  # a broken search config must not break column discovery
    _log_request(row["id"], "columns", alias=alias, request=request, row_count=len(columns))
    return _json({
        "alias": alias,
        "columns": columns,
        "searchable_columns": meta.searchable,
        "sort_key": meta.sort_key,
        "cursor_paging": meta.key_is_unique,
        "hidden_columns": hidden,
        "sortable_columns": sortable,
        "bulk_columns": [c for c in meta.exposed if c not in meta.searchable],
        "search_modes": modes,
        "filter_ops": list(FILTER_OPS),
        "max_filters": MAX_FILTERS,
        "row_limit": min(t["row_limit"], MAX_ROW_LIMIT),
        "vector_search": bool(vectors),
        "vector_columns": [{k: v for k, v in c.items() if k != "type_schema"} for c in vectors],
        "vector_metrics": ["cosine", "l2", "inner_product"] if vectors else [],
        "vector_search_modes": ["auto", "exact"] if vectors else [],
        "vector_max_top_k": min(t["row_limit"], MAX_VECTOR_TOP_K),
        "vector_max_dimensions": 16000,
        "vector_metadata_error": vector_error,
        "vector_requires_index": VECTOR_REQUIRE_INDEX,
        "text_query_columns": [c["name"] for c in vectors if profile and c["name"] in profile.embeddings],
        "retrieval": ({**profile.describe(), "max_queries": MAX_RETRIEVAL_QUERIES,
                       "max_k": min(t["row_limit"], MAX_VECTOR_TOP_K)} if profile else None),
        "metadata_backend": STORE.backend,
    })


@data_api_router.get("/{api_id}/{alias}/count")
def exec_get_count(
    api_id: str,
    alias: str,
    request: Request,
    api_key: str = Query(""),
    search: str = Query(""),
    column: str = Query(""),
    estimate: bool = Query(False),
    mode: str = Query("substring"),
    where: List[str] = Query([]),
):
    """Consumer endpoint: total row count for one exposed table alias,
    optionally filtered by a search term.

    This is a real COUNT(*), same as it has always been, and the number is
    cached briefly so a second caller doesn't pay for it again.

    Pass `estimate=true` for the engine's own row estimate instead: a catalog
    lookup that returns instantly and is accurate to within a rounding error
    unless rows are being written right now. `estimated` in the response says
    which kind of number you got.

    A search is always counted exactly (there is no estimate for a predicate).
    Pass `column` alongside `search` to scan one column instead of all of them.
    Key-only auth."""
    started = time.monotonic()
    with _db(autocommit=True) as conn:
        row = _authorize_key(conn, api_id, api_key, request=request, endpoint="count", alias=alias)
    t = _lookup_alias(row["id"], alias)
    if not t:
        _log_request(row["id"], "count", alias=alias, request=request, status=404, mark_used=False)
        raise HTTPException(status_code=404, detail=f"No table with alias '{alias}' on this API.")
    search = (search or "").strip()
    column = (column or "").strip()
    mode = (mode or "substring").strip().lower()
    if mode not in ("substring", "words", "exact"):
        raise HTTPException(status_code=400, detail="mode must be 'substring', 'words' or 'exact'.")
    if mode != "substring" and not (search and column):
        raise HTTPException(
            status_code=400,
            detail=f"mode={mode} needs both `search` and `column`.",
        )
    db, schema, table = t["database_name"], t["schema_name"], t["table_name"]
    estimated = False
    try:
        with _connector(t["source_system"], t["env"], t["database_name"]) as conn2:
            meta = _table_meta(t, conn2)
            filters = _parse_filters(where, meta)
            if search:
                _check_mode(conn2, mode)
                search_columns = _resolve_search_columns(column, meta.exposed, meta.searchable)
                kw = {"mode": mode} if mode != "substring" else {}
                if filters:
                    kw["filters"] = filters
                total_rows = conn2.search_row_count(
                    db, schema, table, search_columns, search, **kw)
            elif filters:
                # No estimate exists for an arbitrary predicate, so a filtered
                # count is always counted for real.
                total_rows = conn2.filtered_row_count(db, schema, table, filters)
            else:
                total_rows, estimated = _count_rows(t, conn2, exact=not estimate)
    except HTTPException:
        raise
    except ConnectorError as e:
        _log_request(row["id"], "count", alias=alias, request=request, status=400, mark_used=False)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        if _is_timeout(e):
            _log_request(row["id"], "count", alias=alias, request=request, status=504, mark_used=False)
            raise HTTPException(status_code=504, detail=_TIMEOUT_DETAIL)
        if _is_bad_value(e):
            _log_request(row["id"], "count", alias=alias, request=request, status=400, mark_used=False)
            raise HTTPException(status_code=400, detail=_bad_value_detail(e))
        logger.error(f"Error counting rows for data-api {api_id}/{alias}: {e}")
        _log_request(row["id"], "count", alias=alias, request=request, status=502, mark_used=False)
        raise HTTPException(status_code=502, detail=f"Could not count rows: {e}")
    elapsed_ms = int((time.monotonic() - started) * 1000)
    _log_request(
        row["id"], "count", alias=alias, request=request,
        duration_ms=elapsed_ms,
    )
    return _json({
        "alias": alias,
        "total_rows": total_rows,
        "elapsed_ms": elapsed_ms,
        "estimated": bool(estimated),
        "mode": mode,
        "where": [f"{c}:{o}" + (":" + ",".join(v) if v else "") for c, o, v in filters] or None,
        "max_offset": max((total_rows or 0) - 1, 0),
        "row_limit": t["row_limit"],
    })


def _count_rows(t: core_db.Row, conn, exact: bool) -> Tuple[Optional[int], bool]:
    """Returns (count, is_estimate). Exact count when asked for (and then
    cached), estimate otherwise. An exact count already in the cache beats an
    estimate, so a caller that asked once gets the good number for free on
    later calls."""
    cached = _meta_get(t["id"], "exact_count", COUNT_TTL)
    if cached is not None:
        return cached, False
    db, schema, table = t["database_name"], t["schema_name"], t["table_name"]
    if not exact:
        estimate = _meta_get(t["id"], "estimate", META_TTL)
        if estimate is None:
            try:
                estimate = conn.estimate_row_count(db, schema, table)
            except Exception:
                estimate = None
            if estimate is not None:
                _meta_put(t["id"], "estimate", estimate)
        if estimate is not None:
            return estimate, True
        # No estimate available on this source — fall through and count for
        # real rather than returning nothing.
    total = conn.get_row_count(db, schema, table)
    _meta_put(t["id"], "exact_count", total)
    return total, False


@data_api_router.get("/{api_id}/{alias}/rows")
def exec_get_rows(
    api_id: str,
    alias: str,
    request: Request,
    api_key: str = Query(""),
    limit: int = Query(DEFAULT_ROW_LIMIT),
    offset: int = Query(0),
    cursor: str = Query(""),
    columns: str = Query(""),
    search: str = Query(""),
    column: str = Query(""),
    count: bool = Query(True),
    sort: str = Query("key"),
    mode: str = Query("substring"),
    where: List[str] = Query([]),
    sort_by: str = Query(""),
    sort_dir: str = Query("asc"),
):
    """Consumer endpoint: a page of rows from one exposed table alias.

    The default response is unchanged and always will be: `limit`/`offset`
    paging, every exposed column, `total_rows` filled in on the first page,
    `next_offset` until `has_more` is false. A consumer written against that
    keeps working untouched.

    Everything faster is opt-in, and none of it alters a field a caller was
    already reading:

    `cursor` — seek paging. The response carries `next_cursor` alongside
    `next_offset`; passing it back asks the database to seek straight to the
    next page through the sort key's index, so the ten-thousandth page costs
    what the first one did. `offset` makes it walk and discard every row
    before the page, which is why deep pages crawl.

    `columns=a,b,c` — return only these. Usually the biggest single win on a
    table holding embeddings or documents, since those columns are most of the
    bytes.

    `count=false` — skip the first page's COUNT(*), leaving `total_rows` null.
    Only worth it for a caller that doesn't read it.

    Search. `search` alone scans every exposed column that can hold text worth
    matching. Pass `column` with it to scan just that one — much faster, and
    the only form that can use an index.

    `sort=none` — drops the ORDER BY on a search. This is the single biggest
    lever on how long a search takes, and it is worth being precise about why.
    Sorting by the primary key means the engine has to find every matching row
    before it can say which thousand sort first; unsorted, it stops as soon as
    it has a page. Measured on a ten-million-row table: 12.5 seconds sorted,
    171 ms unsorted, for the same rows. The trade is that row order across
    pages is no longer guaranteed, so a caller paging deep into a search could
    in principle see a row twice or miss one. Default stays `key`.

    `mode=words` — matches whole words instead of a literal substring, via
    full-text search. "Bern" stops matching "Berlin", several words mean all of
    them must appear somewhere rather than in that exact sequence, and it can
    use a text-search index where a substring match cannot. Needs `column`,
    since it is only fast against a column that has such an index.

    `mode=exact` — the value must equal the column, rather than appear
    somewhere inside it. This is the right way to ask for a known id, and the
    only form an ordinary index on that column can serve: looking up one
    document by id took 34 seconds as a substring match and 0.4 ms as an
    equality match on the same ten-million-row table, because the substring
    form cannot use the index and reads everything. It is also more correct —
    a substring match on an id would also return rows whose id merely contains
    the one asked for. Needs `column`, and is cheap enough that the default
    `sort=key` costs nothing.

    `sort_by=column&sort_dir=asc|desc` — order by any exposed column that the
    source can sort. The table's key is added after it as a tie-breaker so
    paging stays stable. Cursor paging isn't offered while this is set.

    `where=column:op:value` — filters, repeatable, AND'd together. Operators:
    eq, ne, gt, gte, lt, lte, in, not_in, is_null, not_null, contains,
    starts_with. `in` and `not_in` take comma-separated values; `is_null` and
    `not_null` take none. Filters work on their own or alongside a search, and
    a filtered column must be one this API exposes.

    Page size is capped by the table's configured row_limit (and the hard
    MAX_ROW_LIMIT); there is no cap on the table as a whole. Key-only auth."""
    started = time.monotonic()
    with _db(autocommit=True) as conn:
        row = _authorize_key(conn, api_id, api_key, request=request, endpoint="rows", alias=alias)
    t = _lookup_alias(row["id"], alias)
    if not t:
        _log_request(row["id"], "rows", alias=alias, request=request, status=404, mark_used=False)
        raise HTTPException(status_code=404, detail=f"No table with alias '{alias}' on this API.")

    # This cap is per page, not per table — keep paging for the rest.
    capped_limit = max(min(int(limit), t["row_limit"], MAX_ROW_LIMIT), 1)
    offset = max(int(offset), 0)
    search = (search or "").strip()
    column = (column or "").strip()
    cursor = (cursor or "").strip()
    sort = (sort or "key").strip().lower()
    mode = (mode or "substring").strip().lower()
    db, schema, table = t["database_name"], t["schema_name"], t["table_name"]

    if sort not in ("key", "none"):
        raise HTTPException(status_code=400, detail="sort must be 'key' or 'none'.")
    if sort == "none" and (sort_by or "").strip():
        raise HTTPException(status_code=400, detail="sort=none and sort_by can't be used together.")
    if mode not in ("substring", "words", "exact"):
        raise HTTPException(status_code=400, detail="mode must be 'substring', 'words' or 'exact'.")
    # Both only mean anything on a search, and silently ignoring them would let
    # a caller think they had asked for something they hadn't. Named precisely:
    # a message about mode=words when the caller sent sort=none sends them
    # looking at the wrong parameter.
    if not search and sort == "none":
        raise HTTPException(
            status_code=400,
            detail="sort=none only applies to a search — add `search`, or drop it "
                   "to page through the table normally.",
        )
    if not search and mode != "substring":
        raise HTTPException(
            status_code=400,
            detail=f"mode={mode} only applies to a search — add `search`, or drop it "
                   "to page through the table normally.",
        )
    if mode == "words" and not column:
        raise HTTPException(
            status_code=400,
            detail="mode=words needs `column` naming the single column to search. "
                   "Word search is only fast against a column with a text-search "
                   "index on it.",
        )
    if mode == "exact" and not column:
        raise HTTPException(
            status_code=400,
            detail="mode=exact needs `column` naming the column the value must equal.",
        )

    try:
        with _connector(t["source_system"], t["env"], t["database_name"]) as conn2:
            meta = _table_meta(t, conn2)
            projection = _resolve_projection(columns, meta)
            filters = _parse_filters(where, meta)
            # The sort key has to come back with the rows or there is nothing
            # to build the next cursor from. Fetched, used, then dropped from
            # the response so the caller sees exactly what it asked for.
            key_cols = meta.sort_key
            user_sort = _resolve_sort(sort_by, sort_dir, meta, conn2)
            order = key_cols
            if user_sort:
                order = [user_sort] + [k for k in key_cols if k != user_sort[0]]
            # Seek paging only when the caller opted in by sending a cursor.
            # Switching a caller onto it silently would mean answering an
            # `offset=5000` request with a different page than it asked for.
            offers_cursor = (
                meta.key_is_unique
                and not search
                and not user_sort
                and getattr(conn2, "SUPPORTS_KEYSET", False)
            )
            can_seek = bool(cursor) and offers_cursor
            # A cursor this request can't honour used to be dropped on the
            # floor, which answered "the page after X" with the first page and
            # no way to tell. Say so instead.
            if cursor and not offers_cursor:
                why = (
                    "a search" if search
                    else "sort_by" if user_sort
                    else "this table has no unique key to seek on"
                    if not meta.key_is_unique
                    else "this source doesn't support seek paging"
                )
                raise HTTPException(
                    status_code=400,
                    detail=f"`cursor` can't be used with {why}. Drop the cursor and page "
                           "with `offset` / `next_offset` instead.",
                )
            # The key columns have to be fetched on every page this endpoint
            # will hand a cursor back on, not just the ones reached by cursor:
            # next_cursor is built from the last row's key values, and those
            # aren't in the row unless they were selected. A caller narrowing
            # `columns=`, or an alias configured without its key column, would
            # otherwise take the whole page down with a KeyError. Fetched here,
            # stripped from the response below, so the caller still sees
            # exactly the columns it asked for.
            fetch_cols = (
                projection + [c for c in key_cols if c not in projection]
                if offers_cursor else projection
            )

            after_values = _decode_cursor(cursor) if cursor else None
            if after_values is not None and len(after_values) != len(key_cols):
                raise HTTPException(status_code=400, detail="That cursor was issued for a different table.")

            if search:
                _check_mode(conn2, mode)
                search_columns = _resolve_search_columns(column, meta.exposed, meta.searchable)
                # Ordered by the sort key, never by the column being searched:
                # narrowing a search so an index can match, then sorting the
                # matches by that same large text column, gives the saving
                # straight back. sort=none drops the ordering altogether.
                # mode is only passed when it isn't the default, so the
                # ordinary search path keeps working against any connector,
                # including one that predates the parameter.
                extra = {"mode": mode} if mode != "substring" else {}
                if filters:
                    extra["filters"] = filters
                rows = conn2.search_rows(
                    db, schema, table, projection, search, capped_limit,
                    order_by=([] if sort == "none" else order), offset=offset,
                    search_columns=search_columns, **extra,
                )
            elif can_seek:
                # offset is ignored on a cursor call by definition — the cursor
                # is the position. Reported back as-is so nothing looks lost.
                rows = conn2.fetch_rows_after(
                    db, schema, table, fetch_cols, key_cols, after_values, capped_limit,
                    **({"filters": filters} if filters else {}),
                )
            else:
                rows = conn2.fetch_rows(
                    db, schema, table, fetch_cols, capped_limit, order_by=order, offset=offset,
                    **({"filters": filters} if filters else {}),
                )

            # As documented: counted on the first page only. A full COUNT(*)
            # on every page of a big table is waste the caller never asked for,
            # and the value is cached so the next first-page call is free.
            total_rows, estimated = (None, False)
            if count and offset == 0 and not cursor:
                if search:
                    search_columns = _resolve_search_columns(column, meta.exposed, meta.searchable)
                    kw = {"mode": mode} if mode != "substring" else {}
                    if filters:
                        kw["filters"] = filters
                    try:
                        total_rows = conn2.search_row_count(
                            db, schema, table, search_columns, search, **kw)
                    except Exception:
                        total_rows = None
                elif filters:
                    # A filtered count can't come from the cached table total,
                    # and there is no estimate for an arbitrary predicate.
                    try:
                        total_rows = conn2.filtered_row_count(db, schema, table, filters)
                    except Exception:
                        total_rows = None
                else:
                    try:
                        total_rows, estimated = _count_rows(t, conn2, exact=True)
                    except Exception:
                        total_rows, estimated = None, False
    except HTTPException:
        raise
    except ConnectorError as e:
        _log_request(row["id"], "rows", alias=alias, request=request, status=400, mark_used=False)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        if _is_timeout(e):
            _log_request(row["id"], "rows", alias=alias, request=request, status=504, mark_used=False)
            raise HTTPException(status_code=504, detail=_TIMEOUT_DETAIL)
        if _is_bad_value(e):
            _log_request(row["id"], "rows", alias=alias, request=request, status=400, mark_used=False)
            raise HTTPException(status_code=400, detail=_bad_value_detail(e))
        logger.error(f"Error reading rows for data-api {api_id}/{alias}: {e}")
        _log_request(row["id"], "rows", alias=alias, request=request, status=502, mark_used=False)
        raise HTTPException(status_code=502, detail=f"Could not read rows: {e}")

    has_more = len(rows) == capped_limit
    next_cursor = None
    if offers_cursor and has_more and rows and all(c in rows[-1] for c in key_cols):
        # Handed out on every page, cursor or not, so a caller can switch over
        # whenever it likes without having to start again from the top. The
        # membership check is belt and braces: fetch_cols above guarantees the
        # key is in the row, and a page without a cursor is still a correct
        # page, so a connector that somehow returned less must not 500 here.
        next_cursor = _encode_cursor([rows[-1][c] for c in key_cols])
    extra = [c for c in fetch_cols if c not in projection]
    if extra:
        for r in rows:
            for c in extra:
                r.pop(c, None)

    elapsed_ms = int((time.monotonic() - started) * 1000)
    _log_request(
        row["id"], "rows", alias=alias, request=request, row_count=len(rows),
        duration_ms=elapsed_ms,
    )
    # Key order and meaning below match what consumers were given. The four
    # after `rows`'s original set are additions — a client that doesn't know
    # about them ignores them, and nothing it does read has changed.
    return _json({
        "alias": alias,
        "row_count": len(rows),
        "total_rows": total_rows,
        "max_offset": (max(total_rows - 1, 0) if total_rows is not None else None),
        "offset": offset,
        "limit": capped_limit,
        "has_more": has_more,
        "next_offset": (offset + capped_limit) if has_more else None,
        "search": search or None,
        "column": column or None,
        "rows": rows,
        "next_cursor": next_cursor,
        "sort": sort,
        "mode": mode,
        "where": [f"{c}:{o}" + (":" + ",".join(v) if v else "") for c, o, v in filters] or None,
        "columns": projection,
        # Server-side time, so a caller seeing a slow call can tell whether the
        # source was slow or the payload was simply large and the wire is the
        # bottleneck. Two very different fixes.
        "elapsed_ms": elapsed_ms,
        "total_is_estimate": estimated,
        "sort_by": user_sort[0] if user_sort else None,
        "sort_dir": user_sort[1].lower() if user_sort else None,
    })

def _caller_id(api_key: str) -> str:
    """Same identity DataAPIRoute uses for per-key admission."""
    return hashlib.sha256(api_key.encode()).hexdigest() if api_key else "unauthenticated"


def _lossless_json(payload: dict) -> bytes:
    """Decimal as string so source precision survives. Used by the POST
    endpoints only; legacy /rows serialization is unchanged."""
    def fallback(value):
        return str(value) if isinstance(value, Decimal) else _json_fallback(value)
    return (orjson.dumps(payload, default=fallback) if orjson
            else json.dumps(payload, default=fallback, allow_nan=False).encode())


# ============================================================================
# Semantic-search configuration (stored in the metadata DB, managed in the UI)
# ============================================================================

_SEARCH_READY = {"ok": False, "checked": 0.0}


def _search_ready() -> bool:
    """Whether the four configuration tables exist. The core migration creates
    them, so this is True on any current schema; it only says no when the
    tables are genuinely missing. A database that is merely unreachable
    raises (503) rather than being reported as "not installed"."""
    if _SEARCH_READY["ok"]:
        return True
    now = time.monotonic()
    if now - _SEARCH_READY["checked"] < 30:
        return False
    try:
        with _db() as conn:
            for table in SEARCH_TABLES:
                conn.execute(f"SELECT * FROM {table} LIMIT 0")
        _SEARCH_READY["ok"] = True
    except core_db.Error as e:
        if getattr(e, "pgcode", None) != "42P01":   # undefined_table
            raise
        _SEARCH_READY["checked"] = now
        logger.warning("Data API semantic-search tables are missing; run `python db.py migrate`")
    return _SEARCH_READY["ok"]


SEARCH_NOT_INSTALLED = ("Semantic search is not installed on this server's metadata store. "
                        "Run `python db.py migrate` on the backend.")


def _reg_key(t) -> tuple:
    """Registration identity of an alias's physical table (case-normalised
    like the PostgreSQL connector, database '' when absent)."""
    return ((t["source_system"] or "").lower(), (t["env"] or "").lower(), t["database_name"] or "",
            (t["schema_name"] or "").lower(), (t["table_name"] or "").lower())


def _model_from_row(r) -> EmbeddingModel:
    return EmbeddingModel(r["name"], {
        "id": r["id"], "deployment": r["deployment"], "dimensions": r["dimensions"], "endpoint": r["endpoint"],
        "api_version": r["api_version"], "api_key_env": r["api_key_env"], "query_prefix": r["query_prefix"],
        "send_dimensions": bool(r["send_dimensions"]),
    })


def _table_registrations(conn, t) -> Dict[str, dict]:
    """{column: {registration id, model row}} for this alias's physical table."""
    rows = conn.execute(
        "SELECT r.id AS reg_id, r.column_name, m.* FROM data_api_vector_registrations r "
        "JOIN data_api_embedding_models m ON m.id = r.model_id "
        "WHERE r.source_system = ? AND r.env = ? AND r.database_name = ? AND r.schema_name = ? AND r.table_name = ?",
        _reg_key(t)).fetchall()
    return {r["column_name"]: {"reg_id": r["reg_id"], "model": r} for r in rows}


def _stored_settings(conn, table_id: str) -> Optional[dict]:
    row = conn.execute("SELECT settings FROM data_api_search_settings WHERE table_id = ?", (table_id,)).fetchone()
    return json.loads(row["settings"]) if row else None


def _contract_row(conn, contract_id: Optional[str]):
    if not contract_id:
        return None
    return conn.execute("SELECT * FROM data_api_contracts WHERE id = ?", (contract_id,)).fetchone()


def _load_profile(t) -> Optional[SearchProfile]:
    """The alias's search profile, or None when search is not enabled for it.
    A stored configuration that has become invalid (e.g. the server's endpoint
    allowlist changed) is a 409 for the caller, never a 500."""
    if not _search_ready():
        return None
    with _db() as conn:
        settings = _stored_settings(conn, t["id"])
        if not settings or not settings.get("enabled"):
            return None
        regs = _table_registrations(conn, t)
        contract = _contract_row(conn, settings.get("contract_id"))
    try:
        embeddings = {col: _model_from_row(r["model"]) for col, r in regs.items()}
        if settings.get("contract_id") and contract is None:
            raise SearchConfigError("its response contract no longer exists")
        return SearchProfile(settings, embeddings,
                             json.loads(contract["definition"]) if contract else None,
                             f"{contract['name']} v{contract['version']}" if contract else None)
    except SearchConfigError as e:
        raise HTTPException(409, f"This alias's semantic-search configuration is invalid ({e}). "
                                 "An administrator must review it in the portal.") from None


def _search_profile(t) -> SearchProfile:
    profile = _load_profile(t)
    if profile is None:
        raise HTTPException(409, SEARCH_NOT_INSTALLED if not _search_ready() else
                            "Semantic search is not enabled for this alias. An administrator can enable it "
                            "in the portal (Data API Export, Semantic search tab).")
    return profile


def _embed_for_column(t, vector_column: str, query_text: str) -> Tuple[list, str]:
    """(vector, model name) for free text, using the model registered for this
    physical column. Matching dimensions alone never proves model identity,
    so there is no fallback to 'any model with the right size'."""
    profile = _search_profile(t)
    model = profile.embeddings.get(vector_column)
    if model is None:
        raise HTTPException(409, f"No embedding model is registered for column '{vector_column}'. "
                                 "Send query_vector, or ask an administrator to register the model.")
    try:
        text = clean_query(query_text)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return embed_queries(model, [text])[0], model.name


# ============================================================================
# /retrieve - semantic + keyword (hybrid) retrieval with a response contract
#
# Additive endpoint for PostgreSQL aliases with semantic search enabled. Per
# query: the dense leg (pgvector, same SQL as /vector-search) and the keyword
# leg (GIN full-text) each return candidate KEYS, Reciprocal Rank Fusion picks
# the top k, then the winners' rows and one-hop metadata are fetched once. All
# statements share one READ ONLY REPEATABLE READ snapshot, so the legs, the
# row fetch and the metadata agree with each other.
# ============================================================================

MAX_RETRIEVAL_QUERIES = env_int("DATA_API_RETRIEVAL_MAX_QUERIES", 10, maximum=100)
RETRIEVAL_TIMEOUT_MS = env_int("DATA_API_RETRIEVAL_TIMEOUT_MS", 15000, maximum=300000)


class _RetrievalTimeout(Exception):
    pass


class _StepTimeout(Exception):
    """One retrieval step exceeded its own limit; names the step for the caller."""

    def __init__(self, step: str, limit_ms: int):
        super().__init__(step)
        self.step, self.limit_ms = step, limit_ms


_STEP_ADVICE = {
    "semantic": ("Semantic (vector) search took longer than {ms} ms on this table. Usually the vector index is "
                 "not being used or is not in memory: run Validate in the portal's Semantic search tab and check "
                 "the query plan, or ask a DBA. The limit can be changed per alias (Semantic timeout)."),
    "rows": ("Reading the matched rows took longer than {ms} ms. Check the table's primary key index, "
             "or reduce k or the number of queries."),
    "metadata": ("Reading response-template metadata took longer than {ms} ms. Check the index on the "
                 "lookup table's key column."),
}


class _Timer:
    """Adds each step's wall time to timings and names the step on timeout."""

    def __init__(self, timings: dict, step: str, limit_ms: int, capped: bool):
        self.timings, self.step, self.limit_ms, self.capped = timings, step, limit_ms, capped

    def __enter__(self):
        self.t0 = time.monotonic()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.timings[self.step] = self.timings.get(self.step, 0) + int((time.monotonic() - self.t0) * 1000)
        if exc is not None and _is_timeout(exc):
            # Capped means the overall request budget, not this step's own limit, ran out.
            raise (_RetrievalTimeout() if self.capped else _StepTimeout(self.step, self.limit_ms)) from None
        return False


def _keyword_index(source, t, column: str, config: Optional[str], col_type: str,
                   indexes: Optional[List[dict]] = None) -> Tuple[Optional[str], bool, Optional[str]]:
    """(query config, stored_tsvector, problem) for a keyword column. A usable
    GIN full-text index is always required: without one every keyword query
    would scan the whole table, which is unacceptable at this data volume."""
    stored = col_type == "tsvector"
    if indexes is None:
        indexes = source.get_text_search_indexes(t["database_name"], t["schema_name"], t["table_name"])
    on_column = [i for i in indexes if i["column"] == column]
    if stored:
        if not config:
            return None, True, f"'{column}' is a stored tsvector; set the text search configuration it was built with."
        return (config, True, None) if on_column else (config, True, f"'{column}' has no GIN index.")
    configs = sorted({i["config"] for i in on_column if i["config"]})
    if config is None and len(configs) == 1:
        config = configs[0]
    if not configs:
        return config, False, (f"'{column}' has no GIN full-text index. A DBA must create one, e.g. "
                               f"CREATE INDEX ON <table> USING gin (to_tsvector('english', {column})).")
    if config is None:
        return None, False, f"'{column}' has GIN indexes for several configurations ({', '.join(configs)}); choose one."
    if config not in configs:
        return config, False, f"No GIN index on '{column}' uses the '{config}' configuration (found: {', '.join(configs)})."
    return config, False, None


def _text_index(t, source, meta: TableMeta, profile) -> Tuple[str, bool]:
    column = profile.text_column
    if column not in meta.exposed:
        raise HTTPException(409, f"The keyword column '{column}' is no longer exposed by this alias.")
    col_type = next((_base_type(_col_type(c)) for c in meta.all_columns if c["name"] == column), "")
    indexes = _meta_get(t["id"], _meta_field(t, "text_indexes"), META_TTL)
    if indexes is None:
        indexes = source.get_text_search_indexes(t["database_name"], t["schema_name"], t["table_name"])
        _meta_put(t["id"], _meta_field(t, "text_indexes"), indexes)
    config, stored, problem = _keyword_index(source, t, column, profile.text_search_config, col_type, indexes)
    if problem:
        raise HTTPException(409, "Keyword search is unavailable: " + problem)
    return config, stored


def _lookup_problems(t, source, lookup, cached: bool = True) -> List[str]:
    """Catalog checks for one metadata lookup (never reads table data)."""
    field = _meta_field(t, f"lookup:{lookup.schema}.{lookup.table}")
    info = _meta_get(t["id"], field, META_TTL) if cached else None
    if info is None:
        cols = [c["name"] for c in source.get_columns(t["database_name"], lookup.schema, lookup.table)]
        unique = bool(cols) and lookup.key in cols and source.is_unique_column(
            t["database_name"], lookup.schema, lookup.table, lookup.key)
        info = {"columns": cols, "unique": unique}
        _meta_put(t["id"], field, info)
    if not info["columns"]:
        return [f"Lookup '{lookup.name}': table {lookup.schema}.{lookup.table} was not found in this database."]
    missing = [c for c in [lookup.key] + lookup.columns if c not in info["columns"]]
    if missing:
        return [f"Lookup '{lookup.name}': missing column(s) {', '.join(missing)} in {lookup.schema}.{lookup.table}."]
    if not info["unique"]:
        return [f"Lookup '{lookup.name}': '{lookup.key}' must have a primary key or single-column unique index "
                f"in {lookup.schema}.{lookup.table}, so each lookup is one index probe and returns one record."]
    return []


def _run_retrieval(t, body: RetrievalRequest, caller: str) -> dict:
    """Shared by POST /retrieve and the MCP search tool. Auth, rate limiting
    and activity logging stay with the caller of this function."""
    started = time.monotonic()
    deadline = started + RETRIEVAL_TIMEOUT_MS / 1000
    profile = _search_profile(t)
    queries = body.retrieval_queries
    if not 1 <= len(queries) <= MAX_RETRIEVAL_QUERIES:
        raise HTTPException(400, f"retrieval_queries must contain 1 to {MAX_RETRIEVAL_QUERIES} items.")
    max_k = min(t["row_limit"], MAX_VECTOR_TOP_K)
    plans = []
    for i, q in enumerate(queries):
        if not 1 <= q.k <= max_k:
            raise HTTPException(400, f"retrieval_queries[{i}].k must be between 1 and {max_k}.")
        mode = q.mode or profile.default_mode
        if mode not in profile.modes:
            raise HTTPException(400, f"retrieval_queries[{i}].mode '{mode}' is not available here; "
                                     f"available: {', '.join(profile.modes)}.")
        try:
            text = clean_query(q.query)
        except ValueError as e:
            raise HTTPException(400, f"retrieval_queries[{i}]: {e}") from None
        # A fused list needs depth beyond k; a single leg does not.
        pool = min(max(q.k, profile.candidate_pool), MAX_CANDIDATE_POOL) if mode == "hybrid" else q.k
        plans.append({"text": text, "k": q.k, "mode": mode, "pool": pool, "where": q.where})

    uses_dense = any(p["mode"] != "sparse" for p in plans)
    uses_sparse = any(p["mode"] != "dense" for p in plans)
    timings: Dict[str, int] = {"embedding": 0, "semantic": 0, "keyword": 0, "rows": 0, "metadata": 0}
    semantic_limit = profile.semantic_timeout_ms or VECTOR_TIMEOUT_MS
    if uses_dense and body.search_mode == "exact" and not profile.allow_exact:
        raise HTTPException(409, "Exact search is disabled for this alias: it reads every row, which is not "
                                 "acceptable on large tables. Use search_mode=auto, or ask an administrator.")
    vector_column = (body.vector_column or profile.vector_column) if uses_dense else None
    model = None
    if uses_dense:
        model = profile.embeddings.get(vector_column or "")
        if model is None:
            raise HTTPException(409, f"No embedding model is registered for column '{vector_column}'.")
        # Before checking out a source connection (see _embed_for_column).
        embed_started = time.monotonic()
        for p, vec in zip([p for p in plans if p["mode"] != "sparse"],
                          embed_queries(model, [p["text"] for p in plans if p["mode"] != "sparse"])):
            p["vector"] = vec
        timings["embedding"] = int((time.monotonic() - embed_started) * 1000)

    warnings: List[str] = []
    with _connector(t["source_system"], t["env"], t["database_name"]) as source:
        if not getattr(source, "SUPPORTS_VECTOR_SEARCH", False):
            raise HTTPException(400, "Retrieval requires a PostgreSQL source.")
        meta = _table_meta(t, source)
        if not meta.key_is_unique:
            raise HTTPException(409, "Retrieval needs a primary key or unique index on the table to merge results.")
        key_columns = meta.sort_key
        for p in plans:
            p["filters"] = _parse_filters(p["where"], meta)
        vector = None
        if uses_dense:
            vector = next((v for v in _vector_columns(t, source, meta) if v["name"] == vector_column), None)
            if vector is None:
                raise HTTPException(409, f"'{vector_column}' is not an exposed pgvector column on this alias.")
            if vector["dimensions"] is not None and vector["dimensions"] != model.dimensions:
                raise HTTPException(409, f"Search profile model '{model.name}' produces {model.dimensions} dimensions "
                                         f"but '{vector_column}' stores {vector['dimensions']}.")
            if body.search_mode == "auto":
                if vector["dimensions"] is None:
                    raise HTTPException(400, "Variable-dimension columns require search_mode=exact.")
                if VECTOR_REQUIRE_INDEX and not any(i["metric"] == profile.metric for i in vector.get("ann_indexes", [])):
                    raise HTTPException(409, "Auto search requires a valid full-column ANN index for this metric. "
                                             "Use search_mode=exact or have a DBA create/review the index.")
                if source._pgvector_version(vector) < (0, 8, 0) and any(p["filters"] for p in plans):
                    warnings.append("pgvector is older than 0.8.0; filtered approximate search can return fewer results.")
        text_config, stored_tsv = (_text_index(t, source, meta, profile) if uses_sparse else ("english", False))
        if profile.response:
            columns = profile.base_columns()
            hidden = [c for c in columns if c not in meta.exposed]
            if hidden:
                raise HTTPException(409, f"The response contract uses column(s) this alias does not expose: {', '.join(hidden)}.")
            for lookup in profile.lookups.values():
                problems = _lookup_problems(t, source, lookup)
                if problems:
                    raise HTTPException(409, problems[0] + " An administrator must review the response contract.")
        else:
            by_name = {c["name"]: _col_type(c) for c in meta.all_columns}
            columns = [c for c in meta.exposed if not _is_bulk(by_name[c])]

        exact = uses_dense and body.search_mode == "exact"
        if exact:
            EXACT_GATE.enter(caller)
        try:
            db, schema, table = t["database_name"], t["schema_name"], t["table_name"]

            def budget(cap_ms):
                remaining = int((deadline - time.monotonic()) * 1000)
                if remaining <= 0:
                    raise _RetrievalTimeout()
                return min(cap_ms, remaining)

            def step(name, cap_ms):
                """Set the statement timeout for one step and time it."""
                limit = budget(cap_ms)
                source._set_statement_timeout(cur, limit)
                return _Timer(timings, name, cap_ms, capped=limit < cap_ms)

            with source.read_only_transaction(db, budget(RETRIEVAL_TIMEOUT_MS), repeatable_read=True) as cur:
                if uses_dense and body.search_mode == "auto":
                    source._apply_ann_settings(cur, vector, max(VECTOR_EF_SEARCH, max(p["pool"] for p in plans)),
                                               VECTOR_PROBES, VECTOR_MAX_SCAN, VECTOR_MAX_PROBES)
                for i, p in enumerate(plans):
                    dense, sparse = [], []
                    if p["mode"] != "sparse":
                        with step("semantic", semantic_limit):
                            previous = source.prefer_index(cur) if body.search_mode == "auto" else None
                            dense = source.dense_candidates(cur, schema, table, key_columns, vector, p["vector"],
                                                            p["pool"], profile.metric, p["filters"], body.search_mode)
                            if previous:
                                source.restore_planner(cur, previous)
                    if p["mode"] != "dense":
                        kw_started = time.monotonic()
                        sparse, timed_out = source.sparse_candidates(
                            cur, schema, table, key_columns, profile.text_column, text_config, stored_tsv,
                            p["text"], p["pool"], p["filters"], budget(profile.keyword_timeout_ms))
                        timings["keyword"] += int((time.monotonic() - kw_started) * 1000)
                        if timed_out:
                            warnings.append(f"retrieval_queries[{i}]: keyword search timed out; "
                                            "results use semantic search only.")
                    p["fused"] = reciprocal_rank_fusion(dense, sparse, p["k"], profile.rrf_k,
                                                        profile.dense_weight, profile.sparse_weight)
                keys = list(dict.fromkeys(item["key"] for p in plans for item in p["fused"]))
                with step("rows", RETRIEVAL_TIMEOUT_MS):
                    rows = source.fetch_by_keys(cur, schema, table, key_columns, columns, keys)
                lookup_rows: Dict[str, dict] = {}
                for lookup in profile.lookups.values():
                    values = list(dict.fromkeys(r[lookup.on] for r in rows.values() if r.get(lookup.on) is not None))
                    with step("metadata", RETRIEVAL_TIMEOUT_MS):
                        found = source.fetch_by_keys(cur, lookup.schema, lookup.table, [lookup.key],
                                                     lookup.columns, [(v,) for v in values])
                    lookup_rows[lookup.name] = {k[0]: v for k, v in found.items()}
        finally:
            if exact:
                EXACT_GATE.leave(caller)

    matches_key = profile.response["matches_key"] if profile.response else "matches"
    results = []
    for p in plans:
        out = []
        for item in p["fused"]:
            row = rows.get(item["key"])
            if row is None:  # cannot happen inside one snapshot; be defensive
                continue
            related = {name: lk.get(row.get(profile.lookups[name].on)) for name, lk in lookup_rows.items()}
            out.append(build_match(item, len(out) + 1, row, related, profile, columns))
        results.append({"k": p["k"], matches_key: out})
    if uses_dense and body.search_mode == "auto":
        warnings.append("Semantic results may come from an approximate index; recall is not guaranteed. "
                        "Use search_mode=exact to compare.")
    return {
        "alias": t["alias"],
        "results": results,
        "vector_column": vector_column,
        "metric": profile.metric if uses_dense else None,
        "search_mode": body.search_mode,
        "embedding_model": model.name if model else None,
        "response_contract": profile.contract_label,
        "fusion": {"method": "reciprocal_rank_fusion", "rrf_k": profile.rrf_k,
                   "dense_weight": profile.dense_weight, "sparse_weight": profile.sparse_weight},
        "score_semantics": {
            "score": "fused RRF score, higher is better; defines rank",
            "dense_score": "cosine similarity (1 - cosine distance)" if profile.metric == "cosine" else "inner product",
            "sparse_score": "ts_rank_cd normalised to 0..1",
            "null": "the item was not returned by that leg",
        },
        "elapsed_ms": int((time.monotonic() - started) * 1000),
        # Where the time went (milliseconds, summed over the batch): embedding
        # the questions, the semantic and keyword searches, and reading rows.
        "timings_ms": timings,
        "warnings": warnings,
        "decimal_encoding": "string",
    }


def _retrieval_error(e: Exception) -> HTTPException:
    """Map a failure inside _run_retrieval to a safe HTTP error. Raw driver
    messages are never returned or logged: they can echo query text."""
    if isinstance(e, HTTPException):
        return e
    if isinstance(e, EmbeddingUnavailable):
        return HTTPException(503, str(e), headers={"Retry-After": "2"}) if e.retryable else HTTPException(502, str(e))
    if isinstance(e, ConnectorError):
        return HTTPException(400, str(e))
    if isinstance(e, _StepTimeout):
        return HTTPException(504, _STEP_ADVICE[e.step].format(ms=e.limit_ms))
    if isinstance(e, _RetrievalTimeout) or _is_timeout(e):
        return HTTPException(504, "Retrieval exceeded its time budget. Reduce queries, k or filters, or review indexes.")
    if _is_bad_value(e):
        return HTTPException(400, "A filter value is incompatible with its source column. Check filter types.")
    return HTTPException(502, "Could not query the retrieval source. Check connectivity, privileges and indexes.")


@data_api_router.post("/{api_id}/{alias}/vector-search")
def exec_vector_search(
    api_id: str,
    alias: str,
    body: VectorSearchRequest,
    request: Request,
    api_key: str = Query(""),
):
    """Search stored pgvector embeddings; never generate or persist embeddings.

    The existing query-string key is supported. X-API-Key is also accepted here
    so POST clients do not have to put their key into a URL/access log.
    """
    started = time.monotonic()
    header_key = request.headers.get("x-api-key", "")
    with _db(autocommit=True) as db_conn:
        row = _authorize_key(db_conn, api_id, api_key or header_key, request=request,
                             endpoint="vector-search", alias=alias)
    caller = _caller_id(api_key or header_key)
    try:
        if api_key and header_key and api_key != header_key:
            raise HTTPException(status_code=400, detail="Query and header API keys must match.")
        t = _lookup_alias(row["id"], alias)
        if not t:
            raise HTTPException(status_code=404, detail=f"No table with alias '{alias}' on this API.")
        if not 1 <= body.top_k <= MAX_VECTOR_TOP_K:
            raise HTTPException(status_code=400, detail=f"top_k must be between 1 and {MAX_VECTOR_TOP_K}.")
        vector_column = body.vector_column.strip()
        query_vector, embedding_model = body.query_vector, None
        if body.query_text is not None:
            if body.query_vector:
                raise HTTPException(400, "Send either query_vector or query_text, not both.")
            # Embedded before a source connection is checked out, so a slow
            # provider never holds a pooled database socket.
            query_vector, embedding_model = _embed_for_column(t, vector_column, body.query_text)
        if not 1 <= len(query_vector) <= 16_000:
            raise HTTPException(status_code=400, detail="query_vector must contain 1 to 16000 numbers.")
        with _connector(t["source_system"], t["env"], t["database_name"]) as source:
            if not getattr(source, "SUPPORTS_VECTOR_SEARCH", False):
                raise HTTPException(status_code=400, detail="Vector search requires a PostgreSQL/pgvector source.")
            meta = _table_meta(t, source)
            configured = ((t["columns_csv"] if "columns_csv" in t.keys() else None) or "").split(",")
            if any(configured) and not set(configured).intersection(c["name"] for c in meta.all_columns):
                raise HTTPException(status_code=400, detail="None of this alias's configured columns still exist.")
            if vector_column not in meta.exposed:
                raise HTTPException(status_code=400, detail=f"This API doesn't expose column '{vector_column}'.")
            vectors = _vector_columns(t, source, meta)
            vector = next((v for v in vectors if v["name"] == vector_column), None)
            if vector is None:
                raise HTTPException(status_code=400, detail="vector_column must be an exposed pgvector vector, halfvec, or sparsevec column.")
            if body.columns:
                # Check individual names before delegating to the existing
                # projection resolver, so a malformed name isn't silently split.
                unknown = [c for c in body.columns if c not in meta.exposed]
                if unknown:
                    raise HTTPException(status_code=400, detail=f"This API doesn't expose column(s): {', '.join(unknown)}.")
                projection = list(dict.fromkeys(body.columns))
            else:
                by_name = {c["name"]: _col_type(c) for c in meta.all_columns}
                projection = [c for c in meta.exposed if not _is_bulk(by_name[c])]
            filters = _parse_filters(body.where, meta)
            top_k = min(body.top_k, t["row_limit"], MAX_VECTOR_TOP_K)
            eligible_indexes = [i for i in vector.get("ann_indexes", []) if i["metric"] == body.metric]
            if body.search_mode == "auto" and VECTOR_REQUIRE_INDEX and not eligible_indexes:
                raise HTTPException(409, "Auto search requires a valid full-column ANN index for this metric. Use exact search or have a DBA create/review the index. Partial/expression indexes need separate plan validation.")
            if body.search_mode == "auto" and vector.get("dimensions") is None:
                raise HTTPException(400, "Variable-dimension columns require exact mode in this endpoint.")
            if body.search_mode == "exact":
                EXACT_GATE.enter(caller)
            try:
                matches = source.search_vector_rows(
                    t["database_name"], t["schema_name"], t["table_name"], projection,
                    vector, query_vector, top_k, metric=body.metric,
                    filters=filters, search_mode=body.search_mode,
                    key_columns=meta.sort_key if meta.key_is_unique else [],
                    timeout_ms=VECTOR_TIMEOUT_MS,
                    ef_search=max(VECTOR_EF_SEARCH, top_k), max_scan_tuples=VECTOR_MAX_SCAN,
                    probes=VECTOR_PROBES, max_probes=VECTOR_MAX_PROBES,
                )
            finally:
                if body.search_mode == "exact":
                    EXACT_GATE.leave(caller)
    except HTTPException as e:
        _log_request(row["id"], "vector-search", alias=alias, request=request,
                     status=e.status_code, mark_used=False)
        raise
    except ConnectorError as e:
        _log_request(row["id"], "vector-search", alias=alias, request=request, status=400, mark_used=False)
        raise HTTPException(status_code=400, detail=str(e)) from None
    except EmbeddingUnavailable as e:
        status, headers = (503, {"Retry-After": "2"}) if e.retryable else (502, None)
        _log_request(row["id"], "vector-search", alias=alias, request=request, status=status, mark_used=False)
        raise HTTPException(status, str(e), headers=headers) from None
    except Exception as e:
        if _is_timeout(e):
            status, detail = 504, "Vector search exceeded the source timeout. Narrow the filters or review the vector index."
        elif _is_bad_value(e):
            status, detail = 400, "A query vector or filter value is incompatible with its source column. Check dimensions, numeric ranges and filter types."
        else:
            status, detail = 502, "Could not query the vector source. Check database connectivity, privileges and pgvector configuration."
        # Do not log raw SQL exceptions: drivers may echo the query embedding.
        logger.warning("Vector search failed for %s/%s (%s)", api_id, alias, type(e).__name__)
        _log_request(row["id"], "vector-search", alias=alias, request=request, status=status, mark_used=False)
        raise HTTPException(status_code=status, detail=detail) from None

    elapsed_ms = int((time.monotonic() - started) * 1000)
    warnings = []
    if body.search_mode == "auto":
        warnings.append("The source may use an approximate index. Recall is not guaranteed; filters can yield fewer than top_k results. Use search_mode=exact to compare.")
    if body.search_mode == "auto" and tuple(int(v) for v in vector.get("extension_version", "0.0.0").split(".")[:3] if v.isdigit()) < (0, 8, 0):
        warnings.append("pgvector is older than 0.8.0; iterative scans are unavailable. Filtered ANN recall needs special validation.")
    if vector["dimensions"] is None:
        warnings.append("This column has variable dimensions. Only rows with the query vector's dimension are eligible.")
    payload = {
        "alias": alias,
        "vector_column": vector_column,
        "dimensions": len(query_vector),
        "metric": body.metric,
        "search_mode": body.search_mode,
        "requested_top_k": body.top_k,
        "top_k": top_k,
        "row_count": len(matches),
        "columns": projection,
        "matches": matches,
        "elapsed_ms": elapsed_ms,
        "warnings": warnings,
        "recall_guaranteed": body.search_mode == "exact",
        "eligible_ann_index_count": len(eligible_indexes),
        "returned_top_k": len(matches),
        "top_k_filled": len(matches) == top_k,
        "decimal_encoding": "string",
        "query_source": "text" if embedding_model else "vector",
        "embedding_model": embedding_model,
    }
    encoded = _lossless_json(payload)
    if len(encoded) > MAX_RESPONSE_BYTES:
        METRICS.add("vector_response_too_large")
        _log_request(row["id"], "vector-search", alias=alias, request=request, status=413, mark_used=False)
        raise HTTPException(413, "Vector response exceeds the byte budget. Select fewer columns or reduce top_k.")
    _log_request(row["id"], "vector-search", alias=alias, request=request, row_count=len(matches), duration_ms=elapsed_ms)
    METRICS.add("vector_responses")
    return Response(content=encoded, media_type="application/json")


@data_api_router.post("/{api_id}/{alias}/retrieve")
def exec_retrieve(
    api_id: str,
    alias: str,
    body: RetrievalRequest,
    request: Request,
    api_key: str = Query(""),
):
    """Semantic / hybrid retrieval from query text. The server embeds each
    query with the model registered for the table, so callers never handle
    embeddings. Additive endpoint; existing endpoints are unchanged."""
    header_key = request.headers.get("x-api-key", "")
    with _db(autocommit=True) as db_conn:
        row = _authorize_key(db_conn, api_id, api_key or header_key, request=request,
                             endpoint="retrieve", alias=alias)
    t = _lookup_alias(row["id"], alias)
    if not t:
        _log_request(row["id"], "retrieve", alias=alias, request=request, status=404, mark_used=False)
        raise HTTPException(status_code=404, detail=f"No table with alias '{alias}' on this API.")
    try:
        payload = _run_retrieval(t, body, _caller_id(api_key or header_key))
    except Exception as e:
        err = _retrieval_error(e)
        if not isinstance(e, HTTPException) and err.status_code >= 500:
            logger.warning("Retrieval failed for %s/%s (%s)", api_id, alias, type(e).__name__)
        _log_request(row["id"], "retrieve", alias=alias, request=request, status=err.status_code, mark_used=False)
        raise err from None
    encoded = _lossless_json(payload)
    if len(encoded) > MAX_RESPONSE_BYTES:
        METRICS.add("retrieve_response_too_large")
        _log_request(row["id"], "retrieve", alias=alias, request=request, status=413, mark_used=False)
        raise HTTPException(413, "Retrieval response exceeds the byte budget. Reduce k or the number of queries.")
    total = sum(len(next(v for k, v in r.items() if k != "k")) for r in payload["results"])
    _log_request(row["id"], "retrieve", alias=alias, request=request, row_count=total,
                 duration_ms=payload["elapsed_ms"])
    METRICS.add("retrieve_responses")
    return Response(content=encoded, media_type="application/json")


# ============================================================================
# Semantic-search administration (portal). All configuration is data:
# embedding models, per-column model registrations, versioned response
# contracts and per-alias settings. Nothing needs a code change.
# ============================================================================

_TEXT_TYPES = {"text", "varchar", "character varying", "char", "character", "bpchar", "citext", "tsvector", "name"}


class SearchModelBody(BaseModel):
    name: str
    deployment: str
    dimensions: int
    endpoint: str = ""
    api_version: str = ""
    api_key_env: str = "AZURE_OPENAI_EMBED_API_KEY"
    query_prefix: str = ""
    send_dimensions: bool = False


class SearchContractBody(BaseModel):
    name: str
    description: str = ""
    definition: Dict[str, Any]


class AliasSearchBody(BaseModel):
    settings: Dict[str, Any]
    # {vector column: model id} to register (or re-register) the model that
    # built that column. Shared by every API that publishes the same table.
    registration: Optional[Dict[str, str]] = None
    replace_registration: bool = False
    planner: bool = True
    test_embedding: bool = False


def _editor(auth: dict) -> str:
    return auth.get("user", {}).get("email") or auth.get("user", {}).get("name") or "unknown"


def _require_search_ready():
    if not _search_ready():
        raise HTTPException(409, SEARCH_NOT_INSTALLED)


def _alias_row(conn, api_id: str, table_id: str):
    api = _get_api(conn, api_id)  # 404 if missing
    t = conn.execute("SELECT * FROM data_api_tables WHERE id = ? AND api_id = ?", (table_id, api["id"])).fetchone()
    if not t:
        raise HTTPException(404, "No such table on this API.")
    return api, t


def _settings_usage(conn) -> List[dict]:
    """Every alias with stored search settings (orphans of deleted aliases are ignored)."""
    rows = conn.execute(
        "SELECT s.table_id, s.settings, t.alias, t.source_system, t.env, t.database_name, t.schema_name, "
        "t.table_name, a.name AS api_name, a.slug FROM data_api_search_settings s "
        "JOIN data_api_tables t ON t.id = s.table_id JOIN data_apis a ON a.id = t.api_id").fetchall()
    out = []
    for r in rows:
        try:
            settings = json.loads(r["settings"])
        except ValueError:
            continue
        out.append({"row": r, "settings": settings, "label": f"{r['api_name']} /{r['alias']}"})
    return out


def _model_public(r, registrations: int) -> dict:
    return {"id": r["id"], "name": r["name"], "deployment": r["deployment"], "dimensions": r["dimensions"],
            "endpoint": r["endpoint"], "api_version": r["api_version"], "api_key_env": r["api_key_env"],
            "query_prefix": r["query_prefix"], "send_dimensions": bool(r["send_dimensions"]),
            # Whether the key resolves on this server (dq_config.json, .env or
            # environment, like the assistant); the value is never returned.
            "key_configured": credential_configured(r["api_key_env"]),
            "registrations": registrations, "updated_by": r["updated_by"] or r["created_by"],
            "updated_at": r["updated_at"] or r["created_at"]}


def _validate_alias_search(t, raw_settings: dict, register: Dict[str, str], replace_registration: bool,
                           planner: bool, test_embedding: bool) -> dict:
    """Full check of one alias's settings against its table's live catalog.
    Reads only the system catalog, the planner's EXPLAIN (never ANALYZE) and,
    if asked, one embedding call. No table data is scanned, so this is safe on
    billion-row tables."""
    errors: List[str] = []
    warnings: List[str] = []
    info: Dict[str, Any] = {}
    report = {"errors": errors, "warnings": warnings, "info": info}
    try:
        s = validate_settings(raw_settings)
    except SearchConfigError as e:
        errors.append(str(e))
        return report
    report["settings"] = s
    if not s["enabled"]:
        info["note"] = "Search is off for this alias; nothing else was checked."
        return report

    with _db() as conn:
        regs = _table_registrations(conn, t)
        models = {r["id"]: r for r in conn.execute("SELECT * FROM data_api_embedding_models").fetchall()}
        contract = _contract_row(conn, s["contract_id"])
        shared = [u["label"] for u in _settings_usage(conn)
                  if u["row"]["table_id"] != t["id"] and _reg_key(u["row"]) == _reg_key(t)
                  and u["settings"].get("enabled") and u["settings"].get("vector_column") == s["vector_column"]]

    model = None
    col = s["vector_column"]
    if col:
        chosen = (register or {}).get(col)
        existing = regs.get(col)
        model_row = None
        if chosen:
            model_row = models.get(chosen)
            if model_row is None:
                errors.append("The selected embedding model no longer exists.")
            elif existing and existing["model"]["id"] != chosen and not replace_registration:
                errors.append(
                    f"'{col}' is already registered to model '{existing['model']['name']}'"
                    + (f", which {', '.join(shared)} also use" if shared else "")
                    + ". Change it only after the column's vectors were rebuilt with the new model, "
                      "and confirm that you did.")
        elif existing:
            model_row = existing["model"]
        else:
            errors.append(f"Register the embedding model that built '{col}'.")
        if model_row is not None:
            try:
                model = _model_from_row(model_row)
                info["model"] = model.name
            except SearchConfigError as e:
                errors.append(f"Model '{model_row['name']}': {e}")
        if shared:
            info["shared_with"] = shared

    lookups = {}
    contract_def = None
    if s["contract_id"]:
        if contract is None:
            errors.append("The selected response contract no longer exists.")
        else:
            try:
                contract_def, lookups = validate_contract(json.loads(contract["definition"]))
                info["contract"] = f"{contract['name']} v{contract['version']}"
            except SearchConfigError as e:
                errors.append(f"Contract: {e}")
    if errors:
        return report

    try:
        with _connector(t["source_system"], t["env"], t["database_name"]) as source:
            if not getattr(source, "SUPPORTS_VECTOR_SEARCH", False):
                errors.append("Semantic search requires a PostgreSQL source.")
                return report
            _meta_evict([t["id"]])  # judge the catalog as it is now, not as cached
            meta = _table_meta(t, source)
            db, schema, table = t["database_name"], t["schema_name"], t["table_name"]
            estimate = source.estimate_rows(db, schema, table)
            info["row_estimate"] = estimate
            rows_text = f"~{estimate:,} rows" if estimate is not None else "an unknown number of rows (never analyzed)"
            if not meta.key_is_unique:
                errors.append("The table needs a primary key or unique index so semantic and keyword results can be merged.")
            vec = None
            ann = []
            if col:
                vec = next((v for v in _vector_columns(t, source, meta) if v["name"] == col), None)
                if vec is None:
                    errors.append(f"'{col}' is not a pgvector column exposed by this alias.")
                else:
                    ann = [i for i in vec.get("ann_indexes", []) if i["metric"] == s["metric"]]
                    info["vector"] = {"type": vec["type"], "dimensions": vec["dimensions"],
                                      "pgvector": vec.get("extension_version"),
                                      "ann_indexes": [
                                          f"{i['name']} ({i['method']}, {i['metric']}"
                                          + (", halfvec expression" if i.get("index_kind") == "halfvec_cast" else "") + ")"
                                          for i in vec.get("ann_indexes", [])
                                      ]}
                    if model and vec["dimensions"] is not None and vec["dimensions"] != model.dimensions:
                        errors.append(f"Model '{model.name}' produces {model.dimensions} dimensions but '{col}' stores {vec['dimensions']}.")
                    if vec["dimensions"] is None and not s["allow_exact"]:
                        errors.append(f"'{col}' has variable dimensions, so it has no ANN index; semantic search would need exact mode.")
                    if not ann:
                        msg = f"No valid ANN (HNSW/IVFFlat) index on '{col}' for {s['metric']}."
                        if s["allow_exact"]:
                            warnings.append(msg + f" Callers must use exact search, which reads every row ({rows_text}).")
                        else:
                            errors.append(msg + " A DBA must create one, or (small tables only) allow exact search.")
                    if s["allow_exact"]:
                        warnings.append(f"Exact search reads every row ({rows_text}). Keep it off for large tables.")
                    if (s["semantic_timeout_ms"] or 0) >= RETRIEVAL_TIMEOUT_MS:
                        warnings.append(f"Semantic timeout is not below the overall {RETRIEVAL_TIMEOUT_MS} ms budget.")
                    if source._pgvector_version(vec) < (0, 8, 0):
                        warnings.append(f"pgvector {vec.get('extension_version')} predates iterative index scans (0.8.0); "
                                        "filtered semantic results can come back short. Upgrade to 0.8.x.")
            text_ok = False
            if s["text_column"]:
                tc = s["text_column"]
                col_type = next((_base_type(_col_type(c)) for c in meta.all_columns if c["name"] == tc), "")
                if tc not in meta.exposed:
                    errors.append(f"Keyword column '{tc}' is not exposed by this alias.")
                elif col_type not in _TEXT_TYPES:
                    errors.append(f"Keyword column '{tc}' is {col_type or 'not a text column'}; choose a text or tsvector column.")
                else:
                    config, stored, problem = _keyword_index(source, t, tc, s["text_search_config"], col_type)
                    if problem:
                        errors.append(problem)
                    else:
                        text_ok = True
                        info["keyword"] = {"column": tc, "config": config, "stored_tsvector": stored}
                        s["text_search_config"] = config
                if s["keyword_timeout_ms"] >= RETRIEVAL_TIMEOUT_MS:
                    warnings.append(f"Keyword timeout is not below the overall {RETRIEVAL_TIMEOUT_MS} ms budget, "
                                    "so a slow keyword search cannot fall back to semantic results in time.")
            if contract_def is not None:
                profile = SearchProfile(dict(s, enabled=True), {}, contract_def)
                hidden = [c for c in profile.base_columns() if c not in meta.exposed]
                if hidden:
                    errors.append(f"The contract uses column(s) this alias does not expose: {', '.join(hidden)}.")
                for lk in profile.lookups.values():
                    errors.extend(_lookup_problems(t, source, lk, cached=False))

            if planner and not errors:
                key = meta.sort_key
                pool = s["candidate_pool"]
                if vec is not None and ann and vec["dimensions"]:
                    probe = [1.0] + [0.0] * (vec["dimensions"] - 1)
                    stmt, params = source._vector_statement(schema, table, key, vec, probe, pool, s["metric"],
                                                            None, "auto", key)
                    # Plan it exactly as /retrieve runs it (index preferred, JIT off).
                    with source.read_only_transaction(db, 5000) as pcur:
                        source.prefer_index(pcur)
                        pcur.execute("EXPLAIN " + stmt, params)
                        plan = "\n".join(r[0] for r in pcur.fetchall())
                    used = [i["name"] for i in ann if i["name"] in plan]
                    info["semantic_plan"] = plan.splitlines()[:6]
                    if not used:
                        warnings.append("The semantic search would not use the vector index. Ask a DBA to check the "
                                        "index is valid and to ANALYZE the table.")
                    stats = source.statistics_health(db, schema, table, vec["name"])
                    target = f"{schema}.{table}"
                    if stats and not stats["ever_analyzed"]:
                        warnings.append(f"{target} has never been analyzed, so planner estimates are guesses. "
                                        f"Ask a DBA to run: ANALYZE {target};")
                    elif stats.get("null_frac") is not None and stats["null_frac"] >= 0.9:
                        warnings.append(f"Statistics say {stats['null_frac']:.0%} of '{vec['name']}' values are NULL. "
                                        "If the embeddings were loaded after the last ANALYZE, row estimates and plans "
                                        f"are wrong. Ask a DBA to run: ANALYZE {target};")
                    elif stats.get("live_rows") and (stats.get("modified_since_analyze") or 0) > 0.2 * stats["live_rows"]:
                        warnings.append(f"{stats['modified_since_analyze']:,} rows changed since {target} was last "
                                        f"analyzed. Ask a DBA to run: ANALYZE {target};")
                if text_ok:
                    kw = info["keyword"]
                    stmt, params = source._sparse_statement(schema, table, key, kw["column"], kw["config"],
                                                            kw["stored_tsvector"], "validation", pool, None)
                    plan = source.explain_plan(db, stmt, params)
                    gin = [i["index"] for i in source.get_text_search_indexes(db, schema, table) if i["column"] == kw["column"]]
                    info["keyword_plan"] = plan.splitlines()[:6]
                    if not any(g in plan for g in gin):
                        warnings.append("The planner would not use the full-text index right now. Normal on small "
                                        "tables; on large ones ask a DBA to ANALYZE the table.")
            if test_embedding and model is not None and not errors:
                started = time.monotonic()
                got = embed_queries(model, [f"connection test {uuid.uuid4().hex[:8]}"])[0]
                info["embedding_test"] = {"ms": int((time.monotonic() - started) * 1000), "dimensions": len(got)}
    except HTTPException as e:
        errors.append(str(e.detail))
    except EmbeddingUnavailable as e:
        errors.append(str(e))
    except ConnectorError as e:
        errors.append(str(e))
    except Exception as e:
        logger.warning("Search validation failed for table %s (%s)", t["id"], type(e).__name__)
        errors.append("Could not inspect the source table. Check connectivity and privileges.")
    return report


@data_api_router.get("/search/library")
def search_library(auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Shared semantic-search objects: models, column registrations, contracts."""
    if not _search_ready():
        return {"installed": False, "message": SEARCH_NOT_INSTALLED}
    with _db() as conn:
        models = conn.execute("SELECT * FROM data_api_embedding_models ORDER BY name").fetchall()
        regs = conn.execute("SELECT r.*, m.name AS model_name FROM data_api_vector_registrations r "
                            "JOIN data_api_embedding_models m ON m.id = r.model_id "
                            "ORDER BY r.schema_name, r.table_name, r.column_name").fetchall()
        contracts = conn.execute("SELECT * FROM data_api_contracts ORDER BY name, version DESC").fetchall()
        usage = _settings_usage(conn)
    reg_count: Dict[str, int] = {}
    for r in regs:
        reg_count[r["model_id"]] = reg_count.get(r["model_id"], 0) + 1
    out_regs = []
    for r in regs:
        key = (r["source_system"], r["env"], r["database_name"], r["schema_name"], r["table_name"])
        used = [u["label"] for u in usage if _reg_key(u["row"]) == key and u["settings"].get("enabled")
                and u["settings"].get("vector_column") == r["column_name"]]
        out_regs.append({"id": r["id"], "source_system": r["source_system"], "env": r["env"],
                         "database": r["database_name"], "schema": r["schema_name"], "table": r["table_name"],
                         "column": r["column_name"], "model_id": r["model_id"], "model_name": r["model_name"],
                         "used_by": used})
    out_contracts = []
    for c in contracts:
        used = [u["label"] for u in usage if u["settings"].get("contract_id") == c["id"]]
        out_contracts.append({"id": c["id"], "name": c["name"], "version": c["version"], "description": c["description"],
                              "definition": json.loads(c["definition"]), "created_by": c["created_by"],
                              "created_at": c["created_at"], "used_by": used})
    return {"installed": True, "allowed_hosts": allowed_embedding_hosts(),
            "defaults": {"semantic_timeout_ms": VECTOR_TIMEOUT_MS, "retrieval_timeout_ms": RETRIEVAL_TIMEOUT_MS},
            "models": [_model_public(m, reg_count.get(m["id"], 0)) for m in models],
            "registrations": out_regs, "contracts": out_contracts}


@data_api_router.post("/search/models")
def create_search_model(body: SearchModelBody, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    _require_search_ready()
    try:
        m = validate_model(body.model_dump() if hasattr(body, "model_dump") else body.dict())
    except SearchConfigError as e:
        raise HTTPException(400, str(e)) from None
    now, editor = _now().isoformat(), _editor(auth)
    with _db() as conn:
        # The name is UNIQUE; ON CONFLICT answers two simultaneous creates
        # with a clean 409 instead of letting the second one fail the insert.
        model_id = str(uuid.uuid4())
        row = conn.execute(
            "INSERT INTO data_api_embedding_models (id, name, deployment, dimensions, endpoint, api_version, "
            "api_key_env, query_prefix, send_dimensions, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT (name) DO NOTHING RETURNING *",
            (model_id, m["name"], m["deployment"], m["dimensions"], m["endpoint"], m["api_version"],
             m["api_key_env"], m["query_prefix"], bool(m["send_dimensions"]), editor, now)).fetchone()
        if row is None:
            raise HTTPException(409, f"A model named '{m['name']}' already exists.")
    write_audit_event(action="data_api_search_model_created", performed_by=editor, target=m["name"],
                      details=f"deployment={m['deployment']} dimensions={m['dimensions']}")
    return _model_public(row, 0)


@data_api_router.put("/search/models/{model_id}")
def update_search_model(model_id: str, body: SearchModelBody,
                        auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Routing details (endpoint, API version, key variable) may change at any
    time. What the model produces (deployment, dimensions, prefix) may not
    while columns are registered to it: that would silently mismatch vectors
    already stored. Create a new model and re-register instead."""
    _require_search_ready()
    try:
        m = validate_model(body.model_dump() if hasattr(body, "model_dump") else body.dict())
    except SearchConfigError as e:
        raise HTTPException(400, str(e)) from None
    editor = _editor(auth)
    with _db() as conn:
        # FOR UPDATE: the registration count below must still hold when the
        # update lands (registrations take a key-share lock on this row).
        old = conn.execute("SELECT * FROM data_api_embedding_models WHERE id = ? FOR UPDATE", (model_id,)).fetchone()
        if not old:
            raise HTTPException(404, "No such model.")
        used = conn.execute("SELECT COUNT(*) AS n FROM data_api_vector_registrations WHERE model_id = ?",
                            (model_id,)).fetchone()["n"]
        output_changed = (old["deployment"] != m["deployment"] or old["dimensions"] != m["dimensions"]
                          or old["query_prefix"] != m["query_prefix"] or bool(old["send_dimensions"]) != m["send_dimensions"])
        if used and output_changed:
            raise HTTPException(409, f"'{old['name']}' is registered to {used} column(s). Changing its deployment, "
                                     "dimensions or prefix would mismatch vectors already stored. Create a new model, "
                                     "rebuild the vectors, then re-register those columns.")
        if m["name"] != old["name"] and conn.execute(
                "SELECT 1 FROM data_api_embedding_models WHERE name = ? AND id <> ?", (m["name"], model_id)).fetchone():
            raise HTTPException(409, f"A model named '{m['name']}' already exists.")
        try:
            row = conn.execute(
                "UPDATE data_api_embedding_models SET name=?, deployment=?, dimensions=?, endpoint=?, api_version=?, "
                "api_key_env=?, query_prefix=?, send_dimensions=?, updated_by=?, updated_at=? WHERE id=? RETURNING *",
                (m["name"], m["deployment"], m["dimensions"], m["endpoint"], m["api_version"], m["api_key_env"],
                 m["query_prefix"], bool(m["send_dimensions"]), editor, _now().isoformat(), model_id)).fetchone()
        except core_db.UniqueViolation:
            raise HTTPException(409, f"A model named '{m['name']}' already exists.") from None
    write_audit_event(action="data_api_search_model_updated", performed_by=editor, target=m["name"],
                      details=f"endpoint={m['endpoint'] or '(server default)'} api_version={m['api_version'] or '(default)'}")
    return _model_public(row, used)


@data_api_router.delete("/search/models/{model_id}")
def delete_search_model(model_id: str, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    _require_search_ready()
    with _db() as conn:
        old = conn.execute("SELECT * FROM data_api_embedding_models WHERE id = ? FOR UPDATE", (model_id,)).fetchone()
        if not old:
            raise HTTPException(404, "No such model.")
        if conn.execute("SELECT 1 FROM data_api_vector_registrations WHERE model_id = ?", (model_id,)).fetchone():
            raise HTTPException(409, f"'{old['name']}' is still registered to columns; remove those registrations first.")
        conn.execute("DELETE FROM data_api_embedding_models WHERE id = ?", (model_id,))
    write_audit_event(action="data_api_search_model_deleted", performed_by=_editor(auth), target=old["name"], details="")
    return {"deleted": True}


@data_api_router.post("/search/models/{model_id}/test")
def test_search_model(model_id: str, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """One real embedding call: proves endpoint, key and dimensions."""
    _require_search_ready()
    with _db() as conn:
        row = conn.execute("SELECT * FROM data_api_embedding_models WHERE id = ?", (model_id,)).fetchone()
    if not row:
        raise HTTPException(404, "No such model.")
    try:
        model = _model_from_row(row)
        started = time.monotonic()
        got = embed_queries(model, [f"connection test {uuid.uuid4().hex[:8]}"])[0]
    except (SearchConfigError, EmbeddingUnavailable) as e:
        return {"ok": False, "message": str(e)}
    return {"ok": True, "ms": int((time.monotonic() - started) * 1000), "dimensions": len(got)}


@data_api_router.delete("/search/registrations/{registration_id}")
def delete_search_registration(registration_id: str, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    _require_search_ready()
    with _db() as conn:
        r = conn.execute("SELECT * FROM data_api_vector_registrations WHERE id = ?", (registration_id,)).fetchone()
        if not r:
            raise HTTPException(404, "No such registration.")
        key = (r["source_system"], r["env"], r["database_name"], r["schema_name"], r["table_name"])
        used = [u["label"] for u in _settings_usage(conn) if _reg_key(u["row"]) == key
                and u["settings"].get("enabled") and u["settings"].get("vector_column") == r["column_name"]]
        if used:
            raise HTTPException(409, f"Still used by {', '.join(used)}. Turn search off there, or switch column, first.")
        conn.execute("DELETE FROM data_api_vector_registrations WHERE id = ?", (registration_id,))
    write_audit_event(action="data_api_search_registration_deleted", performed_by=_editor(auth),
                      target=f"{r['schema_name']}.{r['table_name']}.{r['column_name']}", details="")
    return {"deleted": True}


@data_api_router.post("/search/contracts")
def create_search_contract(body: SearchContractBody, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Contracts are immutable: saving under an existing name creates the next
    version, so an API that pinned an earlier version never changes shape."""
    _require_search_ready()
    name = body.name.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\- ]{0,63}", name):
        raise HTTPException(400, "Name: 1-64 letters, digits, spaces, dot, dash or underscore.")
    try:
        definition, _ = validate_contract(body.definition)
    except SearchConfigError as e:
        raise HTTPException(400, f"Contract: {e}") from None
    editor = _editor(auth)
    with _db() as conn:
        # Two saves under one name must get versions n+1 and n+2, not both n+1.
        core_db.advisory_xact_lock(conn, f"data-api-contract:{name}")
        latest = conn.execute("SELECT MAX(version) AS v FROM data_api_contracts WHERE name = ?", (name,)).fetchone()
        version = (latest["v"] or 0) + 1
        contract_id = str(uuid.uuid4())
        conn.execute("INSERT INTO data_api_contracts (id, name, version, description, definition, created_by, created_at) "
                     "VALUES (?,?,?,?,?,?,?)", (contract_id, name, version, body.description.strip()[:500],
                                                json.dumps(definition), editor, _now().isoformat()))
    write_audit_event(action="data_api_search_contract_created", performed_by=editor, target=f"{name} v{version}",
                      details=f"fields={len(definition['fields'])} objects={len(definition['objects'])} "
                              f"lookups={len(definition['lookups'])}")
    return {"id": contract_id, "name": name, "version": version, "definition": definition}


@data_api_router.delete("/search/contracts/{contract_id}")
def delete_search_contract(contract_id: str, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    _require_search_ready()
    with _db() as conn:
        c = conn.execute("SELECT * FROM data_api_contracts WHERE id = ?", (contract_id,)).fetchone()
        if not c:
            raise HTTPException(404, "No such contract.")
        used = [u["label"] for u in _settings_usage(conn) if u["settings"].get("contract_id") == contract_id]
        if used:
            raise HTTPException(409, f"Still used by {', '.join(used)}.")
        conn.execute("DELETE FROM data_api_contracts WHERE id = ?", (contract_id,))
    write_audit_event(action="data_api_search_contract_deleted", performed_by=_editor(auth),
                      target=f"{c['name']} v{c['version']}", details="")
    return {"deleted": True}


@data_api_router.get("/{api_id}/search")
def list_api_search(api_id: str, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Stored search settings for every alias of one API (metadata DB only;
    no source connections), for the portal's alias list."""
    if not _search_ready():
        return {"installed": False, "message": SEARCH_NOT_INSTALLED, "aliases": {}}
    with _db() as conn:
        api = _get_api(conn, api_id)
        tables = _get_tables(conn, api["id"])
        contracts = {c["id"]: f"{c['name']} v{c['version']}"
                     for c in conn.execute("SELECT id, name, version FROM data_api_contracts").fetchall()}
        out = {}
        for t in tables:
            settings = _stored_settings(conn, t["id"])
            if settings:
                reg = _table_registrations(conn, t).get(settings.get("vector_column") or "")
                out[t["id"]] = {"settings": settings, "model": reg["model"]["name"] if reg else None,
                                "contract": contracts.get(settings.get("contract_id"))}
    return {"installed": True, "aliases": out}


@data_api_router.get("/{api_id}/tables/{table_id}/search")
def get_alias_search(api_id: str, table_id: str, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Current settings plus what the table offers (catalog only)."""
    if not _search_ready():
        return {"installed": False, "message": SEARCH_NOT_INSTALLED}
    with _db() as conn:
        _, t = _alias_row(conn, api_id, table_id)
        settings = _stored_settings(conn, t["id"])
        regs = _table_registrations(conn, t)
    options: Dict[str, Any] = {"supported": False}
    try:
        with _connector(t["source_system"], t["env"], t["database_name"]) as source:
            if getattr(source, "SUPPORTS_VECTOR_SEARCH", False):
                meta = _table_meta(t, source)
                vectors = _vector_columns(t, source, meta)
                indexes = source.get_text_search_indexes(t["database_name"], t["schema_name"], t["table_name"])
                by_type = {c["name"]: _base_type(_col_type(c)) for c in meta.all_columns}
                options = {
                    "supported": True,
                    "row_estimate": source.estimate_rows(t["database_name"], t["schema_name"], t["table_name"]),
                    "unique_key": meta.sort_key if meta.key_is_unique else [],
                    "vector_columns": [{"name": v["name"], "type": v["type"], "dimensions": v["dimensions"],
                                        "pgvector": v.get("extension_version"),
                                        "ann_metrics": sorted({i["metric"] for i in v.get("ann_indexes", [])})}
                                       for v in vectors],
                    "vector_index_strategies": {
                        v["name"]: [
                            {"name": i["name"], "method": i["method"], "metric": i["metric"],
                             "representation": "halfvec expression" if i.get("index_kind") == "halfvec_cast"
                                               else v["type"]}
                            for i in v.get("ann_indexes", [])
                        ] for v in vectors
                    },
                    "text_columns": [{"name": c, "type": by_type[c],
                                      "gin_configs": sorted({i["config"] or "(stored tsvector)" for i in indexes if i["column"] == c})}
                                     for c in meta.exposed if by_type.get(c) in _TEXT_TYPES],
                    "exposed_columns": list(meta.exposed),
                }
            else:
                options["reason"] = "Semantic search requires a PostgreSQL source."
    except HTTPException as e:
        options["reason"] = str(e.detail)
    except Exception as e:
        logger.warning("Search options failed for table %s (%s)", table_id, type(e).__name__)
        options["reason"] = "Could not inspect the source table. Check connectivity and privileges."
    return {"installed": True, "alias": t["alias"], "settings": settings,
            "registrations": {c: {"model_id": r["model"]["id"], "model_name": r["model"]["name"]} for c, r in regs.items()},
            "options": options}


@data_api_router.post("/{api_id}/tables/{table_id}/search/validate")
def validate_alias_search(api_id: str, table_id: str, body: AliasSearchBody,
                          auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Dry run: every save-time check, plus the planner's EXPLAIN and an
    optional embedding call. Saves nothing."""
    _require_search_ready()
    with _db() as conn:
        _, t = _alias_row(conn, api_id, table_id)
    return _validate_alias_search(t, body.settings, body.registration or {}, body.replace_registration,
                                  planner=body.planner, test_embedding=body.test_embedding)


@data_api_router.put("/{api_id}/tables/{table_id}/search")
def save_alias_search(api_id: str, table_id: str, body: AliasSearchBody,
                      auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Save one alias's search settings. Rejected (422 with the report) if
    any check fails, so a stored configuration is always one that worked
    against the live catalog when saved."""
    _require_search_ready()
    with _db() as conn:
        api, t = _alias_row(conn, api_id, table_id)
    report = _validate_alias_search(t, body.settings, body.registration or {}, body.replace_registration,
                                    planner=True, test_embedding=False)
    if report["errors"]:
        raise HTTPException(422, {"message": "Not saved: fix the errors below.", **report})
    s = report["settings"]
    now, editor = _now().isoformat(), _editor(auth)
    registered = None
    with _db() as conn:
        col = s["vector_column"]
        model_id = (body.registration or {}).get(col) if col else None
        if s["enabled"] and model_id:
            key = _reg_key(t)
            # Serialise saves that touch the same physical column, so the
            # registered / re-registered decision below can't race.
            core_db.advisory_xact_lock(conn, "data-api-reg:" + "\x1f".join(key + (col,)))
            existing = conn.execute(
                "SELECT id, model_id FROM data_api_vector_registrations WHERE source_system = ? AND env = ? AND "
                "database_name = ? AND schema_name = ? AND table_name = ? AND column_name = ?", key + (col,)).fetchone()
            if existing is None:
                conn.execute("INSERT INTO data_api_vector_registrations (id, source_system, env, database_name, schema_name, "
                             "table_name, column_name, model_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                             (str(uuid.uuid4()),) + key + (col, model_id, editor, now))
                registered = "registered"
            elif existing["model_id"] != model_id:
                conn.execute("UPDATE data_api_vector_registrations SET model_id = ?, created_by = ?, created_at = ? "
                             "WHERE id = ?", (model_id, editor, now, existing["id"]))
                registered = "re-registered"
        stored = json.dumps(s)
        conn.execute("INSERT INTO data_api_search_settings (table_id, settings, updated_by, updated_at) VALUES (?,?,?,?) "
                     "ON CONFLICT (table_id) DO UPDATE SET settings = EXCLUDED.settings, "
                     "updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at",
                     (t["id"], stored, editor, now))
    _meta_evict([t["id"]])
    write_audit_event(
        action="data_api_search_updated", performed_by=editor, target=api["name"],
        details=(f"alias={t['alias']} enabled={s['enabled']} modes={','.join(s['modes'])} "
                 f"vector={s['vector_column']} keyword={s['text_column']} contract={s['contract_id'] or '-'}"
                 + (f" model {registered} for {s['vector_column']}" if registered else "")))
    return {"saved": True, **report}


@data_api_router.delete("/{api_id}/tables/{table_id}/search")
def delete_alias_search(api_id: str, table_id: str, auth: dict = Depends(require_permission("manageDataAPIExports"))):
    """Remove an alias's search settings (the shared model registration stays)."""
    _require_search_ready()
    with _db() as conn:
        api, t = _alias_row(conn, api_id, table_id)
        conn.execute("DELETE FROM data_api_search_settings WHERE table_id = ?", (t["id"],))
    write_audit_event(action="data_api_search_removed", performed_by=_editor(auth), target=api["name"],
                      details=f"alias={t['alias']}")
    return {"deleted": True}


@data_api_router.get("/runtime/status")
def data_api_runtime_status(auth: dict = Depends(require_permission("manageDataAPIExports"))):
    return {
        "scope": "this worker; aggregate across replicas in your monitoring system",
        "pid": os.getpid(), "metadata": STORE.snapshot(),
        "source_pool": SOURCE_POOL.snapshot(), "admission": HTTP_GATE.snapshot(),
        "exact_admission": EXACT_GATE.snapshot(), "counters": METRICS.snapshot(),
        "shared_rate_limit": RATE_LIMIT_MAX > 0,
        "semantic_search": {"installed": _search_ready(),
                            "embedding_hosts_allowed": allowed_embedding_hosts()},
    }