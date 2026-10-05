import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch, apiJson, downloadFile } from '../utils/apiClient';
import { useAuth } from '../context/AuthContext';
import {
  CLS, Icon, Modal, PromptModal, ConfirmModal, BodyEditor, RecipientPicker,
  RecipientField, splitAddresses, ADDR_RE,
} from './components/CommunicationParts';
import { AIDraftModal, AIToolbar } from './components/CommunicationAI';
import { WhatsNewPanel } from './components/WhatsNew';

import mailIcon       from "/icons/JJ_Icon_Communication_RGB.svg";
import alertIcon      from "/icons/JJ_Icon_Alert_RGB.svg";
import checkIcon      from "/icons/JJ_Icon_Check_RGB.svg";
import closeIcon      from "/icons/JJ_Icon_Close.svg";
import saveIcon       from "/icons/JJ_Icon_Save_RGB.svg";
import trashIcon      from "/icons/JJ_Icon_Delete_RGB.svg";
import searchIcon     from "/icons/JJ_Icon_Search_RGB.svg";
import refreshIcon    from "/icons/JJ_Icon_Refresh_RGB.svg";
import addIcon        from "/icons/JJ_Icon_Add.svg";
import stationeryIcon from "/icons/JJ_Icon_Stationery_RGB.svg";
import calendarIcon   from "/icons/JJ_Icon_Calendar_RGB.svg";
import communityIcon  from "/icons/JJ_Icon_Community_RGB.svg";
import shieldIcon     from "/icons/JJ_Icon_Shield_RGB.svg";
import lockIcon       from "/icons/JJ_Icon_Lock_black.svg";


const PREVIEW_TOP = 78;
const PREVIEW_HEIGHT = `calc(100vh - ${PREVIEW_TOP + 40}px)`;

const EASTERN = 'America/New_York';

const PLACEHOLDERS = {
  update:      { bannerTitle: 'Release Notes',          bannerSubtitle: 'GRA Data Quality Engine',        headline: "What's new this month",        subject: 'New in SmartHub: ' },
  warning:     { bannerTitle: 'Action required',        bannerSubtitle: 'SmartHub Alert!',                headline: 'Please review before Friday',  subject: 'Your SmartHub access needs re-approval' },
  maintenance: { bannerTitle: 'Scheduled maintenance',  bannerSubtitle: 'Day 01 Month, Time - Time PM ET', headline: 'SmartHub will be unavailable', subject: 'Planned downtime this Saturday' },
  custom:      { bannerTitle: 'SmartHub information session', bannerSubtitle: 'Updates to SmartHub',      headline: 'Thanks for joining us',        subject: "Recap from today's session" },
};

const BODY_PLACEHOLDER =
  'Hi everyone,\n\n' +
  'SmartHub will be unavailable on Day 01 Month, from Time to Time PM ET\n' +
  'due to scheduled maintenance.\n\n' +
  'No action is needed on your side - any reports scheduled in that window\n' +
  'will run automatically once we\'re back.';

const classifyAddresses = (raw) => {
  const all = splitAddresses(raw);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  all.forEach((addr) => {
    if (!ADDR_RE.test(addr)) {
      invalid.push(addr);
    } else if (!seen.has(addr.toLowerCase())) {
      seen.add(addr.toLowerCase());
      valid.push(addr);
    }
  });
  return { valid, invalid };
};

const hasText = (value) => Boolean(String(value ?? '').trim());

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Every timestamp this page shows is a server timestamp, and the server runs
 *  on Eastern — so render it in Eastern and say so, rather than quietly
 *  converting it to whatever the laptop is set to. */
