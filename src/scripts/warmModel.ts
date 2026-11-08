import { createLocalEmbedder } from '../memory/embedder.js';
import { checkRerankerFiles, createLocalReranker } from '../memory/reranker.js';

const modelDir = process.env.MODEL_DIR ?? './models';
const embedder = await createLocalEmbedder({ modelDir, allowRemote: true });
await embedder.embed('warm', 'passage');
const reranker = await createLocalReranker({ modelDir, allowRemote: true });
await reranker.score('warm', ['warm']);
checkRerankerFiles(modelDir);
console.log('models ready');
