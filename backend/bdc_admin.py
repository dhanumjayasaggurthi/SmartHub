import math
import threading
from datetime import datetime
import pytz

EASTERN = pytz.timezone('America/New_York')
from typing import Optional
import re as _re
import time as _time

from fastapi import APIRouter, Body, HTTPException, Query, Header, Depends

from auth import require_auth, require_permission

# ─── Router ───────────────────────────────────────────────────────────────────
admin_router = APIRouter(prefix="/api/admin", tags=["Admin"])

# ─── Injected BDC dependencies (set once at startup by Backend.py) ────────────
_bdc_config_manager = None
_bdc_connection_manager = None


def set_bdc_dependencies(config_manager, connection_manager):
    global _bdc_config_manager, _bdc_connection_manager
    _bdc_config_manager = config_manager
    _bdc_connection_manager = connection_manager


def _require_bdc():
    """Raise 503 if the BDC service is unavailable."""
    if not _bdc_connection_manager or not _bdc_config_manager:
        raise HTTPException(status_code=503, detail="BDC service is not available")


class _WriteConnectionManager:
    """
    Lightweight single-connection pool for write operations.
    Uses business_defined_checks_write config if present, otherwise falls back
    to the standard business_defined_checks read config.
    Refreshes automatically after 2 hours (same TTL as the read manager).
    """
    CONNECTION_TTL = 2 * 60 * 60  # 2 hours

    def __init__(self):
        self._conn = None
        self._created_at = None
        self._lock = threading.Lock()

    def _is_expired(self) -> bool:
        return self._created_at is None or (_time.time() - self._created_at) > self.CONNECTION_TTL

    def _build_conn(self, sf_config: dict):
        """Create a raw Snowflake connection from a config dict."""
        from cryptography.hazmat.primitives import serialization as _ser
        from pathlib import Path as _Path
        import snowflake.connector as _sf

        pk_path = sf_config["private_key_path"]
        pk_password = sf_config.get("private_key_password", "")

        if not _Path(pk_path).exists():
            raise FileNotFoundError(f"Write private key not found: {pk_path}")

        with open(pk_path, "rb") as f:
            key = _ser.load_pem_private_key(
                f.read(),
                password=pk_password.encode() if pk_password else None,
            )
        pk_bytes = key.private_bytes(
            encoding=_ser.Encoding.DER,
            format=_ser.PrivateFormat.PKCS8,
            encryption_algorithm=_ser.NoEncryption(),
        )

        return _sf.connect(
            user=sf_config["user"],
            account=sf_config["account"],
            private_key=pk_bytes,
            role=sf_config["role"],
            warehouse=sf_config["warehouse"],
            database=sf_config["database"],
            schema=sf_config.get("schema", "PUBLIC"),
        )

    def get_cursor(self):
        """
        Return a raw cursor for write operations.

        Lookup order:
          1. business_defined_checks_write config  → dedicated write account
          2. business_defined_checks config        → fallback to the read account (logs a warning)
        """
        if not _bdc_config_manager:
            raise HTTPException(status_code=503, detail="BDC config not available")

        main_cfg = _bdc_config_manager.config or {}
        if "business_defined_checks_write" in main_cfg:
            sf_config = main_cfg["business_defined_checks_write"]
        else:
            import logging as _log
            _log.getLogger("bdc_admin").warning(
                "No business_defined_checks_write config found — falling back to read "
                "connection for write ops. Add a 'business_defined_checks_write' block "
                "to dq_config.json for dedicated write credentials."
            )
            sf_config = _bdc_config_manager.get_snowflake_config()

        with self._lock:
            if self._conn is None or self._is_expired():
                try:
                    if self._conn is not None:
                        try:
                            self._conn.close()
                        except:
                            pass
                    self._conn = self._build_conn(sf_config)
                    self._created_at = _time.time()
                    import logging as _log2
                    _log2.getLogger("bdc_admin").info("✅ Write connection established")
                except Exception as e:
                    raise HTTPException(
                        status_code=503,
                        detail=f"Failed to open write connection: {type(e).__name__}: {e}"
                    )
            try:
                cur = self._conn.cursor()
                cur.execute("SELECT 1")
                cur.close()
            except Exception:
                try:
                    self._conn = self._build_conn(sf_config)
                    self._created_at = _time.time()
                except Exception as e:
                    raise HTTPException(
                        status_code=503,
                        detail=f"Write connection lost and could not reconnect: {e}"
                    )

            return self._conn.cursor()

    def close_all(self):
        if self._conn:
            try:
                self._conn.close()
            except:
                pass
        self._conn = None
        self._created_at = None


_write_mgr = _WriteConnectionManager()


def _raw_write_cursor():
    _require_bdc()
    return _write_mgr.get_cursor()


# ═══════════════════════════════════════════════════════════════════════════════
# DQ Table Full Viewer
# ═══════════════════════════════════════════════════════════════════════════════
_DQ_TABLE_KEY_MAP = {
    "rule-input":    "rule_input_table",
    "rule-registry": "rule_registry_table",
    # "date-input" is intentionally absent — resolved by _date_input_table_name()
    # which always uses "date_input_table" + default db/schema prefix (CRUD only).
    # The separate "date_range_table_fqn" table is handled by _date_range_table_name()
    # and is only used by the active-ranges banner endpoint.
}


