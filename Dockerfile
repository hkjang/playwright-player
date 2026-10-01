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
# The built-in pages live here now; without them every page returns
# 500 UI_TEMPLATE_MISSING.
COPY public ./public

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data/runs /app/data/artifacts /app/data/environments /app/data/datasets /app/data/schedules /app/storage-states \
  && chown -R pwuser:pwuser /app \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

# The server runs as the base image's unprivileged pwuser. The entrypoint starts
# as root only long enough to align ownership of the mounted directories with
# pwuser (uid 1001), which a host-created volume will not match, then drops
# privileges with setpriv. Pass --user to skip that and pick the uid yourself.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
