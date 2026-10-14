// i18n-keys lists the English keys the client translates (web/i18n.js):
// every T`...` template in app.js (its ${...} become {0}, {1}, ...) and
// every N('...') string. The static page's keys come from the page itself
// (e2e/i18n.js reads them in a browser).
// Usage as a script: node i18n-keys.js  (prints the keys missing from VI)
const fs = require('fs');
const path = require('path');

// codeKeys scans src for T`...` and N('...').
function codeKeys(src) {
  const keys = new Set();
  // T templates: walk the source so nested templates and ${...} are skipped
  // properly; each T` starts a key, ${...} parts become {i}.
  const readTemplate = (i) => { // i: just after the opening backtick
    let key = '', n = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { key += src[i + 1]; i += 2; continue; }
      if (c === '`') return { key, end: i + 1 };
      if (c === '$' && src[i + 1] === '{') {
        i = skipExpr(i + 2);
        key += `{${n++}}`;
        continue;
      }
      key += c;
      i++;
    }
    return { key, end: i };
  };
  // skipExpr returns the index after the } closing an expression that
  // starts at i, collecting the T templates inside it.
  const skipExpr = (i) => {
    let depth = 1;
    while (i < src.length && depth) {
      const c = src[i];
      if (c === '`') {
        const tagged = src[i - 1] === 'T' && !/[\w$]/.test(src[i - 2] || '');
        const t = readTemplate(i + 1);
        if (tagged) keys.add(t.key);
        i = t.end;
        continue;
      }
      if (c === "'" || c === '"') { i = skipString(i); continue; }
      if (c === '{') depth++;
      if (c === '}') depth--;
      i++;
    }
    return i;
  };
  const skipString = (i) => {
    const q = src[i];
    i++;
    while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
    return i + 1;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === "'" || c === '"') { i = skipString(i) - 1; continue; }
    if (c === '`') {
      const tagged = src[i - 1] === 'T' && !/[\w$]/.test(src[i - 2] || '');
      const t = readTemplate(i + 1);
      if (tagged) keys.add(t.key);
      i = t.end - 1;
    }
  }
  for (const m of src.matchAll(/\bN\('((?:[^'\\]|\\.)*)'\)/g)) keys.add(m[1].replace(/\\(.)/g, '$1'));
  return keys;
}

// loadVI evaluates web/i18n.js and returns its VI table.
function loadVI() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'i18n.js'), 'utf8');
  const window = {};
  return new Function('window', 'navigator', 'localStorage', `${src}; return VI;`)(window, { languages: ['en'] }, null);
}

function appKeys() {
  return codeKeys(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'));
}

module.exports = { codeKeys, appKeys, loadVI };

if (require.main === module) {
  const vi = loadVI();
  const missing = [...appKeys()].filter((k) => /[A-Za-z]/.test(k) && vi[k] === undefined);
  for (const k of missing) console.log(JSON.stringify(k));
  console.error(`${missing.length} missing`);
}
