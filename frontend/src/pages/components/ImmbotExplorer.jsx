import React from 'react';
import ChunkExplorer from './ChunkExplorer';

// IMMBOT tab - DEV_RAW.UNSTRUCTURED_EXPLORER.IMMBOT_FINAL (chunks + RIMDocs / trial
// metadata). Everything on screen is driven by this config; the explorer itself
// is shared with Virtual Regulator (ChunkExplorer.jsx).

const FILTERS = [
  { col: 'INSIGHT_THERAPEUTIC_AREA', label: 'Therapeutic area' },
  { col: 'GENERIC', label: 'Compound' },
  { col: 'PHASE', label: 'Phase' },
  { col: 'PRIMARY_INDICATION', label: 'Primary indication' },
  { col: 'PROTOCOL_ID', label: 'Protocol' },
  { col: 'CODI_MDM', label: 'Trial status (MDM)' },
  { col: 'CODI_VTMF', label: 'vTMF status' },
  { col: 'TA_TRIAL_INDICATION', label: 'TA trial indication' },
  { col: 'DOMAIN', label: 'Domain' },
  { col: 'A_STATUS', label: 'Status' },
  { col: 'STATUS', label: 'Ingestion status' },
  { col: 'ARTIFACT_NAME', label: 'Artifact' },
  { col: 'PRIMARY_GROUP', label: 'Primary group' },
  { col: 'R_VERSION_LABEL', label: 'Version label' },
  { col: 'CD_MIGRATED_SOURCE', label: 'Migrated source' },
  { col: 'PROTOCOL_APPROVED_RIMDOCS', label: 'Protocol approved in RIMDocs' },
  { col: 'TOM_HISTORICAL', label: 'TOM historical' },
  { col: 'R_OBJECT_TYPE', label: 'Object type' },
  { col: 'JJ_LEGACY_OBJ_TYPE', label: 'Legacy object type' },
  { col: 'SOURCE', label: 'Source' },
  { col: 'DOCUMENT_TYPE', label: 'Document type' },
  { col: 'VEEVA_TYPE', label: 'Veeva type' },
  { col: 'JJ_SUBMISSION_TYPE', label: 'Submission type' },
  { col: 'CHUNK_LEVEL', label: 'Chunk level' },
  { col: 'CONTENT_TYPE', label: 'Content type' },
];

const SEARCHES = [
  { col: 'FILE_NAME', ph: 'FILE_NAME contains…' },
  { col: 'OBJECT_NAME', ph: 'OBJECT_NAME contains…' },
  { col: 'PROTOCOL_ID', ph: 'PROTOCOL_ID contains…' },
  { col: 'JJ_TITLE', ph: 'JJ_TITLE contains…' },
  { col: 'JJ_NUMBER', ph: 'JJ_NUMBER contains…' },
  { col: 'SECTION_TITLE', ph: 'SECTION_TITLE contains…' },
  { col: 'CHUNK_TEXT', ph: 'Chunk text contains…' },
];

// columns the API sends that aren't listed get appended at the end
const DOC_TABLE_ORDER = [
  'FILE_NAME', 'OBJECT_NAME', 'PROTOCOL_ID', 'GENERIC', 'PHASE', 'PRIMARY_INDICATION',
  'INSIGHT_THERAPEUTIC_AREA', 'CODI_MDM', 'CODI_VTMF', 'JJ_NUMBER', 'JJ_TITLE', 'A_STATUS',
  'R_VERSION_LABEL', 'STATUS', 'ARTIFACT_NAME', 'PRIMARY_GROUP', 'CLINICAL_TRIAL_ID',
  'RIMDOCS_PRODUCT_DISPLAY_NAME', 'INSIGHT_FAMILY_CODE', 'TA_TRIAL_INDICATION',
  'PROTOCOL_APPROVED_RIMDOCS', 'TOM_HISTORICAL', 'CD_MIGRATED_SOURCE', 'DOMAIN', 'SOURCE',
  'CHUNK_TOTAL', 'MATCHING_CHUNKS', 'PAGES_TOTAL', 'FILE_SIZE', 'INGESTED_AT', 'UPDATED_AT', 'LAST_MODIFIED',
  'OBJ_ID', 'DOC_ID', 'FILE_PATH',
];
const CHUNK_TABLE_ORDER = [
  'FILE_NAME', 'CHUNK_INDEX', 'CHUNK_LEVEL', 'SECTION_TITLE', 'PAGE_START', 'PAGE_END', 'CONTENT_TYPES',
  'CHUNK_TEXT', 'OBJECT_NAME', 'PROTOCOL_ID', 'GENERIC', 'PHASE', 'PRIMARY_INDICATION', 'JJ_NUMBER',
  'A_STATUS', 'R_VERSION_LABEL', 'STATUS', 'CHUNK_ID', 'DOC_ID', 'OBJ_ID',
];

const DOC_META_FIELDS = [
  'PROTOCOL_ID', 'CLINICAL_TRIAL_ID', 'GENERIC', 'RIMDOCS_PRODUCT_DISPLAY_NAME', 'PHASE',
  'PRIMARY_INDICATION', 'INSIGHT_THERAPEUTIC_AREA', 'TA_TRIAL_INDICATION', 'CODI_MDM', 'CODI_VTMF',
  'OBJECT_NAME', 'JJ_NUMBER', 'JJ_TITLE', 'A_STATUS', 'R_VERSION_LABEL', 'STATUS', 'ARTIFACT_NAME',
  'PRIMARY_GROUP', 'PROTOCOL_APPROVED_RIMDOCS', 'TOM_HISTORICAL', 'CHUNK_TOTAL', 'PAGES_TOTAL',
  'FILE_SIZE', 'INGESTED_AT', 'UPDATED_AT', 'LAST_MODIFIED',
];

const IMMBOT_CONFIG = {
  apiPath: '/api/immbot',
  label: 'IMMBOT',
  logKey: 'immbot',
  filters: FILTERS,
  searches: SEARCHES,
  docTableOrder: DOC_TABLE_ORDER,
  chunkTableOrder: CHUNK_TABLE_ORDER,
  metaFields: DOC_META_FIELDS,
  defaultDimension: 'PRIMARY_INDICATION',
  defaultLevels: ['INSIGHT_THERAPEUTIC_AREA', 'GENERIC', 'PROTOCOL_ID'],
  trial: true,
  compoundPhase: true,
  kpis: ['protocols', 'size'],
  // the view repeats chunks once per joined metadata row
  distinctChunks: true,
};

export default function ImmbotExplorer(props) {
  return <ChunkExplorer config={IMMBOT_CONFIG} {...props} />;
}