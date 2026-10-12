# GRA SmartHub

Data quality and governance platform. React frontend talking to a FastAPI backend, with native Enterprise Agentic RAG/evaluation, plus two standalone pieces that run on their own schedules: the Source → Snowflake validation scripts and the email reporting jobs.

## Layout

```
SmartHub/
├── backend/
│   ├── assistant/                 # in-portal AI assistant (chat + avatar)
│   │   ├── knowledge/
│   │   │   ├── learned.md         # reviewed corrections, embedded into the KB
│   │   │   └── portal_overview.md # hand-written portal knowledge
│   │   ├── tests/
│   │   │   ├── eval_live.py       # scores the live model, not run by pytest
│   │   │   ├── test_assistant.py
│   │   │   ├── test_chat_flow.py
│   │   │   ├── test_navigation.py
│   │   │   ├── test_portal_map.py
│   │   │   ├── test_prompt_regression.py
│   │   │   └── test_voice.py
│   │   ├── __init__.py
│   │   ├── build_kb.py            # python -m assistant.build_kb
│   │   ├── check_env.py
│   │   ├── env.py                 # loads backend/.env into os.environ
│   │   ├── memory.py              # long-term memory, in the portal database
│   │   ├── navigation.py          # checks navigate_to / guide_tour before they reach the browser
│   │   ├── portal_map.py          # every page, tab and sub-tab the assistant can open
│   │   ├── rbac.py
│   │   ├── retrieval.py
│   │   ├── review_corrections.py
│   │   ├── router.py              # /assistant/* endpoints
│   │   └── tools.py               # permission-gated read-only tools
│   ├── migrations/smarthub_core/  # portal database schema, applied in order (V001__, V002__ …)
│   ├── scripts/                   # preflight.py, migrate_sqlite_to_postgres.py, check_timestamps.py
│   ├── .env.example
│   ├── .gitignore
│   ├── app.py
│   ├── audit.py
│   ├── auth.py
│   ├── bdc_admin.py
│   ├── chunk_explorer.py          # shared router for the IMMBOT / Virtual Regulator explorers
│   ├── communication_center.py
│   ├── consolidated_report.py
│   ├── data_api.py
│   ├── data_api_retrieval.py
│   ├── data_api_mcp.py
│   ├── data_validation.py
│   ├── data_validation_config.example
│   ├── data_validation_connectors.py
│   ├── db.py                      # the portal's own PostgreSQL: pool, queries, migrations
│   ├── epod.py
│   ├── excel_utils.py
│   ├── fda.py
│   ├── haq.py
│   ├── immbot.py                  # Unstructured, IMMBOT tab
│   ├── indexer.py                 # Data Studio, Index Health tab
│   ├── nipo.py
│   ├── postgres_query_runner.py
│   ├── rag.py                     # native Enterprise Agentic RAG orchestration + /rag API
│   ├── rag_evaluation.py          # versioned datasets, runs and quality metrics
│   ├── AGENTIC_RAG.md             # detailed RAG architecture, source config and rollout guide
│   ├── requirements-rag-eval.txt  # optional Ragas/datasets dependencies; not needed in production
│   ├── requirements.txt
│   ├── review.py
│   ├── s3_explorer.py             # Data Studio, S3 tab
│   ├── snowflake_query_runner.py  # Data Studio, Snowflake tab
│   ├── unstructured.py            # Unstructured, RimDocs tab + SF query runner
│   ├── virtual_regulator.py       # Unstructured, Virtual Regulator Internal
│   └── vr_external.py             # Unstructured, Virtual Regulator External
├── frontend/
│   ├── public/
│   │   ├── fonts/                 # 16 Johnson Display/Text .otf faces
│   │   ├── icons/                 # 66 JJ_* SVG icons
│   │   ├── background.png
│   │   ├── favicon.png
│   │   ├── jj-logo.png
│   │   ├── jj-logo-small.png
│   │   ├── jj-logo-stacked.png
│   │   ├── sh_logo.png
│   │   ├── sh_logo_small.svg
│   │   ├── sh_logo_small_black.svg
│   │   └── spinner.mp4
│   ├── src/
│   │   ├── assistant/             # floating avatar assistant widget
│   │   │   ├── test/preview.html
│   │   │   ├── AssistantAvatar3D.jsx   # lazy-loaded three.js chunk
│   │   │   ├── FloatingAssistant.jsx
│   │   │   ├── assistantActions.js
│   │   │   ├── avatarOptions.js
│   │   │   ├── captureScreen.js
│   │   │   ├── liquid-glass.js
│   │   │   ├── pageTips.js
│   │   │   ├── screenContext.js
│   │   │   ├── useAzureVoice.js
│   │   │   └── useSpeech.js
│   │   ├── components/
│   │   │   ├── Header.jsx
│   │   │   ├── ProtectedRoute.jsx
│   │   │   └── Sidebar.jsx
│   │   ├── config/
│   │   │   ├── msalConfig.js
│   │   │   ├── msalInstance.js
│   │   │   └── tools.js           # dashboard tool cards and their categories
│   │   ├── context/
│   │   │   ├── AssistantSettingsContext.jsx
│   │   │   ├── AuthContext.jsx
│   │   │   ├── RBACContext.jsx
│   │   │   └── SessionTimeoutContext.jsx
│   │   ├── hooks/
│   │   │   ├── useHeartbeat.js
│   │   │   ├── usePageTracking.js
│   │   │   └── useProfilePhoto.jsx
│   │   ├── pages/
│   │   │   ├── dataStudio/        # Data Studio, one folder per tab
│   │   │   │   ├── indexer.jsx        # Index Health tab (+ indexer.css)
│   │   │   │   ├── s3/S3Pane.jsx
│   │   │   │   ├── shared/            # studioParts.jsx, studioHelpers.js
│   │   │   │   ├── snowflake/         # SnowflakePane.jsx, TableCopier.jsx
│   │   │   │   ├── DataStudio.jsx     # tab bar
│   │   │   │   ├── panes.js           # list of tabs
│   │   │   │   └── useInPageLog.js
│   │   │   ├── components/
│   │   │   │   ├── ChunkExplorer.jsx          # shared IMMBOT / Virtual Regulator explorer
│   │   │   │   ├── CommunicationAI.jsx
│   │   │   │   ├── CommunicationParts.jsx
│   │   │   │   ├── DataTable.jsx
│   │   │   │   ├── EpodExplorer.jsx
│   │   │   │   ├── FDAExplorer.jsx
│   │   │   │   ├── ImmbotExplorer.jsx
│   │   │   │   ├── InlineMetadataModal.jsx
│   │   │   │   ├── LoadingSpinner.jsx
│   │   │   │   ├── NipoExplorer.jsx
│   │   │   │   ├── PostgresQueryRunner.jsx
│   │   │   │   ├── UnstructuredWelcome.jsx    # document-set picker
│   │   │   │   ├── VirtualRegulatorExplorer.jsx
│   │   │   │   ├── VrExternalExplorer.jsx     # + VrExternalTable, VrExternalWelcome, vrExternalFacets.js
│   │   │   │   └── WhatsNew.jsx
│   │   │   ├── AIassistant.jsx
│   │   │   ├── AuditPage.jsx
│   │   │   ├── CommunicationCenter.jsx
│   │   │   ├── BusinessDefinedChecks.jsx
│   │   │   ├── DQEngine.jsx
│   │   │   ├── Dashboard.jsx
│   │   │   ├── Dashboard.css
│   │   │   ├── DataAPIExport.jsx
│   │   │   ├── DataApiTableView.jsx
│   │   │   ├── DataTypeValidation.jsx
│   │   │   ├── DataValidation.jsx
│   │   │   ├── EPodRAG.jsx
│   │   │   ├── FuzzyMatch.jsx
│   │   │   ├── LoginPage.jsx
│   │   │   ├── LogoutPage.jsx
│   │   │   ├── RAGPage.jsx
│   │   │   ├── RAGEvaluation.jsx  # native /rag/evaluation regression/evaluation workspace
│   │   │   ├── RimDocsAgentic.jsx # native React Agentic RAG chat/configuration UI
│   │   │   ├── RimDocsRAG.jsx
│   │   │   ├── Unstructured.jsx
│   │   │   └── UserManagement.jsx
│   │   ├── utils/
│   │   │   ├── apiClient.js
│   │   │   ├── auditLog.js
│   │   │   └── sessionKeys.js
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── main.jsx
│   ├── .env.example
│   ├── .gitignore
│   ├── eslint.config.js
│   ├── index.html
│   ├── package.json
│   ├── postcss.config.js
│   ├── tailwind.config.js
│   └── vite.config.js
├── DQ_IT_Validation/
│   ├── Orchestration/
│   │   ├── Readme.md
│   │   ├── Source_Validation_Script.py
│   │   └── Target_Validation_Script.py
│   ├── .gitignore
│   ├── INSIGHTS_REPORT_DEV.json
│   ├── INSIGHTS_REPORT_PRD.json
│   ├── INSIGHTS_REPORT_QA.json
│   ├── Src_to_Trgt_Validation_Script.py
│   ├── requirements.txt
│   └── snowflake_comparison.py            # L0 → L1 Snowflake-only comparison
├── Email_reports/
│   ├── Email_delta_report.py
│   ├── Email_quarterly_report.py
│   ├── delta_wrapper.sh
│   ├── quarterly_wrapper.sh
│   └── requirements.txt
├── .github/workflows/
│   └── agentic-rag-ci.yml         # RAG backend tests + frontend lint/build
├── .gitignore
└── Readme.md
```

