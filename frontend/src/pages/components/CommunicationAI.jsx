import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '../../utils/apiClient';
import { CLS, Icon, Modal } from './CommunicationParts';

import aiIcon from "/icons/JJ_Icon_AI_RGB.svg";

/* What the quick buttons under the Message heading do. "write" and the
   what's-new one are the big two and live on their own buttons. */
export const REWORK = [
  ['rewrite',  'Rewrite'],
  ['shorten',  'Shorten'],
  ['expand',   'Expand'],
  ['formal',   'More formal'],
  ['friendly', 'Warmer'],
  ['subject',  'New subject'],
];

const TITLES = {
  write:     'Draft with AI',
  whats_new: 'Announce what’s new',
  rewrite:   'Rewrite this message',
  shorten:   'Shorten this message',
  expand:    'Expand this message',
  formal:    'Make it more formal',
  friendly:  'Make it warmer',
  subject:   'Write a new subject',
};

const SUBTITLES = {
  write:     'Say what the message needs to cover. It will look the portal up before it writes. Nothing is sent: the draft lands in the editor for you to edit.',
  whats_new: 'Built from the items you picked. Anything without a summary gets looked up in the portal knowledge base first.',
  subject:   'The body is left exactly as it is.',
};

/* What each tool call is called in the line under the draft. The point is to
   show the admin what the draft is standing on, so "it made that up" and "it
   read that off the portal" are told apart at a glance. */
const LOOKUP_LABELS = {
  portal_knowledge: 'the portal knowledge base',
  whats_new:        'the what’s-new list',
  past_messages:    'past announcements',
};

const lookupLine = (names = []) => {
  if (!names.length) return '';
  const known = names.map((n) => LOOKUP_LABELS[n] || n.replace(/_/g, ' '));
  const last = known.pop();
  return known.length ? `${known.join(', ')} and ${last}` : last;
};

const EXAMPLES = [
  'The Sunday DQE refresh moves from 2am to 6am ET starting this weekend. No action needed.',
  'Data Studio is down while we patch the warehouse. Back by 3pm ET Friday.',
  'Remind data stewards that Q3 business-defined checks need sign-off by the 30th.',
];

/* The AI is a drafting aid, so the result is shown and edited here rather than
   dropped straight into the compose boxes — the admin presses Insert, and what
   they press it on is what they read. */
