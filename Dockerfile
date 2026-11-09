# ---- 1) build the PWA and the browser side of the modules ----
FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY web web
RUN cd web && npm run build
# Modules are compiled ahead of time (React comes from the app at run time); only the files a running module needs are kept.
COPY modules modules
COPY scripts/build-modules.mjs scripts/
RUN node scripts/build-modules.mjs && rm -rf modules/*/web modules/*/test

# ---- 2) install server dependencies (toolchain only here, as a fallback for native modules) ----
FROM node:22-bookworm-slim AS server-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---- 3) runtime image ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data WEB_DIR=/app/web-dist OCR_LANGS=heb+eng
# Tesseract reads receipt photos on this server (English and Hebrew language data)
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-heb \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server-deps /app/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=web /build/web/dist ./web-dist
# Modules that ship with the app: installed on first start, upgraded when a newer version is bundled (see HANDOFF.md)
COPY --from=web /build/modules ./modules
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data /app
# Starts as root only to fix /data ownership, then drops to the node user (see docker-entrypoint.sh)
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
