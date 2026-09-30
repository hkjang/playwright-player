FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Copy the lockfile so the image is reproducible: npm ci installs the exact
# resolved tree, npm install would re-resolve ranges at build time.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

COPY server.js ./
COPY scripts ./scripts

RUN mkdir -p /app/data/runs /app/data/artifacts /app/storage-states \
  && chown -R pwuser:pwuser /app

# The base image ships an unprivileged pwuser; running the browser and the
# spawned test processes as root is unnecessary privilege.
USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
