import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiJson } from '../../utils/apiClient';
import { CLS, Icon, Modal } from './CommunicationParts';

import aiIcon      from "/icons/JJ_Icon_AI_RGB.svg";
import refreshIcon from "/icons/JJ_Icon_Refresh_RGB.svg";
import addIcon     from "/icons/JJ_Icon_Add.svg";
import trashIcon   from "/icons/JJ_Icon_Delete_RGB.svg";
import editIcon    from "/icons/JJ_Icon_Edit_RGB.svg";
import checkIcon   from "/icons/JJ_Icon_Check_RGB.svg";

const KINDS = [
  ['feature',     'Feature'],
  ['improvement', 'Improvement'],
  ['fix',         'Fix'],
  ['removal',     'Removed'],
  ['commit',      'Commit'],
];

const BLANK = { title: '', summary: '', detail: '', area: '', kind: 'feature', status: 'ready' };

// Pill colours per kind — background tint and text, from the brand palette.
const KIND_PILL = {
  feature:     ['rgba(15,104,178,.08)', '#0f68b2', 'New feature'],
  improvement: ['rgba(50,135,20,.1)',   '#328714', 'Improvement'],
  fix:         ['rgba(255,96,23,.1)',   '#c44a0f', 'Fix'],
  removal:     ['rgba(49,44,42,.08)',   '#312c2a', 'Removed'],
  commit:      ['rgba(163,154,146,.14)', '#6e6259', 'Commit'],
};

/** "2 days ago" for the last couple of weeks, a date after that. */
const relativeDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 14) return '1 week ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const shortDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/* One row's edit form. Detected items land with a title and no summary — the
   summary is the sentence a user would actually read, so this is mostly a box
   for writing that one line. */
