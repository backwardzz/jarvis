#!/usr/bin/env node
// Test double for src/brain.js: a Claude Code CLI that predates --input-format (one-shot print mode only).
if (process.argv.includes('--input-format')) {
  process.stderr.write("error: unknown option '--input-format'\n");
  process.exit(1);
}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', session_id: 'old-session', model: 'test' });
  out({ type: 'stream_event', session_id: 'old-session', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `Эхо: ${input.trim()}` } } });
  out({ type: 'stream_event', session_id: 'old-session', event: { type: 'content_block_stop' } });
  out({ type: 'result', session_id: 'old-session', result: `Эхо: ${input.trim()}`, is_error: false, num_turns: 1, duration_ms: 1 });
});