const formatTimestamp = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-US', {
    timeZone: EASTERN,
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })} ET`;
};

/** "YYYY-MM-DDTHH:MM" for a datetime-local input, in Eastern rather than in
 *  the browser's zone — the field is an ET wall clock, because that is how the
 *  backend reads it back. */
const easternInputValue = (date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EASTERN,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ─── Toast ───────────────────────────────────────────────────────────────── */

const Toast = ({ message, type = 'success', onClose }) => {
  // onClose is a new closure on every parent render, so depending on it meant
  // the six-second timer restarted on each keystroke and the toast sat there.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const timer = setTimeout(() => close.current(), 6000);
    return () => clearTimeout(timer);
  }, []);

  const tone = type === 'error'
    ? 'bg-white border-jj-red/30'
    : 'bg-white border-jj-green-01/60';

  return (
    <div className="fixed top-5 right-5 z-[60] animate-slide-in">
      <div className={`${tone} border rounded-xl shadow-[0_12px_32px_rgba(49,44,42,0.16)] px-4 py-3.5
                       flex items-start gap-3 min-w-[300px] max-w-md`}>
        <Icon
          src={type === 'error' ? alertIcon : checkIcon}
          className="w-4 h-4 flex-shrink-0 mt-0.5"
          tone={type === 'error' ? 'red' : 'green'}
        />
        <span className="font-johnson-text text-[13px] text-jj-gray-08 flex-1">{message}</span>
        <button onClick={onClose} aria-label="Dismiss" className="opacity-50 hover:opacity-100">
          <Icon src={closeIcon} className="w-3.5 h-3.5" tone="gray" />
        </button>
      </div>
    </div>
  );
};

/* ─── Sensitivity label ───────────────────────────────────────────────────── */
/* The labels come down as a tree so sub-labels can sit in their own flyout,
   the way Outlook nests them behind the shield. Everything else wants them
   flat, so both shapes are kept. */

const flattenLabels = (tree, out = []) => {
  (tree || []).forEach((node) => {
    out.push(node);
    flattenLabels(node.children, out);
  });
  return out;
};

const findLabel = (tree, id) =>
  id ? flattenLabels(tree).find((l) => l.id === id) || null : null;

const SensitivityPicker = ({ tree, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [openChild, setOpenChild] = useState('');
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  useEffect(() => { if (!open) setOpenChild(''); }, [open]);

  const current = findLabel(tree, value);

  const pick = (id) => {
    onChange(id);
    setOpen(false);
  };

  // depth only sets the indent; isTop says whether this row sits in the main
  // menu. A row inside a flyout must not touch openChild - that was closing
  // the flyout the moment the pointer landed on one of its options.
  const row = (node, depth, isTop) => {
    const kids = node.children || [];
    // A parent is a way into its sub-labels, not a choice of its own - same
    // as Outlook, where Restricted only ever resolves to one of the two
    // underneath it. Ticked when the pick is somewhere below it.
    const chosen = kids.length
      ? flattenLabels(kids).some((k) => k.id === value)
      : value === node.id;

    return (
      <div
        key={node.id}
        className="relative"
        onMouseEnter={isTop && kids.length ? () => setOpenChild(node.id) : undefined}
      >
        <button
          onClick={() => (kids.length
            ? setOpenChild(openChild === node.id ? '' : node.id)
            : pick(node.id))}
          className={`flex items-center gap-2 w-full text-left py-2 pr-3 font-johnson-text
                      text-[13px] hover:bg-jj-gray-01 ${
            chosen ? 'text-jj-gray-08 font-medium' : 'text-jj-gray-07'
          }`}
          style={{ paddingLeft: 12 + depth * 10 }}
        >
          <span className="w-3 flex-none text-[11px] text-jj-gray-08">{chosen ? '✓' : ''}</span>
          <Icon
            src={node.protection ? lockIcon : shieldIcon}
            className="w-3.5 h-3.5 flex-none opacity-80"
          />
          <span className="flex-1">{node.label}</span>
          {kids.length > 0 && <span className="text-[11px] text-jj-gray-05">›</span>}
        </button>

        {/* Sub-labels fly out to the side where there is room for them, and
            fold in underneath where there is not. */}
        {kids.length > 0 && openChild === node.id && (
          <div className="hidden md:block absolute right-full top-0 w-56 py-1.5 bg-white
                          border border-jj-gray-02 rounded-[10px] shadow-lg">
            {kids.map((kid) => row(kid, 0, false))}
          </div>
        )}
        {kids.length > 0 && openChild === node.id && (
          <div className="md:hidden">{kids.map((kid) => row(kid, depth + 1, false))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={current ? `Sensitivity: ${current.path}` : 'No sensitivity label'}
        className={`flex items-center gap-1.5 ${CLS.ghostBtn} ${open ? 'bg-jj-gray-01' : ''}`}
      >
        <Icon
          src={current?.protection ? lockIcon : shieldIcon}
          className="w-3.5 h-3.5"
          tone={current ? 'dark' : 'gray'}
        />
        <span className="max-w-[170px] truncate">{current ? current.path : 'No label'}</span>
        <span className="text-[10px] text-jj-gray-05">▾</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-1.5 w-60 py-1.5 bg-white border
                        border-jj-gray-02 rounded-[10px] shadow-lg z-30">
          {tree.map((node) => row(node, 0, true))}
          {value && (
            <div className="border-t border-jj-gray-02 mt-1.5 pt-1.5">
              <button
                onClick={() => pick('')}
                className="w-full text-left px-3 py-2 font-johnson-text text-[13px]
                           text-jj-gray-06 hover:bg-jj-gray-01"
              >
                No label
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* ─── Confirm send ────────────────────────────────────────────────────────── */

const ConfirmSend = ({ summary, sending, onCancel, onConfirm }) => (
  <Modal
    title={summary.sendAt ? 'Schedule this message?' : 'Send this message?'}
    onClose={onCancel}
    busy={sending}
    footer={
      <>
        <button onClick={onCancel} disabled={sending} className={CLS.ghostBtn}>Cancel</button>
        <button onClick={onConfirm} disabled={sending} className={CLS.primaryBtn}>
          {sending
            ? (summary.sendAt ? 'Scheduling…' : 'Sending…')
            : (summary.sendAt ? 'Schedule it' : `Send to ${summary.total}`)}
        </button>
      </>
    }
  >
    <div className="bg-jj-gray-01 rounded-xl p-3.5 flex flex-col gap-2 mb-3.5">
      <div className="flex gap-2.5 font-johnson-text text-[13px]">
        <span className="w-[72px] flex-none text-jj-gray-06">Subject</span>
        <span className="flex-1 text-jj-gray-08">{summary.subject || '(none)'}</span>
      </div>
      <div className="flex gap-2.5 font-johnson-text text-[13px]">
        <span className="w-[72px] flex-none text-jj-gray-06">Going to</span>
        <span className="flex-1 text-jj-gray-08">
          {summary.to} to · {summary.cc} cc · {summary.bcc} bcc
        </span>
      </div>
      {summary.sendAt && (
        <div className="flex gap-2.5 font-johnson-text text-[13px]">
          <span className="w-[72px] flex-none text-jj-gray-06">Goes out</span>
          <span className="flex-1 text-jj-gray-08">{summary.sendAtLabel}</span>
        </div>
      )}
      {summary.attachments > 0 && (
        <div className="flex gap-2.5 font-johnson-text text-[13px]">
          <span className="w-[72px] flex-none text-jj-gray-06">Files</span>
          <span className="flex-1 text-jj-gray-08">{summary.attachments}</span>
        </div>
      )}
      {summary.sensitivityLabel && (
        <div className="flex gap-2.5 font-johnson-text text-[13px]">
          <span className="w-[72px] flex-none text-jj-gray-06">Sensitivity</span>
          <span className="flex-1 text-jj-gray-08">{summary.sensitivityLabel}</span>
        </div>
      )}
    </div>
    <p className="font-johnson-text text-[11.5px] text-jj-gray-05">
      {summary.sendAt
        ? 'It can be cancelled from the Queue tab up until it goes out.'
        : 'This cannot be recalled once sent.'}
    </p>
  </Modal>
);

/* ─── Page ────────────────────────────────────────────────────────────────── */

// In the URL, like every other tabbed page in the portal - so the Queue can
// be linked to, Back steps between tabs, and a refresh does not drop you
// into Compose from wherever you were.
const TABS = ['compose', 'whats-new', 'queue', 'history'];

const QUEUE_FILTERS = [
  ['all', 'All'], ['pending', 'Queued'], ['sent', 'Sent'],
  ['failed', 'Failed'], ['cancelled', 'Cancelled'],
];

const CommunicationCenter = () => {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState(() => {
    const wanted = searchParams.get('tab');
    return TABS.includes(wanted) ? wanted : 'compose';
  });
  const [config, setConfig] = useState(null);
  const [toast, setToast] = useState(null);
  const [device, setDevice] = useState('desktop');

  const [category, setCategory] = useState('update');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [attachments, setAttachments] = useState([]);
  // What is typed into a recipient box but not yet a chip. Blocks the send
  // rather than being dropped on the floor.
  const [drafts, setDrafts] = useState({ to: '', cc: '', bcc: '' });

  // J&J house-template fields. All optional.
  const [bannerTitle, setBannerTitle] = useState('');
  const [bannerSubtitle, setBannerSubtitle] = useState('');
  const [headline, setHeadline] = useState('');
  const [resources, setResources] = useState([]);

  // Schedule send. Empty means "now"; the value is an Eastern wall clock.
  const [sendAt, setSendAt] = useState('');

  // Purview label id. Empty = send unlabelled; the config picks the default.
  const [sensitivity, setSensitivity] = useState('');

  const [preview, setPreview] = useState({ subject: '', html: '' });
  const [previewError, setPreviewError] = useState('');
  const [templates, setTemplates] = useState([]);
  const [templatesState, setTemplatesState] = useState({ loading: true, error: '' });
  const [templateId, setTemplateId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [drafting, setDrafting] = useState(false);

  // Which AI mode the draft dialogue is open on, or null for closed.
  const [aiMode, setAiMode] = useState(null);
  // What's-new items this message is announcing. They ride along with the send
  // and are only ticked off once the mail has actually left.
  const [noteIds, setNoteIds] = useState([]);

  // One slot each for the two kinds of dialogue the page raises, so a stray
  // second click cannot stack two of them.
  const [ask, setAsk] = useState(null);      // { title, label, defaultValue, confirmLabel, onConfirm }
  const [check, setCheck] = useState(null);  // { title, subtitle, confirmLabel, tone, onConfirm }
  const [working, setWorking] = useState(false);

  // history
  const [entries, setEntries] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historySearch, setHistorySearch] = useState('');
  const [historyStatus, setHistoryStatus] = useState('all');
  const [historyCounts, setHistoryCounts] = useState({ all: 0, sent: 0, failed: 0, test: 0 });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const LIMIT = 25;

  // queue
  const [queue, setQueue] = useState([]);
  const [queueStatus, setQueueStatus] = useState('pending');
  const [queueCounts, setQueueCounts] = useState({});
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueDetail, setQueueDetail] = useState(null);

  const fileInput = useRef(null);

  const noteDraft = useCallback((field, text) => setDrafts((current) => (
    current[field] === text ? current : { ...current, [field]: text })), []);

  const changeTab = useCallback((next) => {
    if (next === tab) return;
    setTab(next);
    setDetail(null);
    setQueueDetail(null);
    // Compose is the default, so it stays a bare /communication-center
    // rather than leaving ?tab=compose on every link anyone copies.
    setSearchParams(next === 'compose' ? {} : { tab: next }, { replace: true });
  }, [tab, setSearchParams]);

  useEffect(() => {
    const wanted = searchParams.get('tab');
    const next = TABS.includes(wanted) ? wanted : 'compose';
    if (next === tab) return;
    setTab(next);
    setDetail(null);
    setQueueDetail(null);
  }, [searchParams, tab]);

  // The id keys the component, so a second toast starts a fresh timer rather
  // than inheriting whatever was left of the first one's.
  const showToast = useCallback(
    (message, type = 'success') => setToast({ id: Date.now(), message, type }), []);
  const showError = useCallback(
    (message) => setToast({ id: Date.now(), message, type: 'error' }), []);

  const layout = useMemo(() => ({
    banner_title: bannerTitle,
    banner_subtitle: bannerSubtitle,
    headline,
    // Tolerant of a template saved before one of these fields existed: a
    // missing key used to throw on .trim() and take the page down with it.
    resources: resources.filter(
      (r) => hasText(r.title) || hasText(r.description) || hasText(r.link_url)),
  }), [bannerTitle, bannerSubtitle, headline, resources]);

  /* ── initial load ───────────────────────────────────────────────────────── */
  const loadTemplates = useCallback(async () => {
    setTemplatesState({ loading: true, error: '' });
    try {
      const data = await apiJson('/api/communications/templates');
      setTemplates(data.templates || []);
      setTemplatesState({ loading: false, error: '' });
    } catch (err) {
      // Still not a blocker - you can write and send without a template.
      // But the rail used to say "No saved templates yet" whether they were
      // loading, missing, or unreachable, and those are three different
      // things to be told while you are looking for one.
      setTemplatesState({ loading: false, error: err.message || 'Could not load templates' });
    }
  }, []);

  useEffect(() => {
    apiJson('/api/communications/config')
      .then((cfg) => {
        setConfig(cfg);
        setSensitivity(cfg.default_sensitivity || '');
      })
      .catch((err) => showError(err.message || 'Could not load settings'));
    loadTemplates();
  }, [loadTemplates, showError]);

  /* ── history ────────────────────────────────────────────────────────────── */
  const historyParams = useCallback((extra = {}) => new URLSearchParams({
    search: historySearch || '',
    status: historyStatus && historyStatus !== 'all' ? historyStatus : '',
    ...extra,
  }), [historySearch, historyStatus]);

  const loadHistory = useCallback(async (nextOffset, term, status) => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(LIMIT),
        offset: String(nextOffset),
        search: term || '',
        status: status && status !== 'all' ? status : '',
      });
      const data = await apiJson(`/api/communications/history?${params}`);
      setEntries(data.entries || []);
      setHistoryTotal(data.total || 0);
      setHistoryCounts(data.counts || { all: 0, sent: 0, failed: 0, test: 0 });
      setHistoryOffset(nextOffset);
    } catch (err) {
      showError(err.message || 'Could not load history');
    } finally {
      setHistoryLoading(false);
    }
  }, [showError]);

  // Search and status both send you back to page one. The server does the
  // filtering now, so the rail counts, the pager and the rows on screen all
  // describe the same set instead of the rail describing only this page.
  useEffect(() => {
    if (tab !== 'history') return undefined;
    const timer = setTimeout(() => loadHistory(0, historySearch, historyStatus), 350);
    return () => clearTimeout(timer);
  }, [tab, historySearch, historyStatus, loadHistory]);

  const openDetail = async (id) => {
    setDetailLoading(true);
    try {
      setDetail(await apiJson(`/api/communications/history/${id}`));
    } catch (err) {
      // Clear the pane rather than leave the previous message sitting under
      // the row you just clicked, looking like the answer.
      setDetail(null);
      showError(err.message || 'Could not open that message');
    } finally {
      setDetailLoading(false);
    }
  };

  const exportHistory = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadFile(
        `/api/communications/history/export?${historyParams()}`,
        `communications_${new Date().toISOString().split('T')[0]}.csv`,
      );
    } catch (err) {
      showError(err.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const downloadAttachment = async (entryId, index, filename) => {
    try {
      await downloadFile(
        `/api/communications/history/${entryId}/files/${index}`, filename);
    } catch (err) {
      showError(err.message || 'That file could not be downloaded');
    }
  };

  /* ── queue ──────────────────────────────────────────────────────────────── */
  const loadQueue = useCallback(async (status) => {
    setQueueLoading(true);
    try {
      const params = new URLSearchParams({ status: status === 'all' ? 'all' : status });
      const data = await apiJson(`/api/communications/scheduled?${params}`);
      setQueue(data.entries || []);
      setQueueCounts(data.counts || {});
    } catch (err) {
      showError(err.message || 'Could not load the queue');
    } finally {
      setQueueLoading(false);
    }
  }, [showError]);

  // Loaded when the tab opens, and once on mount besides, so the count on the
  // Queue tab is right before anyone has been there - a message waiting to go
  // out is worth noticing from the Compose tab.
  const queuePreloaded = useRef(false);
  useEffect(() => {
    if (tab === 'queue') {
      queuePreloaded.current = true;      // a deep link counts as the preload
      loadQueue(queueStatus);
    } else if (!queuePreloaded.current) {
      queuePreloaded.current = true;
      loadQueue('pending');
    }
  }, [tab, queueStatus, loadQueue]);

  const openQueueDetail = async (id) => {
    setDetailLoading(true);
    try {
      setQueueDetail(await apiJson(`/api/communications/scheduled/${id}`));
    } catch (err) {
      setQueueDetail(null);
      showError(err.message || 'Could not open that message');
    } finally {
      setDetailLoading(false);
    }
  };

  const cancelScheduled = (entry) => setCheck({
    title: 'Cancel this scheduled send?',
    subtitle: `"${entry.subject}" is queued for ${formatTimestamp(entry.send_at)}. `
      + 'It will not go out, and its attachments are deleted.',
    confirmLabel: 'Cancel the send',
    tone: 'danger',
    onConfirm: async () => {
      await apiJson(`/api/communications/scheduled/${entry.id}`, { method: 'DELETE' });
      showToast('That send was cancelled');
      if (queueDetail?.id === entry.id) setQueueDetail(null);
      loadQueue(queueStatus);
    },
  });

  /* ── use a sent or queued message as a new draft ────────────────────────── */

  /** Pull the stored files back down and turn them into the File objects the
   *  send form wants. History used to keep only their names, so a re-used
   *  draft quietly went out without its attachment. */
  const refetchFiles = async (entry) => {
    const files = [];
    for (let index = 0; index < (entry.attachments || []).length; index += 1) {
      const meta = entry.attachments[index];
      /* eslint-disable no-await-in-loop */
      const response = await apiFetch(
        `/api/communications/history/${entry.id}/files/${index}`);
      if (!response.ok) continue;
      const blob = await response.blob();
      /* eslint-enable no-await-in-loop */
      files.push(new File([blob], meta.filename,
        { type: blob.type || 'application/octet-stream' }));
    }
    return files;
  };

  /** Load a stored message back into the compose tab. The stored subject
   *  already carries its category prefix, so strip it rather than let the
   *  server add a second one. */
  const loadIntoCompose = async (source, { withFiles }) => {
    if (!source || drafting) return;
    setDrafting(true);
    const prefix = (config?.categories || []).find((c) => c.id === source.category)?.prefix || '';
    const stored = source.subject || '';
    setCategory(source.category);
    setSubject(prefix && stored.startsWith(prefix) ? stored.slice(prefix.length).trim() : stored);
    setBody(source.body || '');
    setTo(source.to_addrs || '');
    setCc(source.cc_addrs || '');
    setBcc(source.bcc_addrs || '');
    const saved = source.layout || {};
    setBannerTitle(saved.banner_title || '');
    setBannerSubtitle(saved.banner_subtitle || '');
    setHeadline(saved.headline || '');
    setResources(saved.resources || []);
    setAttachments([]);
    setTemplateId('');
    setSendAt('');
    // Keep the classification it was sent under, unless that label is gone.
    setSensitivity(
      findLabel(config?.sensitivity_labels || [], source.sensitivity)
        ? source.sensitivity
        : (config?.default_sensitivity || ''),
    );
    // Through changeTab, so the url follows the screen - setting the tab
    // directly left ?tab=history on a draft that is plainly in Compose, and a
    // refresh then threw you back into the history list.
    changeTab('compose');

    const named = (source.attachments || []).length;
    if (!named) {
      showToast('Copied into Compose');
      setDrafting(false);
      return;
    }
    if (!withFiles || !source.files_stored) {
      showToast(`Copied into Compose — re-attach the ${plural(named, 'file')} before sending`);
      setDrafting(false);
      return;
    }
    showToast('Copied into Compose — fetching the files…');
    try {
      const files = await refetchFiles(source);
      setAttachments(files);
      showToast(files.length === named
        ? `Copied into Compose with ${plural(files.length, 'file')}`
        : `Copied into Compose — only ${files.length} of ${named} files could be fetched`);
    } catch {
      showError('Copied into Compose, but the files could not be fetched — re-attach them');
    } finally {
      setDrafting(false);
    }
  };

  /* ── from the What's New tab straight into a draft ──────────────────────── */
  const startWhatsNewDraft = useCallback((ids) => {
    if (!ids.length) return;
    if (!config?.ai_drafting) {
      showError('AI drafting is not configured on this server');
      return;
    }
    // An announcement is an update, whatever was selected in the rail before.
    setCategory('update');
    changeTab('compose');
    setAiMode('whats_new');
  }, [config, changeTab, showError]);

  /* ── AI draft lands in the editor ───────────────────────────────────────── */
  const applyDraft = useCallback((draft) => {
    if (draft.subject) setSubject(draft.subject);
    if (draft.body) setBody(draft.body);
    if (!draft.keepBlocks) {
      // Only what the model actually filled in — an empty banner_title means
      // it had no opinion, not that the one on screen should be cleared.
      if (draft.headline) setHeadline(draft.headline);
      if (draft.banner_title) setBannerTitle(draft.banner_title);
      if (draft.banner_subtitle) setBannerSubtitle(draft.banner_subtitle);
    }
    // Only the items it actually wrote about ride along to the send. If it
    // quietly dropped one, that one stays on the waiting list.
    if (draft.used_note_ids?.length) setNoteIds(draft.used_note_ids);
    setAiMode(null);
    showToast('Draft inserted — read it before you send');
  }, [showToast]);

  /* ── live preview, rendered server-side so it matches what goes out ─────── */
  useEffect(() => {
    // Anything at all in the draft is worth previewing - a headline or a
    // resource row on its own used to leave the pane empty.
    const anyContent =
      [subject, body, bannerTitle, bannerSubtitle, headline].some(hasText) ||
      (layout.resources || []).length > 0;
    if (!anyContent) {
      setPreview({ subject: '', html: '' });
      setPreviewError('');
      return undefined;
    }
    const timer = setTimeout(() => {
      apiJson('/api/communications/preview', {
        method: 'POST',
        body: { category, subject, body, layout },
      })
        .then((rendered) => {
          setPreview(rendered);
          setPreviewError('');
        })
        // Still no toast - it would fire on every other keystroke. But the
        // pane keeps showing the last good render, and saying nothing left
        // that looking like a preview of what you just typed.
        .catch((err) => setPreviewError(err.message || 'Preview is out of date'));
    }, 400);
    return () => clearTimeout(timer);
  }, [category, subject, body, bannerTitle, bannerSubtitle, headline, layout]);

  /* ── tallies and blockers ───────────────────────────────────────────────── */
  const tally = useMemo(() => {
    const t = classifyAddresses(to);
    const c = classifyAddresses(cc);
    const b = classifyAddresses(bcc);
    return {
      to: t.valid.length,
      cc: c.valid.length,
      bcc: b.valid.length,
      total: t.valid.length + c.valid.length + b.valid.length,
      invalid: t.invalid.length + c.invalid.length + b.invalid.length,
    };
  }, [to, cc, bcc]);

  const attachmentBytes = attachments.reduce((sum, f) => sum + f.size, 0);
  const maxBytes = (config?.max_attachment_mb ?? 10) * 1024 * 1024;
  const maxSubjectChars = config?.max_subject_chars ?? 300;
  const maxBodyChars = config?.max_body_chars ?? 50000;
  const maxScheduleDays = config?.max_schedule_days ?? 90;

  // Recomputed on every render rather than held in state: a "min" that was
  // right when the page loaded is wrong by the time a long message is written.
  const earliestSend = easternInputValue(new Date(Date.now() + 5 * 60 * 1000));
  const latestSend = easternInputValue(
    new Date(Date.now() + maxScheduleDays * 86400 * 1000));

  const blockers = useMemo(() => {
    const list = [];
    if (!subject.trim()) list.push('Subject is empty');
    if (!body.trim()) list.push('Message is empty');
    if (subject.length > maxSubjectChars) list.push(`Subject is over ${maxSubjectChars} characters`);
    if (body.length > maxBodyChars) {
      list.push(`Message is over ${maxBodyChars.toLocaleString()} characters`);
    }
    if (tally.to === 0) list.push('No valid To recipients');
    // Say which key fixes it. The address is sitting right there in the box;
    // the admin just has not told us it is finished yet.
    const unfinished = Object.keys(drafts).filter((field) => drafts[field].trim());
    if (unfinished.length) {
      list.push(`Press Enter to add the address typed in ${unfinished
        .map((field) => field.toUpperCase()).join(' and ')}`);
    }
    if (tally.invalid > 0) list.push(`${tally.invalid} address${tally.invalid === 1 ? '' : 'es'} need fixing`);
    if (attachmentBytes > maxBytes) list.push('Attachments are over the size limit');
    if (config && tally.total > config.max_recipients) {
      list.push(`Over the ${config.max_recipients} recipient limit`);
    }
    if (sendAt && sendAt < earliestSend) list.push('The send time has already passed');
    if (sendAt && sendAt > latestSend) {
      list.push(`Cannot schedule more than ${maxScheduleDays} days ahead`);
    }
    return list;
  }, [subject, body, tally, attachmentBytes, maxBytes, maxSubjectChars, maxBodyChars,
      config, sendAt, earliestSend, latestSend, maxScheduleDays, drafts]);

  const ready = blockers.length === 0;

  /* ── attachments ────────────────────────────────────────────────────────── */
  const addFiles = (fileList) => {
    const incoming = Array.from(fileList || []);
    const max = config?.max_attachments ?? 5;
    const merged = [...attachments];
    let overflow = 0;
    let duplicate = 0;
    incoming.forEach((file) => {
      if (merged.length >= max) { overflow += 1; return; }
      if (merged.some((f) => f.name === file.name && f.size === file.size)) {
        duplicate += 1;
        return;
      }
      merged.push(file);
    });
    // Say what was dropped and why. Adding four files to a full list used to
    // look exactly like adding four files to an empty one.
    if (overflow) {
      showError(`At most ${max} attachments — ${overflow} file${overflow === 1 ? '' : 's'} not added`);
    } else if (duplicate) {
      showError(`${duplicate} file${duplicate === 1 ? ' is' : 's are'} already attached`);
    }
    setAttachments(merged);
    if (fileInput.current) fileInput.current.value = '';
  };

  const removeFile = (index) => setAttachments(attachments.filter((_, i) => i !== index));

  /* ── recipients from the directory ──────────────────────────────────────── */
  const addRecipients = (field, emails) => {
    const setter = { to: setTo, cc: setCc, bcc: setBcc }[field];
    const current = { to, cc, bcc }[field];
    const existing = splitAddresses(current);
    const seen = new Set(existing.map((a) => a.toLowerCase()));
    const added = emails.filter((email) => {
      const key = email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setter([...existing, ...added].join(', '));
    const skipped = emails.length - added.length;
    showToast(
      `${plural(added.length, 'address')} added to ${field.toUpperCase()}`
      + (skipped ? ` · ${skipped} already there` : ''));
  };

  /* ── send ───────────────────────────────────────────────────────────────── */
  const post = async (testOnly) => {
    const form = new FormData();
    form.append('category', category);
    form.append('subject', subject);
    form.append('body', body);
    form.append('layout', JSON.stringify(layout));
    form.append('to', to);
    form.append('cc', cc);
    form.append('bcc', bcc);
    form.append('test_only', testOnly ? 'true' : 'false');
    form.append('send_at', testOnly ? '' : sendAt);
    form.append('sensitivity', sensitivity);
    form.append('release_notes', noteIds.join(','));
    attachments.forEach((file) => form.append('files', file, file.name));

    const response = await apiFetch('/api/communications/send', { method: 'POST', body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || 'Send failed');
    return payload;
  };

  const clearDraft = () => {
    setSubject(''); setBody(''); setTo(''); setCc(''); setBcc('');
    setAttachments([]); setTemplateId(''); setSendAt('');
    setDrafts({ to: '', cc: '', bcc: '' });
    setBannerTitle(''); setBannerSubtitle(''); setHeadline('');
    setResources([]);
    setNoteIds([]);
    setSensitivity(config?.default_sensitivity || '');
  };

  const sendTest = async () => {
    if (!subject.trim() || !body.trim()) {
      showError('Add a subject and a message first');
      return;
    }
    setSending(true);
    try {
      await post(true);
      // A test never waits for the schedule — it is a rehearsal, and one you
      // find out about on Saturday is no rehearsal at all.
      showToast(`Test sent to ${user?.email || 'you'}${sendAt ? ' — the schedule is unaffected' : ''}`);
    } catch (err) {
      showError(err.message);
    } finally {
      setSending(false);
    }
  };

  const sendForReal = async () => {
    setSending(true);
    try {
      const result = await post(false);
      setConfirming(false);
      if (result.scheduled) {
        showToast(`Queued for ${formatTimestamp(result.send_at)} · ${plural(result.recipient_count, 'recipient')}`);
      } else {
        showToast(`Sent to ${plural(result.recipient_count, 'recipient')}`);
      }
      clearDraft();
    } catch (err) {
      setConfirming(false);
      showError(err.message);
    } finally {
      setSending(false);
    }
  };

  const resend = (entry) => setCheck({
    title: entry.status === 'failed' ? 'Try sending this again?' : 'Send this message again?',
    subtitle: `"${entry.subject}" goes back out to the same ${plural(entry.recipient_count, 'recipient')}`
      + `${(entry.attachments || []).length && !entry.files_stored
            ? ', without its attachments — they are no longer stored' : ''}.`
      + ' It is recorded as a new entry, so the original stays as it is.',
    confirmLabel: 'Send it again',
    onConfirm: async () => {
      const result = await apiJson(`/api/communications/history/${entry.id}/resend`,
        { method: 'POST' });
      showToast(`Sent again to ${plural(result.recipient_count, 'recipient')}`
        + (result.missing_attachments
            ? ` · ${plural(result.missing_attachments, 'file')} no longer stored` : ''));
      setDetail(null);
      loadHistory(historyOffset, historySearch, historyStatus);
    },
  });

  /* ── templates ──────────────────────────────────────────────────────────── */
  const applyTemplate = (id) => {
    setTemplateId(id);
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    setCategory(template.category);
    setSubject(template.subject);
    setBody(template.body);
    const saved = template.layout || {};
    setBannerTitle(saved.banner_title || '');
    setBannerSubtitle(saved.banner_subtitle || '');
    setHeadline(saved.headline || '');
    setResources(saved.resources || []);
  };

  const selectedTemplate = templates.find((t) => t.id === templateId) || null;

  const saveTemplate = () => setAsk({
    title: 'Save as a template',
    subtitle: 'Everything in the editor is saved — category, subject, message and template blocks.',
    label: 'Template name',
    placeholder: 'Monthly release notes',
    confirmLabel: 'Save template',
    onConfirm: async (name) => {
      const result = await apiJson('/api/communications/templates', {
        method: 'POST',
        body: { name, category, subject, body, layout },
      });
      showToast(`Template "${name}" saved`);
      // Select what was just saved, so Update and Delete act on it without the
      // admin having to hunt for it in the list first.
      if (result?.id) setTemplateId(result.id);
      loadTemplates();
    },
  });

  /** Overwrite the selected template in place. The endpoint has always existed;
   *  until recently the only way to change a template was to delete and retype it. */
  const updateTemplate = () => {
    if (!selectedTemplate) return;
    setCheck({
      title: `Overwrite "${selectedTemplate.name}"?`,
      subtitle: 'The saved version is replaced by what is in the editor now.',
      confirmLabel: 'Overwrite it',
      onConfirm: async () => {
        await apiJson(`/api/communications/templates/${selectedTemplate.id}`, {
          method: 'PUT',
          body: { name: selectedTemplate.name, category, subject, body, layout },
        });
        showToast(`Template "${selectedTemplate.name}" updated`);
        loadTemplates();
      },
    });
  };

  const deleteTemplate = () => {
    if (!selectedTemplate) return;
    setCheck({
      title: `Delete "${selectedTemplate.name}"?`,
      subtitle: 'The template is removed for everyone. Messages already sent from it are not affected.',
      confirmLabel: 'Delete it',
      tone: 'danger',
      onConfirm: async () => {
        await apiJson(`/api/communications/templates/${selectedTemplate.id}`, { method: 'DELETE' });
        showToast(`Template "${selectedTemplate.name}" deleted`);
        setTemplateId('');
        loadTemplates();
      },
    });
  };

  /** Both dialogues run their action here so the busy state, the error toast
   *  and the closing are handled once instead of in nine call sites. */
  const runChecked = async (action) => {
    setWorking(true);
    try {
      await action();
      setCheck(null);
      setAsk(null);
    } catch (err) {
      showError(err.message || 'That did not work');
    } finally {
      setWorking(false);
    }
  };

  /* ── resources ──────────────────────────────────────────────────────────── */
  const addResource = () =>
    setResources([...resources, { title: '', description: '', link_text: 'Link', link_url: '' }]);

  const updateResource = (index, field, value) =>
    setResources(resources.map((r, i) => (i === index ? { ...r, [field]: value } : r)));

  const removeResource = (index) =>
    setResources(resources.filter((_, i) => i !== index));

  /* ── render ─────────────────────────────────────────────────────────────── */
  const categories = config?.categories || [];
  const sensitivityTree = config?.sensitivity_labels || [];
  const sensitivityLabel = findLabel(sensitivityTree, sensitivity)?.path || '';
  const activeCategory = categories.find((c) => c.id === category);
  const hints = PLACEHOLDERS[category] || PLACEHOLDERS.custom;
  const isCompose = tab === 'compose';
  const isWhatsNew = tab === 'whats-new';
  const isQueue = tab === 'queue';
  const isHistory = tab === 'history';
  const sheetMax = device === 'mobile' ? 360 : 640;

  const scheduledLabel = sendAt
    ? new Date(`${sendAt}:00`).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'
    : '';

  const readyHint = ready
    ? `${activeCategory?.label || 'Message'} · ${plural(tally.total, 'recipient')}`
      + (attachments.length ? ` · ${plural(attachments.length, 'attachment')}` : '')
      + (sendAt ? ` · goes out ${scheduledLabel}` : '')
    : blockers[0];

  // Which message the right-hand pane is showing, if any.
  const viewing = isCompose ? null : (isQueue ? queueDetail : detail);

  return (
    <div className="min-h-full flex flex-col bg-[#faf9f7] font-johnson-text text-jj-gray-08">
      {toast && <Toast key={toast.id} {...toast} onClose={() => setToast(null)} />}

      {/* Header */}
      <header className="sticky top-0 z-30 flex items-center gap-4 flex-wrap px-5 py-3 bg-white border-b border-jj-gray-02">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-[38px] h-[38px] rounded-[10px] bg-jj-red/[0.07] flex items-center justify-center flex-none">
            <Icon src={mailIcon} className="w-[21px] h-[21px]" tone="red" />
          </div>
          <div className="min-w-0">
            <h1 className="font-johnson-display font-medium text-[20px] leading-[1.1] tracking-[-0.01em]">
              Communication Center
            </h1>
            <p className="font-johnson-text text-[12.5px] text-jj-gray-06 mt-0.5 truncate">
              {config ? `Sending as ${config.sender}` : 'Loading settings…'}
            </p>
          </div>
        </div>

        <div className="flex gap-0.5 p-0.5 bg-jj-gray-01 rounded-[10px] ml-auto">
          {[['compose', 'Compose'], ['whats-new', 'What\u2019s new'],
            ['queue', 'Queue'], ['history', 'Sent history']].map(([id, label]) => (
            <button
              key={id}
              onClick={() => changeTab(id)}
              className={`px-4 py-1.5 rounded-lg font-johnson-text text-[12.5px] transition-colors ${
                tab === id
                  ? 'bg-white text-jj-gray-08 font-medium shadow-[0_1px_3px_rgba(49,44,42,0.12)]'
                  : 'text-jj-gray-06 hover:text-jj-gray-08'
              }`}
            >
              {label}
              {id === 'queue' && queueCounts.pending > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-jj-red/[0.09] text-jj-red text-[10.5px]">
                  {queueCounts.pending}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 flex items-stretch flex-wrap min-h-0">
        {/* ── Rail ── */}
        <aside className="w-[252px] flex-none px-4 py-5 bg-white border-r border-jj-gray-02">
          {isCompose && (
            <>
              <div className={CLS.railH}>Message type</div>
              <div className="flex flex-col gap-0.5 mt-2.5 mb-6">
                {categories.map((c) => {
                  const active = category === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setCategory(c.id)}
                      className={`flex items-center gap-2.5 w-full text-left px-2.5 py-2 rounded-[9px]
                                  font-johnson-text text-[13px] border transition-colors ${
                        active
                          ? 'bg-jj-red/[0.04] border-jj-red/20 text-jj-gray-08 font-medium'
                          : 'border-transparent text-jj-gray-07 hover:bg-jj-gray-01'
                      }`}
                      style={{ borderLeft: `3px solid ${active ? c.color : 'transparent'}` }}
                    >
                      <span className="w-2 h-2 rounded-full flex-none" style={{ background: c.color }} />
                      <span className="flex-1">{c.label}</span>
                      {active && <span className="text-[11px]" style={{ color: c.color }}>✓</span>}
                    </button>
                  );
                })}
              </div>

              <div className="px-3 py-2.5 bg-[#f7f6f4] rounded-[9px] font-johnson-text text-[11.5px]
                              leading-relaxed text-jj-gray-07 mb-6">
                Subject prefix
                <br />
                <span
                  className="font-medium"
                  style={{ color: activeCategory?.prefix ? activeCategory.color : '#a39992' }}
                >
                  {activeCategory?.prefix || 'None'}
                </span>
              </div>

              <div className="flex items-center justify-between mb-2.5">
                <span className={CLS.railH}>Templates</span>
                <div className="flex gap-1">
                  <button
                    onClick={saveTemplate}
                    disabled={!subject.trim() && !body.trim()}
                    title="Save as template"
                    className={`flex items-center gap-1 ${CLS.chipBtn}`}
                  >
                    <Icon src={saveIcon} className="w-3 h-3" tone="dark" />Save
                  </button>
                  <button
                    onClick={updateTemplate}
                    disabled={!selectedTemplate}
                    title={selectedTemplate
                      ? `Overwrite "${selectedTemplate.name}"`
                      : 'Pick a template to overwrite'}
                    className={CLS.chipBtn}
                  >
                    Update
                  </button>
                  <button
                    onClick={deleteTemplate}
                    disabled={!templateId}
                    title="Delete template"
                    className={CLS.chipBtn}
                  >
                    <Icon src={trashIcon} className="w-3 h-3" tone="red" />
                  </button>
                </div>
              </div>

              {templatesState.loading ? (
                <p className={CLS.hint}>Loading templates…</p>
              ) : templatesState.error ? (
                <div>
                  <p className="font-johnson-text text-[11.5px] text-jj-maroon-05 leading-relaxed">
                    {templatesState.error}
                  </p>
                  <button onClick={loadTemplates} className={`${CLS.chipBtn} mt-1.5`}>
                    Try again
                  </button>
                </div>
              ) : templates.length === 0 ? (
                <p className={CLS.hint}>No saved templates yet.</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => applyTemplate(t.id)}
                      className={`w-full text-left px-2.5 py-2 rounded-[9px] border transition-colors ${
                        templateId === t.id
                          ? 'bg-[#f7f6f4] border-jj-gray-02'
                          : 'border-transparent hover:bg-jj-gray-01'
                      }`}
                    >
                      <span className="block font-johnson-text text-[13px] text-jj-gray-08">{t.name}</span>
                      <span className="block font-johnson-text text-[11px] text-jj-gray-05 mt-0.5">
                        {t.category}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {isHistory && (
            <>
              <div className="relative mb-5">
                <Icon src={searchIcon} className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" tone="gray" />
                <input
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Search sent mail"
                  className="w-full pl-8 pr-2.5 py-2 rounded-[9px] border border-jj-gray-03 bg-white
                             font-johnson-text text-[13px] outline-none focus:border-jj-red
                             focus:ring-[3px] focus:ring-jj-red/10"
                />
              </div>
              <div className={CLS.railH}>Status</div>
              <div className="flex flex-col gap-0.5 mt-2.5">
                {[['all', 'All'], ['sent', 'Sent'], ['failed', 'Failed'], ['test', 'Tests']].map(([id, label]) => {
                  const active = historyStatus === id;
                  return (
                    <button
                      key={id}
                      onClick={() => setHistoryStatus(id)}
                      className={`flex items-center w-full px-2.5 py-2 rounded-[9px] font-johnson-text
                                  text-[13px] border transition-colors ${
                        active
                          ? 'bg-jj-red/[0.04] border-jj-red/20 border-l-[3px] border-l-jj-red text-jj-gray-08 font-medium'
                          : 'border-transparent text-jj-gray-07 hover:bg-jj-gray-01'
                      }`}
                    >
                      <span className="flex-1 text-left">{label}</span>
                      <span className="font-johnson-text text-[11.5px] text-jj-gray-05">
                        {historyCounts[id] ?? 0}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {isQueue && (
            <>
              <div className={CLS.railH}>Queue</div>
              <div className="flex flex-col gap-0.5 mt-2.5 mb-5">
                {QUEUE_FILTERS.map(([id, label]) => {
                  const active = queueStatus === id;
                  return (
                    <button
                      key={id}
                      onClick={() => setQueueStatus(id)}
                      className={`flex items-center w-full px-2.5 py-2 rounded-[9px] font-johnson-text
                                  text-[13px] border transition-colors ${
                        active
                          ? 'bg-jj-red/[0.04] border-jj-red/20 border-l-[3px] border-l-jj-red text-jj-gray-08 font-medium'
                          : 'border-transparent text-jj-gray-07 hover:bg-jj-gray-01'
                      }`}
                    >
                      <span className="flex-1 text-left">{label}</span>
                      <span className="font-johnson-text text-[11.5px] text-jj-gray-05">
                        {queueCounts[id] ?? 0}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className={`${CLS.hint} leading-relaxed`}>
                Queued messages are sent by the server, so they go out whether or
                not anyone is signed in. Times are Eastern.
              </p>
            </>
          )}

          {isWhatsNew && (
            <>
              <div className={CLS.railH}>How this works</div>
              <ol className="mt-2.5 mb-5 flex flex-col gap-2.5 font-johnson-text text-[12px]
                             text-jj-gray-07 leading-relaxed list-decimal pl-4">
                <li>Ship something. A new page or endpoint is picked up on the next
                    backend start, or when you press Scan now.</li>
                <li>Write it a one-line summary, or add anything the code cannot
                    show — a redesign, a fix, a policy change.</li>
                <li>Tick what users should hear about and draft the announcement.</li>
                <li>Send it. Only then do the items move to Announced.</li>
              </ol>
              <div className="px-3 py-2.5 bg-[#f7f6f4] rounded-[9px] font-johnson-text
                              text-[11.5px] leading-relaxed text-jj-gray-07">
                Items are never announced automatically. Nothing leaves this portal
                until someone presses Send.
              </div>
            </>
          )}
        </aside>

        {/* ── Centre ── */}
        <main className="flex-[1.15] min-w-[340px] flex flex-col min-h-0">
          {isWhatsNew && (
            <WhatsNewPanel
              selected={noteIds}
              onSelectedChange={setNoteIds}
              onDraft={startWhatsNewDraft}
              showToast={showToast}
              showError={showError}
            />
          )}

          {isCompose && (
            <>
              <div className="flex-1 overflow-auto p-5 flex flex-col gap-3.5">
                {/* Audience */}
                <section className={`${CLS.card} p-[18px]`}>
                  <div className="flex items-baseline justify-between gap-3 mb-3.5">
                    <h2 className={CLS.sectionH}>Audience</h2>
                    <div className="flex items-center gap-2.5">
                      <span className={`font-johnson-text text-[12px] ${
                        tally.invalid ? 'text-jj-red' : 'text-jj-gray-06'
                      }`}>
                        {plural(tally.total, 'recipient')}
                        {tally.invalid > 0 && ` · ${tally.invalid} not valid`}
                      </span>
                      <button
                        onClick={() => setPicking(true)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-jj-gray-02
                                   font-johnson-text text-[11.5px] text-jj-gray-07 hover:border-jj-gray-04"
                      >
                        <Icon src={communityIcon} className="w-3 h-3" tone="dark" />Add from directory
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2.5">
                    <RecipientField
                      label="To" value={to} onChange={setTo}
                      placeholder="name@its.jnj.com"
                      onDraftChange={(text) => noteDraft('to', text)}
                    />
                    <RecipientField
                      label="Cc" value={cc} onChange={setCc}
                      placeholder="Optional"
                      onDraftChange={(text) => noteDraft('cc', text)}
                    />
                    <RecipientField
                      label="Bcc" value={bcc} onChange={setBcc}
                      placeholder="Optional"
                      onDraftChange={(text) => noteDraft('bcc', text)}
                    />
                  </div>
                  <p className={`${CLS.hint} mt-3`}>
                    {config?.allowed_domains?.length
                      ? `Only ${config.allowed_domains.join(', ')} addresses are accepted. `
                      : ''}
                    Limit {config?.max_recipients ?? 500} per send.
                  </p>
                </section>

                {/* Message */}
                <section className={`${CLS.card} p-[18px]`}>
                  <div className="flex items-start justify-between gap-3 mb-3.5">
                    <h2 className={CLS.sectionH}>Message</h2>
                    {config?.ai_drafting && (
                      <AIToolbar
                        hasBody={hasText(body)}
                        busy={Boolean(aiMode)}
                        onPick={setAiMode}
                      />
                    )}
                  </div>

                  {noteIds.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap mb-3.5 px-3 py-2
                                    rounded-[9px] bg-[#f7f6f4]">
                      <span className="font-johnson-text text-[11.5px] text-jj-gray-07">
                        Sending this marks {plural(noteIds.length, 'what\u2019s-new item')} announced.
                      </span>
                      <button onClick={() => setNoteIds([])} className={`${CLS.chipBtn} ml-auto`}>
                        Don&rsquo;t
                      </button>
                    </div>
                  )}

                  <div className="flex items-baseline justify-between mb-1.5">
                    <label className={CLS.label.replace(' mb-1.5', '')}>Subject</label>
                    {subject.length > maxSubjectChars * 0.8 && (
                      <span className={`font-johnson-text text-[11.5px] ${
                        subject.length > maxSubjectChars ? 'text-jj-red' : 'text-jj-gray-05'
                      }`}>
                        {subject.length} / {maxSubjectChars}
                      </span>
                    )}
                  </div>
                  <div className="flex items-stretch border border-jj-gray-03 rounded-[10px] overflow-hidden
                                  bg-white mb-3.5 focus-within:border-jj-red">
                    {activeCategory?.prefix && (
                      <span className="flex items-center px-2.5 flex-none bg-[#f7f6f4] border-r border-jj-gray-02
                                       font-johnson-text text-[12.5px] text-jj-gray-07 whitespace-nowrap">
                        {activeCategory.prefix}
                      </span>
                    )}
                    <input
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder={hints.subject}
                      className="flex-1 min-w-0 border-0 outline-none px-3 py-2.5 font-johnson-text
                                 text-[13.5px] text-jj-gray-08"
                    />
                  </div>

                  <label className={CLS.label}>Body</label>
                  <BodyEditor
                    value={body}
                    onChange={setBody}
                    placeholder={BODY_PLACEHOLDER}
                    invalid={body.length > maxBodyChars}
                    hint={body.length > maxBodyChars * 0.8
                      ? `${body.length.toLocaleString()} / ${maxBodyChars.toLocaleString()} characters`
                      : 'Select text, then a button — or type the marks yourself'}
                  />
                </section>

                {/* Template blocks */}
                <section className={`${CLS.card} p-[18px]`}>
                  <div className="flex items-baseline justify-between">
                    <h2 className={CLS.sectionH}>Template blocks</h2>
                    <span className={CLS.hint}>Optional</span>
                  </div>
                  <p className={`${CLS.hint} mt-1 mb-3.5`}>
                    Leave these blank for a plain branded note.
                  </p>

                  <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5 mb-3">
                    <div>
                      <label className={CLS.label}>Banner title</label>
                      <input
                        value={bannerTitle}
                        onChange={(e) => setBannerTitle(e.target.value)}
                        placeholder={hints.bannerTitle}
                        className={CLS.input}
                      />
                    </div>
                    <div>
                      <label className={CLS.label}>Banner subtitle</label>
                      <input
                        value={bannerSubtitle}
                        onChange={(e) => setBannerSubtitle(e.target.value)}
                        placeholder={hints.bannerSubtitle}
                        className={CLS.input}
                      />
                    </div>
                  </div>

                  <div className="mb-4">
                    <label className={CLS.label}>Headline</label>
                    <input
                      value={headline}
                      onChange={(e) => setHeadline(e.target.value)}
                      placeholder={hints.headline}
                      className={CLS.input}
                    />
                  </div>

                  <div className="flex items-center justify-between mb-2">
                    <label className={CLS.label.replace(' mb-1.5', '')}>Resources</label>
                    <button
                      onClick={addResource}
                      disabled={resources.length >= 8}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-jj-gray-02
                                 font-johnson-text text-[11.5px] text-jj-gray-07 hover:border-jj-gray-04
                                 disabled:opacity-40"
                    >
                      <Icon src={addIcon} className="w-3 h-3" tone="dark" />Add resource
                    </button>
                  </div>

                  {resources.length === 0 ? (
                    <p className={CLS.hint}>No resource links. Add one to render the Resources block.</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {resources.map((resource, index) => (
                        <li key={index} className="p-3 bg-[#f7f6f4] rounded-xl flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <input
                              value={resource.title}
                              onChange={(e) => updateResource(index, 'title', e.target.value)}
                              placeholder="Release notes"
                              className={CLS.inputSm}
                            />
                            <button
                              onClick={() => removeResource(index)}
                              aria-label="Remove resource"
                              className="opacity-50 hover:opacity-100 flex-none"
                            >
                              <Icon src={closeIcon} className="w-3 h-3" tone="gray" />
                            </button>
                          </div>
                          <input
                            value={resource.description}
                            onChange={(e) => updateResource(index, 'description', e.target.value)}
                            placeholder="Full list of what changed in this release."
                            className={CLS.inputSm}
                          />
                          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
                            <input
                              value={resource.link_text}
                              onChange={(e) => updateResource(index, 'link_text', e.target.value)}
                              placeholder="Open"
                              className={CLS.inputSm}
                            />
                            <input
                              value={resource.link_url}
                              onChange={(e) => updateResource(index, 'link_url', e.target.value)}
                              placeholder="https://gra-smarthub.jnj.com/…"
                              className={CLS.inputSm}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* Attachments */}
                <section className={`${CLS.card} p-[18px]`}>
                  <div className="flex items-baseline justify-between mb-3">
                    <h2 className={CLS.sectionH}>Attachments</h2>
                    <span className={`font-johnson-text text-[11.5px] ${
                      attachmentBytes > maxBytes ? 'text-jj-red' : 'text-jj-gray-05'
                    }`}>
                      {formatBytes(attachmentBytes)} of {config?.max_attachment_mb ?? 10} MB
                    </span>
                  </div>

                  {attachments.length > 0 && (
                    <ul className="flex flex-col gap-1.5 mb-2.5">
                      {attachments.map((file, index) => (
                        <li
                          key={`${file.name}-${index}`}
                          className="flex items-center gap-2.5 px-3 py-2 bg-[#f7f6f4] rounded-[10px]"
                        >
                          <Icon src={stationeryIcon} className="w-3.5 h-3.5" tone="gray" />
                          <span className="flex-1 min-w-0 font-johnson-text text-[13px] truncate">{file.name}</span>
                          <span className={CLS.hint}>{formatBytes(file.size)}</span>
                          <button
                            onClick={() => removeFile(index)}
                            aria-label={`Remove ${file.name}`}
                            className="opacity-50 hover:opacity-100"
                          >
                            <Icon src={closeIcon} className="w-3 h-3" tone="gray" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <input ref={fileInput} type="file" multiple onChange={(e) => addFiles(e.target.files)} className="hidden" />
                  <button
                    onClick={() => fileInput.current?.click()}
                    className="w-full py-2.5 rounded-[10px] border border-dashed border-jj-gray-04 bg-white
                               font-johnson-text text-[12.5px] text-jj-gray-07 hover:border-jj-red
                               flex items-center justify-center gap-2"
                  >
                    <Icon src={addIcon} className="w-3.5 h-3.5" tone="dark" />Add files
                  </button>
                  {config && !config.store_attachments && attachments.length > 0 && (
                    <p className={`${CLS.hint} mt-2`}>
                      Attachment storage is switched off on this server, so these files
                      cannot be re-sent later and a queued send would go out without them.
                    </p>
                  )}
                </section>
              </div>

              {/* Send bar */}
              <footer className="flex-none px-5 py-3 bg-white border-t border-jj-gray-02
                                 flex items-center gap-3.5 flex-wrap">
                <div className="flex-1 min-w-[170px]">
                  <div className={`font-johnson-text text-[13px] font-medium ${
                    ready ? 'text-jj-green-03' : 'text-jj-gray-06'
                  }`}>
                    {ready ? (sendAt ? 'Ready to schedule' : 'Ready to send') : 'Not ready yet'}
                  </div>
                  <div className={`${CLS.hint} mt-0.5`}>{readyHint}</div>
                </div>

                {/* Schedule send. The field is an Eastern wall clock whatever the
                    laptop is set to, which is what the backend reads it as. */}
                {sendAt ? (
                  <div className="flex items-center gap-1.5">
                    <Icon src={calendarIcon} className="w-3.5 h-3.5" tone="gray" />
                    <input
                      type="datetime-local"
                      value={sendAt}
                      min={earliestSend}
                      max={latestSend}
                      onChange={(e) => setSendAt(e.target.value)}
                      className="px-2.5 py-2 rounded-[10px] border border-jj-gray-03 bg-white
                                 font-johnson-text text-[12.5px] text-jj-gray-08 outline-none
                                 focus:border-jj-red"
                    />
                    <span className={CLS.hint}>ET</span>
                    <button
                      onClick={() => setSendAt('')}
                      title="Clear the schedule and send immediately"
                      className="opacity-50 hover:opacity-100 px-1"
                    >
                      <Icon src={closeIcon} className="w-3 h-3" tone="gray" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setSendAt(easternInputValue(new Date(Date.now() + 3600 * 1000)))}
                    className={`flex items-center gap-1.5 ${CLS.ghostBtn}`}
                  >
                    <Icon src={calendarIcon} className="w-3.5 h-3.5" tone="dark" />Schedule send
                  </button>
                )}

                {sensitivityTree.length > 0 && (
                  <SensitivityPicker
                    tree={sensitivityTree}
                    value={sensitivity}
                    onChange={setSensitivity}
                  />
                )}

                <button onClick={sendTest} disabled={sending} className={CLS.ghostBtn}>
                  Send test to me
                </button>
                <button
                  onClick={() => setConfirming(true)}
                  disabled={!ready || sending}
                  className="px-5 py-2.5 rounded-[10px] bg-jj-red text-white font-johnson-text
                             text-[13px] font-medium hover:bg-jj-maroon-05 transition-colors
                             disabled:bg-jj-red/30 disabled:hover:bg-jj-red/30"
                >
                  {sendAt
                    ? 'Schedule'
                    : (tally.total > 0 ? `Send to ${tally.total}` : 'Send')}
                </button>
              </footer>
            </>
          )}

          {isHistory && (
            <div className="flex-1 overflow-auto p-5">
              <div className={`${CLS.card} overflow-hidden`}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-jj-gray-02">
                  <h2 className={CLS.sectionH}>Sent history</h2>
                  <div className="flex items-center gap-2.5">
                    <span className="font-johnson-text text-[12px] text-jj-gray-05">
                      {plural(historyTotal, 'message')}
                    </span>
                    <button
                      onClick={exportHistory}
                      disabled={!historyTotal || exporting}
                      title="Download everything matching these filters"
                      className="px-2.5 py-1 rounded-lg border border-jj-gray-02 font-johnson-text
                                 text-[11.5px] text-jj-gray-07 hover:border-jj-gray-04 disabled:opacity-40"
                    >
                      {exporting ? 'Exporting…' : 'Export CSV'}
                    </button>
                    <button
                      onClick={() => loadHistory(historyOffset, historySearch, historyStatus)}
                      title="Refresh"
                      className="w-[29px] h-[29px] border border-jj-gray-02 rounded-lg flex items-center
                                 justify-center hover:border-jj-gray-04"
                    >
                      <Icon src={refreshIcon} className="w-3.5 h-3.5" tone="gray" />
                    </button>
                  </div>
                </div>

                {historyLoading ? (
                  <div className="p-12 text-center font-johnson-text text-[13px] text-jj-gray-06">Loading…</div>
                ) : entries.length === 0 ? (
                  <div className="p-12 text-center">
                    <Icon src={mailIcon} className="w-9 h-9 mx-auto opacity-30 mb-3" tone="gray" />
                    <p className="font-johnson-text text-[13px] text-jj-gray-06">
                      {historySearch || historyStatus !== 'all'
                        ? 'Nothing matches those filters.'
                        : 'No emails have been sent yet.'}
                    </p>
                  </div>
                ) : (
                  entries.map((entry) => {
                    const meta = categories.find((c) => c.id === entry.category);
                    const active = detail?.id === entry.id;
                    return (
                      <button
                        key={entry.id}
                        onClick={() => openDetail(entry.id)}
                        className={`flex items-center gap-3 w-full px-4 py-3 border-t border-jj-gray-01
                                    text-left transition-colors ${
                          active ? 'bg-jj-red/[0.04] shadow-[inset_3px_0_0_#eb1700]' : 'bg-white hover:bg-jj-gray-01'
                        }`}
                      >
                        <span
                          className="w-2 h-2 rounded-full flex-none"
                          style={{ background: meta?.color || '#a39992' }}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block font-johnson-text text-[13.5px] text-jj-gray-08 truncate">
                            {entry.subject}
                            {entry.is_test === 1 && (
                              <span className="ml-2 px-1.5 py-0.5 rounded bg-jj-gray-02 text-jj-gray-07 text-[11px]">
                                test
                              </span>
                            )}
                            {entry.scheduled_id ? (
                              <span className="ml-2 px-1.5 py-0.5 rounded bg-jj-gray-02 text-jj-gray-07 text-[11px]">
                                scheduled
                              </span>
                            ) : null}
                            {entry.resent_from ? (
                              <span className="ml-2 px-1.5 py-0.5 rounded bg-jj-gray-02 text-jj-gray-07 text-[11px]">
                                resend
                              </span>
                            ) : null}
                          </span>
                          <span className="block font-johnson-text text-[11.5px] text-jj-gray-05 mt-0.5">
                            {formatTimestamp(entry.sent_at)} · {entry.sent_by}
                          </span>
                        </span>
                        <span className="font-johnson-text text-[12px] text-jj-gray-07 whitespace-nowrap">
                          {entry.recipient_count}
                        </span>
                        <span className={`px-2 py-0.5 rounded-full font-johnson-text text-[11px] whitespace-nowrap ${
                          entry.status === 'sent'
                            ? 'bg-jj-green-01/25 text-jj-green-03'
                            : 'bg-jj-red/[0.07] text-jj-maroon-05'
                        }`}>
                          {entry.status}
                        </span>
                      </button>
                    );
                  })
                )}

                {historyTotal > LIMIT && (
                  <div className="flex items-center justify-between px-4 py-3 border-t border-jj-gray-02">
                    <button
                      onClick={() =>
                        loadHistory(Math.max(0, historyOffset - LIMIT), historySearch, historyStatus)}
                      disabled={historyOffset === 0}
                      className="px-3 py-1.5 rounded-lg border border-jj-gray-03 font-johnson-text
                                 text-[12.5px] disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <span className="font-johnson-text text-[12px] text-jj-gray-06">
                      {historyOffset + 1}–{Math.min(historyOffset + LIMIT, historyTotal)} of {historyTotal}
                    </span>
                    <button
                      onClick={() => loadHistory(historyOffset + LIMIT, historySearch, historyStatus)}
                      disabled={historyOffset + LIMIT >= historyTotal}
                      className="px-3 py-1.5 rounded-lg border border-jj-gray-03 font-johnson-text
                                 text-[12.5px] disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {isQueue && (
            <div className="flex-1 overflow-auto p-5">
              <div className={`${CLS.card} overflow-hidden`}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-jj-gray-02">
                  <h2 className={CLS.sectionH}>Scheduled sends</h2>
                  <div className="flex items-center gap-2.5">
                    <span className="font-johnson-text text-[12px] text-jj-gray-05">
                      {plural(queue.length, 'message')}
                    </span>
                    <button
                      onClick={() => loadQueue(queueStatus)}
                      title="Refresh"
                      className="w-[29px] h-[29px] border border-jj-gray-02 rounded-lg flex items-center
                                 justify-center hover:border-jj-gray-04"
                    >
                      <Icon src={refreshIcon} className="w-3.5 h-3.5" tone="gray" />
                    </button>
                  </div>
                </div>

                {queueLoading ? (
                  <div className="p-12 text-center font-johnson-text text-[13px] text-jj-gray-06">Loading…</div>
                ) : queue.length === 0 ? (
                  <div className="p-12 text-center">
                    <Icon src={calendarIcon} className="w-9 h-9 mx-auto opacity-30 mb-3" tone="gray" />
                    <p className="font-johnson-text text-[13px] text-jj-gray-06">
                      {queueStatus === 'pending'
                        ? 'Nothing is waiting to go out.'
                        : 'Nothing here.'}
                      <br />
                      <span className={CLS.hint}>
                        Write a message on the Compose tab and choose Schedule send.
                      </span>
                    </p>
                  </div>
                ) : (
                  queue.map((entry) => {
                    const meta = categories.find((c) => c.id === entry.category);
                    const active = queueDetail?.id === entry.id;
                    const tone = {
                      pending:   'bg-jj-gray-02 text-jj-gray-07',
                      sending:   'bg-jj-gray-02 text-jj-gray-07',
                      sent:      'bg-jj-green-01/25 text-jj-green-03',
                      failed:    'bg-jj-red/[0.07] text-jj-maroon-05',
                      cancelled: 'bg-jj-gray-01 text-jj-gray-05',
                    }[entry.status] || 'bg-jj-gray-02 text-jj-gray-07';
                    return (
                      <div
                        key={entry.id}
                        className={`flex items-center gap-3 w-full px-4 py-3 border-t border-jj-gray-01
                                    transition-colors ${
                          active ? 'bg-jj-red/[0.04] shadow-[inset_3px_0_0_#eb1700]' : 'bg-white hover:bg-jj-gray-01'
                        }`}
                      >
                        <span
                          className="w-2 h-2 rounded-full flex-none"
                          style={{ background: meta?.color || '#a39992' }}
                        />
                        <button
                          onClick={() => openQueueDetail(entry.id)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <span className="block font-johnson-text text-[13.5px] text-jj-gray-08 truncate">
                            {entry.subject}
                          </span>
                          <span className="block font-johnson-text text-[11.5px] text-jj-gray-05 mt-0.5 truncate">
                            {formatTimestamp(entry.send_at)} · {plural(entry.recipient_count, 'recipient')}
                            {(entry.attachments || []).length
                              ? ` · ${plural(entry.attachments.length, 'file')}` : ''}
                            {entry.error ? ` · ${entry.error}` : ''}
                          </span>
                        </button>
                        <span className={`px-2 py-0.5 rounded-full font-johnson-text text-[11px] whitespace-nowrap ${tone}`}>
                          {entry.status === 'pending' ? 'queued' : entry.status}
                        </span>
                        {entry.status === 'pending' && (
                          <button
                            onClick={() => cancelScheduled(entry)}
                            title="Cancel this send"
                            className={CLS.chipBtn}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </main>

        {/* ── Preview ──
            The aside is a flex item in an items-stretch row, so it is as tall as
            the compose column next to it - several hundred pixels taller than
            anything in here. That surplus used to land as grey between the sheet
            and the subject card pinned below it, and the preview scrolled out of
            sight while you typed further down the form. The aside is now just
            the backdrop; everything sits in a sticky column of its own height. */}
        <aside className="flex-1 min-w-[320px] p-5 bg-jj-gray-01 border-l border-jj-gray-02">
          <div
            className="sticky flex flex-col gap-3.5"
            style={{ top: PREVIEW_TOP, height: PREVIEW_HEIGHT }}
          >
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className={CLS.railH}>
                {isCompose ? 'Live preview'
                  : isWhatsNew ? 'Last draft'
                  : (isQueue ? 'Queued message' : 'Sent message')}
              </span>
              {viewing && (
                <div className="ml-auto flex items-center gap-1.5">
                  {isHistory && (
                    <button
                      onClick={() => resend(detail)}
                      title="Send this same message again"
                      className="px-2.5 py-1 rounded-lg border border-jj-gray-03 bg-white
                                 font-johnson-text text-[11.5px] text-jj-gray-07 hover:border-jj-red"
                    >
                      {detail.status === 'failed' ? 'Try again' : 'Send again'}
                    </button>
                  )}
                  <button
                    onClick={() => loadIntoCompose(viewing, { withFiles: isHistory })}
                    disabled={drafting}
                    title="Copy this message into the Compose tab"
                    className="px-2.5 py-1 rounded-lg border border-jj-gray-03 bg-white
                               font-johnson-text text-[11.5px] text-jj-gray-07 hover:border-jj-red
                               disabled:opacity-50"
                  >
                    {drafting ? 'Copying…' : 'Use as draft'}
                  </button>
                </div>
              )}
              <div className={`flex gap-0.5 p-0.5 bg-jj-gray-02 rounded-lg ${viewing ? '' : 'ml-auto'}`}>
                {[['desktop', 'Desktop'], ['mobile', 'Mobile']].map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setDevice(id)}
                    className={`px-3 py-1 rounded-md font-johnson-text text-[11.5px] ${
                      device === id ? 'bg-white text-jj-gray-08' : 'text-jj-gray-06'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {isCompose && previewError && (
              <div className="flex-none px-3 py-2 rounded-lg bg-jj-red/[0.06] border border-jj-red/20
                              font-johnson-text text-[11.5px] text-jj-maroon-05">
                {previewError} — showing the last version that rendered.
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-auto flex justify-center">
              {!isCompose && detailLoading ? (
                <div className="flex-1 flex items-center justify-center p-10">
                  <p className="font-johnson-text text-[13px] text-jj-gray-06">Opening…</p>
                </div>
              ) : (isCompose ? preview.html : viewing?.html) ? (
                <div
                  className="w-full flex flex-col bg-white border border-jj-gray-02 rounded-[10px]
                             overflow-hidden shadow-[0_2px_10px_rgba(49,44,42,0.06)]"
                  style={{ maxWidth: sheetMax }}
                >
                  {/* Fills the column. At a fixed 640 it left a band of grey
                      between the sheet and the card underneath on a tall screen,
                      and showed less of the email than there was room for. */}
                  <iframe
                    title={isCompose ? 'Email preview' : 'Stored message'}
                    srcDoc={isCompose ? preview.html : viewing.html}
                    className="w-full flex-1 bg-white"
                    style={{ border: 0, minHeight: 0 }}
                    sandbox=""
                  />
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center p-10 text-center">
                  <p className="font-johnson-text text-[13px] text-jj-gray-06 leading-relaxed">
                    {isCompose
                      ? <>Start typing a subject and message —<br />the preview renders here.</>
                      : <>Pick a message from the list<br />to see what {isQueue ? 'will go out' : 'was sent'}.</>}
                  </p>
                </div>
              )}
            </div>

            <div className="flex-none px-3.5 py-3 bg-white border border-jj-gray-02 rounded-xl">
              <div className="font-johnson-text text-[11px] text-jj-gray-05 mb-0.5">
                {isCompose ? 'Subject line as sent' : (isQueue ? 'Goes out' : 'Delivery')}
              </div>
              <div className="font-johnson-text text-[13px] text-jj-gray-08 leading-snug break-words">
                {isCompose && (preview.subject
                  || `${activeCategory?.prefix ? activeCategory.prefix + ' ' : ''}${subject || '(no subject)'}`)}
                {isQueue && (queueDetail
                  ? `${formatTimestamp(queueDetail.send_at)} · ${plural(queueDetail.recipient_count, 'recipient')}`
                    + ` · ${queueDetail.status === 'pending' ? 'queued' : queueDetail.status}`
                    + (queueDetail.error ? ` — ${queueDetail.error}` : '')
                  : '—')}
                {isHistory && (detail
                  ? `${plural(detail.recipient_count, 'recipient')} · ${detail.status}${
                      detail.status === 'failed' && detail.error ? ` — ${detail.error}` : ''}`
                  : '—')}
              </div>

              {/* Who it actually went to. The pane stopped at a count, which is no
                  help to an admin being asked whether someone was on the list. */}
              {viewing && (
                <dl className="mt-2.5 pt-2.5 border-t border-jj-gray-01 flex flex-col gap-1.5">
                  {[['To', viewing.to_addrs], ['Cc', viewing.cc_addrs], ['Bcc', viewing.bcc_addrs]]
                    .filter(([, value]) => hasText(value))
                    .map(([field, value]) => (
                      <div key={field} className="flex gap-2 font-johnson-text text-[12px]">
                        <dt className="w-7 flex-none text-jj-gray-05">{field}</dt>
                        <dd className="flex-1 min-w-0 text-jj-gray-07 break-words">{value}</dd>
                      </div>
                    ))}
                  {hasText(viewing.sensitivity_label) && (
                    <div className="flex gap-2 font-johnson-text text-[12px]">
                      <dt className="w-7 flex-none text-jj-gray-05">Label</dt>
                      <dd className="flex-1 min-w-0 text-jj-gray-07 break-words">
                        {viewing.sensitivity_label}
                      </dd>
                    </div>
                  )}
                  {(viewing.attachments || []).length > 0 && (
                    <div className="flex gap-2 font-johnson-text text-[12px]">
                      <dt className="w-7 flex-none text-jj-gray-05">Files</dt>
                      <dd className="flex-1 min-w-0 text-jj-gray-07 flex flex-wrap gap-x-2 gap-y-1">
                        {viewing.attachments.map((file, index) => (
                          // Downloadable only where the bytes were kept; older
                          // rows recorded the name alone and still show it.
                          viewing.files_stored && isHistory ? (
                            <button
                              key={`${file.filename}-${index}`}
                              onClick={() => downloadAttachment(detail.id, index, file.filename)}
                              className="underline decoration-jj-gray-04 underline-offset-2 hover:text-jj-red break-all"
                            >
                              {file.filename}
                            </button>
                          ) : (
                            <span key={`${file.filename}-${index}`} className="break-all">
                              {file.filename}
                            </span>
                          )
                        ))}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
            </div>
          </div>
        </aside>
      </div>

      {confirming && (
        <ConfirmSend
          summary={{
            ...tally,
            subject: preview.subject || subject,
            attachments: attachments.length,
            sendAt,
            sendAtLabel: scheduledLabel,
            sensitivityLabel,
          }}
          sending={sending}
          onCancel={() => setConfirming(false)}
          onConfirm={sendForReal}
        />
      )}

      {aiMode && (
        <AIDraftModal
          key={aiMode}
          mode={aiMode}
          category={category}
          subject={subject}
          body={body}
          noteIds={noteIds}
          onClose={() => setAiMode(null)}
          onApply={applyDraft}
        />
      )}

      {picking && (
        <RecipientPicker
          allowedDomains={config?.allowed_domains || []}
          onClose={() => setPicking(false)}
          onAdd={addRecipients}
        />
      )}

      {ask && (
        <PromptModal
          title={ask.title}
          subtitle={ask.subtitle}
          label={ask.label}
          placeholder={ask.placeholder}
          defaultValue={ask.defaultValue || ''}
          confirmLabel={ask.confirmLabel}
          busy={working}
          onCancel={() => setAsk(null)}
          onConfirm={(value) => runChecked(() => ask.onConfirm(value))}
        />
      )}

      {check && (
        <ConfirmModal
          title={check.title}
          subtitle={check.subtitle}
          confirmLabel={check.confirmLabel}
          tone={check.tone}
          busy={working}
          onCancel={() => setCheck(null)}
          onConfirm={() => runChecked(check.onConfirm)}
        />
      )}
    </div>
  );
};

export default CommunicationCenter;