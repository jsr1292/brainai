/**
 * ONNX Runtime settings for the two local models (B5). Each model has its own thread pool; by default it has a thread
 * per core and its threads spin while they wait. A recall runs the embedder and then the reranker, and two spinning
 * pools taking turns made each recall about 3 times slower and burn about 16 s of CPU on a 22-thread mini PC
 * (measured 2026-11-08: 886 ms and 16 s per recall before, 304 ms and 1.4 s with these settings).
 */
import { availableParallelism } from 'node:os';

/** Threads per model: more gained nothing measurable on the mini PC (8 threads: 298 ms, 1.7 s of CPU). */
export const MODEL_THREADS = 6;

export function modelSessionOptions(cores = availableParallelism()): {
  intraOpNumThreads: number; interOpNumThreads: 1;
  extra: { session: { intra_op: { allow_spinning: '0' }; inter_op: { allow_spinning: '0' } } };
} {
  return {
    intraOpNumThreads: Math.max(1, Math.min(MODEL_THREADS, cores)),
    interOpNumThreads: 1,
    extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
  };
}