const NoteForm = ({ note, busy, onCancel, onSave }) => {
  const [draft, setDraft] = useState({ ...BLANK, ...note });
  const set = (key) => (e) => setDraft({ ...draft, [key]: e.target.value });

  return (
    <Modal
      title={note.id ? 'Edit item' : 'Add a what’s-new item'}
      subtitle="The summary is what the announcement will be built from. One plain sentence is plenty."
      onClose={onCancel}
      busy={busy}
      width={520}
      footer={
        <>
          <button onClick={onCancel} disabled={busy} className={CLS.ghostBtn}>Cancel</button>
          <button
            onClick={() => onSave(draft)}
            disabled={busy || !draft.title.trim()}
            className={CLS.primaryBtn}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <label className={CLS.label}>Title</label>
      <input value={draft.title} onChange={set('title')} disabled={busy}
             placeholder="Table Copier" className={`${CLS.input} mb-3.5`} />

      <label className={CLS.label}>Summary</label>
      <textarea value={draft.summary} onChange={set('summary')} rows={3} disabled={busy}
                placeholder="Copy a Snowflake table or a whole schema between databases without writing the SQL."
                className={`${CLS.input} resize-y leading-relaxed mb-3.5`} />

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={CLS.label}>Where</label>
          <input value={draft.area} onChange={set('area')} disabled={busy}
                 placeholder="/data-studio" className={CLS.input} />
        </div>
        <div>
          <label className={CLS.label}>Kind</label>
          <select value={draft.kind} onChange={set('kind')} disabled={busy} className={CLS.input}>
            {KINDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
      </div>

      {draft.detail && (
        <>
          <label className={`${CLS.label} mt-3.5`}>Detail <span className={CLS.hint}>from the code</span></label>
          <textarea value={draft.detail} onChange={set('detail')} rows={3} disabled={busy}
                    className={`${CLS.input} resize-y leading-relaxed font-mono text-[12px]`} />
        </>
      )}
    </Modal>
  );
};

/** The What's New tab: everything that has shipped and whether users have
 *  been told. Tick the ones to cover, then let the model write it. */
export const WhatsNewPanel = ({ selected, onSelectedChange, onDraft, showToast, showError }) => {
  const [notes, setNotes] = useState([]);
  const [counts, setCounts] = useState({});
  const [lastScan, setLastScan] = useState(null);
  const [view, setView] = useState('open');
  const [showCommits, setShowCommits] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await apiJson(
        `/api/release-notes?status=${view}&include_commits=${showCommits}`);
      setNotes(data.notes || []);
      setCounts(data.counts || {});
      setLastScan(data.last_scan || null);
    } catch (err) {
      // Inline, with a retry: a toast that fades leaves an empty list that
      // looks exactly like "nothing shipped".
      setLoadError(err.message || 'Could not load what’s new');
    } finally {
      setLoading(false);
    }
  }, [view, showCommits, showError]);

  useEffect(() => { load(); }, [load]);

  const rescan = async () => {
    setScanning(true);
    try {
      const result = await apiJson('/api/release-notes/scan', { method: 'POST' });
      if (result.first_run) {
        showToast('First scan done. From here on, anything new gets picked up');
      } else if (result.total_new) {
        showToast(`Found ${result.total_new} change${result.total_new === 1 ? '' : 's'}`);
      } else {
        showToast('Nothing new since the last scan');
      }
      await load();
    } catch (err) {
      showError(err.message || 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const save = async (draft) => {
    setSaving(true);
    try {
      const body = {
        title: draft.title, summary: draft.summary, detail: draft.detail,
        area: draft.area, kind: draft.kind, status: draft.status || 'ready',
      };
      if (draft.id) {
        await apiJson(`/api/release-notes/${draft.id}`, { method: 'PUT', body });
      } else {
        await apiJson('/api/release-notes', { method: 'POST', body });
      }
      setEditing(null);
      showToast(draft.id ? 'Item updated' : 'Item added');
      await load();
    } catch (err) {
      showError(err.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (note) => {
    try {
      await apiJson(`/api/release-notes/${note.id}`, { method: 'DELETE' });
      onSelectedChange(selected.filter((id) => id !== note.id));
      showToast('Item removed');
      await load();
    } catch (err) {
      showError(err.message || 'Could not remove that');
    }
  };

  const toggle = (id) => onSelectedChange(
    selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const open = useMemo(() => notes.filter((n) => n.status !== 'announced'), [notes]);
  const allOpenPicked = open.length > 0 && open.every((n) => selected.includes(n.id));

  return (
    <div className="flex-1 overflow-auto p-5 flex flex-col">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="font-johnson-display font-medium text-[22px] tracking-[-0.02em] text-jj-gray-08">What&rsquo;s new</h2>
          <p className="font-johnson-text text-[12.5px] text-jj-gray-06 mt-1 leading-relaxed max-w-[64ch]">
            Found in recent deploys and not yet announced. Tick what users should hear about.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-none">
          <button type="button" onClick={rescan} disabled={scanning}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-jj-gray-02 bg-white
                             font-johnson-text text-[12px] text-jj-gray-07 hover:border-jj-gray-04 hover:text-jj-gray-08 disabled:opacity-50">
            <Icon src={refreshIcon} className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} tone="dark" />
            {scanning ? 'Scanning…' : 'Scan now'}
          </button>
          <button type="button" onClick={() => setEditing({ ...BLANK })}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-jj-gray-02 bg-white
                             font-johnson-text text-[12px] text-jj-gray-07 hover:border-jj-gray-04 hover:text-jj-gray-08">
            <Icon src={addIcon} className="w-3.5 h-3.5" tone="dark" />Add item
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap mt-4 mb-3.5">
        <div className="flex p-[3px] rounded-[10px] bg-jj-gray-01" role="group" aria-label="Which items">
          {[['open', 'Waiting'], ['announced', 'Announced'], ['all', 'Everything']].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-pressed={view === id}
              className={`px-3 py-1 rounded-[7px] font-johnson-text text-[11.5px] transition-all ${
                view === id ? 'bg-white text-jj-gray-08 font-medium shadow-[0_1px_4px_rgba(49,44,42,0.12)]' : 'text-jj-gray-06 hover:text-jj-gray-08'}`}
            >
              {label}
              {id === 'open' && (counts.draft || counts.ready) ? (
                <span className="ml-1.5 text-jj-gray-05 tabular-nums">{(counts.draft || 0) + (counts.ready || 0)}</span>
              ) : null}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 ml-2 cursor-pointer">
          <input type="checkbox" checked={showCommits} className="accent-jj-violet-03"
                 onChange={(e) => setShowCommits(e.target.checked)} />
          <span className={CLS.hint}>Show raw commits</span>
        </label>
        {open.length > 0 && (
          <button type="button" onClick={() => onSelectedChange(allOpenPicked ? [] : open.map((n) => n.id))}
                  className={`${CLS.chipBtn} ml-2`}>
            {allOpenPicked ? 'Clear all' : 'Select all'}
          </button>
        )}
        {lastScan && <span className={`${CLS.hint} ml-auto`}>Last scan {shortDate(lastScan)}</span>}
      </div>

      {loading && !notes.length && (
        <div className="flex flex-col gap-2.5" role="status" aria-label="Loading what’s new">
          {[0, 1, 2, 3].map((i) => <div key={i} className="cc-skel h-[92px] rounded-2xl" />)}
        </div>
      )}

      {!loading && loadError && (
        <div className="p-10 flex flex-col items-center text-center gap-3 bg-white rounded-2xl border border-jj-gray-02" role="alert">
          <p className="font-johnson-text text-[13px] text-jj-maroon-05">{loadError}</p>
          <button type="button" onClick={load} className={CLS.ghostBtn}>Try again</button>
        </div>
      )}

      {!loading && !loadError && !notes.length && (
        <div className="p-10 flex flex-col items-center text-center gap-2 bg-white rounded-2xl border border-jj-gray-02">
          <span className="w-12 h-12 rounded-2xl flex items-center justify-center bg-jj-violet-03/[0.08] mb-1">
            <Icon src={aiIcon} className="w-5 h-5" />
          </span>
          <p className="font-johnson-text text-[13px] text-jj-gray-07">
            {view === 'open' ? 'Everything that shipped has been announced.' : 'Nothing here yet.'}
          </p>
          <p className={`${CLS.hint} max-w-[52ch] leading-relaxed`}>
            The first scan only takes a snapshot of the portal as it stands. Anything shipped after that shows up on the next one.
          </p>
        </div>
      )}

      <div className={`flex flex-col gap-2.5 ${loading && notes.length ? 'opacity-60 transition-opacity' : 'transition-opacity'}`}>
        {notes.map((note, i) => {
          const picked = selected.includes(note.id);
          const done = note.status === 'announced';
          const [pillBg, pillFg, pillLabel] = KIND_PILL[note.kind] || KIND_PILL.commit;
          return (
            <div
              key={note.id}
              role="checkbox"
              aria-checked={picked}
              aria-disabled={done}
              tabIndex={done ? -1 : 0}
              onClick={() => { if (!done) toggle(note.id); }}
              onKeyDown={(e) => {
                if (done || e.target !== e.currentTarget) return;
                if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(note.id); }
              }}
              className={`cc-rise group relative flex gap-3.5 px-4 py-3.5 rounded-2xl bg-white border transition-[transform,border-color] duration-300
                          focus-visible:outline focus-visible:outline-2 focus-visible:outline-jj-violet-03 ${
                done ? 'border-jj-gray-02 opacity-70 cursor-default'
                  : picked
                    ? 'border-jj-violet-03/45 shadow-[0_0_0_3px_rgba(140,59,187,0.08)] cursor-pointer'
                    : 'border-jj-gray-02 hover:-translate-y-0.5 hover:shadow-[0_18px_36px_-28px_rgba(49,44,42,0.6)] cursor-pointer'}`}
              style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}
            >
              <span
                aria-hidden="true"
                className={`w-5 h-5 mt-0.5 rounded-md border-[1.5px] flex items-center justify-center flex-none transition-all ${
                  done ? 'bg-jj-gray-01 border-jj-gray-03'
                    : picked ? 'bg-jj-violet-03 border-jj-violet-03' : 'border-jj-gray-04 bg-white'}`}
              >
                {(picked || done) && (
                  <Icon src={checkIcon} className="w-[11px] h-[11px] cc-pop" tone={done ? 'gray' : 'white'} />
                )}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <b className="font-johnson-display font-medium text-[14.5px] text-jj-gray-08 break-words">{note.title}</b>
                  {note.area && <span className="font-mono text-[11px] text-jj-gray-05">{note.area}</span>}
                </div>
                <p className="font-johnson-text text-[12.5px] font-light text-jj-gray-07 mt-1 leading-relaxed break-words">
                  {note.summary || note.detail || (
                    <span className="italic text-jj-gray-05">
                      No summary written. The drafter will look the page up, but a sentence here makes it better.
                    </span>
                  )}
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <span className="px-2 py-0.5 rounded-md font-johnson-text text-[10px] tracking-[0.08em] uppercase font-medium"
                        style={{ background: pillBg, color: pillFg }}>
                    {pillLabel}
                  </span>
                  {done && (
                    <span className="flex items-center gap-1 font-johnson-text text-[11px] text-jj-gray-05">
                      <Icon src={checkIcon} className="w-3 h-3" tone="gray" />Announced
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-col items-end justify-between gap-2 flex-none">
                <span className={`${CLS.hint} whitespace-nowrap`} title={note.created_at ? new Date(note.created_at).toLocaleString() : ''}>
                  {relativeDate(note.created_at)}
                </span>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setEditing(note); }}
                          className={CLS.chipBtn} title="Edit" aria-label={`Edit ${note.title}`}>
                    <Icon src={editIcon} className="w-3 h-3" tone="gray" />
                  </button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); remove(note); }}
                          className={CLS.chipBtn} title="Remove" aria-label={`Remove ${note.title}`}>
                    <Icon src={trashIcon} className="w-3 h-3" tone="gray" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* The action bar rises once something is ticked, and stays in reach
          however long the list gets. */}
      <div
        className={`sticky bottom-0 mt-4 flex items-center gap-3 px-4 py-3 rounded-2xl bg-white/90 backdrop-blur-md
                    border border-jj-gray-02 shadow-[0_20px_40px_-24px_rgba(49,44,42,0.5)] transition-[transform,opacity] duration-500 ${
          selected.length ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6 pointer-events-none'}`}
        aria-hidden={!selected.length}
      >
        <span className="font-johnson-text text-[13px] text-jj-gray-07">
          <b className="font-johnson-display font-medium text-jj-gray-08 tabular-nums">{selected.length}</b> selected
        </span>
        <button type="button" onClick={() => onSelectedChange([])} tabIndex={selected.length ? 0 : -1}
                className={`${CLS.chipBtn} ml-auto`}>
          Clear
        </button>
        <button
          type="button"
          onClick={() => onDraft(selected)}
          disabled={!selected.length}
          tabIndex={selected.length ? 0 : -1}
          className="cc-ai flex items-center gap-1.5 px-3.5 py-2 rounded-[10px] font-johnson-text text-[12.5px] font-medium
                     text-white shadow-[0_10px_22px_-14px_rgba(140,59,187,0.8)] hover:-translate-y-0.5 transition-transform
                     disabled:opacity-40"
        >
          <Icon src={aiIcon} className="w-3.5 h-3.5" tone="white" />
          Draft announcement
        </button>
      </div>

      {editing && (
        <NoteForm note={editing} busy={saving} onCancel={() => setEditing(null)} onSave={save} />
      )}
    </div>
  );
};