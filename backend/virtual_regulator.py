"""Virtual Regulator (Internal) tab - DEV_RAW.UNSTRUCTURED_EXPLORER.SUBX_FINAL.

One row per chunk, and every chunk is repeated once per EDMS version of its
document (VERSION_LABEL / MODIFIED / MODIFIED_BY / RANKING come from that join).
So chunks are always counted as COUNT(DISTINCT CHUNK_ID) and "the" metadata for a
document is its latest version.

The generic endpoints (summary, facets, charts, rows, document, chunk) come from
chunk_explorer.py. The business views on top of them live here:
    /products   product portfolio cards
    /library    one row per document, latest version, paged
    /versions   version history for one document
"""
from fastapi import Depends, Query

from auth import require_permission
from chunk_explorer import build_chunk_router
from unstructured import _render_sql_for_display

DOC_COLUMNS = [
    "DOC_ID", "FILE_NAME", "FILE_PATH", "CHUNK_TOTAL", "FILE_SIZE", "PAGES_TOTAL",
    "STATUS", "LAST_MODIFIED", "INGESTED_AT", "CREATED_AT", "UPDATED_AT",
    "OBJ_ID", "NAME", "RANKING", "EDMS_NUMBER", "TITLE", "VERSION_LABEL",
    "MODIFIED", "MODIFIED_BY", "S3_PATH", "PRODUCT_NAME",
]

# MODIFIED is text like "4/24/2025 11:17"
MOD_TS = (
    "COALESCE(TRY_TO_TIMESTAMP_NTZ(\"MODIFIED\", 'MM/DD/YYYY HH24:MI'), "
    "TRY_TO_TIMESTAMP_NTZ(\"MODIFIED\", 'MM/DD/YYYY HH24:MI:SS'), "
    "TRY_TO_TIMESTAMP_NTZ(\"MODIFIED\"))"
)
VER_NUM = 'TRY_TO_DOUBLE("VERSION_LABEL")'
LATEST = f'{VER_NUM} DESC NULLS LAST, {MOD_TS} DESC NULLS LAST, "CHUNK_INDEX"'
# no literal % here - these strings go through pyformat params
HAS_TABLE = "CONTAINS(LOWER(\"CONTENT_TYPES\"), '\"table\"')"
VERSION_KEY = "\"EDMS_NUMBER\" || '|' || \"VERSION_LABEL\""
# "10.3. Pharmacokinetics" and "11.5 Pharmacokinetics" are the same section to a reader
SECTION_NORM = "TRIM(REGEXP_REPLACE(\"SECTION_TITLE\", '^[0-9]+([.][0-9]+)*[.]?[[:space:]]*', ''))"

CHARTS = {
    "recent-docs": lambda b: (
        f'SELECT "DOC_ID", "PRODUCT_NAME", "EDMS_NUMBER", "TITLE", "VERSION_LABEL", '
        f'"MODIFIED_BY", {MOD_TS} AS TS FROM {b} '
        f'QUALIFY ROW_NUMBER() OVER (PARTITION BY "DOC_ID" ORDER BY {LATEST}) = 1 '
        f"ORDER BY TS DESC NULLS LAST LIMIT 8"
    ),
    "owners": lambda b: (
        f'SELECT "MODIFIED_BY", COUNT(DISTINCT {VERSION_KEY}) AS VERS, COUNT(DISTINCT "DOC_ID") '
        f'FROM {b} WHERE "MODIFIED_BY" IS NOT NULL GROUP BY 1 ORDER BY VERS DESC LIMIT 12'
    ),
    "modified-trend": lambda b: (
        f"SELECT DATE_TRUNC('month', {MOD_TS}) AS P, COUNT(DISTINCT {VERSION_KEY}) "
        f"FROM {b} WHERE {MOD_TS} IS NOT NULL GROUP BY P ORDER BY P"
    ),
    "common-sections": lambda b: (
        f"SELECT ANY_VALUE({SECTION_NORM}) AS S, COUNT(DISTINCT \"DOC_ID\") AS DOCS, "
        f'COUNT(DISTINCT "PRODUCT_NAME") AS PRODS FROM {b} '
        f"WHERE \"SECTION_TITLE\" IS NOT NULL AND LENGTH({SECTION_NORM}) BETWEEN 3 AND 90 "
        f"GROUP BY UPPER({SECTION_NORM}) ORDER BY DOCS DESC, PRODS DESC LIMIT 15"
    ),
}

