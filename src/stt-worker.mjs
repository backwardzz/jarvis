// Whisper speech recognition off the main thread (transformers.js + onnxruntime-node, CPU).
import { parentPort, workerData } from 'node:worker_threads';
import { pipeline, env } from '@huggingface/transformers';

env.cacheDir = workerData.cacheDir;
env.allowLocalModels = false;

const pipes = new Map();
let queue = Promise.resolve();

function load(size) {
  if (!pipes.has(size)) {
    const seen = new Map();
    const p = pipeline('automatic-speech-recognition', `onnx-community/whisper-${size}`, {
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (info) => {
        if (info.status !== 'progress' || !info.total) return;
        seen.set(info.file, [info.loaded, info.total]);
        let loaded = 0, total = 0;
        for (const [l, t] of seen.values()) { loaded += l; total += t; }
        parentPort.postMessage({ type: 'progress', size, loaded, total });
      },
    });
    pipes.set(size, p);
    p.then(
      () => parentPort.postMessage({ type: 'ready', size }),
      (e) => { pipes.delete(size); parentPort.postMessage({ type: 'load-error', size, message: e.message }); },
    );
  }
  return pipes.get(size);
}

parentPort.on('message', (m) => {
  if (m.type === 'load') {
    const known = pipes.has(m.size);
    const p = load(m.size);
    if (known) p.then(() => parentPort.postMessage({ type: 'ready', size: m.size }), () => {});
    return;
  }
  if (m.type === 'transcribe') {
    queue = queue.then(async () => {
      const t0 = Date.now();
      try {
        const asr = await load(m.size);
        const out = await asr(m.audio, { language: m.language || 'russian', task: 'transcribe' });
        parentPort.postMessage({ type: 'result', id: m.id, text: (out.text || '').trim(), ms: Date.now() - t0 });
      } catch (e) {
        parentPort.postMessage({ type: 'result', id: m.id, error: e.message });
      }
    });
  }
});
