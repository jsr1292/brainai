import { createLocalEmbedder } from '../memory/embedder.js';

const embedder = await createLocalEmbedder({ modelDir: process.env.MODEL_DIR ?? './models', allowRemote: true });
await embedder.embed('warm', 'passage');
console.log('model ready');