virtual_regulator_router, set_virtual_regulator_dependencies = build_chunk_router({
    "prefix": "/api/virtual-regulator",
    "tag": "Virtual Regulator",
    "cache_name": "virtual_regulator",
    "default_table": "DEV_RAW.UNSTRUCTURED_EXPLORER.SUBX_FINAL",
    "config_key": "virtual_regulator_table",
    "doc_columns": DOC_COLUMNS,
    "filter_columns": ["PRODUCT_NAME", "MODIFIED_BY", "VERSION_LABEL", "STATUS", "CHUNK_LEVEL", "CONTENT_TYPE"],
    "search_columns": ["EDMS_NUMBER", "TITLE", "NAME", "FILE_NAME", "SECTION_TITLE", "CHUNK_TEXT"],
    "distinct_counts": {"products": "PRODUCT_NAME", "edms_docs": "EDMS_NUMBER", "owners": "MODIFIED_BY"},
    "extra_charts": CHARTS,
    "default_dimension": None,
    "default_levels": None,
    "chunk_count": 'COUNT(DISTINCT "CHUNK_ID")',
    "doc_pick_order": LATEST,
})

router = virtual_regulator_router
ctx = router.chunk_ctx
T, base, run, cached, json_rows = ctx["table"], ctx["base"], ctx["query"], ctx["cached"], ctx["json_rows"]
scope_dep = ctx["scope_dep"]
PERM = require_permission("viewUnstructured")


def as_dicts(res):
    cols = [c.upper() for c in res.columns]
    return [dict(zip(cols, r)) for r in json_rows(res)]


@router.get("/products")
def get_products(scope: dict = Depends(scope_dep), bypass_cache: bool = Query(False), auth: dict = Depends(PERM)):
    """One card per product."""
    def build():
        b = base(scope["where"])
        sql = (
            f"WITH F AS {b}, "
            f'PG AS (SELECT "PRODUCT_NAME", SUM(P) AS PAGES FROM '
            f'(SELECT "PRODUCT_NAME", "DOC_ID", MAX("PAGES_TOTAL") AS P FROM F GROUP BY 1, 2) GROUP BY 1) '
            f'SELECT F."PRODUCT_NAME", COUNT(DISTINCT "DOC_ID") AS DOCS, COUNT(DISTINCT "EDMS_NUMBER") AS EDMS, '
            f"COUNT(DISTINCT {VERSION_KEY}) AS VERSIONS, ANY_VALUE(PG.PAGES) AS PAGES, "
            f"COUNT(DISTINCT \"DOC_ID\" || '|' || \"SECTION_TITLE\") AS SECTIONS, "
            f'COUNT(DISTINCT IFF({HAS_TABLE}, "CHUNK_ID", NULL)) AS TABLES, '
            f'COUNT(DISTINCT "MODIFIED_BY") AS OWNERS, MAX({MOD_TS}) AS LAST_MOD, '
            f'MAX_BY("TITLE", {MOD_TS}) AS LAST_TITLE, MAX_BY("MODIFIED_BY", {MOD_TS}) AS LAST_BY '
            f'FROM F LEFT JOIN PG ON PG."PRODUCT_NAME" IS NOT DISTINCT FROM F."PRODUCT_NAME" '
            f"GROUP BY 1 ORDER BY DOCS DESC"
        )
        rows = as_dicts(run(sql, scope["params"], "/products"))
        return {
            "products": rows,
            "sql": _render_sql_for_display(sql, scope["params"]),
        }

    return cached("products", scope["key"], bypass_cache, build)


LIBRARY_SORTS = {
    "modified": "MODIFIED_TS", "title": "TITLE", "edms": "EDMS_NUMBER", "product": "PRODUCT_NAME",
    "pages": "PAGES_TOTAL", "versions": "VERSIONS", "sections": "SECTIONS", "tables": "TABLES",
    "matches": "MATCHING",
}