@admin_router.get("/dq-tables/{table_type}")
def get_dq_table_full(
        table_type: str,
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1, le=200),
        auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    _require_bdc()

    sf = _bdc_connection_manager.get_client()
    dq_config = _bdc_config_manager.get_dq_config()

    # date-input uses its own resolver so it honours date_range_table_fqn
    if table_type == "date-input":
        table_name = _date_input_table_name()
    else:
        table_key = _DQ_TABLE_KEY_MAP.get(table_type)
        if not table_key:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown table_type '{table_type}'. Valid values: {sorted(list(_DQ_TABLE_KEY_MAP) + ['date-input'])}"
            )
        if table_key not in dq_config:
            raise HTTPException(
                status_code=404,
                detail=f"'{table_key}' is not configured."
            )
        table_name = _bdc_config_manager.get_full_table_name(dq_config[table_key])
    offset = (page - 1) * page_size

    count_result = sf.execute(f"SELECT COUNT(*) FROM {table_name}")
    total_count = int(count_result.rows[0][0]) if count_result.rows else 0

    # Use a stable sort so rows don't reorder after IS_ACTIVE updates
    order_clause = {
        "date-input": "ORDER BY REPORT_SET, FROM_DATE",
    }.get(table_type, "")

    result = sf.execute(f"SELECT * FROM {table_name} {order_clause} LIMIT {page_size} OFFSET {offset}")

    return {
        "table_name": table_name,
        "columns": result.columns,
        "rows": [
            [str(cell) if cell is not None else None for cell in row]
            for row in result.rows
        ],
        "total_count": total_count,
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, math.ceil(total_count / page_size)),
    }



# ═══════════════════════════════════════════════════════════════════════════════
# DQ Rule Input Table — Row Edit
# ═══════════════════════════════════════════════════════════════════════════════

