FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_LAUNCH_ARGS="--no-sandbox,--disable-dev-shm-usage,--disable-gpu"

COPY package.json ./
RUN npm install --omit=dev --no-fund --no-audit

COPY server.js ./
COPY scripts ./scripts

RUN mkdir -p /app/data/runs /app/data/artifacts /app/storage-states

EXPOSE 3000

CMD ["node", "server.js"]
