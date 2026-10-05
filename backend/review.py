from __future__ import annotations

import logging
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Header, Depends

from auth import require_auth, require_permission
from pydantic import BaseModel

logger = logging.getLogger(__name__)

_bdc_config_manager      = None
_bdc_connection_manager  = None
_write_connection_factory = None

review_router = APIRouter(prefix="/api/review", tags=["Review"])

REVIEW_TABLE_NAME = "DQ_REVIEW_REGISTRY"
DEFAULT_CORE_SCHEMA = "DQ_CORE"


def _review_table() -> str:
    """Where the review registry lives.

    Fully qualified, deliberately. Writes here run on a connection opened from
    the *write* credentials, whose own default database need not be the one the
    read side uses - and this name used to carry only the schema, so the same
    table name resolved to two different databases and an accepted review could
    simply not be there when the read side looked for it.

    The schema is a setting rather than a constant now, and both parts are read
    when a statement is built rather than when this module is imported: the
    config manager is wired in afterwards."""
    if _bdc_config_manager is not None:
        try:
            return _bdc_config_manager.core_table(REVIEW_TABLE_NAME)
        except Exception:
            pass
    return f"{DEFAULT_CORE_SCHEMA}.{REVIEW_TABLE_NAME}"


def _create_table_sql() -> str:
    return f"""
CREATE TABLE IF NOT EXISTS {_review_table()} (
    REVIEW_ID               VARCHAR(36)    NOT NULL,
    RULE_ID                 VARCHAR(200)   NOT NULL,
    RULE_TITLE              VARCHAR(500),
    STATUS                  VARCHAR(30)    NOT NULL,
    REVIEWED_BY             VARCHAR(300),
    REVIEWED_AT             TIMESTAMP_TZ   DEFAULT CURRENT_TIMESTAMP(),
    REVIEW_NOTE             VARCHAR(4000),
    SQL_PREDICATE_SNAPSHOT  VARCHAR(16000),
    FAILED_ROW_COUNT        INTEGER,
    PRIMARY KEY (REVIEW_ID)
)
"""


def set_review_dependencies(config_manager, connection_manager, write_connection_factory=None):
    global _bdc_config_manager, _bdc_connection_manager, _write_connection_factory
    _bdc_config_manager       = config_manager
    _bdc_connection_manager   = connection_manager
    _write_connection_factory = write_connection_factory
    if connection_manager and connection_manager.available:
        try:
            sf = connection_manager.get_client()
            sf.execute(_create_table_sql())
            logger.info("DQ_REVIEW_REGISTRY ensured")
        except Exception as e:
            logger.warning(f"Could not ensure DQ_REVIEW_REGISTRY: {e}")


def _sf():
    if not _bdc_connection_manager:
        raise HTTPException(status_code=503, detail="Review service not available")
    return _bdc_connection_manager.get_client()


def _sf_write():
    if _write_connection_factory:
        from app import SnowflakeClient
        return SnowflakeClient(_write_connection_factory())
    return _sf()


def _safe(val: str) -> str:
    return (val or "").replace("'", "''")


def _to_dict(columns, row) -> dict:
    return {
        col: (val.isoformat() if hasattr(val, "isoformat") else val)
        for col, val in zip(columns, row)
    }


# Delta-mode reviews are stored under the same registry table, keyed by a
# "DELTA_" prefix on RULE_ID. This avoids a schema migration (no MODE column)
# while keeping quarterly and delta sign-off history fully independent.
# Quarterly-mode rows are stored exactly as before (no prefix), so existing
# review history keeps working unchanged.
_DELTA_PREFIX = "DELTA_"


def _storage_rule_id(rule_id: str, delta_mode: bool) -> str:
    if delta_mode and not rule_id.startswith(_DELTA_PREFIX):
        return f"{_DELTA_PREFIX}{rule_id}"
    return rule_id


def _display_rule_id(stored_rule_id: str) -> str:
    if stored_rule_id and stored_rule_id.startswith(_DELTA_PREFIX):
        return stored_rule_id[len(_DELTA_PREFIX):]
    return stored_rule_id


class ReviewSubmitRequest(BaseModel):
    rule_id:                str
    rule_title:             Optional[str] = None
    status:                 str
    note:                   Optional[str] = None
    sql_predicate_snapshot: Optional[str] = None
    failed_row_count:       Optional[int] = None


