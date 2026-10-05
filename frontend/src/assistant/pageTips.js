// Short, friendly, one-time-per-session tips keyed by route. Keep them genuinely
// useful — this is the "contextual guide" surface. Empty/!match = no proactive tip.
export const PAGE_TIPS = {
  '/dashboard':       "Welcome back. Search any tool with Ctrl K, or ask me and I'll pull it up.",
  '/dqe':             "This is the DQ Engine. Ask me for pass rates, failing rules, or dataset health.",
  '/fuzzy-match':     "Need a hand with matching? Ask and I'll walk you through it.",
  '/audit':           "This is the audit log. Ask me how to filter it or what a column means.",
  '/user-management': "Managing roles here. I can explain what each permission does.",
  '/data-type-validation': "This compares L0 to L1 in Snowflake - row counts, column types, constraints. Ask me what FAULTY means.",
  '/data-api':        "This is the Data API Export page. Ask me about a specific export or table.",
  '/rag':             "This covers EPOD RAG, RIMDOCS RAG, and RIMDocs Agentic. Ask me about a document or search.",
  '/unstructured-explorer':    "Pick a document set to explore - you'll only see the ones your role allows. Ask me what's in each one.",
  '/gra-data-domains':       "This is Structured Explorer. Click a domain to see its full record.",
  '/data-studio':            "This is Data Studio. Snowflake, Index Health, S3 and StreamSets each have their own tab up top.",
  '/communication-center':   "This is the Communication Center. Send an update or warning to users — I can help you word it.",
};

export function tipForPath(pathname) {
  if (PAGE_TIPS[pathname]) return PAGE_TIPS[pathname];
  // match the closest known prefix (handles deep links like /dqe?rule_id=...)
  const hit = Object.keys(PAGE_TIPS).find(p => pathname.startsWith(p) && p !== '/');
  return hit ? PAGE_TIPS[hit] : null;
}

// Empty-chat quick-start chips, per route — swapped in instead of the generic
// defaults whenever the current page has something more specific to suggest.
const PAGE_PROMPTS = {
  '/dashboard':       ["How's our data quality?", 'Give me a tour', "What's on this screen?"],
  '/dqe':             ['Show me failing rules', "What's the current pass rate?", 'Explain a rule'],
  '/fuzzy-match':     ['How does fuzzy matching work?', 'Walk me through a match', 'Give me a tour'],
  '/audit':           ['How do I filter by user?', 'Give me a tour', "What's on this screen?"],
  '/user-management': ['Explain this permission', 'What can each role do?', "What's on this screen?"],
  '/data-type-validation': ['Explain this result', 'What does FAULTY mean?', 'Give me a tour'],
  '/data-api':        ['What exports are available?', 'Explain this table', "What's on this screen?"],
  '/rag':             ['Search a document', 'Give me a tour', 'What can I do here?'],
  '/unstructured-explorer':    ["What's in each document set?", 'Give me a tour', "What's on this screen?"],
  '/gra-data-domains':       ['Give me a tour', "What's on this screen?"],
  '/data-studio':            ['Give me a tour', 'How do I edit table rows?', 'Which indexes is my table missing?', "What's on this screen?"],
  '/communication-center':   ['Draft an outage notice', 'How do templates work?', "What's on this screen?"],
};

export function promptsForPath(pathname) {
  if (PAGE_PROMPTS[pathname]) return PAGE_PROMPTS[pathname];
  const hit = Object.keys(PAGE_PROMPTS).find(p => pathname.startsWith(p) && p !== '/');
  return hit ? PAGE_PROMPTS[hit] : null;
}

// cheap emotion read from the answer text so the face reacts in context.
export function emotionFor(text = '') {
  const t = text.toLowerCase();
  if (/\b(error|sorry|couldn't|can't|unable|failed|outside|don't have)\b/.test(t)) return 'concerned';
  if (/\b(great|done|complete|passed|100%|all good|success|nicely)\b/.test(t)) return 'celebrating';
  if (/\b(here'?s|found|sure|happy to|let me show|i can)\b/.test(t)) return 'happy';
  return 'neutral';
}