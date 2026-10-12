# Generic halfvec search status

Branch: `feature-generic-halfvec-expression-search`
Base: `main`
Merge/deploy: pending review and live environment signoff.

- [x] Generic direct-cast index-expression validator.
- [x] PostgreSQL index discovery for valid/ready full-column HNSW halfvec casts.
- [x] Matching auto-mode SQL; exact mode retains original vector precision.
- [x] Existing alias validation accepts recognized ANN strategy.
- [x] Alias UI displays recognized ANN storage representation.
- [x] Pure parser unit tests and PostgreSQL integration fixture added.
- [ ] Confirm unit and PostgreSQL integration tests passing on CI.
- [ ] Confirm actual source catalog/index mapping and query plans in staging.
- [ ] Benchmark real model, recall and latency with the HAQ dataset.
- [ ] Reviewed database migration for the selected source indexes.

Do not merge, deploy, or create database indexes solely because the
code changes are pushed.
