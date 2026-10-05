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

const KIND_COLOR = {
  feature:     '#eb1700',
  improvement: '#6e6259',
  fix:         '#ff6017',
  removal:     '#312c2a',
  commit:      '#a39a92',
};

const BLANK = { title: '', summary: '', detail: '', area: '', kind: 'feature', status: 'ready' };

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
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiJson(
        `/api/release-notes?status=${view}&include_commits=${showCommits}`);
      setNotes(data.notes || []);
      setCounts(data.counts || {});
      setLastScan(data.last_scan || null);
    } catch (err) {
      showError(err.message || 'Could not load what’s new');
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
        showToast('First scan done — from here on, anything new gets picked up');
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
    <div className="flex-1 overflow-auto p-5 flex flex-col gap-3.5">
      <section className={`${CLS.card} p-[18px]`}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className={CLS.sectionH}>What&rsquo;s new in SmartHub</h2>
            <p className={`${CLS.hint} mt-1 leading-relaxed max-w-[60ch]`}>
              Pages and endpoints that appear, vanish or move are picked up automatically
              every time the backend starts. Write a one-line summary on the ones worth
              announcing, tick them, and the drafter builds the email out of exactly those.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-none">
            <button onClick={rescan} disabled={scanning} className={CLS.ghostBtn}>
              <span className="flex items-center gap-1.5">
                <Icon src={refreshIcon} className="w-3.5 h-3.5" tone="dark" />
                {scanning ? 'Scanning…' : 'Scan now'}
              </span>
            </button>
            <button onClick={() => setEditing({ ...BLANK })} className={CLS.ghostBtn}>
              <span className="flex items-center gap-1.5">
                <Icon src={addIcon} className="w-3.5 h-3.5" tone="dark" />Add
              </span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap mt-3.5 pt-3.5 border-t border-jj-gray-02">
          {[['open', 'Waiting'], ['announced', 'Announced'], ['all', 'Everything']].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`px-2.5 py-1 rounded-lg font-johnson-text text-[11.5px] border ${
                view === id
                  ? 'border-jj-red/30 bg-jj-red/[0.05] text-jj-gray-08 font-medium'
                  : 'border-jj-gray-02 text-jj-gray-07 hover:border-jj-gray-04'
              }`}
            >
              {label}
              {id === 'open' && (counts.draft || counts.ready) ? (
                <span className="ml-1.5 text-jj-gray-05">
                  {(counts.draft || 0) + (counts.ready || 0)}
                </span>
              ) : null}
            </button>
          ))}
          <label className="flex items-center gap-1.5 ml-1 cursor-pointer">
            <input type="checkbox" checked={showCommits} className="accent-jj-red"
                   onChange={(e) => setShowCommits(e.target.checked)} />
            <span className={CLS.hint}>Show raw commits</span>
          </label>
          {lastScan && (
            <span className={`${CLS.hint} ml-auto`}>Last scan {shortDate(lastScan)}</span>
          )}
        </div>
      </section>

      <section className={`${CLS.card} p-[18px]`}>
        <div className="flex items-baseline justify-between gap-3 mb-3.5">
          <h2 className={CLS.sectionH}>
            {selected.length ? `${selected.length} picked` : 'Pick what to announce'}
          </h2>
          <div className="flex items-center gap-2">
            {open.length > 0 && (
              <button
                onClick={() => onSelectedChange(allOpenPicked ? [] : open.map((n) => n.id))}
                className={CLS.chipBtn}
              >
                {allOpenPicked ? 'Clear' : 'Select all'}
              </button>
            )}
            <button
              onClick={() => onDraft(selected)}
              disabled={!selected.length}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] bg-jj-red text-white
                         font-johnson-text text-[12.5px] font-medium hover:bg-jj-maroon-05
                         disabled:opacity-40 transition-colors"
            >
              <Icon src={aiIcon} className="w-3.5 h-3.5" tone="white" />
              Draft the announcement
            </button>
          </div>
        </div>

        {loading && <p className={CLS.hint}>Loading…</p>}

        {!loading && !notes.length && (
          <p className={`${CLS.hint} leading-relaxed`}>
            Nothing here yet. The first scan only takes a snapshot of the portal as it
            stands — anything you ship after that shows up on the next one.
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          {notes.map((note) => {
            const picked = selected.includes(note.id);
            const done = note.status === 'announced';
            return (
              <div
                key={note.id}
                className={`flex items-start gap-3 px-3 py-2.5 rounded-[10px] border transition-colors ${
                  picked
                    ? 'border-jj-red/25 bg-jj-red/[0.03]'
                    : 'border-jj-gray-02 hover:border-jj-gray-04'
                }`}
                style={{ borderLeft: `3px solid ${KIND_COLOR[note.kind] || '#a39a92'}` }}
              >
                <input
                  type="checkbox"
                  checked={picked}
                  disabled={done}
                  onChange={() => toggle(note.id)}
                  className="mt-1 accent-jj-red flex-none"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-johnson-text text-[13px] text-jj-gray-08 font-medium break-words">
                      {note.title}
                    </span>
                    {note.kind === 'removal' && (
                      <span className="px-1.5 py-0.5 rounded-md bg-jj-gray-08 text-white
                                       font-johnson-text text-[10px] tracking-wide uppercase">
                        removed
                      </span>
                    )}
                    {note.area && (
                      <span className="font-mono text-[11px] text-jj-gray-05">{note.area}</span>
                    )}
                    {done && (
                      <span className="flex items-center gap-1 font-johnson-text text-[11px] text-jj-gray-05">
                        <Icon src={checkIcon} className="w-3 h-3" tone="gray" />announced
                      </span>
                    )}
                  </div>
                  <p className="font-johnson-text text-[12px] text-jj-gray-06 mt-0.5 leading-relaxed break-words">
                    {note.summary || note.detail || (
                      <span className="italic text-jj-gray-05">
                        No summary written — the drafter will look the page up, but a
                        sentence here makes it better.
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-none">
                  <span className={`${CLS.hint} mr-1`}>{shortDate(note.created_at)}</span>
                  <button onClick={() => setEditing(note)} className={CLS.chipBtn} title="Edit">
                    <Icon src={editIcon} className="w-3 h-3" tone="gray" />
                  </button>
                  <button onClick={() => remove(note)} className={CLS.chipBtn} title="Remove">
                    <Icon src={trashIcon} className="w-3 h-3" tone="gray" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {editing && (
        <NoteForm note={editing} busy={saving} onCancel={() => setEditing(null)} onSave={save} />
      )}
    </div>
  );
};