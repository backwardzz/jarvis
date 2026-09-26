'use strict';
const fs = require('fs');
const path = require('path');
const { JsonStore } = require('./store');

const SEED = [
  {
    id: 'usetime-astana',
    name: 'Usetime Astana',
    url: 'https://usetime-astana.netlify.app/',
    description: 'Сайт антикафе Usetime в Астане: цены, каталог развлечений (караоке, кинозал, PS5, Xbox, бильярд), правила, три адреса и отзывы.',
    stack: 'HTML · CSS · JS · Netlify',
    localPath: 'D:\\usetime-site',
    aliases: ['usetime', 'юзтайм', 'юстайм', 'юз тайм', 'ю тайм', 'юзтайм астана', 'антикафе'],
    addedAt: '2026-09-26',
  },
];

function slug(s) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' };
  return String(s).toLowerCase().split('').map((ch) => map[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
}

class Projects {
  constructor(file, thumbsDir, seedThumbsDir) {
    this.store = new JsonStore(file, SEED);
    this.thumbsDir = thumbsDir;
    this.seedThumbsDir = seedThumbsDir;
    this.status = new Map();
    fs.mkdirSync(thumbsDir, { recursive: true });
  }

  thumbFile(id) {
    for (const f of [path.join(this.thumbsDir, id + '.jpg'), path.join(this.seedThumbsDir, id + '.png')]) {
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  list() {
    return this.store.data.map((p) => {
      const thumb = this.thumbFile(p.id);
      let v = 0;
      try { v = thumb ? Math.floor(fs.statSync(thumb).mtimeMs) : 0; } catch { /* ignore */ }
      return { ...p, thumb: thumb ? `app://thumbs/${p.id}?v=${v}` : null, status: this.status.get(p.id) || null };
    });
  }

  get(id) {
    return this.store.data.find((p) => p.id === id) || null;
  }

  add({ name, url, description = '', stack = '', localPath = '' }) {
    name = String(name || '').trim();
    url = String(url || '').trim();
    if (!name) throw new Error('Нужно название проекта');
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (url) new URL(url); // throws on garbage
    const existing = this.store.data.find((p) => (url && p.url === url) || p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      Object.assign(existing, { name, url: url || existing.url, description: description || existing.description });
      this.store.save();
      return existing;
    }
    let id = slug(name);
    while (this.get(id)) id += '-2';
    const project = {
      id, name, url, description, stack, localPath, aliases: [name.toLowerCase()],
      addedAt: new Date().toISOString().slice(0, 10),
    };
    this.store.set([...this.store.data, project]);
    return project;
  }

  remove(id) {
    this.store.set(this.store.data.filter((p) => p.id !== id));
    try { fs.unlinkSync(path.join(this.thumbsDir, id + '.jpg')); } catch { /* none */ }
  }

  async check(p) {
    if (!p.url) return null;
    const t0 = Date.now();
    let st;
    try {
      const res = await fetch(p.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(9000) });
      const ms = Date.now() - t0;
      const code = res.status;
      if (code === 401 || code === 403) st = { state: 'protected', code, ms };
      else if (code < 400) st = { state: 'online', code, ms };
      else st = { state: 'error', code, ms };
    } catch (e) {
      st = { state: 'offline', code: 0, ms: Date.now() - t0 };
    }
    st.checkedAt = Date.now();
    this.status.set(p.id, st);
    return st;
  }

  async checkAll() {
    await Promise.all(this.store.data.map((p) => this.check(p)));
    return this.list();
  }
}

module.exports = { Projects };
