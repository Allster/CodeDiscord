'use strict';
// Tiny JSON store. One server means one small file is plenty; writes are atomic (temp file + rename)
// and batched so a burst of changes is one disk write.
const fs = require('fs');
const path = require('path');

const DEFAULTS = () => ({
  setup: { done: false, studioName: null, roles: {}, categories: {}, channels: {}, messages: {}, ranAt: null, ranBy: null },
  settings: { welcomeEnabled: true, autoRoleOnJoin: true, staffApplicationsOpen: true },
  warnings: {},
  cases: { counter: 0 },
  tickets: { counter: 0, open: {} },
  bugs: { counter: 0, reports: {} },
  suggestions: { counter: 0, items: {} },
  playtests: {},
});

function merge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

class Store {
  constructor(dir) {
    this.file = path.resolve(dir, 'data.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[store] Could not read ${this.file} (${e.message}); starting fresh and keeping a copy.`);
      if (e.code !== 'ENOENT') try { fs.copyFileSync(this.file, `${this.file}.broken-${Date.now()}`); } catch {}
    }
    this.data = merge(DEFAULTS(), saved);
    this.timer = null;
  }

  get(...keys) { return keys.reduce((o, k) => (o == null ? o : o[k]), this.data); }

  // Change data through a function, then save soon.
  update(fn) { const r = fn(this.data); this.save(); return r; }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  channelId(key) { return this.data.setup.channels[key] || null; }
  roleId(key) { return this.data.setup.roles[key] || null; }
}

module.exports = { Store, DEFAULTS };
