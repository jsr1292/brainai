# Not Alpine: onnxruntime-node needs glibc.
#
# `npm ci --ignore-scripts`: better-sqlite3 ships prebuilt binaries, but the npm
# bundled in the node image still runs `node-gyp rebuild` for it (it has a
# binding.gyp) and fails without a compiler toolchain. Nothing here needs install scripts.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
# Bake the embedding model into the image: the running app makes no network calls for it.
RUN MODEL_DIR=/app/models node dist/scripts/warmModel.js

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production MODEL_DIR=/app/models DATA_DIR=/app/data PORT=3000 HOST=0.0.0.0 OVERLAY_DIR=/app/overlay
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --from=build /app/models ./models
# EmbeddingGemma ships with its notice and terms (Gemma Terms of Use, section 3.1).
COPY licenses ./licenses
COPY licenses/GEMMA-NOTICE.txt ./models/onnx-community/embeddinggemma-300m-ONNX/NOTICE
CMD ["node", "dist/index.js"]
