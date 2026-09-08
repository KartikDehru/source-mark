FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY client ./client
COPY agent ./agent
COPY scripts ./scripts
COPY mcp ./mcp
COPY public ./public
COPY registry ./registry

RUN npm install --no-save tsx

ENV PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:8787/health || exit 1

CMD ["npx", "tsx", "src/index.ts"]
