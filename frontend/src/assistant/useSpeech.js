import { useRef, useState, useEffect, useCallback } from 'react';

// same cleanup as the Azure voice — no reason to hear "asterisk" on fallback either
function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .trim();
}

/*
  Voice in/out using the browser's built-in Web Speech API. No keys, no backend.

  speak(text)        -> says it out loud, firing onBoundary on each word so the
                        caller can pulse the mouth.
  startListening()   -> mic on; streams the transcript back via onTranscript(text, isFinal).
  cancelSpeech()     -> shut up immediately (e.g. user sent a new message).

  Notes:
   - TTS (speechSynthesis) works in basically every modern browser.
   - STT (SpeechRecognition) is Chrome/Edge only and webkit-prefixed; sttSupported
     tells the UI whether to show the mic at all.
   - For higher-quality voices + real lip-sync (viseme timing), swap this for the
     Azure Speech SDK — they have Azure already. See the note in chat.
*/
// SpeechRecognition error codes -> a short, human reason. Used to surface *why*
// the mic stopped instead of just silently going back to idle (which read as
// "the mic button is broken" to anyone who denied permission or hit a quiet room).
const STT_ERROR_MESSAGES = {
  'not-allowed': 'Mic access is blocked. Allow microphone access in your browser to talk to Regwiz.',
  'service-not-allowed': 'Mic access is blocked. Allow microphone access in your browser to talk to Regwiz.',
  'no-speech': "Didn't catch that — try again.",
  'audio-capture': 'No microphone found.',
  network: 'Voice input lost its connection. Try again.',
  aborted: null, // user-initiated stop, not an error worth showing
};

export function useSpeech({ onBoundary, onTranscript, onError } = {}) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  const Recognition = typeof window !== 'undefined'
    ? (window.SpeechRecognition || window.webkitSpeechRecognition)
    : null;

  const [listening, setListening] = useState(false);
  const recogRef = useRef(null);
  const voiceRef = useRef(null);

  // pick the most natural english voice the browser offers
  useEffect(() => {
    if (!synth) return;
    const load = () => {
      const vs = synth.getVoices();
      voiceRef.current =
        vs.find(v => /natural|neural/i.test(v.name) && /^en/i.test(v.lang)) ||
        vs.find(v => /(Google US English|Samantha|Microsoft (Aria|Jenny|Guy))/i.test(v.name)) ||
        vs.find(v => v.lang === 'en-US') ||
        vs[0] || null;
    };
    load();
    synth.addEventListener?.('voiceschanged', load);
    return () => synth.removeEventListener?.('voiceschanged', load);
  }, [synth]);

  const speak = useCallback((text) => {
    const clean = stripMarkdown((text || '').trim());
    if (!synth || !clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    if (voiceRef.current) u.voice = voiceRef.current;
    u.rate = 1.02;
    u.pitch = 1.0;
    u.onboundary = () => onBoundary?.();
    synth.speak(u);
  }, [synth, onBoundary]);

  const cancelSpeech = useCallback(() => { try { synth?.cancel(); } catch {} }, [synth]);
  const isSpeaking = useCallback(() => !!synth?.speaking, [synth]);

  const startListening = useCallback(() => {
    if (!Recognition || listening) return;
    const r = new Recognition();
    r.lang = 'en-US';
    r.interimResults = true;
    r.continuous = false;
    let finalText = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      onTranscript?.((finalText + interim).trim(), false);
    };
    r.onend = () => {
      setListening(false);
      if (finalText.trim()) onTranscript?.(finalText.trim(), true);
    };
    r.onerror = (e) => {
      setListening(false);
      const msg = STT_ERROR_MESSAGES[e.error];
      if (msg) onError?.(msg);
      else if (msg === undefined) onError?.('Voice input had a problem. Try again.');
    };
    recogRef.current = r;
    setListening(true);
    try { r.start(); } catch { setListening(false); onError?.('Could not start the microphone.'); }
  }, [Recognition, listening, onTranscript, onError]);

  const stopListening = useCallback(() => { try { recogRef.current?.stop(); } catch {} }, []);

  return {
    speak, cancelSpeech, isSpeaking,
    startListening, stopListening, listening,
    ttsSupported: !!synth,
    sttSupported: !!Recognition,
  };
}