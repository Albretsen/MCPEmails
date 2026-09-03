/**
 * The demo video ships one WebVTT file per marketing locale. They are cut from
 * the same 51 second voiceover, so they have to stay in lockstep: the same cue
 * numbers on the same timestamps, only the text differing. A translator who
 * merges two cues or drops one desynchronises that language against the audio,
 * and nothing in the build would notice, so it is checked here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = join(HERE, '..', '..', '..', 'public', 'demo');

const LOCALES = ['en', 'es', 'fr', 'nb', 'zh'];
const REFERENCE = 'en';

function read(locale) {
  return readFileSync(join(DEMO_DIR, `connect-and-triage.${locale}.vtt`), 'utf8');
}

/**
 * Parses just enough WebVTT for this check: the cue identifier, the timing
 * line, and the payload. Cue settings after the timestamp (align, line) are
 * kept on the timing line so a stray setting counts as a difference.
 */
function parseCues(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  assert.equal(lines[0].trim(), 'WEBVTT', 'file must start with the WEBVTT magic line');

  const cues = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i].includes('-->')) continue;
    const timing = lines[i].trim();
    const id = lines[i - 1].trim();
    const text = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ''; j += 1) {
      text.push(lines[j]);
    }
    cues.push({ id, timing, text: text.join('\n') });
  }
  return cues;
}

const parsed = new Map(LOCALES.map((locale) => [locale, parseCues(read(locale))]));

test('every locale has a subtitle file', () => {
  const present = readdirSync(DEMO_DIR).filter((name) => name.endsWith('.vtt')).sort();
  assert.deepEqual(
    present,
    LOCALES.map((locale) => `connect-and-triage.${locale}.vtt`).sort(),
    'public/demo holds exactly one .vtt per locale',
  );
});

test('the reference file has cues at all', () => {
  assert.ok(parsed.get(REFERENCE).length > 0, 'the English file parsed to zero cues');
});

for (const locale of LOCALES.filter((l) => l !== REFERENCE)) {
  test(`${locale} matches ${REFERENCE} cue for cue`, () => {
    const reference = parsed.get(REFERENCE);
    const translated = parsed.get(locale);

    assert.equal(
      translated.length,
      reference.length,
      `${locale} has ${translated.length} cues, English has ${reference.length}`,
    );

    reference.forEach((cue, index) => {
      assert.equal(translated[index].id, cue.id, `${locale} cue ${index + 1} is numbered differently`);
      assert.equal(
        translated[index].timing,
        cue.timing,
        `${locale} cue ${cue.id} has a different timestamp line`,
      );
      assert.notEqual(translated[index].text.trim(), '', `${locale} cue ${cue.id} is empty`);
    });
  });
}

for (const locale of LOCALES) {
  test(`${locale} uses no em dash`, () => {
    const source = read(locale);
    const index = source.indexOf('\u2014');
    assert.equal(index, -1, `${locale} contains an em dash near: ${source.slice(Math.max(0, index - 40), index + 40)}`);
  });
}
