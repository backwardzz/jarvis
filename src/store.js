'use strict';
const fs = require('fs');
const path = require('path');

/** Tiny JSON file store: defaults merged with what is on disk, written atomically. */
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = Array.isArray(defaults) ? raw : { ...this.data, ...raw };
    } catch {
      this.save();
    }
  }

  set(patch) {
    this.data = Array.isArray(patch) ? patch : { ...this.data, ...patch };
    this.save();
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