`DQ_IT_Validation` and `Email_reports` aren't called by the backend directly, they're scheduled jobs that write results into Snowflake, and the backend/frontend just read that data back out. The one exception is the delta wrapper, which kicks off a BDC run through the backend's `/api/run-validation` SSE endpoint before it builds the report.

## Stack

- Frontend: React 19, Vite 7, React Router 7, Tailwind 3, MSAL for Azure AD login, Recharts, @xyflow/react, three.js + @react-three/fiber/drei (assistant avatar, lazy-loaded)
- Backend: FastAPI on Uvicorn, Pandas, Snowflake connector (RSA key-pair auth), python-oracledb, psycopg2, jaydebeapi/JPype (Denodo), RapidFuzz for fuzzy matching, and the OpenAI SDK against Azure OpenAI for the assistant and native Agentic RAG
- Data: Snowflake is the main store, Oracle is where the IT validation scripts pull from, Postgres backs the unstructured explorers (EPOD, Q!, Nipocalimab, FDA) and the PG Query Runner. The portal's own state (roles, audit log, Communication Center, Data API, Data Studio history, What's New, assistant memory) lives in a separate PostgreSQL database, schema `smarthub_core`
- Auth: Azure AD, RBAC checked on both the frontend routes and backend endpoints

## Before you start