export const AIDraftModal = ({
  mode = 'write', category, subject, body, noteIds = [], onClose, onApply,
}) => {
  const [prompt, setPrompt] = useState('');
  const [audience, setAudience] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [withBlocks, setWithBlocks] = useState(true);
  const field = useRef(null);
  const started = useRef(false);

  // The two modes that start from an instruction rather than from whatever is
  // already in the compose box.
  const isWrite = mode === 'write';
  const isWhatsNew = mode === 'whats_new';

  const generate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await apiJson('/api/communications/draft', {
        method: 'POST',
        body: { mode, prompt, category, subject, body, audience, note_ids: noteIds },
      });
      setResult({
        subject: data.subject || subject,
        body: data.body || '',
        headline: data.headline || '',
        banner_title: data.banner_title || '',
        banner_subtitle: data.banner_subtitle || '',
        used_note_ids: data.used_note_ids || [],
        looked_up: data.looked_up || [],
      });
    } catch (err) {
      setError(err.message || 'Could not draft the message');
    } finally {
      setBusy(false);
    }
  }, [busy, mode, prompt, category, subject, body, audience, noteIds]);

  /* A rework button already knows what it wants, so it runs on open rather
     than making you press Generate to say "yes, the thing I just clicked". */
  useEffect(() => {
    if (isWrite) { field.current?.focus(); return; }
    if (isWhatsNew) { field.current?.focus(); }
    if (started.current) return;
    started.current = true;
    generate();
  }, [isWrite, isWhatsNew, generate]);

  const insert = () => {
    if (!result) return;
    onApply({
      ...result,
      // Blocks are opt-in: overwriting a banner someone set by hand because
      // the model had an opinion about it would be rude.
      headline: withBlocks ? result.headline : '',
      banner_title: withBlocks ? result.banner_title : '',
      banner_subtitle: withBlocks ? result.banner_subtitle : '',
      keepBlocks: !withBlocks,
    });
  };

  const canGenerate = isWrite ? Boolean(prompt.trim()) : true;
  const askForPrompt = isWrite || isWhatsNew;

  return (
    <Modal
      title={TITLES[mode] || TITLES.write}
      subtitle={SUBTITLES[mode] || SUBTITLES.write}
      onClose={onClose}
      busy={busy}
      width={620}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className={CLS.ghostBtn}>Cancel</button>
          <button
            onClick={generate}
            disabled={busy || !canGenerate}
            className={CLS.ghostBtn}
          >
            {busy ? 'Writing…' : (result ? 'Try again' : 'Generate')}
          </button>
          <button
            onClick={insert}
            disabled={busy || !result}
            className={CLS.primaryBtn}
          >
            Insert into compose
          </button>
        </>
      }
    >
      {isWhatsNew && (
        <p className="mb-3.5 px-3 py-2.5 rounded-[10px] bg-[#f7f6f4] font-johnson-text
                      text-[12.5px] text-jj-gray-07 leading-relaxed">
          {noteIds.length
            ? `Covering ${noteIds.length} item${noteIds.length === 1 ? '' : 's'} picked on the What’s New tab.`
            : 'Nothing was picked, so this covers everything waiting to be announced.'}
          {' '}Items are marked announced when the email actually goes out, not now.
        </p>
      )}

      {askForPrompt && (
        <>
          <label className={CLS.label}>
            {isWhatsNew ? 'Anything to add?' : 'What should the message say?'}
            {isWhatsNew && <span className={`${CLS.hint} ml-1.5`}>Optional</span>}
          </label>
          <textarea
            ref={field}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); generate(); }
            }}
            rows={4}
            disabled={busy}
            placeholder={isWhatsNew
              ? 'Group it by page, mention the training session on the 5th…'
              : 'What changed, when it takes effect, and whether anyone has to do anything.'}
            className={`${CLS.input} resize-y leading-relaxed`}
          />
          <div className={`flex flex-wrap gap-1.5 mt-2 ${isWhatsNew ? 'hidden' : ''}`}>
            {EXAMPLES.map((text) => (
              <button
                key={text}
                onClick={() => setPrompt(text)}
                disabled={busy}
                className={CLS.chipBtn}
                title={text}
              >
                {text.slice(0, 42)}…
              </button>
            ))}
          </div>

          <label className={`${CLS.label} mt-3.5`}>Who is it going to? <span className={CLS.hint}>Optional</span></label>
          <input
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            disabled={busy}
            placeholder="Data stewards, GRA leads…"
            className={CLS.input}
          />
        </>
      )}

      {error && (
        <p className="mt-3.5 px-3 py-2.5 rounded-[10px] bg-jj-red/5 border border-jj-red/20
                      font-johnson-text text-[12.5px] text-jj-red">
          {error}
        </p>
      )}

      {busy && !result && (
        <p className={`${CLS.hint} mt-3.5`}>Writing the draft. This usually takes a few seconds.</p>
      )}

      {result && (
        <div className="mt-4 pt-4 border-t border-jj-gray-02">
          <label className={CLS.label}>Subject</label>
          <input
            value={result.subject}
            onChange={(e) => setResult({ ...result, subject: e.target.value })}
            disabled={busy}
            className={`${CLS.input} mb-3.5`}
          />

          <label className={CLS.label}>Body</label>
          <textarea
            value={result.body}
            onChange={(e) => setResult({ ...result, body: e.target.value })}
            rows={12}
            disabled={busy || mode === 'subject'}
            className={`${CLS.input} resize-y leading-relaxed font-mono text-[12.5px]`}
          />

          {(result.headline || result.banner_title) && (
            <label className="flex items-start gap-2 mt-3 cursor-pointer">
              <input
                type="checkbox"
                checked={withBlocks}
                onChange={(e) => setWithBlocks(e.target.checked)}
                className="mt-0.5 accent-jj-red"
              />
              <span className="font-johnson-text text-[12.5px] text-jj-gray-07 leading-snug">
                Also fill the template blocks
                {result.headline && <>, headline “{result.headline}”</>}
                {result.banner_title && <>, banner “{result.banner_title}”</>}
              </span>
            </label>
          )}

          <p className={`${CLS.hint} mt-3 leading-relaxed`}>
            {result.looked_up?.length
              ? `Written after reading ${lookupLine(result.looked_up)}. `
              : 'Written without looking anything up. '}
            Read it before you send it. It can still get a date wrong.
          </p>
        </div>
      )}
    </Modal>
  );
};

/** The row of AI buttons that sits in the Message section heading. */
export const AIToolbar = ({ hasBody, busy, onPick }) => (
  <div className="flex flex-wrap items-center gap-1.5">
    <button
      type="button"
      onClick={() => onPick('write')}
      disabled={busy}
      className="cc-ai flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] font-johnson-text text-[12px] font-medium
                 text-white shadow-[0_10px_22px_-14px_rgba(140,59,187,0.8)] transition-transform hover:-translate-y-0.5
                 disabled:opacity-50 disabled:hover:translate-y-0"
      title="Write this message from a short instruction"
    >
      <Icon src={aiIcon} className="w-3 h-3" tone="white" />Write with AI
    </button>
    <button
      type="button"
      onClick={() => onPick('whats_new')}
      disabled={busy}
      className="px-2.5 py-1 rounded-full border border-jj-violet-03/25 bg-jj-violet-03/[0.04] font-johnson-text
                 text-[11px] text-jj-violet-03 hover:bg-jj-violet-03/10 disabled:opacity-40"
      title="Announce everything that has shipped and not been announced yet"
    >
      What&rsquo;s new
    </button>
    {REWORK.map(([id, label]) => (
      <button
        type="button"
        key={id}
        onClick={() => onPick(id)}
        disabled={busy || !hasBody}
        className="px-2.5 py-1 rounded-full border border-jj-violet-03/25 bg-jj-violet-03/[0.04] font-johnson-text
                   text-[11px] text-jj-violet-03 hover:bg-jj-violet-03/10 disabled:opacity-35"
        title={hasBody ? `${label} the current message` : 'Write something first'}
      >
        {label}
      </button>
    ))}
  </div>
);