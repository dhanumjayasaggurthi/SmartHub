# Oracle → Snowflake Data Validation

Two-script validation tool that snapshots Oracle source data at ingestion time and validates it against Snowflake at a later time — eliminating discrepancies caused by source data changes after ingestion.

---

## Scripts

| Script | Purpose |
|---|---|
| `Source_Validation_Script.py` | Connects to Oracle, collects source data, saves snapshot (step 1 of 2) |
| `Target_Validation_Script.py` | Reads snapshot, connects to Snowflake, merges and validates (step 2 of 2) |

The two scripts one level up in `DQ_IT_Validation/` are the older approach and aren't part of this flow:

| Script | Purpose |
|---|---|
| `Src_to_Trgt_Validation_Script.py` | Original single-pass Oracle → Snowflake validation, no snapshot step |
| `snowflake_comparison.py` | L0 → L1 comparison inside Snowflake (multi-schema), no Oracle involved |

Both read the same `validation_config.json` via `--config`. Use the pair in this folder for anything new.

---

## CLI flags

| Script | Flag | Default |
|---|---|---|
| `Source_Validation_Script.py` | `--config` / `-c` | `validation_config.json` |
| | `--report` / `-r` | falls back to `validation.report_path` |
| | `--output` / `-o` | falls back to `validation.snapshot_path` |
| `Target_Validation_Script.py` | `--config` / `-c` | `validation_config.json` |
| | `--snapshot` / `-s` | falls back to `validation.snapshot_path` |

---

## Workflow

For multiple databases, use separate snapshot files:
```
python Source_Validation_Script.py --config validation_config.json --output rimdocs_snapshot.json
python Source_Validation_Script.py --config validation_config.json --output insights_snapshot.json

python Target_Validation_Script.py --config validation_config.json --snapshot rimdocs_snapshot.json
python Target_Validation_Script.py --config validation_config.json --snapshot insights_snapshot.json
```

Sample StreamSets pipeline reports for the Insights database are checked in one level up as `INSIGHTS_REPORT_DEV.json`, `INSIGHTS_REPORT_QA.json` and `INSIGHTS_REPORT_PRD.json` — point `--report` (or `validation.report_path`) at the one for your environment.

---

## Config

Both scripts share a single `validation_config.json`:

| Section | Used By | Purpose |
|---|---|---|
| `oracle` | Script 1 only | Oracle connection credentials |
| `snowflake` | Script 2 only | Snowflake connection for querying tables |
| `snowflake_save` | Script 2 only | Snowflake connection for writing STG/CORE results |
| `validation` | Both | Runtime settings (timeout, parallelism, snapshot path, database name) |

## Config Example (validation_config.json)
 
```json
{
  "oracle": {
    "username": "your_oracle_username",
    "password": "your_oracle_password",
    "dsn": "your_oracle_host:1521/your_service_name"
  },
 
  "snowflake": {
    "account": "your_account.region",
    "user": "your_snowflake_user",
    "role": ["ROLE_ONE", "ROLE_TWO"],
    "warehouse": "your_warehouse",
    "private_key_path": "/path/to/rsa_key.p8",
    "private_key_password": "your_private_key_passphrase"
  },
 
  "snowflake_save": {
    "account": "your_account.region",
    "user": "your_snowflake_user",
    "role": "YOUR_SAVE_ROLE",
    "warehouse": "your_warehouse",
    "private_key_path": "/path/to/rsa_key.p8",
    "private_key_password": "your_private_key_passphrase",
    "database": "your_results_database",
    "stg_schema": "STG schema",
    "core_schema": "Core schema"
  },
 
  "validation": {
    "report_path": "/path/to/pipelines.json",
    "snapshot_path": "/path/to/source_snapshot.json",
    "database_name": "database_name",
    "parallel_execution": true,
    "max_parallel_tables": 5,
    "connection_pool_size": 7,
    "table_timeout": 60,
    "max_timeout_retries": 3,
    "excluded_columns": ["col1", "col2", "........."],
    "validate_all_tables": true,
    "max_tables_to_validate": null
  }
}
```
 
| Field | Description |
|---|---|
| `oracle.dsn` | Format: `host:port/service_name` |
| `snowflake.role` | Single string or list — if list, tries each role in order (multi-role fallback) |
| `snowflake_save.stg_schema` / `core_schema` | Schemas where validation result tables are created |
| `validation.report_path` | StreamSets pipeline JSON — used by Script 1 as default if `--report` not passed |
| `validation.snapshot_path` | Default snapshot file path for both scripts if CLI flags not passed |
| `validation.database_name` | Value stored in the `database` column in STG/CORE — e.g. `rimdocs` or `insights` |
| `validation.parallel_execution` | Collect tables concurrently (default true) |
| `validation.max_parallel_tables` | Worker count when parallel (default 5) |
| `validation.connection_pool_size` | Oracle pool size, defaults to `max_parallel_tables + 2` |
| `validation.table_timeout` | Seconds before a single table query is abandoned and retried (default 60) |
| `validation.max_timeout_retries` | How many times a timed-out table is retried before being marked FAULTY (default 3) |
| `validation.excluded_columns` | Column names skipped everywhere, matched case-insensitively |
 
This file is gitignored — keep your own copy out of the repo.

---
 

## Snowflake Output Tables

**STG** — new timestamped table per run, always written:
```
{stg_schema}.DQ_IT_VALIDATION_REPORT_YYYYMMDD_HHMMSS
```

**CORE** — single fixed table, incremental by database:
```
{core_schema}.DQ_IT_VALIDATION_REPORT
```
On each run if it's a new validation it appends the report data in the table or if it's a re-run for the same `database_name` then it deletes that row(report) and inserts the latest run report — other database reports are untouched (if any).