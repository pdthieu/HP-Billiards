#!/usr/bin/env node
// Records the commentary lines of web/voice/lines.json with macOS's
// Vietnamese voice "Linh" into web/voice/<id>.m4a (AAC at 32 kbit/s, a few
// KB each). A file that is already
// there is kept, so recordings of your own (same name, any m4a) survive;
// --force records every line again. Needs macOS (`say`).
//
// The system voice is fine for personal, non-commercial use (Apple's
// licence); replace the files with your own recordings for anything else.
//
// Usage: node scripts/make-voices.js [--force] [--voice Linh] [--rate 185]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(__dirname, '..', 'web', 'voice');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const force = args.includes('--force');
const voice = opt('--voice', 'Linh');
const rate = opt('--rate', '185');

const lines = JSON.parse(fs.readFileSync(path.join(dir, 'lines.json'), 'utf8'));
let made = 0;
for (const line of lines) {
  const out = path.join(dir, `${line.id}.m4a`);
  if (!force && fs.existsSync(out)) continue;
  const raw = path.join(os.tmpdir(), `voice-${line.id}.aiff`);
  execFileSync('say', ['-v', voice, '-r', rate, '-o', raw, line.text]);
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '32000', raw, out]);
  fs.rmSync(raw);
  made++;
}
console.log(`${made} recorded, ${lines.length - made} kept`);
