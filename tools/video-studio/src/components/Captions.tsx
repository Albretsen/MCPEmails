import React from 'react';
import { AbsoluteFill, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { getTheme, type ThemeName } from '../theme';

/**
 * Burned-in captions, read from the same word-level timing file that produces
 * the sidecar .vtt. One source, two outputs, so the two can never disagree.
 *
 * The timing file is written by scripts/render.mjs from
 * @remotion/install-whisper-cpp, into captures/<id>.captions.json (which is
 * served through the public/captures symlink). It is absent until a voiceover
 * has been transcribed, and this component renders nothing in that case rather
 * than failing the render: a cut without a voiceover is legitimate.
 */

interface Word {
  text: string;
  startMs: number;
  endMs: number;
}

/** Words are grouped into short phrases. A caption that changes on every word
 *  is unreadable, and one that holds a full sentence covers the frame. */
const MAX_CHARS = 42;
const MAX_GAP_MS = 500;

/**
 * Canonical spellings for terms whisper fragments or homophones. Must match
 * SPELLINGS / applySpellings() in scripts/lib/captions.mjs exactly, for the
 * same reason joinWords() is duplicated: the burned-in captions and the
 * sidecar .vtt have to say the same thing, and a shared import would cross the
 * node/bundle boundary.
 *
 * RE-JOINS: `heard` is exactly what the fragments already spell, so re-joining
 * cannot change what was said. HOMOPHONES (currently only Claude, which is
 * pronounced "clawed"): `heard` differs from the text, so this substitutes one
 * word for another. See the mjs file for why that is scoped this tightly.
 */
const SPELLINGS: { heard: string; text: string }[] = [
  { heard: 'mcpemails.com', text: 'mcpemails.com' },
  { heard: 'mcpemails', text: 'MCP Emails' },
  { heard: 'encrypted', text: 'encrypted' },
  { heard: 'fastmail', text: 'Fastmail' },
  { heard: 'codebase', text: 'codebase' },
  { heard: 'chatgpt', text: 'ChatGPT' },
  { heard: 'oauth', text: 'OAuth' },
  // "Claude" is pronounced "clawed", and which ordinary word whisper picks
  // for it is not stable: the same script transcribed "Cl awed" on one render
  // and "Cl od" on the next. Both spellings are listed rather than one,
  // and this entry MUST be rechecked when the scratch voiceover is replaced
  // by a real one, because a different voice will produce a different guess.
  { heard: 'clawed', text: 'Claude' },
  { heard: 'clod', text: 'Claude' },
  { heard: 'jmap', text: 'JMAP' },
  { heard: 'imap', text: 'IMAP' },
  { heard: 'smtp', text: 'SMTP' },
  { heard: 'mcp', text: 'MCP' },
];

const termKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]/g, '');

function applySpellings(words: Word[]): Word[] {
  const out: Word[] = [];
  let i = 0;

  while (i < words.length) {
    let hit: { text: string; end: number; tail: string } | null = null;

    for (const entry of SPELLINGS) {
      const target = entry.heard;
      let acc = '';

      for (let j = i; j < words.length && j < i + 6; j += 1) {
        const k = termKey(words[j].text);

        // See scripts/lib/captions.mjs: a punctuation-only token has an empty
        // key, which matches every prefix and lets a match begin on the comma
        // before a term, swallowing it and shifting the window.
        if (k === '') break;

        acc += k;

        if (acc === target) {
          hit = { text: entry.text, end: j, tail: '' };
          break;
        }

        if (acc.startsWith(target)) {
          const rest = words[j].text.slice(-(acc.length - target.length));
          if (/^[.,!?;:]+$/.test(rest)) hit = { text: entry.text, end: j, tail: rest };
          break;
        }

        if (!target.startsWith(acc)) break;
      }

      if (hit) break;
    }

    if (hit) {
      out.push({
        text: hit.text + hit.tail,
        startMs: words[i].startMs,
        endMs: words[hit.end].endMs,
      });
      i = hit.end + 1;
    } else {
      out.push(words[i]);
      i += 1;
    }
  }

  return out;
}

/**
 * Join word tokens into readable text. Must match joinWords() in
 * scripts/lib/captions.mjs exactly: the burned-in captions and the sidecar
 * .vtt have to say the same thing.
 *
 * whisper emits punctuation as its own token, so a naive space-join renders
 * "password , no O Auth review ,".
 */
function joinWords(words: Word[]): string {
  return words
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+([,.!?;:%\)\]])/g, '$1')
    // whisper emits a contraction suffix as its own token, so a plain join
    // gives "It 's read" and "We 're going". Only closed before a letter, so a
    // genuine opening quote is left alone.
    .replace(/\s+'(?=[A-Za-z])/g, "'")
    .replace(/([(\[])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupIntoPhrases(rawWords: Word[]): { text: string; startMs: number; endMs: number }[] {
  // Before grouping, not inside joinWords: "mcpemails.com" arrives as six
  // fragments and would otherwise be split across two cues.
  const words = applySpellings(rawWords);
  const out: { text: string; startMs: number; endMs: number }[] = [];
  let current: Word[] = [];

  const flush = () => {
    if (current.length === 0) return;
    out.push({
      text: joinWords(current),
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
    });
    current = [];
  };

  for (const w of words) {
    const wouldBe = joinWords([...current, w]).length;
    const gap = current.length ? w.startMs - current[current.length - 1].endMs : 0;
    if (current.length && (wouldBe > MAX_CHARS || gap > MAX_GAP_MS)) flush();
    current.push(w);
    if (/[.!?]$/.test(w.text)) flush();
  }
  flush();
  return out;
}

export const BurnedInCaptions: React.FC<{ storyboardId: string; themeName: ThemeName }> = ({
  storyboardId,
  themeName,
}) => {
  const theme = getTheme(themeName);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [words, setWords] = React.useState<Word[] | null>(null);
  const [handle] = React.useState(() => delayRender(`captions:${storyboardId}`));

  React.useEffect(() => {
    let cancelled = false;
    fetch(staticFile(`captures/${storyboardId}.captions.json`))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setWords(Array.isArray(data?.words) ? data.words : []);
        continueRender(handle);
      })
      .catch(() => {
        if (cancelled) return;
        // No timing file yet. Draw nothing, do not fail the render.
        setWords([]);
        continueRender(handle);
      });
    return () => {
      cancelled = true;
    };
  }, [handle, storyboardId]);

  if (!words || words.length === 0) return null;

  const nowMs = (frame / fps) * 1000;
  const phrases = groupIntoPhrases(words);
  const active = phrases.find((p) => nowMs >= p.startMs && nowMs <= p.endMs + 120);
  if (!active) return null;

  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 76 }}>
      <div
        style={{
          background: 'rgba(11,16,32,0.82)',
          color: '#FFFFFF',
          fontFamily: theme.fontSans,
          fontWeight: 500,
          fontSize: 38,
          lineHeight: 1.3,
          letterSpacing: '-0.01em',
          padding: '14px 28px',
          borderRadius: 12,
          maxWidth: '76%',
          textAlign: 'center',
          textShadow: '0 1px 3px rgba(0,0,0,0.6)',
        }}
      >
        {active.text}
      </div>
    </AbsoluteFill>
  );
};
