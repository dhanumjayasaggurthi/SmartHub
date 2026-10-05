import { useRef, useCallback, useState, useEffect } from 'react';

/*
  Plays neural speech from the backend /assistant/tts endpoint and drives the
  mouth from the *actual audio amplitude* (real lip-sync, not word-flapping).

  speak(text)  -> fetches mp3, queues it, plays in order. Returns false if the
                  backend has no TTS configured, so the caller can fall back to
                  the browser voice.
  cancel()     -> stop now, clear the queue.
  onLevel(0..1) is called every frame while audio plays — wire it to the face.
*/

// TTS reads markdown out loud literally ("asterisk asterisk bold asterisk
// asterisk") if we don't strip it first. Chat replies come back as markdown,
// so clean it up before it ever hits the speech endpoint.
function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')           // code blocks
    .replace(/`([^`]+)`/g, '$1')               // inline code
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')        // images
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')     // links -> just the label
    .replace(/^#{1,6}\s+/gm, '')                // headings
    .replace(/(\*\*|__)(.*?)\1/g, '$2')         // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')            // italics
    .replace(/~~(.*?)~~/g, '$1')                // strikethrough
    .replace(/^\s*>\s?/gm, '')                  // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '')              // bullet list markers
    .replace(/^\s*\d+\.\s+/gm, '')              // numbered list markers
    .replace(/\|/g, ' ')                        // table pipes
    .trim();
}

export function useAzureVoice({ apiBase, getToken, onLevel }) {
  const ctxRef = useRef(null);
  const queueRef = useRef([]);
  const playingRef = useRef(false);
  const stoppedRef = useRef(false);
  const srcRef = useRef(null);
  const disabledRef = useRef(false);   // backend said "not configured" — stop trying
  const disabledUntilRef = useRef(0);  // backend/network hiccup — retry after a cooldown
  // mirrors disabledRef but as state, so the UI can actually show "voice unavailable"
  // instead of a mute toggle that silently does nothing.
  const [ttsUnavailable, setTtsUnavailable] = useState(false);
  // bumped by cancel(): anything fetched or queued before a Stop belongs to an
  // older generation and must never play, even if its download finishes later
  const genRef = useRef(0);
  const inflightRef = useRef(new Set());

  const audioCtx = () => {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return ctxRef.current;
  };

  useEffect(() => () => {
    try { ctxRef.current?.close(); } catch { /* already closed / unsupported */ }
  }, []);

  // Call this from a direct user gesture (e.g. the click that opens the panel).
  // Chrome/Safari only allow an AudioContext to leave "suspended" inside a real
  // gesture's call stack; creating it lazily on first playback (which can happen
  // async, several ticks after the click that triggered it) risks a context stuck
  // suspended forever with audio silently not playing. Cheap and idempotent.
  const primeAudio = useCallback(() => {
    try { audioCtx().resume(); } catch { /* no-op if unsupported */ }
  }, []);

  const playNext = useCallback(async () => {
    if (playingRef.current) return;
    const item = queueRef.current.shift();
    if (!item) return;
    playingRef.current = true;
    try {
      const ctx = audioCtx();
      await ctx.resume();
      const buffer = await ctx.decodeAudioData(item.bytes);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      srcRef.current = src;

      const data = new Uint8Array(analyser.frequencyBinCount);
      let raf;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        onLevel?.(Math.min(1, (peak / 128) * 2.2));
        raf = requestAnimationFrame(tick);
      };
      try {
        tick();
        await new Promise((res) => { src.onended = res; src.start(); });
      } finally {
        // if start() or anything mid-playback throws, the meter loop must still
        // die with it — otherwise it keeps a rAF spinning forever on dead audio
        cancelAnimationFrame(raf);
        onLevel?.(0);
      }
    } catch {
      /* swallow — bad chunk shouldn't kill the queue */
    }
    playingRef.current = false;
    srcRef.current = null;
    item.onEnd?.(stoppedRef.current);   // resolve THIS clip's promise - null if it was cut off by Stop
    if (!stoppedRef.current && queueRef.current.length) playNext();
  }, [onLevel]);

  // fetch the audio for a line WITHOUT playing it yet — lets the caller prefetch the
  // next step's speech while the current one is still playing / while she walks.
  // Returns { bytes, gen } when audio is ready, null when there's nothing to
  // play (no text, TTS off/unavailable), or { cancelled: true } when a Stop
  // happened while it was downloading - callers must NOT fall back to another
  // voice in that case, the user asked for silence.
  const prepare = useCallback(async (text, emotion, voice) => {
    const clean = stripMarkdown((text || '').trim());
    if (!clean) return null;
    if (disabledRef.current) return null;
    if (disabledUntilRef.current && Date.now() < disabledUntilRef.current) return null;

    const gen = genRef.current;
    const controller = new AbortController();
    inflightRef.current.add(controller);
    try {
      const token = await getToken();
      if (gen !== genRef.current) return { cancelled: true };
      const killer = setTimeout(() => controller.abort(), 15000); // don't hang the queue forever
      let res;
      try {
        res = await fetch(`${apiBase}/assistant/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ text: clean, emotion: emotion || '', voice: voice || '' }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(killer);
      }
      if (gen !== genRef.current) return { cancelled: true };
      if (res.status === 503) { disabledRef.current = true; setTtsUnavailable(true); return null; }
      if (!res.ok) { disabledUntilRef.current = Date.now() + 30000; return null; } // brief backoff, try again soon
      const bytes = await res.arrayBuffer();
      if (gen !== genRef.current) return { cancelled: true };
      return bytes.byteLength ? { bytes, gen } : null;
    } catch {
      // our own Stop aborting the request isn't a network problem - no backoff
      if (gen !== genRef.current) return { cancelled: true };
      disabledUntilRef.current = Date.now() + 30000; // timeout/network drop — back off, don't disable forever
      return null;
    } finally {
      inflightRef.current.delete(controller);
    }
  }, [apiBase, getToken]);

  // play already-fetched audio; resolves true when it finished playing, false if
  // there was nothing to play, null if it was stopped / from before a Stop
  const play = useCallback((handle) => {
    if (handle?.cancelled || (handle?.bytes && handle.gen !== genRef.current)) return Promise.resolve(null);
    if (!handle || !handle.bytes) return Promise.resolve(false);
    stoppedRef.current = false;
    return new Promise((resolve) => {
      queueRef.current.push({ bytes: handle.bytes, onEnd: (stopped) => resolve(stopped ? null : true) });
      playNext();
    });
  }, [playNext]);

  // true = spoke, false = couldn't (caller may use the browser voice), null = stopped
  const speak = useCallback(async (text, emotion, voice) => {
    const h = await prepare(text, emotion, voice);
    if (h?.cancelled) return null;
    if (!h) return false;
    return play(h);
  }, [prepare, play]);

  const cancel = useCallback(() => {
    genRef.current += 1;
    inflightRef.current.forEach((c) => { try { c.abort(); } catch { /* already done */ } });
    inflightRef.current.clear();
    stoppedRef.current = true;
    const pending = queueRef.current;
    queueRef.current = [];
    pending.forEach((it) => it.onEnd?.(true));   // unblock anyone awaiting a queued clip
    try { srcRef.current?.stop(); } catch { /* not started / already stopped */ }
    onLevel?.(0);
  }, [onLevel]);

  // Cut the clip that's playing (and anything queued to play) but keep audio
  // that's already downloaded or downloading - a tour moving to its next step
  // uses this, so the next step's prefetched narration still plays.
  const skip = useCallback(() => {
    stoppedRef.current = true;
    const pending = queueRef.current;
    queueRef.current = [];
    pending.forEach((it) => it.onEnd?.(true));
    try { srcRef.current?.stop(); } catch { /* not started / already stopped */ }
    onLevel?.(0);
  }, [onLevel]);

  // still "speaking" while a clip is downloading too - otherwise the Stop button
  // hides in the gap and the voice then starts with no way to stop it
  const isSpeaking = useCallback(
    () => playingRef.current || queueRef.current.length > 0 || inflightRef.current.size > 0, []);

  return { speak, prepare, play, cancel, skip, isSpeaking, ttsUnavailable, primeAudio };
}