@router.get("/library")
def get_library(
    page: int = Query(1, ge=1, le=100_000),
    page_size: int = Query(25, ge=1, le=100),
    sort: str = Query("modified"),
    sort_dir: str = Query("desc", pattern="^(asc|desc)$"),
    scope: dict = Depends(scope_dep),
    bypass_cache: bool = Query(False),
    auth: dict = Depends(PERM),
):
    """One row per document in scope, showing its latest version. Section / table /
    version counts are for the whole document, MATCHING is chunks that hit the filters."""
    order_col = LIBRARY_SORTS.get(sort, "MODIFIED_TS")
    direction = "ASC" if sort_dir == "asc" else "DESC"

    def build():
        sql = (
            f"WITH F AS {base(scope['where'])}, "
            f'IDS AS (SELECT "DOC_ID", COUNT(DISTINCT "CHUNK_ID") AS MATCHING FROM F GROUP BY 1), '
            f'A AS (SELECT t."DOC_ID", COUNT(DISTINCT t."VERSION_LABEL") AS VERSIONS, '
            f'COUNT(DISTINCT t."CHUNK_ID") AS CHUNKS, COUNT(DISTINCT t."SECTION_TITLE") AS SECTIONS, '
            f'COUNT(DISTINCT IFF({HAS_TABLE}, t."CHUNK_ID", NULL)) AS TABLES '
            f'FROM {T()} t JOIN IDS ON IDS."DOC_ID" = t."DOC_ID" GROUP BY 1), '
            f'L AS (SELECT t."DOC_ID", "PRODUCT_NAME", "EDMS_NUMBER", "TITLE", "NAME", "VERSION_LABEL", '
            f'"MODIFIED_BY", {MOD_TS} AS MODIFIED_TS, "PAGES_TOTAL", "FILE_SIZE", "STATUS", "INGESTED_AT", '
            f'"FILE_NAME", "S3_PATH" FROM {T()} t JOIN IDS ON IDS."DOC_ID" = t."DOC_ID" '
            f'QUALIFY ROW_NUMBER() OVER (PARTITION BY t."DOC_ID" ORDER BY {LATEST}) = 1) '
            f"SELECT L.*, A.VERSIONS, A.CHUNKS, A.SECTIONS, A.TABLES, IDS.MATCHING "
            f'FROM L JOIN A ON A."DOC_ID" = L."DOC_ID" JOIN IDS ON IDS."DOC_ID" = L."DOC_ID" '
            f'ORDER BY {order_col} {direction} NULLS LAST, L."DOC_ID" '
            f"LIMIT %(limit)s OFFSET %(offset)s"
        )
        params = {**scope["params"], "limit": page_size, "offset": (page - 1) * page_size}
        count_sql = f'SELECT COUNT(DISTINCT "DOC_ID") FROM {T()} {scope["where"]}'
        rows = as_dicts(run(sql, params, "/library"))
        count = run(count_sql, scope["params"], "/library count")
        total = count.rows[0][0] if count.rows else 0
        return {
            "rows": rows,
            "total_count": total,
            "page": page,
            "total_pages": max(1, -(-total // page_size)),
            "sql": _render_sql_for_display(sql, params),
        }

    key = {**scope["key"], "page": page, "page_size": page_size, "sort": order_col, "dir": direction}
    return cached("library", key, bypass_cache, build)


@router.get("/versions")
def get_versions(doc_id: str = Query(..., min_length=1), bypass_cache: bool = Query(False), auth: dict = Depends(PERM)):
    """Version history of one document, newest first."""
    def build():
        sql = (
            f'SELECT "VERSION_LABEL", "MODIFIED", "MODIFIED_BY", MAX("RANKING") AS RANKING, '
            f'ANY_VALUE("TITLE") AS TITLE, ANY_VALUE("NAME") AS NAME, {MOD_TS} AS MODIFIED_TS '
            f'FROM {T()} WHERE "DOC_ID" = %(doc_id)s GROUP BY 1, 2, 3 '
            f"ORDER BY {VER_NUM} DESC NULLS LAST, MODIFIED_TS DESC NULLS LAST"
        )
        return {"versions": as_dicts(run(sql, {"doc_id": doc_id}, "/versions"))}

    return cached("versions", {"doc_id": doc_id}, bypass_cache, build)