@review_router.get("/badge")
def get_review_badge(
    delta_mode: bool = Query(False, description="When True, count pending Delta-mode reviews"),
    auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Count of Business Defined Checks rules not yet ACCEPTED — the number shown
    on the Review tab's badge. Pass delta_mode for the Delta-mode queue instead."""
    sf  = _sf()
    cfg = _bdc_config_manager.get_dq_config()
    latest_key = cfg["rule_latest_view"]
    if delta_mode:
        latest_key = latest_key + "_DELTA" if not latest_key.endswith("_DELTA") else latest_key
    rule_view = _bdc_config_manager.get_full_table_name(latest_key)
    id_expr = f"'{_DELTA_PREFIX}' || v.RULE_ID" if delta_mode else "v.RULE_ID"
    try:
        res = sf.execute(f"""
            SELECT COUNT(DISTINCT v.RULE_ID)
            FROM {rule_view} v
            WHERE NOT EXISTS (
                SELECT 1 FROM {_review_table()} r
                WHERE r.RULE_ID = {id_expr} AND r.STATUS = 'ACCEPTED'
            )
        """)
        return {"pending": int(res.rows[0][0]) if res.rows else 0}
    except Exception as e:
        logger.warning(f"Badge query failed: {e}")
        return {"pending": 0}


@review_router.get("/rules")
def get_review_rules(
    delta_mode: bool = Query(False, description="When True, show Delta-mode review queue"),
    auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Business Defined Checks rules with their SQL predicate, AI output, and
    latest review status (NOT_REVIEWED/ACCEPTED/REJECTED) — the Review tab's queue."""
    sf  = _sf()
    cfg = _bdc_config_manager.get_dq_config()
    latest_key = cfg["rule_latest_view"]
    if delta_mode:
        latest_key = latest_key + "_DELTA" if not latest_key.endswith("_DELTA") else latest_key
    rule_view  = _bdc_config_manager.get_full_table_name(latest_key)
    rule_input = _bdc_config_manager.get_full_table_name(cfg["rule_input_table"])
    rule_reg   = _bdc_config_manager.get_full_table_name(cfg["rule_registry_table"])

    # Delta-mode reviews are stored in the same table keyed by a "DELTA_"
    # prefix on RULE_ID, so we only look at rows matching the current mode
    # and join back by adding/stripping that prefix.
    review_filter = "RULE_ID LIKE 'DELTA_%'" if delta_mode else "RULE_ID NOT LIKE 'DELTA_%'"
    join_id_expr  = f"'{_DELTA_PREFIX}' || v.RULE_ID" if delta_mode else "v.RULE_ID"

    # Use a CTE with QUALIFY to get the latest review per rule — avoids correlated
    # subqueries in the SELECT/ORDER BY which Snowflake does not support.
    res = sf.execute(f"""
        WITH latest_reviews AS (
            SELECT
                RULE_ID,
                STATUS,
                REVIEWED_BY,
                TO_CHAR(REVIEWED_AT, 'YYYY-MM-DD HH24:MI:SS') AS REVIEWED_AT_STR,
                REVIEW_NOTE
            FROM {_review_table()}
            WHERE {review_filter}
            QUALIFY ROW_NUMBER() OVER (PARTITION BY RULE_ID ORDER BY REVIEWED_AT DESC) = 1
        )
        SELECT
            v.RULE_ID,
            v.RULE_TITLE,
            v.RULE_DESCRIPTION,
            v.SEVERITY,
            v.TARGET_TABLE,
            v.DATASET_TITLE,
            v.PASS_PERCENTAGE,
            v.STATUS                                     AS EXEC_STATUS,
            i.COLOR_COLUMNS,
            reg.SQL_PREDICATE,
            reg.AI_OUTPUT,
            COALESCE(lr.STATUS,       'NOT_REVIEWED') AS REVIEW_STATUS,
            lr.REVIEWED_BY                               AS LAST_REVIEWED_BY,
            lr.REVIEWED_AT_STR                           AS LAST_REVIEWED_AT,
            lr.REVIEW_NOTE                               AS LAST_REVIEW_NOTE
        FROM {rule_view} v
        LEFT JOIN {rule_input}    i   ON v.RULE_ID = i.RULE_ID  AND i.IS_ACTIVE   = TRUE
        LEFT JOIN {rule_reg}      reg ON v.RULE_ID = reg.RULE_ID AND reg.IS_VALIDATED = TRUE
        LEFT JOIN latest_reviews  lr  ON {join_id_expr} = lr.RULE_ID
        ORDER BY
            CASE COALESCE(lr.STATUS, 'NOT_REVIEWED')
                WHEN 'NOT_REVIEWED' THEN 0
                WHEN 'REJECTED'     THEN 1
                WHEN 'ACCEPTED'     THEN 2
            END,
            v.RULE_ID
    """)

    return {
        "rules": [
            {
                "rule_id":          r[0],
                "rule_title":       r[1],
                "rule_description": r[2] or "",
                "severity":         r[3],
                "target_table":     r[4],
                "dataset_title":    r[5] or "",
                "pass_percentage":  float(r[6]) if r[6] is not None else 0.0,
                "exec_status":      r[7],
                "color_columns":    r[8] or "",
                "sql_predicate":    r[9] or "",
                "ai_output":        r[10] or "",
                "review_status":    r[11],
                "last_reviewed_by": r[12],
                "last_reviewed_at": r[13],
                "last_review_note": r[14],
            }
            for r in res.rows
        ]
    }


@review_router.post("/submit")
def submit_review(
    body:         ReviewSubmitRequest,
    auth: dict = Depends(require_permission("runBDCOperations")),
    delta_mode:   bool          = Query(False, description="When True, record this as a Delta-mode review"),
):
    """Record a reviewer's Accept/Reject decision (with an optional note) for
    one Business Defined Checks rule. Reviewer identity comes from the caller's
    verified token, not a request field."""
    # Reviewer identity comes from the verified token — a review can no longer
    # be recorded against someone else's name.
    x_user_email = auth["user"]["email"]

    if body.status not in ("ACCEPTED", "REJECTED"):
        raise HTTPException(status_code=400, detail="status must be 'ACCEPTED' or 'REJECTED'")

    stored_rule_id = _storage_rule_id(body.rule_id, delta_mode)

    sw = _sf_write()
    sw.execute(f"""
        INSERT INTO {_review_table()}
            (REVIEW_ID, RULE_ID, RULE_TITLE, STATUS,
             REVIEWED_BY, REVIEWED_AT, REVIEW_NOTE,
             SQL_PREDICATE_SNAPSHOT, FAILED_ROW_COUNT)
        VALUES (
            '{str(uuid.uuid4())}',
            '{_safe(stored_rule_id)}',
            '{_safe(body.rule_title or "")}',
            '{body.status}',
            '{_safe(x_user_email)}',
            CURRENT_TIMESTAMP(),
            '{_safe(body.note or "")}',
            '{_safe(body.sql_predicate_snapshot or "")}',
            {int(body.failed_row_count) if body.failed_row_count is not None else 0}
        )
    """)
    logger.info(f"[REVIEW] {body.status}  rule={stored_rule_id}  delta_mode={delta_mode}  by={x_user_email}")
    return {"success": True, "status": body.status}


@review_router.get("/history")
def get_review_history(
    rule_id:    Optional[str] = Query(None),
    limit:      int           = Query(200, ge=1, le=1000),
    delta_mode: bool          = Query(False, description="When True, return Delta-mode review history"),
    auth: dict = Depends(require_permission("viewBusinessChecks")),
):
    """Past Accept/Reject decisions for Business Defined Checks rules, newest
    first — optionally filtered to one rule_id."""
    sf  = _sf()
    mode_clause = "AND RULE_ID LIKE 'DELTA_%'" if delta_mode else "AND RULE_ID NOT LIKE 'DELTA_%'"
    rule_clause = f"AND RULE_ID = '{_safe(_storage_rule_id(rule_id, delta_mode))}'" if rule_id else ""
    try:
        res = sf.execute(f"""
            SELECT REVIEW_ID, RULE_ID, RULE_TITLE, STATUS, REVIEWED_BY,
                   REVIEWED_AT, REVIEW_NOTE, FAILED_ROW_COUNT
            FROM {_review_table()}
            WHERE 1=1 {mode_clause} {rule_clause}
            ORDER BY REVIEWED_AT DESC
            LIMIT {limit}
        """)
        history = [_to_dict(res.columns, r) for r in res.rows]
        for h in history:
            h["RULE_ID"] = _display_rule_id(h["RULE_ID"])
        return {"history": history}
    except Exception as e:
        logger.warning(f"History query failed: {e}")
        return {"history": []}