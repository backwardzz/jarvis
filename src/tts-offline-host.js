'use strict';
/**
 * Offline voices (sherpa-onnx) in their own Electron utility process.
 * sherpa-onnx ships its own onnxruntime.dll; loading it next to onnxruntime-node (Whisper) in one process
 * makes Windows reuse whichever DLL came first, and the other engine then fails to load.
 */
const sherpa = require('sherpa-onnx-node');

const engines = new Map(); // key -> Promise<OfflineTts>
const queues = new Map(); // key -> Promise chain: one generation at a time per model

function engine(key, config) {
  if (!engines.has(key)) {
    const p = sherpa.OfflineTts.createAsync(config);
    p.catch(() => engines.delete(key));
    engines.set(key, p);
  }
  return engines.get(key);
}

process.parentPort.on('message', ({ data: m }) => {
  const reply = (payload) => process.parentPort.postMessage({ id: m.id, ...payload });
  if (m.type === 'load') {
    engine(m.key, m.config).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
    return;
  }
  if (m.type === 'synth') {
    const run = (queues.get(m.key) || Promise.resolve()).then(async () => {
      const tts = await engine(m.key, m.config);
      // Electron's V8 sandbox forbids external ArrayBuffers, so the samples must be copied out
      const audio = await tts.generateAsync({
        text: m.text, enableExternalBuffer: false, generationConfig: new sherpa.GenerationConfig({ sid: m.sid, speed: m.speed }),
      });
      if (!audio?.samples?.length) throw new Error('модель не вернула звук');
      reply({ samples: audio.samples, sampleRate: audio.sampleRate });
    }).catch((e) => reply({ error: e.message }));
    queues.set(m.key, run);
  }
});
