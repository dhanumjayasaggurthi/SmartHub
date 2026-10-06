import React, { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../utils/apiClient';
import { useRBAC } from '../context/RBACContext';

const fmt = (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(3) : '—';

export default function RAGEvaluation() {
  const { hasPermission } = useRBAC();
  const canManage = hasPermission('manageDataAPIExports');
  const [profiles, setProfiles] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [runs, setRuns] = useState([]);
  const [capabilities, setCapabilities] = useState(null);
  const [datasetId, setDatasetId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [baselineId, setBaselineId] = useState('');
  const [selectedRun, setSelectedRun] = useState(null);
  const [selectedCase, setSelectedCase] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newDataset, setNewDataset] = useState(false);
  const [datasetName, setDatasetName] = useState('');
  const [datasetDescription, setDatasetDescription] = useState('');
  const [casesJson, setCasesJson] = useState(JSON.stringify([
    {
      case_id: 'case-001',
      question: 'What does the approved source say about this topic?',
      reference_answer: null,
      reference_evidence_ids: [],
      reference_source_ids: [],
      expected_tool_calls: [],
      forbidden_tool_calls: [],
      expected_abstention: null,
      tags: ['smoke'],
      metadata: {}
    }
  ], null, 2));

  const refresh = async () => {
    const [p, d, r, c] = await Promise.all([
      apiJson('/rag/profiles'),
      apiJson('/rag/evaluation/datasets'),
      apiJson('/rag/evaluation/runs'),
      apiJson('/rag/evaluation/capabilities'),
    ]);
    setProfiles(p.profiles || []);
    setDatasets(d.datasets || []);
    setRuns(r.runs || []);
    setCapabilities(c);
    if (!profileId && p.profiles?.length) setProfileId(p.profiles[0].id);
    if (!datasetId && d.datasets?.length) setDatasetId(d.datasets[0].id);
  };

  useEffect(() => { refresh().catch((e) => setError(e.message)); }, []);

  const openRun = async (id) => {
    setError('');
    try {
      const data = await apiJson(`/rag/evaluation/runs/${id}`);
      setSelectedRun(data);
      setSelectedCase(data.cases?.[0] || null);
    } catch (e) { setError(e.message); }
  };

  const run = async () => {
    if (!datasetId || !profileId || busy) return;
    setBusy(true); setError('');
    try {
      const data = await apiJson('/rag/evaluation/runs', {
        method: 'POST',
        body: { dataset_id: datasetId, profile_id: profileId, baseline_run_id: baselineId || null },
      });
      await refresh();
      await openRun(data.run_id);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const createDataset = async () => {
    let cases;
    try { cases = JSON.parse(casesJson); } catch { setError('Cases must be valid JSON.'); return; }
    if (!Array.isArray(cases)) { setError('Cases JSON must be an array.'); return; }
    try {
      await apiJson('/rag/evaluation/datasets', {
        method: 'POST',
        body: { name: datasetName, description: datasetDescription, cases },
      });
      setDatasetName(''); setDatasetDescription(''); setNewDataset(false);
      await refresh();
    } catch (e) { setError(e.message); }
  };

  const summaryMetrics = selectedRun?.run?.summary?.metrics || {};
  const metricRows = useMemo(() => Object.entries(summaryMetrics), [summaryMetrics]);

  return (
    <div className="min-h-full bg-jj-gray-01 p-5">
      <div className="mx-auto max-w-[1550px]">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-johnson-text text-[11px] font-bold uppercase tracking-[.16em] text-jj-red">Agentic RAG quality</p>
            <h1 className="mt-1 font-johnson-display text-3xl font-bold text-jj-gray-08">Evaluation & regression</h1>
            <p className="mt-2 max-w-3xl font-johnson-text text-sm leading-6 text-jj-gray-06">
              Run versioned datasets against a RAG profile, inspect retrieval/citation/grounding metrics, and compare a candidate with a baseline.
            </p>
          </div>
          {canManage && (
            <button type="button" onClick={() => setNewDataset((x) => !x)}
              className="rounded-lg bg-jj-red px-4 py-2.5 text-sm font-bold text-white">
              {newDataset ? 'Close dataset editor' : 'New dataset version'}
            </button>
          )}
        </header>

        {error && <div className="mt-4 rounded-xl bg-jj-maroon-05/10 p-3 text-sm text-jj-maroon-05">{error}</div>}

        {newDataset && canManage && (
          <section className="mt-5 rounded-2xl border border-jj-gray-03 bg-white p-5 shadow-sm">
            <h2 className="font-johnson-display text-xl font-bold text-jj-gray-08">Create evaluation dataset</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="text-xs font-bold text-jj-gray-07">Name
                <input value={datasetName} onChange={(e) => setDatasetName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-jj-gray-03 px-3 py-2 font-normal" />
              </label>
              <label className="text-xs font-bold text-jj-gray-07">Description
                <input value={datasetDescription} onChange={(e) => setDatasetDescription(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-jj-gray-03 px-3 py-2 font-normal" />
              </label>
              <label className="md:col-span-2 text-xs font-bold text-jj-gray-07">Cases JSON
                <textarea value={casesJson} onChange={(e) => setCasesJson(e.target.value)} rows={15} spellCheck={false}
                  className="mt-1 w-full rounded-xl bg-jj-gray-08 p-3 font-mono text-xs text-white" />
              </label>
            </div>
            <button type="button" disabled={!datasetName.trim()} onClick={createDataset}
              className="mt-4 rounded-lg bg-jj-red px-4 py-2 text-sm font-bold text-white disabled:opacity-40">
              Save immutable version
            </button>
          </section>
        )}

        <section className="mt-5 rounded-2xl border border-jj-gray-03 bg-white p-5 shadow-sm">
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
            <label className="text-xs font-bold text-jj-gray-07">Dataset
              <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-jj-gray-03 px-3 py-2 font-normal">
                <option value="">Select dataset</option>
                {datasets.map((d) => <option key={d.id} value={d.id}>{d.name} v{d.version} · {d.cases?.length || 0} cases</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-jj-gray-07">Profile
              <select value={profileId} onChange={(e) => setProfileId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-jj-gray-03 px-3 py-2 font-normal">
                <option value="">Select profile</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-jj-gray-07">Baseline run (optional)
              <select value={baselineId} onChange={(e) => setBaselineId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-jj-gray-03 px-3 py-2 font-normal">
                <option value="">No baseline</option>
                {runs.filter((r) => r.status === 'complete').map((r) => <option key={r.id} value={r.id}>{r.id.slice(0, 8)} · {r.started_at}</option>)}
              </select>
            </label>
            <button type="button" onClick={run} disabled={!datasetId || !profileId || busy}
              className="rounded-lg bg-jj-red px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40">
              {busy ? 'Running…' : 'Run evaluation'}
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-full bg-jj-gray-01 px-2.5 py-1 text-jj-gray-06">Deterministic metrics: {capabilities?.deterministic?.length || 0}</span>
            <span className={`rounded-full px-2.5 py-1 ${capabilities?.ragas?.available ? 'bg-jj-green-03/10 text-jj-green-05' : 'bg-jj-gray-01 text-jj-gray-06'}`}>
              Ragas adapter: {capabilities?.ragas?.available ? 'available' : 'optional / not installed'}
            </span>
          </div>
        </section>

        <div className="mt-5 grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <section className="overflow-hidden rounded-2xl border border-jj-gray-03 bg-white shadow-sm">
            <div className="border-b border-jj-gray-03 px-4 py-3">
              <h2 className="font-johnson-display text-lg font-bold text-jj-gray-08">Runs</h2>
            </div>
            <div className="max-h-[720px] overflow-auto p-3">
              {runs.map((r) => (
                <button key={r.id} type="button" onClick={() => openRun(r.id)}
                  className={`mb-2 w-full rounded-xl border p-3 text-left ${selectedRun?.run?.id === r.id ? 'border-jj-red bg-jj-red/5' : 'border-jj-gray-03 hover:bg-jj-gray-01'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs font-bold text-jj-gray-08">{r.id.slice(0, 10)}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${r.status === 'complete' ? 'bg-jj-green-03/10 text-jj-green-05' : r.status === 'failed' ? 'bg-jj-maroon-05/10 text-jj-maroon-05' : 'bg-jj-gray-01 text-jj-gray-06'}`}>{r.status}</span>
                  </div>
                  <p className="mt-2 text-[11px] text-jj-gray-06">{r.started_at}</p>
                  <p className="mt-1 text-[11px] text-jj-gray-06">{r.summary?.cases ?? '—'} cases · {r.summary?.failures ?? '—'} failures</p>
                </button>
              ))}
              {!runs.length && <p className="p-5 text-center text-xs text-jj-gray-05">No evaluation runs yet.</p>}
            </div>
          </section>

          <section className="min-w-0 space-y-5">
            {selectedRun ? (
              <>
                <div className="rounded-2xl border border-jj-gray-03 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wide text-jj-red">Run {selectedRun.run.id.slice(0, 10)}</p>
                      <h2 className="mt-1 font-johnson-display text-2xl font-bold text-jj-gray-08">Quality summary</h2>
                    </div>
                    <span className="rounded-full bg-jj-gray-01 px-3 py-1 text-xs font-bold text-jj-gray-07">{selectedRun.run.status}</span>
                  </div>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {metricRows.slice(0, 12).map(([name, stats]) => (
                      <div key={name} className="rounded-xl border border-jj-gray-03 bg-jj-gray-01/50 p-3">
                        <p className="truncate text-[10px] font-bold uppercase tracking-wide text-jj-gray-06">{name.replaceAll('_', ' ')}</p>
                        <p className="mt-2 font-johnson-display text-2xl font-bold text-jj-gray-08">{fmt(stats.mean)}</p>
                        <p className="mt-1 text-[10px] text-jj-gray-05">p95 {fmt(stats.p95)} · min {fmt(stats.min)}</p>
                      </div>
                    ))}
                  </div>
                  {selectedRun.run.summary?.baseline?.mean_deltas && (
                    <div className="mt-4 rounded-xl border border-jj-gray-03 p-4">
                      <p className="text-xs font-bold text-jj-gray-08">Baseline deltas</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {Object.entries(selectedRun.run.summary.baseline.mean_deltas).map(([name, delta]) => (
                          <span key={name} className={`rounded-full px-2 py-1 text-[10px] font-bold ${Number(delta) >= 0 ? 'bg-jj-green-03/10 text-jj-green-05' : 'bg-jj-maroon-05/10 text-jj-maroon-05'}`}>
                            {name}: {Number(delta) >= 0 ? '+' : ''}{fmt(delta)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
                  <div className="overflow-hidden rounded-2xl border border-jj-gray-03 bg-white shadow-sm">
                    <div className="border-b border-jj-gray-03 px-4 py-3">
                      <h3 className="font-johnson-display text-lg font-bold text-jj-gray-08">Cases</h3>
                    </div>
                    <div className="max-h-[650px] overflow-auto p-3">
                      {selectedRun.cases.map((c) => (
                        <button key={c.case_id} type="button" onClick={() => setSelectedCase(c)}
                          className={`mb-2 w-full rounded-xl border p-3 text-left ${selectedCase?.case_id === c.case_id ? 'border-jj-red bg-jj-red/5' : 'border-jj-gray-03'}`}>
                          <p className="text-xs font-bold text-jj-gray-08">{c.case_id}</p>
                          <p className="mt-1 line-clamp-2 text-xs text-jj-gray-06">{c.question}</p>
                          <div className="mt-2 flex gap-2 text-[10px] text-jj-gray-05">
                            <span>{c.latency_ms} ms</span><span>{c.error ? 'error' : 'complete'}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="min-w-0 rounded-2xl border border-jj-gray-03 bg-white p-5 shadow-sm">
                    {selectedCase ? (
                      <>
                        <p className="text-[11px] font-bold uppercase tracking-wide text-jj-red">{selectedCase.case_id}</p>
                        <h3 className="mt-2 font-johnson-display text-xl font-bold text-jj-gray-08">{selectedCase.question}</h3>
                        {selectedCase.error && <p className="mt-3 rounded-lg bg-jj-maroon-05/10 p-3 text-xs text-jj-maroon-05">{selectedCase.error}</p>}
                        <div className="mt-5">
                          <p className="text-xs font-bold uppercase tracking-wide text-jj-gray-06">Response</p>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-jj-gray-08">{selectedCase.response || '—'}</p>
                        </div>
                        <div className="mt-5 grid gap-2 sm:grid-cols-2">
                          {Object.entries(selectedCase.metrics || {}).map(([name, value]) => (
                            <div key={name} className="flex items-center justify-between rounded-lg border border-jj-gray-03 px-3 py-2">
                              <span className="text-[11px] text-jj-gray-06">{name.replaceAll('_', ' ')}</span>
                              <span className="text-xs font-bold text-jj-gray-08">{fmt(value)}</span>
                            </div>
                          ))}
                        </div>
                        <details className="mt-5 rounded-xl border border-jj-gray-03 p-4">
                          <summary className="cursor-pointer text-xs font-bold text-jj-gray-08">Retrieved evidence ({selectedCase.retrieved_evidence?.length || 0})</summary>
                          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-jj-gray-07">{JSON.stringify(selectedCase.retrieved_evidence || [], null, 2)}</pre>
                        </details>
                        <details className="mt-3 rounded-xl border border-jj-gray-03 p-4">
                          <summary className="cursor-pointer text-xs font-bold text-jj-gray-08">Citations ({selectedCase.citations?.length || 0})</summary>
                          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-jj-gray-07">{JSON.stringify(selectedCase.citations || [], null, 2)}</pre>
                        </details>
                      </>
                    ) : <p className="text-sm text-jj-gray-05">Select a case to inspect it.</p>}
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-jj-gray-03 bg-white p-12 text-center">
                <h2 className="font-johnson-display text-xl font-bold text-jj-gray-08">Select or run an evaluation</h2>
                <p className="mt-2 text-sm text-jj-gray-06">The result workspace shows metric distributions, baseline deltas, and case-level retrieval/citation diagnostics.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