- Python 3.10+
- A PostgreSQL 12+ database for the portal's own tables (RDS is fine). The login needs CREATE on the database the first time, to make the `smarthub_core` schema
- Node 22.12+ (Vite 7 won't run on older)
- A Snowflake account with RSA key-pair auth already set up (this app doesn't use password auth to Snowflake)
- Source DB client libs if you're running the DQ validation scripts locally — `oracledb` may need Instant Client in thick mode depending on your DB version
- An Azure AD app registration (client ID + tenant ID) for login, with `User.Read`, `User.Read.All` and `Group.Read.All` delegated permissions and admin consent granted (the backend reads group membership to resolve roles)
- An Azure OpenAI deployment if you want the AI assistant or native Agentic RAG to answer (chat, plus embeddings where Data API semantic retrieval uses them; TTS is optional for avatar voice). The non-AI portal features still work without it.

## Getting it running

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate      # venv\Scripts\activate on Windows
pip install -r requirements.txt
```

You'll need a `backend/dq_config.json` before this will start. You also need CORS origins configured (in `dq_config.json` or the `CORS_ORIGINS` env var); the app deliberately refuses to boot without them rather than defaulting to something permissive.

Point the backend at its database with `SMARTHUB_DB_DSN` in `backend/.env` (see `.env.example`), then check it:

```bash
python db.py status          # which migrations are applied
python scripts/preflight.py  # connection, schema, privileges, capacity, file versions
```

Tables are created on first start (`SMARTHUB_DB_AUTO_MIGRATE=true`, the default). With it off, run `python db.py migrate` yourself.

```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

To sanity-check the assistant's environment before starting: `python -m assistant.check_env`.

### Frontend

```bash
cd frontend
cp .env.example .env          # then fill it in
npm install
npm run dev
```

Runs on port 3000. Everything environment-specific lives in `frontend/.env` — API base URL, legacy EPOD/RIMDocs RAG service URLs, the AD group names, the MSAL client ID/authority, and the native Agentic RAG rollout flag. `RimDocsAgentic.jsx` talks to the SmartHub FastAPI `/rag` endpoints through the existing authenticated API/SSE client; `VITE_API_RIMDOCS_AGENTIC_URL` is now only used by the temporary legacy rollback path. `msalConfig.js` just reads `VITE_MSAL_CLIENT_ID` / `VITE_MSAL_AUTHORITY`, so you switch tenants by editing `.env`, not code.

### DQ_IT_Validation

```bash
cd DQ_IT_Validation
pip install -r requirements.txt
python Orchestration/Source_Validation_Script.py --config validation_config.json --output snapshot.json
python Orchestration/Target_Validation_Script.py --config validation_config.json --snapshot snapshot.json
```

This one's a two-step process on purpose — snapshot Oracle first, validate against Snowflake later, so you're not comparing against a source that's already moved on. There's a full writeup of the config file in `DQ_IT_Validation/Orchestration/Readme.md`, worth reading before you touch it.

The two scripts at the top of that folder are older: `Src_to_Trgt_Validation_Script.py` does the whole Oracle → Snowflake comparison in one pass (no snapshot), and `snowflake_comparison.py` compares L0 to L1 inside Snowflake. Both take `--config validation_config.json`. Use the Orchestration pair for anything new.

### Email_reports

```bash
cd Email_reports
pip install -r requirements.txt
./delta_wrapper.sh
./quarterly_wrapper.sh
```

Heads up — the wrapper scripts have a hardcoded venv path, working directory, backend host and recipient list (`email_id` placeholders) baked in near the top. Fine for the existing box, but if you're setting this up somewhere new, go edit those first or the cron job will just fail quietly. They also expect an SMTP relay on `localhost`.

The Python scripts run on their own too: `python Email_delta_report.py --output-dir ... --config ... --skip-snowflake --skip-delta`.

## Config files you need to provide

None of these are in the repo, all gitignored:

- **`backend/dq_config.json`** — the main one. Startup fails unless it has `denodo_service_account`, `snowflake` (with `account`, `user`, `private_key_path`, `private_key_password`, `role`, `warehouse`, `database`, `schema`, `table_name`) and `scripts` (`script_dir`, `python_path`). Optional sections on top of that:
    - `ad_groups` — AD group → role mapping, see below. Skip it and everyone ends up a viewer.
    - `cors_origins` — list of allowed browser origins. Required unless you set `CORS_ORIGINS` instead.
    - `postgres_query_runner` — the Postgres connection. Shared by the PG Query Runner *and* the EPOD / Q! / Nipocalimab / FDA explorers. Without it those tabs report "not configured" instead of taking down the app.
    - `unstructured` — the Snowflake connection for the RimDocs, Virtual Regulator and IMMBOT tabs, plus `virtual_regulator_table`, `immbot_table`, `vr_external_table`, `vr_external_mapping_table` and `vr_external_sources` (extra External tables) to point them at other tables.
    - `snowflake_query_runner` — Data Studio's Snowflake tab. Anything left out falls back to the main `snowflake` section, so it can be as small as `allow_writes`. `SFQR_*` env vars work too. `SFQR_ALLOW_WRITES=false` makes the tab read-only whatever the role.
    - Data Studio's Index Health tab has no section here: it connects with the `[postgresql.<env>]` sections of `data_validation_config.ini`, and `INDEX_HEALTH_*` env vars tune builds (see `.env.example`).
    - `s3_explorer` — Data Studio's S3 tab: region, credentials (or the host's role if left blank) and a bucket allow-list. `S3X_*` env vars work too. Uploads and deletes stay off unless turned on.
- **`backend/.env`** — the portal database (`SMARTHUB_DB_DSN`, required, plus pool and timeout settings), Azure OpenAI (chat, embeddings, TTS), assistant behaviour, native Agentic RAG limits/REST allowlist, optional Redis for rate limiting, `PGQR_*` fallbacks for the Postgres connection, and `CORS_ORIGINS`. Copy `backend/.env.example` and work through it. For RDS put `sslmode=require` in the DSN. External RAG REST sources require `RAG_ALLOWED_API_HOSTS`; credentials are referenced by `RAG_SECRET_*` environment-variable name and are never stored in RAG metadata.
- **`backend/data_validation_config.ini`** — per-source, per-environment credentials for the Data Validation feature (`[insight7.dev]`, `[rimdocs.qa]`, `[postgresql.prod]` and so on; a suffix-less section is the fallback for any env without its own). Copy `backend/data_validation_config.example` as a starting point. Note the code's error message calls that file `data_validation_config.example.ini` — the one in the repo has no `.ini` on the end.
- **Semantic search** — no config file. Embedding models, per-column model registrations, response templates and per-alias settings are managed in the portal (Data API Export > Semantic search) and stored in the portal database with everything else; the core migration creates their tables.
- **`frontend/.env`** — see `frontend/.env.example`. Native Agentic RAG is on by default; `VITE_RAG_NATIVE_ENABLED=false` temporarily restores the legacy RIMDocs Agentic iframe during rollout.
- **`DQ_IT_Validation/validation_config.json`** — see that module's own readme for the full field list.

### Where the portal keeps its state

Everything the portal writes lives in PostgreSQL, schema `smarthub_core` (override with `SMARTHUB_DB_SCHEMA`). Back the database up; it holds real state:

- RBAC — custom roles, hand-given roles and per-user custom access (`rbac_*`). A leftover `rbac_config.json` next to `app.py` is imported once into an empty database, then renamed `.json.migrated`.
- Audit log and per-user assistant settings (`audit_log`, `assistant_settings`)
- Communication Center templates, sent history and the send queue (`email_*`)
- Data API Export definitions, tables, keys, request log, rate windows and semantic-search settings (`data_api_*`)
- Data Studio's Snowflake history and saved queries (`sf_*`)
- What's New items and the last scan (`release_notes`, `release_note_snapshots`)
- Assistant long-term memory (`assistant_user_memory`)
- Native Agentic RAG sources, profiles and user feedback (`rag_sources`, `rag_profiles`, `rag_feedback`)
- Agentic RAG evaluation datasets, immutable run snapshots and case-level results (`rag_eval_*`)

The schema is defined by the files in `backend/migrations/smarthub_core/`, applied in order and recorded in `schema_migrations`. Agentic RAG is added by `V004__agentic_rag.sql`. Never edit an applied migration; any later schema change must go in the next new versioned migration file.

On disk, next to `app.py`, the backend still creates:

- `communication_attachments/` — files sent through the Communication Center, kept for resend and download
- `assistant/knowledge/portal_kb.jsonl` — the embedded knowledge base, rebuilt with `python -m assistant.build_kb`

Coming from the SQLite version? The old `rbac.db`, `audit_log.db`, `communication_center.db`, `data_api_exports.db`, `snowflake_query_runner.db` and `release_notes.db` are no longer read. Copy them across once with `python scripts/migrate_sqlite_to_postgres.py` (`--dry-run` first; it merges, so running it twice duplicates nothing), check with `python scripts/check_timestamps.py`, then archive the files.

### AD group → role mapping (required)

The backend resolves each caller's role from their Azure AD group membership, so it needs to know which group maps to which role. Add an `ad_groups` block to `backend/dq_config.json`:

```json
"ad_groups": {
  "admin": "GRP-SmartHub-Admins",
  "dqe_righttime_superuser": "GRP-SmartHub-RightTime",
  "it_viewer": "GRP-SmartHub-IT"
}
```

Copy the three values verbatim from `frontend/.env` (`VITE_AD_GROUP_ADMIN`, `VITE_AD_GROUP_DQE_RIGHTTIME_SUPERUSER`, `VITE_AD_GROUP_IT_VIEWER`) so the two sides agree. Either the group display name or its object ID works.

If this is missing, **every user without an explicit override resolves to `viewer`** — the app will look broken (empty dashboard, no menu items) even though login succeeds. The backend logs a loud warning at startup when no mapping is configured, and confirms the loaded roles when it is. Alternatively the same three values can be supplied as `AD_GROUP_ADMIN` / `AD_GROUP_DQE_RIGHTTIME_SUPERUSER` / `AD_GROUP_IT_VIEWER` environment variables; the config file takes precedence.

Also confirm the Azure app registration has admin consent granted for `Group.Read.All` — without it the token is valid but group lookup returns nothing, with the same everyone-is-viewer result.

## Running it day to day

Backend: `uvicorn app:app --host 0.0.0.0 --port 8000` (drop `--reload` outside of dev)
Frontend dev: `npm run dev`
Frontend prod: `npm run build`, then serve `dist/`
Assistant tests: `python -m pytest assistant/tests -q` from `backend/`
Agentic RAG unit/security tests: `python -m pytest tests/test_rag.py tests/test_data_api_retrieval.py -q` from `backend/`
Assistant live eval (hits Azure OpenAI): `python -m assistant.tests.eval_live --workers 6` from `backend/`, add `--role it_viewer` etc. to test another role
Rebuild the assistant KB: `python -m assistant.build_kb` from `backend/`
Health check: `GET /health` (includes the portal database and its connection pool)
Database: `python db.py status` / `python db.py migrate`; full pre-deploy check `python scripts/preflight.py`

## Auth & access control

Login is Azure AD via MSAL. The frontend acquires an access token and sends it as a bearer token on every backend call (through `src/utils/apiClient.js` — don't call `fetch` against the API directly, it'll come back 401 without the token). The backend validates the token against Microsoft Graph and derives the caller's identity and role from it, so the API enforces permissions independently of the UI — hiding a button in the frontend is presentation, not security.

Two deliberate exceptions to "everything needs a token":

- `GET /health`
- the Data API Export consumer endpoints (`/data-api/{api_id}/tables`, `/{alias}/columns`, `/{alias}/count`, `/{alias}/rows`, and the POSTs `/{alias}/vector-search` and `/{alias}/retrieve`), authorised by `api_key` alone so the URLs work as plain links. The optional MCP endpoint `/data-api/mcp/{api_id}` uses the same key. Everything else under `/data-api` needs `manageDataAPIExports`.

Role resolution order, highest priority first:

1. AD group membership, per the `ad_groups` mapping
2. `viewer` (the default with no access)

Because the override is checked first, a user with **no AD groups at all** who is assigned a role in the portal gets that role's full access — including `admin`. Assignments are validated against the known role list, so a mistyped role name is rejected rather than silently locking the user down.

One caveat worth telling admins: when you change someone's role, the backend picks it up immediately, but that user's browser won't until they **refresh the page** (the frontend only loads their permissions on mount). If someone says "you made me an admin but I still can't see anything," a hard refresh is the first thing to try.

## What's in the backend

`app.py` is the main app and carries most of the routes — auth, search/metadata/download, the DQ validation report endpoints, KPI and dashboard endpoints, RBAC config, and the SSE-streamed triggers (`/api/run-validation`, `/api/run-compilation`, `/api/run-it-validation`). The rest is split into routers:

- `auth.py` — not a router; the shared token-validation and permission-check dependencies (`require_auth`, `require_permission`) plus server-side role resolution. Every protected route depends on it.
- `db.py` — not a router; the portal database. One connection pool per process, session limits (statement/lock/idle timeouts, Eastern time zone), the `?`-placeholder query adapter every module uses, and the migration runner (`python db.py migrate|status`). Errors from it surface as 503 (database unavailable) or 409 (concurrent change), never a bare 500.
- `audit.py` (`/api/audit`) — audit log with CSV export, heartbeat and active-user tracking, and per-user assistant settings. The dashboard counts are cached for a minute and refreshed in the background, since they scan the whole log
- `bdc_admin.py` (`/api/admin`) — admin side of Business Defined Checks
- `communication_center.py` (`/api/communications`) — Communication Center: admin-composed email to portal users (updates, warnings, maintenance notices), saved templates and a sent-message history. Sends through the local MTA with `smtplib`, gated on `sendCommunications`, and reads the optional `communications` config block.
- `consolidated_report.py` — the cross-rule consolidated report
- `review.py` (`/api/review`) — review/approval workflow
- `data_validation.py` (`/api/data-validation`) — the Data Validation / Data Type Validation backend: source system browsing (databases/schemas/tables), running comparisons, report generation. Reads `data_validation_config.ini`.
- `data_validation_connectors.py` — not a router; one connector class per source system (Oracle, Snowflake, PostgreSQL, Denodo, SQL Server, Databricks, plus DocuBridge/Grail as thin subclasses), each implementing the same interface (`get_columns`, `fetch_rows`/`search_rows`, `get_row_count`, pagination via `offset`)
- `data_api.py` (`/data-api`) — Data API Export: create/manage shareable, key-only table URLs (see the auth exception above); reuses `data_validation.py`'s source picker and the connectors rather than duplicating them
    - `data_api_retrieval.py` — validation of the portal-managed search configuration, server-side query embedding, Reciprocal Rank Fusion and response contracts behind `/retrieve` and text queries on `/vector-search`. No FastAPI or `data_api.py` imports, so it unit-tests on its own.
    - `data_api_mcp.py` — optional MCP server (`list_tables`, `describe_table`, `search`) mounted in-process at `/data-api/mcp/{api_id}`. Off unless `DATA_API_MCP_ENABLED=1` and `requirements-mcp.txt` is installed (it needs Pydantic 2).
    - Tests: `cd backend && python -m pytest tests -q`. The PostgreSQL integration tests run when `DATA_API_TEST_PG_DSN` points at a disposable database with pgvector.
    - Local demo and evidence: `scripts/retrieval_demo.py` (`setup`, `serve`, `evidence`) seeds a synthetic corpus into a local pgvector database, runs the Data API alone against it in an isolated `backend/.retrieval_demo/` folder, and writes an evidence pack (every request/response, EXPLAIN plans, latency, activity log, test results).
- `rag.py` (`/rag`) — native Enterprise Agentic RAG. Reuses Data API retrieval, the existing JDBC/database connector registry and permission-gated SmartHub read-only tools; also supports explicitly allowlisted HTTPS REST sources. Orchestration is bounded: rewrite/decompose/route → parallel retrieval → RRF → rerank → structured grounded generation → citation validation → claim verification → at most one repair/re-verification → verified answer or abstention.
- `rag_evaluation.py` (`/rag/evaluation`) — versioned regression datasets, persisted evaluation runs/case results, deterministic retrieval/citation/grounding/tool/abstention/latency metrics and baseline comparison. Ragas is an optional adapter installed from `requirements-rag-eval.txt`, not a production runtime dependency.
- `unstructured.py` (`/api/unstructured`) — the RimDocs side of the Unstructured Explorer; hosts the Snowflake ("SF") query runner
- `postgres_query_runner.py` (`/api/postgres`) — the Postgres ("PG") query runner: full SQL (not just SELECT) against a configured Postgres database, with destructive-statement confirmation, server-side cursor pagination for large results, cancellation, and its own database/schema/table/column explorer endpoints
- `snowflake_query_runner.py` (`/api/snowflake`) — Data Studio's Snowflake tab: full SQL with destructive-statement confirmation, background jobs with paging and cancel, the object explorer, saved queries and history, the editable row grid and the Table Copier
- `indexer.py` (`/index-health`) — Data Studio's Index Health tab: browse PostgreSQL databases/schemas/tables per env, check a table's indexes against how its columns are queried, and build the missing ones in a background thread the UI polls (`/build`, `/jobs/{id}`, `/jobs/{id}/cancel`). Jobs live in process memory, so run one worker; a restart forgets running jobs (the database keeps building, but the log is lost).
- `s3_explorer.py` (`/api/s3`) — Data Studio's S3 tab: bucket browsing, object preview and download, key search, and optional upload/delete
- `chunk_explorer.py` — not a router itself; builds the shared summary / facets / charts / rows / document / chunk / breakdown endpoints for the chunk-level Snowflake explorers below from a column spec
- `virtual_regulator.py` (`/api/virtual-regulator`) — Virtual Regulator Internal over `DEV_RAW.UNSTRUCTURED_EXPLORER.SUBX_FINAL` (one row per chunk per document version); adds `/products`, `/library` and `/versions` for the Overview and Documents tabs
- `vr_external.py` (`/api/vr-external`) — Virtual Regulator External: FDA press releases from `FDA_PRESS_RELEASE_RSS` plus any extra tables listed in `vr_external_sources`, grouped by health authority
- `immbot.py` (`/api/immbot`) — IMMBOT explorer over `DEV_RAW.UNSTRUCTURED_EXPLORER.IMMBOT_FINAL`; all endpoints come from `chunk_explorer.py`
- `epod.py` (`/api/epod`) — EPOD explorer over `regulatory.epod_extracts_core` (doc_chunks joined to ingestion_log)
- `haq.py` (`/api/haq`) — the Q! explorer over `haq_vector_embedding.haq_query_question`
- `nipo.py` (`/api/nipo`) — Nipocalimab explorer over `regulatory.rimdocs_nipo.doc_chunks`, grouped per document. There's no doc-level table behind it, so every query scans the full chunk table — it's the slowest of the four Postgres explorers.
- `fda.py` (`/api/fda`) — FDA & Others explorer, several dashboards over `regulatory.vector_embedding` (CRL AI matches, CRL letters, Pink Sheet letters, eCTD documents, FDA CRL letters, Milvexian metadata, RIM facility index)
- `excel_utils.py` — not a router, just shared helpers for formatting the Excel exports
- `assistant/` (`/assistant`) — the in-portal AI assistant, covered below

The four Postgres explorer routers (`epod`, `haq`, `nipo`, `fda`) share the single `postgres_query_runner` config block and override the database name themselves; there's no separate config section per explorer. The Snowflake ones (`unstructured`, `virtual_regulator`, `immbot`, `vr_external`) all read the `unstructured` config block. MirAI and RMWCreate have no backend yet.

Every Unstructured router needs `viewUnstructured` plus its document-set permission: `viewUnstructuredRimDocs` for `/api/unstructured` (and `/api/postgres`, which also needs `runPostgresQueryRunner`), `viewUnstructuredVR` + `viewUnstructuredVRInternal` for the Virtual Regulator router, `viewUnstructuredVR` + `viewUnstructuredVRExternal` for `/api/vr-external`, `viewUnstructuredIMMBOT`, `viewUnstructuredHAQ`, `viewUnstructuredEPOD`, `viewUnstructuredNipo` and `viewUnstructuredFDA` for the rest. The Explore / Data table / Breakdown sub-tab permissions (`viewUnstructuredEPODTable` and so on) only hide tabs in the UI; those tabs share endpoints, so the API checks the document set, not the sub-tab.

The Data Studio routers need `viewDataStudio` plus their own tab permission: `runSnowflakeQueryRunner` for `/api/snowflake`, `viewPGindexer` for `/index-health` (plus `buildPGindexer` to start or cancel builds), `runS3Explorer` for `/api/s3`.

## Enterprise Agentic RAG

The **RIMDocs Agentic** tab is now a native SmartHub React/FastAPI capability rather than a Streamlit iframe. The existing `/rag` page and its RIMDocs/EPOD legacy tabs remain in place; the native evaluation workspace is `/rag/evaluation`. The frontend uses the same MSAL-authenticated `apiClient.js` and SSE machinery as the rest of SmartHub, and the backend keeps RBAC enforcement server-side.

Source configuration is portal-managed and intentionally capability-aware:

- **Data API source** — points at an existing Data API export + alias. `mode=auto` uses the alias's existing semantic/hybrid retrieval configuration when available and otherwise falls back to safe live connector text search.
- **Connector source** — reuses `data_validation_connectors.py` for existing Oracle/RIMDocs, PostgreSQL, Snowflake, Denodo JDBC, SQL Server/Grail JDBC, Databricks JDBC and other registered connectors. A generic JDBC source is not falsely treated as pgvector-capable.
- **REST source** — HTTPS only, outbound host must be listed in `RAG_ALLOWED_API_HOSTS`, redirects are disabled, time/response-size limits apply, and any credential is referenced by a server-side `RAG_SECRET_*` variable rather than stored in metadata.
- **SmartHub tools/plugins** — a profile may enable existing assistant tools that are read-only and allowed for the current user's permissions. Browser actions and preference-writing tools are excluded.

A RAG profile controls its source IDs, source-only policy, decomposition, routing, candidate/final evidence budgets, reranking threshold, model overrides, permitted tools and verification policy. Configure sources/profiles from **RAGs → RIMDocs Agentic → Configure** (requires `manageDataAPIExports`); chat/evaluation use `viewRimDocsAgentic`.

The grounding contract is fail-closed. Every evidence item receives a stable evidence ID; generation must return structured claims and cite those IDs. The backend rejects invented citation IDs, verifies each claim against its cited evidence, treats verifier/model failure as unavailable rather than faithful, permits at most one repair, verifies the repaired answer again, and abstains when a verification-required profile cannot produce a fully verified answer. Retrieved DB/API/tool content is explicitly treated as untrusted data, not model instructions.

Evaluation lives at `/rag/evaluation`. Dataset versions are immutable; runs persist the profile/config snapshot and case-level evidence/citations. Deterministic metrics include retrieval recall/precision, Hit@K, MRR, source recall, citation validity, claim support/unsupported-claim rate, expected/forbidden tool behavior, abstention accuracy, verification rate and latency. Install `backend/requirements-rag-eval.txt` only in an evaluation environment if Ragas metrics are also wanted.

First-time deployment:

```bash
cd backend
python db.py migrate
# start SmartHub, then create at least one source + active/default profile in the UI
```

Native React is the default. `VITE_RAG_NATIVE_ENABLED=false` is a temporary rollout rollback that renders the old RIMDocs Agentic service URL instead. Full configuration examples, source contracts, security controls and rollout notes are in **[`backend/AGENTIC_RAG.md`](backend/AGENTIC_RAG.md)**.

The branch/PR validation workflow `.github/workflows/agentic-rag-ci.yml` compiles the RAG backend, runs the new grounding/security tests plus existing Data API retrieval tests, lints the changed React files and builds the Vite production bundle.

## The AI assistant

Two front doors, one backend: the floating avatar widget (`frontend/src/assistant/`, present on every page) and the `/ai-assistant` full page. `POST /assistant/chat` streams SSE back — tokens, browser actions (navigate, highlight, click/type, guided tour), the sources it grounded on, then done. The browser acks each action on `POST /assistant/action-ack`, so the model knows whether it actually worked.

Answers come from RAG over `assistant/knowledge/*.md` plus permission-gated read-only tools in `assistant/tools.py` that hit the portal's own API with the caller's token. The model only ever sees tools the user's role allows, and it's told to refuse rather than guess anything it can't back with a tool result or a retrieved doc.

Navigation doesn't trust the model. `assistant/portal_map.py` lists every page, tab and sub-tab with its exact URL, aliases and required permissions. A plain "take me to X" is resolved there and never reaches the model; anything else the model sends through `navigate_to` gets checked by `navigation.py`: ambiguous names get options, pages the role can't open are refused, and it upgrades a parent page to the exact tab asked for. Tours get the same treatment: each step is pinned to a real element from the user's screen, steps that point at nothing are dropped, and a tour is capped at 8 steps.

Worth knowing:

- Added or renamed a page, tab or URL param? Update `portal_map.py`. `test_portal_map.py` reads the frontend source and fails when the two drift apart.
- Run `python -m assistant.build_kb` after changing anything under `assistant/knowledge/`. The build also harvests backend routes from `app.py` and frontend routes from `App.jsx` automatically, so those don't need documenting by hand.
- User-submitted corrections land in `pending_corrections.jsonl` and are never embedded until an admin promotes them with `python -m assistant.review_corrections`, which appends them to `knowledge/learned.md`.
- The widget is opt-in per user (off by default, toggled from the account menu) and needs the `viewAssistantAvatar` permission, which today only `admin` has.
- Avatar models load from `/assets/*.glb` (see `avatarOptions.js`). Those files aren't in the repo — drop them into `frontend/public/assets/` or the 3D avatar won't render.
- Voice uses Azure OpenAI TTS. If the TTS vars aren't set the endpoint returns 503 and the browser falls back to its own voice. Clips are cached in memory, so repeated lines are free. Stop in the widget kills the stream, the audio and any tour.
- Chat, setup lookups and TTS each run in their own thread pool (`ASSISTANT_STREAM_WORKERS`, `ASSISTANT_PREP_WORKERS`, `ASSISTANT_TTS_WORKERS`), so a slow call doesn't hold up the others.
- Rate limiting is per user (30 chats/min). Redis when `ASSISTANT_REDIS_URL`/`REDIS_URL` is set, otherwise an in-process dict, which means per-worker counters.
- `azure-identity`, `redis` and `python-dotenv` are optional imports — installed, they get used; missing, the code falls back (api-key auth, in-memory limits, a small built-in .env parser). None of them are in `requirements.txt`.

## Frontend pages

Sidebar is grouped: Workspace (Dashboard, Data quality `/dqe`, Data Type Validation, Fuzzy match), Explorers (Unstructured Explorer `/unstructured-explorer`, Structured Explorer `/gra-data-domains`, Data Studio `/data-studio`, Data API Export), Intelligence (RAGs `/rag`, AI assistant) and Admin (User Management, Communication Center `/communication-center`, Audit Log). Everything except `/login` and `/logout` sits behind `PermissionRoute`, so what a user actually sees depends on their RBAC role.

A few pages are composites rather than routes of their own:

- **DQ Engine** (`/dqe?check=…`) picks between three check types, filtered by permission: IT Checks (`IT_Checks`), Data Validation (`Data_Validation`, still marked beta) and Business Defined Checks (`Business_defined_checks`). The latter two render `DataValidation.jsx` and `BusinessDefinedChecks.jsx`.
- **RAGs** (`/rag`) tabs between EPOD RAG, RimDocs RAG and **native RimDocs Agentic**. EPOD and legacy RimDocs still use `VITE_API_EPOD_URL` / `VITE_API_RIMDOCS_URL`; RimDocs Agentic uses the SmartHub backend `/rag` endpoints. `VITE_API_RIMDOCS_AGENTIC_URL` is retained only for the temporary `VITE_RAG_NATIVE_ENABLED=false` rollback. Agentic evaluation is the separate native route `/rag/evaluation`.
- **Unstructured Explorer** (`/unstructured-explorer`) opens on a picker (`UnstructuredWelcome`) and then into one of nine document sets — Virtual Regulator, IMMBOT, MirAI, RMWCreate, Q!, Nipocalimab, RimDocs, EPOD, FDA & Others — selected with `?doctype=`. RimDocs has Explore / Data table / Domain breakdown tabs plus the SF and PG query runners (`runUnstructuredQueryRunner`, `runPostgresQueryRunner`); Virtual Regulator has Internal / External; IMMBOT has Explore / Data table / Breakdown; EPOD, Nipocalimab and FDA have Explore / Data table; MirAI and RMWCreate are placeholders.
  - Access is a three-level tree in User Management: `viewUnstructured` → one permission per document set (`viewUnstructuredVR`, `viewUnstructuredRimDocs`, …) → one per sub-tab (`viewUnstructuredVRInternal`, `viewUnstructuredRimDocsTable`, …); the two query runners sit under `viewUnstructuredRimDocs`. Document sets and sub-tabs the user can't open are hidden, the picker cards are numbered by what's shown, and a URL pointing at a hidden one falls back to the first allowed.
  - Roles and custom access saved before these permissions existed are upgraded on read (`with_unstructured_tabs` / `apply_user_overrides` in `auth.py`, mirrored in `RBACContext.jsx`): a missing child follows its parent, so nobody loses a tab until an admin edits the role.
  - To add a document set or sub-tab: add the key to `UNSTRUCTURED_TABS` / `UNSTRUCTURED_SUBTABS` in both `backend/auth.py` and `context/RBACContext.jsx`, add it to the Unstructured group in `pages/userManagement/access.js`, gate its router in `app.py`, and give its `portal_map.py` entry the same `perms`.
- **Data Studio** (`/data-studio?pane=…`) is a tab bar over standalone tools, currently Snowflake (`pane=snowflake`), Index Health (`pane=indexer`) and S3 Explorer (`pane=s3`). It used to be the Snowflake Query Runner at `/snowflake-query-runner`; that path is gone. The page needs `viewDataStudio` and each tab has its own permission (`runSnowflakeQueryRunner`, `viewPGindexer` with `buildPGindexer` under it, `runS3Explorer`), all under the "Data Studio" section in User Management. Roles saved before that section existed get `viewDataStudio` automatically if any tab was on, until they're saved again. A tab stays mounted once opened, so switching back keeps a running query and its results. To add a tool: build it under `pages/dataStudio/<name>/`, add one line to `panes.js` (it gets `logInPage` and `active` as props), and add its permission to `ALL_PERMISSIONS` in `backend/auth.py`, the Data Studio group in `pages/userManagement/access.js`, its parent in `PERMISSION_PARENTS` and the role defaults in `RBACContext.jsx`. For a dashboard shortcut and breadcrumb, add it to the Data Studio `sections` and `trail` in `config/tools.js`; then add a `studio.<pane>` entry and the pane value in `backend/assistant/portal_map.py` (the portal map tests check every `tools.js` link resolves) and a line in `assistant/knowledge/portal_overview.md`.
- **Audit** also has `/audit-edit` and `/audit-edit-force` variants for admin cleanup.
- **Data API table view** (`/data-api-view/:apiId/:alias`) renders outside the app chrome, so it wires up its own RBAC provider.

## Deploying

- Backend behind nginx with TLS, run under systemd or supervisor, not `uvicorn --reload`.
    - **Run a single worker for now (`--workers 1`, the default).** A few things are still held in process memory — validated-token and resolved-role caches, the short-lived download/delta tokens, and running query jobs in the Snowflake, PG and unstructured query runners — and none of it is shared across workers. With more than one worker you'll get failed downloads (the "prepare" and "download" calls can land on different workers) and "job not found" while polling a query. Everything stored is in PostgreSQL now, so the database itself is ready for more workers and hosts; those in-memory pieces are what's left before scaling out. One worker comfortably serves a few hundred people: load-tested at 500 simulated users, median response 11 ms.
    - The backend must run close to the database (same AWS region/VPC as RDS). Most requests make one round trip to it; over a VPN that's ~100 ms each, in-region ~1 ms.
    - Before go-live, and after every deploy, run `python scripts/preflight.py --workers 1` on the server. It checks that the changed files are the reviewed versions, the database connection, migrations, privileges, connection headroom and time zone, and exits non-zero on any failure. Deployments that include Agentic RAG must have `V004__agentic_rag.sql` applied and at least one active RAG source/profile configured before the native tab can answer.
    - Connections: each worker opens up to `SMARTHUB_DB_POOL_MAX` (default 20) plus 8 for the Data API. Keep that well under the server's `max_connections`.
- Frontend is just a static build, `npm run build` and serve `dist/` from nginx or wherever. Remember `.env` is baked in at build time — a config change means a rebuild.
- Cron the two wrapper scripts for scheduled reports — again, fix the hardcoded paths, host and recipients first.
- Don't put `dq_config.json`, `.env`, `data_validation_config.ini`, the Snowflake key, or email credentials in the repo — pull them in from whatever secrets manager you're using at deploy time.

## PostgreSQL large-vector semantic search (opt-in)

The Data API semantic-search path supports catalog-validated HNSW indexes over
full-column half-precision casts of an existing fixed-size vector column.
This enables large embeddings (such as 3072-dimensional vectors) to retain
full-precision storage while HNSW uses a compatible halfvec expression index.
It discovers the selected physical source and index strategy from PostgreSQL
and the existing alias/model registry; there are no HAQ-specific code paths.

See [ARCHITECTURE_HALFVECS.md](ARCHITECTURE_HALFVECS.md),
[STATUS_HALFVECS.md](STATUS_HALFVECS.md), and
[docs/SEMANTIC_SEARCH_INDEX_GUIDE.md](docs/SEMANTIC_SEARCH_INDEX_GUIDE.md).
Index DDL remains a DBA deployment decision; the portal does not build these
expression indexes. Existing APIs continue to use their native vector indexes.
