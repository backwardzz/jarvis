#!/usr/bin/env node
// Test double for src/brain.js: stream-json input, one process for many turns, interrupts, stale sessions.
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const resume = process.argv[process.argv.indexOf('--resume') + 1];
if (process.argv.includes('--resume') && resume === 'stale') {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, duration_api_ms: 0, session_id: resume });
  process.exit(1);
}
const session = process.argv.includes('--resume') ? resume : `s-${process.pid}`;
let buffer = '';
let slow = null; // a long answer in progress, cut short by an interrupt
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buffer += d;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
      if (slow) { clearInterval(slow); slow = null; out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_api_ms: 5, session_id: session }); }
      continue;
    }
    const text = msg.message.content;
    out({ type: 'system', subtype: 'init', session_id: session, model: 'test', pid: process.pid });
    if (/долго/.test(text)) {
      slow = setInterval(() => out({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'бла ' } } }), 20);
      continue;
    }
    const reply = `pid ${process.pid}: ${text.slice(-30)}`;
    out({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
    out({ type: 'stream_event', session_id: session, event: { type: 'content_block_stop' } });
    out({ type: 'result', subtype: 'success', result: reply, is_error: false, num_turns: 1, duration_api_ms: 5, session_id: session });
  }
});
