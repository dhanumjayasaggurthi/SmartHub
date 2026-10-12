# Semantic-search index guide

## The problem

An indexed `vector(n)` storage representation has an HNSW dimension limit.
A `vector(3072)` embedding column can remain full precision while its HNSW
index is built over the corresponding `halfvec(3072)` cast.

This feature adds generic support for the latter without table-specific code.

## Existing API setup

Use the Data API Export > Semantic search tab for the selected alias. Select
the original embedding column, the model that produced those vectors, the
metric and an optional keyword column. The model registration is shared by all
aliases exposing the same physical column.

A compatible indexed cast is detected from PostgreSQL's catalog and listed
in the index strategy hint. Save is allowed only after the source index and
other configuration requirements pass backend validation.

For Hybrid/Keywords-only mode, the indexed full-text expression must match
the text-search configuration (typically English). If an index is missing,
the operator creates it outside SmartHub through DBA change control.

Use Validate, including an embedding test when appropriate, to confirm:
model dimensions, recognized indexes, query plans and retrieval permissions.

## Deployment safeguards

Review actual database/schema/table, object ownership, HNSW memory/disk,
index build concurrency, null/zero vectors, PostgreSQL statistics, index
validity and permissions. Do not index a table under heavy bulk ingestion
without scheduling and monitoring. Index changes are not performed by the UI.

If the index does not appear after creation, check index validity and refresh
the alias validation/catalog cache. Never bypass index checks merely to make
Save succeed.

The semantic query uses half precision only when a compatible expression
index exists and the API is in auto mode. Exact mode uses the original vector
column and is expensive on large tables; use it for controlled QA.
