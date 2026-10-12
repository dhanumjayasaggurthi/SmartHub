# Generic halfvec expression ANN search

## Scope and compatibility

SmartHub's Data API now discovers HNSW indexes created over a **direct**
halfvec(n) cast of an existing fixed-size vector(n) column. It leaves the
original full-precision embedding column unchanged. The model, database, schema,
table, exposed column, dimension, operator class, and index name are resolved
from existing alias/model registration and PostgreSQL's live catalog, not from
table-specific conditionals.

A halfvec expression index is qualified only when it is ready, valid, not
partial, single-key HNSW, and its expression is a direct cast of a recognized
vector column to the same number of dimensions. Its operator class chooses
cosine/l2/inner-product behavior. Other expressions remain excluded.

On automatic search, use the discovered cast and halfvec operator for the
matching metric. Explicit exact search continues using the original vector
values, so operators can measure ANN recall against a full-precision baseline.
Existing native vector/halfvec indexes remain preferred when present.

The existing API configuration and alias registration are unchanged. The alias
editor reports the chosen indexed representation. The source table is never
created or modified by SmartHub; a DBA separately creates or removes indexes.

## Deployment example (illustrative configuration, NOT application logic)

Selected source: `haq_vector_embedding.rdh_haq_haq_query`
Original content: `question`
Original embedding: `question_embedding vector(3072)`
Model registration: the actual `text-embedding-3-large` Azure deployment, 3072 dimensions
Search metric: cosine

Subject to DBA review of existing indexes, capacity and pgvector version:

    CREATE INDEX CONCURRENTLY <approved_unique_index_name>
      ON <qualified_table>
      USING hnsw ((<embedding_column>::halfvec(<detected_dimensions>)) halfvec_cosine_ops);

    CREATE INDEX CONCURRENTLY <approved_unique_fts_index_name>
      ON <qualified_table>
      USING gin (to_tsvector('english', <question_column>));

Placeholders above are deliberate: SmartHub does not run arbitrary DDL through
its API. Choose exact SQL for a known source through the existing DBA process.

## Validation gates

1. Check source view versus base table and correct alias mapping.
2. Check pgvector extension version, index readiness, permissions, available
   disk/memory, and concurrent ingestion load.
3. Verify expression index appears in alias options and validation results.
4. Use Validate with planner enabled: the HNSW index must appear in the query
   plan, and the full-text GIN index must match the configured text language.
5. Verify a query-time embedding from the registered model is 3072-dimensional
   and uses the same preprocessing/model used for ingestion.
6. Compare ANN results with exact full-precision search for representative
   questions, including zero/null embeddings and table filters.
7. Load-test requests, provider throttling, latency and cost; canary before
   broad release.

Rollback is application rollback to main plus retaining database indexes until
operators review whether other queries depend on them. No stored vectors must be
regenerated solely because of index strategy changes.

## Known limitations

Only HNSW direct halfvec casts are added. Arbitrary expression, partial and
multi-column indexes are intentionally not supported. Half-precision ANN is
approximate and can change rank ordering relative to exact full precision.
The independent Index Health build-suggestion feature may still recommend
checking wide vector columns by hand; expression index creation stays a DBA task.
