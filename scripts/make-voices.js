#!/usr/bin/env node
// Records the commentary lines of web/voice/lines.json with macOS's
// Vietnamese voice "Linh" into web/voice/<id>.m4a (AAC at 32 kbit/s, a few
// KB each), in a style per kind to make them funnier: good news comes high
// and fast like a cartoon, bad news deep and slow, the shot clock sleepy.
// A style is a pitch factor (the recording is played back that much faster
// or slower, which moves pitch and pace together) and the speaking rate
// before it; a line may name its own "style". A file that is already there
// is kept, so recordings of your own (same name, any m4a) survive; --force
// records every line again. Needs macOS (`say`, `afconvert`).
//
// The system voice is fine for personal, non-commercial use (Apple's
// licence); replace the files with your own recordings for anything else.
//
// Usage: node scripts/make-voices.js [--force] [--voice Linh]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(__dirname, '..', 'web', 'voice');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const force = args.includes('--force');
const voice = opt('--voice', 'Linh');

const STYLES = {
  hype: { pitch: 1.3, rate: 175 },   // squeaky and thrilled
  sad: { pitch: 0.78, rate: 200 },   // deep, slow, a little mocking
  sleepy: { pitch: 0.7, rate: 185 }, // dragging, for the shot clock
};
const KIND_STYLE = {
  break: 'hype', nice: 'hype', great: 'hype', win: 'hype',
  miss: 'sad', foul: 'sad', scratch: 'sad', lose: 'sad',
  timeout: 'sleepy',
};
const RATE = 22050; // say's sample rate, and the files'

// pitched rewrites a WAV's sample rate (and byte rate) by factor, so it plays
// back that much faster or slower; afconvert then resamples it to RATE.
function pitched(wav, factor) {
  const buf = fs.readFileSync(wav);
  const at = buf.indexOf('fmt ');
  const rate = buf.readUInt32LE(at + 12);
  const bytes = buf.readUInt32LE(at + 16);
  buf.writeUInt32LE(Math.round(rate * factor), at + 12);
  buf.writeUInt32LE(Math.round(bytes * factor), at + 16);
  fs.writeFileSync(wav, buf);
}

const lines = JSON.parse(fs.readFileSync(path.join(dir, 'lines.json'), 'utf8'));
let made = 0;
for (const line of lines) {
  const out = path.join(dir, `${line.id}.m4a`);
  if (!force && fs.existsSync(out)) continue;
  const style = STYLES[line.style || KIND_STYLE[line.kind]] || { pitch: 1, rate: 185 };
  const raw = path.join(os.tmpdir(), `voice-${line.id}.wav`);
  // say now and then hangs; a few tries with a time limit get past it
  for (let tries = 1; ; tries++) {
    try {
      execFileSync('say', ['-v', voice, '-r', String(style.rate), '--file-format=WAVE', `--data-format=LEI16@${RATE}`, '-o', raw, line.text], { timeout: 15000 });
      break;
    } catch (err) {
      if (tries === 3) throw err;
    }
  }
  pitched(raw, style.pitch);
  execFileSync('afconvert', ['-f', 'm4af', '-d', `aac@${RATE}`, '-b', '32000', raw, out]);
  fs.rmSync(raw);
  made++;
}
console.log(`${made} recorded, ${lines.length - made} kept`);
