# Transcription Pipeline Dockerfile
FROM node:20-slim AS base

# Install ffmpeg for audio processing
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

FROM base AS builder
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build

FROM base AS runner
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/dist ./dist
COPY --from=builder /app/apps/server/package.json .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.mjs"]
