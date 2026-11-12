import { checkEmbedderFiles, createLocalEmbedder } from '../memory/embedder.js';
import { E5_PROFILE, GEMMA_PROFILE } from '../memory/embeddingProfile.js';
import { checkRerankerFiles, createLocalReranker } from '../memory/reranker.js';

const modelDir = process.env.MODEL_DIR ?? './models';
// Both search models: EMBED_MODEL picks one at run time, and switching back needs no download.
for (const model of [E5_PROFILE, GEMMA_PROFILE]) {
  const embedder = await createLocalEmbedder({ modelDir, allowRemote: true, model });
  await embedder.embed('warm', 'passage');
}
checkEmbedderFiles(modelDir);
const reranker = await createLocalReranker({ modelDir, allowRemote: true });
await reranker.score('warm', ['warm']);
checkRerankerFiles(modelDir);
console.log('models ready');
