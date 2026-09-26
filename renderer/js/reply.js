// Turns a streamed Claude reply into speakable sentences and HUD commands.
// non-greedy up to "]]", so JSON arguments of [[call:…]] may contain single brackets
const TAG = /\[\[(open|project|voice|panel|window|close|call|macro):(.*?)\]\]/g;
const SPEAK_LIMIT = 650;

export function stripTags(text) {
  return text.replace(TAG, '').replace(/^\s*-{3,}\s*$/gm, '').replace(/[ \t]+\n/g, '\n').trim();
}

export function speakable(text) {
  return text
    .replace(TAG, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/https?:\/\/(?:www\.)?([^\s/]+)[^\s]*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,!?])/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/[|]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ReplyProcessor {
  constructor({ onSentence, onCommand, notice = 'Подробности вывел на экран, сэр.', codeNotice = 'Код вывел на экран.' }) {
    this.onSentence = onSentence;
    this.onCommand = onCommand;
    this.notice = notice;
    this.codeNotice = codeNotice;
    this.pending = '';
    this.inFence = false;
    this.spoken = 0;
    this.muted = false;
    this.codeAnnounced = false;
    this.full = '';
  }

  push(delta) {
    this.full += delta;
    this.pending += delta;
    this.drain(false);
  }

  /** A content block ended: whatever is left is a complete thought. */
  flush() {
    this.drain(true);
  }

  drain(final) {
    // HUD commands — only act on complete tags
    this.pending = this.pending.replace(TAG, (_, kind, arg) => {
      this.onCommand?.(kind, arg.trim());
      return '';
    });

    let nl;
    while ((nl = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this.line(line, true);
    }
    if (final) {
      const rest = this.pending;
      this.pending = '';
      if (rest.includes('[[')) this.line(rest.slice(0, rest.indexOf('[[')), true);
      else this.line(rest, true);
      this.inFence = false;
      return;
    }
    // Partial line: speak finished sentences early, but never half a fence, table or tag.
    if (this.inFence || /^\s*(`|\||\[\[)/.test(this.pending)) return;
    const tagAt = this.pending.indexOf('[[');
    const safe = tagAt >= 0 ? this.pending.slice(0, tagAt) : this.pending;
    const m = safe.match(/^([\s\S]*?[.!?…]+["»)]?)(\s+)/);
    if (m) {
      this.pending = this.pending.slice(m[0].length);
      this.emit(m[1]);
      this.drain(false);
    }
  }

  line(raw, complete) {
    if (/^\s*```/.test(raw)) {
      this.inFence = !this.inFence;
      if (this.inFence && !this.codeAnnounced) {
        this.codeAnnounced = true;
        this.emit(this.codeNotice);
      }
      return;
    }
    if (this.inFence) return;
    if (/^\s*-{3,}\s*$/.test(raw)) { this.muted = true; return; } // everything below the rule is screen-only
    if (/^\s*\|/.test(raw)) return; // tables are for the eyes
    if (!complete) return;
    this.emit(raw);
  }

  emit(text) {
    if (this.muted) return;
    const clean = speakable(text);
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return;
    if (this.spoken + clean.length > SPEAK_LIMIT && this.spoken > 0) {
      this.muted = true;
      this.onSentence?.(this.notice);
      return;
    }
    this.spoken += clean.length;
    // long lines: split into sentences so synthesis starts sooner
    const parts = clean.match(/[^.!?…]+[.!?…]*["»)]?\s*/g) || [clean];
    let chunk = '';
    for (const p of parts) {
      if ((chunk + p).length > 220 && chunk) { this.onSentence?.(chunk.trim()); chunk = ''; }
      chunk += p;
    }
    if (chunk.trim()) this.onSentence?.(chunk.trim());
  }
}
