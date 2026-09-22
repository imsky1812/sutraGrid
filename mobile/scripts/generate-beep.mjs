// Generates assets/sounds/alert_beep.wav: three short, high tones.
//
// Synthesised rather than downloaded so the sound has no licence to track and
// can be regenerated exactly. 1.2 kHz sits where the ear is sensitive and cuts
// through road and engine noise better than a low tone.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22050;
const FREQ = 1200;
const BEEP_S = 0.18;
const GAP_S = 0.1;
const BEEPS = 3;
// Ramping each beep in and out avoids the click a hard edge produces.
const FADE_S = 0.01;

const beepLen = Math.round(BEEP_S * RATE);
const gapLen = Math.round(GAP_S * RATE);
const fadeLen = Math.round(FADE_S * RATE);
const total = BEEPS * beepLen + (BEEPS - 1) * gapLen;

const samples = new Int16Array(total);
for (let b = 0; b < BEEPS; b++) {
  const start = b * (beepLen + gapLen);
  for (let i = 0; i < beepLen; i++) {
    const envelope = Math.min(1, i / fadeLen, (beepLen - i) / fadeLen);
    samples[start + i] = Math.round(Math.sin((2 * Math.PI * FREQ * i) / RATE) * envelope * 0.9 * 32767);
  }
}

const data = Buffer.from(samples.buffer);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds', 'alert_beep.wav');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out} (${(total / RATE).toFixed(2)}s)`);