@admin_router.get("/dq-tables/rule-input/schema")
def get_rule_input_schema(
        auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """
    Return column names + nullability for the rule input table so the
    frontend can render a properly typed edit form.
    """
    _require_bdc()

    sf = _bdc_connection_manager.get_client()
    dq_config = _bdc_config_manager.get_dq_config()

    if "rule_input_table" not in dq_config:
        raise HTTPException(status_code=404, detail="rule_input_table not configured.")

    table_name = _bdc_config_manager.get_full_table_name(dq_config["rule_input_table"])

    result = sf.execute(f"SELECT * FROM {table_name} LIMIT 1")

    return {
        "table_name": table_name,
        "columns": result.columns,
    }




def _parse_version(rule_id: str):
    # Split RULE_ID into (base, version_number)
    # 'BDC_001'    -> ('BDC_001', 0)
    # 'BDC_001_v1' -> ('BDC_001', 1)
    m = _re.match(r'^(.+?)_v(\d+)$', rule_id, _re.IGNORECASE)
    if m:
        return m.group(1), int(m.group(2))
    return rule_id, 0


def _raw_cursor():
    return _bdc_connection_manager.get_client().conn.cursor()


def _next_version_id(table_name: str, rule_id: str) -> str:
    base, _ = _parse_version(rule_id)
    like_pattern = f"{base.upper()}%"

    cur = _raw_cursor()
    try:
        cur.execute(
            f"SELECT RULE_ID FROM {table_name} WHERE UPPER(RULE_ID) LIKE %s",
            (like_pattern,)
        )
        rows = cur.fetchall()
    finally:
        cur.close()

    max_ver = 0
    for (rid,) in rows:
        _, ver = _parse_version(str(rid))
        if ver > max_ver:
            max_ver = ver

    return f"{base}_v{max_ver + 1}"


def _safe_val(v):
    # Convert Snowflake-returned Python types to plain scalars safe for re-insertion
    if v is None:
        return None
    try:
        from decimal import Decimal
        if isinstance(v, Decimal):
            return float(v)
    except ImportError:
        pass
    if hasattr(v, 'isoformat'):
        return v.isoformat()
    return v


@admin_router.get("/dq-tables/rule-input/next-version")
def get_next_version_id(
        rule_id: str = Query(..., description="Current RULE_ID to compute the next version for"),
        auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Preview the next versioned RULE_ID without writing anything."""
    _require_bdc()

    dq_config = _bdc_config_manager.get_dq_config()
    if "rule_input_table" not in dq_config:
        raise HTTPException(status_code=404, detail="rule_input_table not configured.")

    table_name = _bdc_config_manager.get_full_table_name(dq_config["rule_input_table"])
    base, _ = _parse_version(rule_id)
    next_ver_id = _next_version_id(table_name, rule_id)

    return {
        "original_rule_id": rule_id,
        "base_rule_id": base,
        "next_version_id": next_ver_id,
    }


@admin_router.put("/dq-tables/rule-input/row")
def update_rule_input_row(

        payload: dict = Body(...),
        auth: dict = Depends(require_permission("runBDCOperations")),
):
    _require_bdc()

    pk_col = payload.get("primary_key_col", "").strip()
    pk_val = payload.get("primary_key_val")
    updates = payload.get("updates", {})

    if not pk_col:
        raise HTTPException(status_code=400, detail="primary_key_col is required")
    if pk_val is None:
        raise HTTPException(status_code=400, detail="primary_key_val is required")
    if not updates:
        raise HTTPException(status_code=400, detail="updates dict is empty — nothing to save")

    dq_config = _bdc_config_manager.get_dq_config()
    if "rule_input_table" not in dq_config:
        raise HTTPException(status_code=404, detail="rule_input_table not configured.")

    table_name = _bdc_config_manager.get_full_table_name(dq_config["rule_input_table"])
    next_ver_id = _next_version_id(table_name, pk_val)

    # Fetch original row via raw cursor
    cur = _raw_cursor()
    try:
        cur.execute(f"SELECT * FROM {table_name} WHERE {pk_col} = %s", (pk_val,))
        row = cur.fetchone()
        col_names = [d[0] for d in cur.description] if cur.description else []
    finally:
        cur.close()

    if not row:
        raise HTTPException(status_code=404, detail=f"Row with {pk_col} = '{pk_val}' not found.")

    original_row = {col: _safe_val(val) for col, val in zip(col_names, row)}
    is_active_col = next((c for c in col_names if c.upper() == "IS_ACTIVE"), None)
    created_ts_col = next((c for c in col_names if c.upper() in ("CREATED_TS", "CREATED_AT")), None)
    updated_ts_col = next((c for c in col_names if c.upper() in ("UPDATED_TS", "UPDATED_AT")), None)

    try:
        cur2 = _raw_write_cursor()
        try:
            now_ts = datetime.now(EASTERN).strftime("%Y-%m-%d %H:%M:%S.%f")

            # Step 1: deactivate original row and stamp UPDATED_TS on it
            if is_active_col:
                if updated_ts_col:
                    cur2.execute(
                        f"UPDATE {table_name} SET {is_active_col} = FALSE, {updated_ts_col} = %s WHERE {pk_col} = %s",
                        (now_ts, pk_val)
                    )
                else:
                    cur2.execute(
                        f"UPDATE {table_name} SET {is_active_col} = FALSE WHERE {pk_col} = %s",
                        (pk_val,)
                    )

            # Step 2: build new versioned row
            new_row = dict(original_row)
            for col, val in updates.items():
                if col.upper() == pk_col.upper():
                    continue
                new_row[col] = None if val == "" else val

            new_row[pk_col] = next_ver_id
            if is_active_col:
                new_row[is_active_col] = True

            # Timestamps: carry original CREATED_TS, set UPDATED_TS to now
            if created_ts_col:
                new_row[created_ts_col] = original_row.get(created_ts_col) or now_ts
            if updated_ts_col:
                new_row[updated_ts_col] = now_ts

            # Step 3: insert new versioned row — all columns included
            insert_cols = list(col_names)
            insert_vals = tuple(new_row.get(c) for c in insert_cols)
            placeholders = ", ".join(["%s"] * len(insert_cols))
            col_list = ", ".join(insert_cols)
            cur2.execute(
                f"INSERT INTO {table_name} ({col_list}) VALUES ({placeholders})",
                insert_vals
            )
        finally:
            cur2.close()

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Snowflake versioning failed: {type(e).__name__}: {e}"
        )

    return {
        "success": True,
        "original_rule_id": pk_val,
        "new_rule_id": next_ver_id,
        "message": f"'{pk_val}' deactivated. New row '{next_ver_id}' inserted with IS_ACTIVE = TRUE.",
        "updated_by": auth["user"]["email"],
    }


@admin_router.patch("/dq-tables/rule-input/toggle-active")
def toggle_rule_active(

        payload: dict = Body(...),
        auth: dict = Depends(require_permission("runBDCOperations")),
):
    _require_bdc()

    rule_id = payload.get("rule_id", "").strip()
    is_active = payload.get("is_active")

    if not rule_id:
        raise HTTPException(status_code=400, detail="rule_id is required")
    if is_active is None:
        raise HTTPException(status_code=400, detail="is_active (true/false) is required")

    dq_config = _bdc_config_manager.get_dq_config()
    if "rule_input_table" not in dq_config:
        raise HTTPException(status_code=404, detail="rule_input_table not configured.")

    table_name = _bdc_config_manager.get_full_table_name(dq_config["rule_input_table"])
    now_ts = datetime.now(EASTERN).strftime("%Y-%m-%d %H:%M:%S.%f")

    # Detect IS_ACTIVE and UPDATED_TS column names
    schema_cur = _raw_cursor()
    try:
        schema_cur.execute(f"SELECT * FROM {table_name} LIMIT 0")
        col_names = [d[0] for d in schema_cur.description] if schema_cur.description else []
    finally:
        schema_cur.close()

    is_active_col = next((c for c in col_names if c.upper() == "IS_ACTIVE"), None)
    updated_ts_col = next((c for c in col_names if c.upper() in ("UPDATED_TS", "UPDATED_AT")), None)

    if not is_active_col:
        raise HTTPException(status_code=404, detail="IS_ACTIVE column not found in the rule input table.")

    try:
        cur = _raw_write_cursor()
        try:
            if updated_ts_col:
                cur.execute(
                    f"UPDATE {table_name} SET {is_active_col} = %s, {updated_ts_col} = %s WHERE RULE_ID = %s",
                    (bool(is_active), now_ts, rule_id)
                )
            else:
                cur.execute(
                    f"UPDATE {table_name} SET {is_active_col} = %s WHERE RULE_ID = %s",
                    (bool(is_active), rule_id)
                )
        finally:
            cur.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Toggle failed: {type(e).__name__}: {e}")

    return {
        "success": True,
        "rule_id": rule_id,
        "is_active": bool(is_active),
        "updated_by": auth["user"]["email"],
    }


@admin_router.post("/dq-tables/rule-input/row")
def create_rule_input_row(

        payload: dict = Body(...),
        auth: dict = Depends(require_permission("runBDCOperations")),
):
    _require_bdc()

    row_data = payload.get("row", {})
    if not row_data:
        raise HTTPException(status_code=400, detail="row dict is required and cannot be empty")

    dq_config = _bdc_config_manager.get_dq_config()
    if "rule_input_table" not in dq_config:
        raise HTTPException(status_code=404, detail="rule_input_table not configured.")

    table_name = _bdc_config_manager.get_full_table_name(dq_config["rule_input_table"])

    # Validate RULE_ID is provided and not already taken
    pk_val = row_data.get("RULE_ID", "").strip()
    if not pk_val:
        raise HTTPException(status_code=400, detail="RULE_ID is required")

    cur_check = _raw_cursor()
    try:
        cur_check.execute(
            f"SELECT COUNT(*) FROM {table_name} WHERE RULE_ID = %s", (pk_val,)
        )
        (count,) = cur_check.fetchone()
    finally:
        cur_check.close()

    if count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"A rule with RULE_ID '{pk_val}' already exists. Choose a different ID."
        )

    # Fetch column list from the table to know all columns and their order
    cur_schema = _raw_cursor()
    try:
        cur_schema.execute(f"SELECT * FROM {table_name} LIMIT 0")
        col_names = [d[0] for d in cur_schema.description] if cur_schema.description else []
    finally:
        cur_schema.close()

    now_ts = datetime.now(EASTERN).strftime("%Y-%m-%d %H:%M:%S.%f")

    # Build insert values for every column we know about
    # Caller-supplied values take priority; server fills timestamps and IS_ACTIVE.
    insert_cols = []
    insert_vals = []

    for col in col_names:
        cu = col.upper()
        if cu in ("CREATED_TS", "CREATED_AT", "UPDATED_TS", "UPDATED_AT"):
            insert_cols.append(col)
            insert_vals.append(now_ts)
        elif cu == "IS_ACTIVE":
            insert_cols.append(col)
            insert_vals.append(True)
        elif col in row_data:
            val = row_data[col]
            insert_cols.append(col)
            insert_vals.append(None if val == "" else val)
        # columns not supplied by caller are omitted (will be NULL or DB default)

    # Always ensure RULE_ID is in the insert even if col_names is empty
    if not insert_cols:
        insert_cols = list(row_data.keys())
        insert_vals = [row_data[c] for c in insert_cols]

    placeholders = ", ".join(["%s"] * len(insert_cols))
    col_list = ", ".join(insert_cols)

    try:
        cur2 = _raw_write_cursor()
        try:
            cur2.execute(
                f"INSERT INTO {table_name} ({col_list}) VALUES ({placeholders})",
                tuple(insert_vals)
            )
        finally:
            cur2.close()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Snowflake insert failed: {type(e).__name__}: {e}"
        )

    return {
        "success": True,
        "rule_id": pk_val,
        "message": f"New rule '{pk_val}' created in {table_name} with IS_ACTIVE = TRUE.",
        "created_by": auth["user"]["email"],
    }


# ═══════════════════════════════════════════════════════════════════════════════
# DQ Date Input Table — Row CRUD
# Identified by the ID (UUID) column — unique per row.
# CREATED_DATE / UPDATED_DATE are always server-managed.
# ═══════════════════════════════════════════════════════════════════════════════

def _date_input_table_name() -> str:
    """
    Return the fully-qualified name of the admin date-input table.
    Used exclusively by the CRUD endpoints (create / update / toggle-active).
    Always resolves via 'date_input_table' (short name) + the default db/schema prefix.
    Never touches 'date_range_table_fqn'.
    """
    dq_config = _bdc_config_manager.get_dq_config()
    if "date_input_table" not in dq_config:
        raise HTTPException(
            status_code=404,
            detail="'date_input_table' is not configured in dq_config.",
        )
    return _bdc_config_manager.get_full_table_name(dq_config["date_input_table"])


def _date_range_table_name() -> str:
    """
    Return the fully-qualified name of the separate date-range table used
    exclusively by the active-ranges banner endpoint.
    Always resolves via 'date_range_table_fqn' — a fully-qualified name stored
    verbatim in dq_config (e.g. "PRD_DB.SCHEMA.DQ_DATE_INPUT__L1__DQ_CORE").
    Never touches 'date_input_table'.
    """
    dq_config = _bdc_config_manager.get_dq_config()
    fqn = (dq_config.get("date_range_table_fqn") or "").strip()
    if not fqn:
        raise HTTPException(
            status_code=404,
            detail=(
                "'date_range_table_fqn' is not configured in dq_config. "
                "Set it to the fully-qualified name of the date-range table "
                "(e.g. 'MY_DB.MY_SCHEMA.DQ_DATE_INPUT__L1__DQ_CORE')."
            ),
        )
    return fqn


@admin_router.post("/dq-tables/date-input/row")
def create_date_input_row(
    payload: dict = Body(...),
    auth: dict = Depends(require_permission("runBDCOperations")),
):
    _require_bdc()
    row = payload.get("row", {})
    if not row:
        raise HTTPException(status_code=400, detail="row dict is required.")

    report_set = (row.get("REPORT_SET") or "").strip()
    from_date   = (row.get("FROM_DATE") or "").strip()
    if not report_set:
        raise HTTPException(status_code=400, detail="REPORT_SET is required.")
    if not from_date:
        raise HTTPException(status_code=400, detail="FROM_DATE is required.")

    table_name = _date_input_table_name()
    now_ts = datetime.now(EASTERN).strftime("%Y-%m-%d %H:%M:%S.%f")

    # Get column list from the table
    cur_schema = _raw_cursor()
    try:
        cur_schema.execute(f"SELECT * FROM {table_name} LIMIT 0")
        col_names = [d[0] for d in cur_schema.description] if cur_schema.description else []
    finally:
        cur_schema.close()

    insert_cols, insert_vals = [], []
    for col in col_names:
        cu = col.upper()
        if cu in ("CREATED_DATE", "UPDATED_DATE", "CREATED_TS", "UPDATED_TS", "CREATED_AT", "UPDATED_AT"):
            insert_cols.append(col); insert_vals.append(now_ts)
        elif cu == "IS_ACTIVE":
            insert_cols.append(col); insert_vals.append(True)
        elif col in row or cu in row:
            val = row.get(col) or row.get(cu)
            insert_cols.append(col); insert_vals.append(None if val == "" else val)

    if not insert_cols:
        insert_cols = list(row.keys()); insert_vals = [row[c] for c in insert_cols]

    placeholders = ", ".join(["%s"] * len(insert_cols))
    col_list     = ", ".join(insert_cols)
    try:
        cur2 = _raw_write_cursor()
        try:
            cur2.execute(f"INSERT INTO {table_name} ({col_list}) VALUES ({placeholders})", tuple(insert_vals))
        finally:
            cur2.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Insert failed: {type(e).__name__}: {e}")

    return {"success": True, "report_set": report_set, "from_date": from_date, "created_by": auth["user"]["email"]}


@admin_router.put("/dq-tables/date-input/row")
def update_date_input_row(
    payload: dict = Body(...),
    auth: dict = Depends(require_permission("runBDCOperations")),
):
    _require_bdc()
    row_id  = (payload.get("id") or "").strip()
    updates = payload.get("updates", {})

    if not row_id:
        raise HTTPException(status_code=400, detail="id is required.")
    if not updates:
        raise HTTPException(status_code=400, detail="updates dict is empty.")

    table_name = _date_input_table_name()
    now_ts = datetime.now(EASTERN).strftime("%Y-%m-%d %H:%M:%S.%f")

    cur_schema = _raw_cursor()
    try:
        cur_schema.execute(f"SELECT * FROM {table_name} LIMIT 0")
        col_names = [d[0] for d in cur_schema.description] if cur_schema.description else []
    finally:
        cur_schema.close()

    updated_ts_col = next(
        (c for c in col_names if c.upper() in ("UPDATED_DATE", "UPDATED_TS", "UPDATED_AT")), None
    )

    LOCKED = {"CREATED_DATE", "UPDATED_DATE", "CREATED_TS", "UPDATED_TS", "CREATED_AT", "UPDATED_AT", "ID"}
    set_parts, set_vals = [], []
    for col, val in updates.items():
        if col.upper() in LOCKED:
            continue
        set_parts.append(f"{col} = %s")
        set_vals.append(None if val == "" else val)

    if updated_ts_col:
        set_parts.append(f"{updated_ts_col} = %s")
        set_vals.append(now_ts)

    if not set_parts:
        return {"success": True, "message": "Nothing to update."}

    set_clause = ", ".join(set_parts)
    set_vals.append(row_id)

    try:
        cur = _raw_write_cursor()
        try:
            cur.execute(f"UPDATE {table_name} SET {set_clause} WHERE ID = %s", tuple(set_vals))
        finally:
            cur.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Update failed: {type(e).__name__}: {e}")

    return {"success": True, "updated_by": auth["user"]["email"]}


@admin_router.patch("/dq-tables/date-input/toggle-active")
def toggle_date_input_active(
    payload: dict = Body(...),
    auth: dict = Depends(require_permission("runBDCOperations")),
):
    _require_bdc()
    row_id    = (payload.get("id") or "").strip()
    is_active = payload.get("is_active")

    if not row_id:
        raise HTTPException(status_code=400, detail="id is required.")
    if is_active is None:
        raise HTTPException(status_code=400, detail="is_active (true/false) is required.")

    table_name = _date_input_table_name()
    now_ts = datetime.now(EASTERN).strftime("%Y-%m-%d %H:%M:%S.%f")

    cur_schema = _raw_cursor()
    try:
        cur_schema.execute(f"SELECT * FROM {table_name} LIMIT 0")
        col_names = [d[0] for d in cur_schema.description] if cur_schema.description else []
    finally:
        cur_schema.close()

    is_active_col  = next((c for c in col_names if c.upper() == "IS_ACTIVE"), None)
    updated_ts_col = next(
        (c for c in col_names if c.upper() in ("UPDATED_DATE", "UPDATED_TS", "UPDATED_AT")), None
    )

    if not is_active_col:
        raise HTTPException(status_code=404, detail="IS_ACTIVE column not found.")

    try:
        cur = _raw_write_cursor()
        try:
            # If activating a row, first deactivate all other rows in the same REPORT_SET
            if bool(is_active):
                # Fetch the REPORT_SET value for this row
                report_set_cur = _raw_cursor()
                try:
                    report_set_cur.execute(f"SELECT REPORT_SET FROM {table_name} WHERE ID = %s", (row_id,))
                    rs_row = report_set_cur.fetchone()
                finally:
                    report_set_cur.close()

                if rs_row:
                    report_set_val = rs_row[0]
                    # Deactivate all other rows in the same REPORT_SET
                    if updated_ts_col:
                        cur.execute(
                            f"UPDATE {table_name} SET {is_active_col} = FALSE, {updated_ts_col} = %s "
                            f"WHERE REPORT_SET = %s AND ID != %s",
                            (now_ts, report_set_val, row_id),
                        )
                    else:
                        cur.execute(
                            f"UPDATE {table_name} SET {is_active_col} = FALSE "
                            f"WHERE REPORT_SET = %s AND ID != %s",
                            (report_set_val, row_id),
                        )

            # Now apply the requested toggle to the target row
            if updated_ts_col:
                cur.execute(
                    f"UPDATE {table_name} SET {is_active_col} = %s, {updated_ts_col} = %s WHERE ID = %s",
                    (bool(is_active), now_ts, row_id),
                )
            else:
                cur.execute(
                    f"UPDATE {table_name} SET {is_active_col} = %s WHERE ID = %s",
                    (bool(is_active), row_id),
                )
        finally:
            cur.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Toggle failed: {type(e).__name__}: {e}")

    return {"success": True, "is_active": bool(is_active), "updated_by": auth["user"]["email"]}


# ═══════════════════════════════════════════════════════════════════════════════
# Multi-source Table Browser
# Unified endpoints that fetch table lists from Snowflake, Denodo, or PostgreSQL
# based on the caller-supplied connection_type parameter.
# ═══════════════════════════════════════════════════════════════════════════════


# ── PostgreSQL helper ─────────────────────────────────────────────────────────

def _get_pg_config() -> dict:
    """Read PostgreSQL connection details from the 'postgresql' key in dq_config.json."""
    if not _bdc_config_manager or not _bdc_config_manager.config:
        raise HTTPException(status_code=503, detail="BDC config not available")
    pg = _bdc_config_manager.config.get("postgresql")
    if not pg:
        raise HTTPException(
            status_code=503,
            detail="No 'postgresql' section found in dq_config.json."
        )
    return pg


def _pg_cursor():
    """Open a psycopg2 cursor (connection not cached — PG queries are infrequent)."""
    try:
        import psycopg2
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="psycopg2 is not installed. Run: pip install psycopg2-binary"
        )
    cfg = _get_pg_config()
    try:
        conn = psycopg2.connect(
            host=cfg.get("host"),
            port=cfg.get("port", 5432),
            dbname=cfg.get("database"),
            user=cfg.get("user"),
            password=cfg.get("password"),
            connect_timeout=10,
        )
        conn.autocommit = True
        return conn, conn.cursor()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"PostgreSQL connection failed: {type(e).__name__}: {e}")


# ── Denodo helper ─────────────────────────────────────────────────────────────

def _get_denodo_creds():
    """Return (base_url, username, password) from the injected config manager."""
    if not _bdc_config_manager or not _bdc_config_manager.config:
        raise HTTPException(status_code=503, detail="BDC config not available")
    sa = _bdc_config_manager.config.get("denodo_service_account", {})
    base_url = sa.get("base_url")
    user = sa.get("username")
    password = sa.get("password")
    if not base_url or not user:
        raise HTTPException(
            status_code=503,
            detail="Denodo credentials not found in dq_config.json. "
                   "Ensure 'denodo_service_account' has base_url, username, password."
        )
    return base_url, user, password


# ── Endpoint: databases / top-level groupings ─────────────────────────────────

@admin_router.get("/tables/databases")
def list_table_databases(
        connection_type: str = Query("Snowflake", description="Snowflake | Denodo | PostgreSQL"),
        auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Return the top-level groupings for the chosen connection."""
    ct = connection_type.strip().lower()

    if ct == "snowflake":
        _require_bdc()
        cur = _raw_cursor()
        try:
            cur.execute("SHOW DATABASES")
            rows = cur.fetchall()
            databases = sorted({row[1] for row in rows if row[1]})
        except Exception:
            databases = [_bdc_config_manager.get_snowflake_config().get("database", "")]
        finally:
            cur.close()
        return {"connection_type": "Snowflake", "databases": databases}

    elif ct == "denodo":
        base_url, user, password = _get_denodo_creds()
        import requests as _req
        from requests.auth import HTTPBasicAuth as _BA
        try:
            resp = _req.get(
                f"{base_url}/public/api/databases",
                auth=_BA(user, password),
                headers={"Accept": "application/json"},
                timeout=15,
                verify=False,
            )
            if resp.status_code == 200:
                data = resp.json()
                # The response can be a list of {name:...} or similar shapes
                if isinstance(data, list):
                    databases = sorted({
                        d.get("name") or d.get("databaseName") or str(d)
                        for d in data if isinstance(d, dict)
                    })
                else:
                    databases = []
            else:
                databases = []
        except Exception:
            databases = []
        return {"connection_type": "Denodo", "databases": databases}

    elif ct == "postgresql":
        conn, cur = _pg_cursor()
        try:
            cur.execute("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
            databases = [row[0] for row in cur.fetchall()]
        finally:
            cur.close();
            conn.close()
        return {"connection_type": "PostgreSQL", "databases": databases}

    raise HTTPException(status_code=400,
                        detail=f"Unknown connection_type '{connection_type}'. Use Snowflake, Denodo, or PostgreSQL.")


# ── Endpoint: schemas ─────────────────────────────────────────────────────────

@admin_router.get("/tables/schemas")
def list_table_schemas(

        connection_type: str = Query("Snowflake"),
        database: str = Query(...),
        auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Return schemas inside a database for the chosen connection."""
    ct = connection_type.strip().lower()

    if ct == "snowflake":
        _require_bdc()
        cur = _raw_cursor()
        try:
            cur.execute(f"SHOW SCHEMAS IN DATABASE {database}")
            rows = cur.fetchall()
            schemas = sorted({row[1] for row in rows if row[1] and row[1] != "INFORMATION_SCHEMA"})
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Snowflake error: {e}")
        finally:
            cur.close()
        return {"database": database, "schemas": schemas}

    elif ct == "denodo":
        # In Denodo the "database" IS the schema concept; return views grouped by database
        base_url, user, password = _get_denodo_creds()
        import requests as _req
        from requests.auth import HTTPBasicAuth as _BA
        try:
            resp = _req.get(
                f"{base_url}/public/api/databases/{database}/views",
                auth=_BA(user, password),
                headers={"Accept": "application/json"},
                timeout=15,
                verify=False,
            )
            # If the endpoint doesn't exist, fall back to a dummy schema list
            if resp.status_code == 200:
                schemas = ["views"]
            else:
                schemas = ["views"]
        except Exception:
            schemas = ["views"]
        return {"database": database, "schemas": schemas}

    elif ct == "postgresql":
        conn, cur = _pg_cursor()
        try:
            cur.execute(
                "SELECT schema_name FROM information_schema.schemata "
                "WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast') "
                "ORDER BY schema_name"
            )
            schemas = [row[0] for row in cur.fetchall()]
        finally:
            cur.close();
            conn.close()
        return {"database": database, "schemas": schemas}

    raise HTTPException(status_code=400, detail=f"Unknown connection_type '{connection_type}'.")


# ── Endpoint: table names ─────────────────────────────────────────────────────

@admin_router.get("/tables/table-names")
def list_table_names(

        connection_type: str = Query("Snowflake"),
        database: str = Query(...),
        schema: str = Query(...),
        search: str = Query(""),
        auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Return table/view names in a specific database.schema for the chosen connection."""
    ct = connection_type.strip().lower()
    search = search.strip().lower()

    if ct == "snowflake":
        _require_bdc()
        sf_filter = f"AND LOWER(TABLE_NAME) LIKE '%{search}%'" if search else ""
        sql = f"""
            SELECT TABLE_NAME, TABLE_TYPE
            FROM {database}.INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = '{schema.upper()}'
              AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
              {sf_filter}
            ORDER BY TABLE_NAME
            LIMIT 2000
        """
        cur = _raw_cursor()
        try:
            cur.execute(sql)
            rows = cur.fetchall()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Snowflake error: {type(e).__name__}: {e}")
        finally:
            cur.close()
        tables = [
            {"database": database, "schema": schema, "table_name": row[0], "type": row[1],
             "full_name": f"{database}.{schema}.{row[0]}"}
            for row in rows
        ]
        return {"tables": tables}

    elif ct == "denodo":
        base_url, user, password = _get_denodo_creds()
        import requests as _req
        from requests.auth import HTTPBasicAuth as _BA
        # Use the metadata search API — filter by database name
        payload = {
            "text": search or "",
            "elementType": "Views",
            "databaseIds": [],
            "searchType": "CONTAINS" if search else "EXACT_MATCH",
            "offset": 0,
            "limit": 2000,
        }
        try:
            resp = _req.post(
                f"{base_url}/public/api/search/metadata?serverId=1",
                auth=_BA(user, password),
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                json=payload,
                timeout=30,
                verify=False,
            )
            tables = []
            if resp.status_code == 200:
                data = resp.json()
                elements = data.get("elements", data) if isinstance(data, dict) else data
                for el in (elements if isinstance(elements, list) else []):
                    db_info = el.get("database", {})
                    db_name = db_info.get("databaseName", "") if isinstance(db_info, dict) else ""
                    # Filter to the selected database
                    if database.lower() not in (db_name.lower(), ""):
                        continue
                    name = el.get("name", "")
                    if search and search not in name.lower():
                        continue
                    tables.append({
                        "database": db_name or database,
                        "schema": schema,
                        "table_name": name,
                        "type": "VIEW",
                        "full_name": f"{db_name or database}/{name}",
                    })
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Denodo error: {type(e).__name__}: {e}")
        return {"tables": sorted(tables, key=lambda t: t["table_name"])}

    elif ct == "postgresql":
        conn, cur = _pg_cursor()
        try:
            pg_filter = f"AND LOWER(table_name) LIKE '%{search}%'" if search else ""
            cur.execute(f"""
                SELECT table_name, table_type
                FROM information_schema.tables
                WHERE table_schema = %s
                  AND table_type IN ('BASE TABLE', 'VIEW')
                  {pg_filter}
                ORDER BY table_name
                LIMIT 2000
            """, (schema,))
            rows = cur.fetchall()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"PostgreSQL error: {type(e).__name__}: {e}")
        finally:
            cur.close();
            conn.close()
        tables = [
            {"database": database, "schema": schema, "table_name": row[0], "type": row[1],
             "full_name": f"{database}.{schema}.{row[0]}"}
            for row in rows
        ]
        return {"tables": tables}

    raise HTTPException(status_code=400, detail=f"Unknown connection_type '{connection_type}'.")


# ── Endpoint: columns for a specific table ────────────────────────────────────

@admin_router.get("/tables/columns")
def list_table_columns(
        connection_type: str = Query("Snowflake"),
        database: str = Query(...),
        schema: str = Query(...),
        table: str = Query(...),
        auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Return column names (+ data types) for a specific database.schema.table."""
    ct = connection_type.strip().lower()

    if ct == "snowflake":
        _require_bdc()
        cur = _raw_cursor()
        try:
            cur.execute(f"""
                SELECT COLUMN_NAME, DATA_TYPE
                FROM {database}.INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = '{schema.upper()}'
                  AND TABLE_NAME = '{table.upper()}'
                ORDER BY ORDINAL_POSITION
            """)
            rows = cur.fetchall()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Snowflake error: {type(e).__name__}: {e}")
        finally:
            cur.close()
        columns = [{"name": row[0], "type": row[1]} for row in rows]
        return {"database": database, "schema": schema, "table": table, "columns": columns}

    elif ct == "postgresql":
        conn, cur = _pg_cursor()
        try:
            cur.execute("""
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_schema = %s AND table_name = %s
                ORDER BY ordinal_position
            """, (schema, table))
            rows = cur.fetchall()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"PostgreSQL error: {type(e).__name__}: {e}")
        finally:
            cur.close();
            conn.close()
        columns = [{"name": row[0], "type": row[1]} for row in rows]
        return {"database": database, "schema": schema, "table": table, "columns": columns}

    elif ct == "denodo":
        # Denodo table browsing is marked "Coming Soon" on the frontend — no column lookup yet.
        return {"database": database, "schema": schema, "table": table, "columns": []}

    raise HTTPException(status_code=400, detail=f"Unknown connection_type '{connection_type}'.")

# ─── Active Date Ranges — used by the BDC top bar to show dataset context ─────

@admin_router.get("/date-input/active-ranges")
def get_active_date_ranges(
        auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """
    Return the active date range for each REPORT_SET in DQ_DATE_INPUT.

    For each report_set we:
      1. Count how many rows have IS_ACTIVE = TRUE.
         - 0  → status: "none"    (no active row configured)
         - 1  → status: "ok"      (normal case)
         - 2+ → status: "multiple" (data integrity issue — multiple actives)
      2. When multiple are active, pick the most recently updated row via
         QUALIFY so the frontend always has a single date range to display,
         while also surfacing the warning.

    Response shape:
      {
        "ranges": [
          {
            "report_set":       "RTE_REPORT_BIWEEKLY",
            "from_date":        "2026-05-01",   # null when status == "none"
            "to_date":          "2026-05-31",   # null when status == "none"
            "status":           "ok" | "none" | "multiple",
            "active_count":     1               # actual count of IS_ACTIVE rows
          },
          ...
        ]
      }
    """
    _require_bdc()
    try:
        sf = _bdc_connection_manager.get_client()
        table_name = _date_range_table_name()  # separate table — never DQ_DATE_INPUT

        # ── Step 1: count active rows per report_set (all rows, not just active) ──
        count_res = sf.execute(f"""
            SELECT
                REPORT_SET,
                SUM(CASE WHEN IS_ACTIVE = TRUE THEN 1 ELSE 0 END) AS active_count
            FROM {table_name}
            GROUP BY REPORT_SET
            ORDER BY REPORT_SET
        """)
        active_counts = {row[0]: int(row[1]) for row in count_res.rows}

        # ── Step 2: for each report_set that has ≥1 active row, get the best one ──
        # QUALIFY with ROW_NUMBER picks the most recently updated row when there
        # are multiple actives, so we always return exactly one date range per set.
        best_res = sf.execute(f"""
            SELECT
                REPORT_SET,
                TO_CHAR(FROM_DATE, 'YYYY-MM-DD') AS FROM_DATE,
                TO_CHAR(TO_DATE,   'YYYY-MM-DD') AS TO_DATE
            FROM {table_name}
            WHERE IS_ACTIVE = TRUE
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY REPORT_SET
                ORDER BY COALESCE(UPDATED_DATE, CREATED_DATE) DESC
            ) = 1
            ORDER BY REPORT_SET
        """)
        best_rows = {row[0]: {"from_date": row[1], "to_date": row[2]} for row in best_res.rows}

        # ── Step 3: merge counts + best row into the final response ──
        ranges = []
        for report_set, count in active_counts.items():
            best = best_rows.get(report_set)
            if count == 0:
                status = "none"
            elif count == 1:
                status = "ok"
            else:
                status = "multiple"

            ranges.append({
                "report_set":   report_set,
                "from_date":    best["from_date"] if best else None,
                "to_date":      best["to_date"]   if best else None,
                "status":       status,
                "active_count": count,
            })

        return {"ranges": ranges}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch active date ranges: {type(e).__name__}: {e}"
        )