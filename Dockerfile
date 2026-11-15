# Legendary Memory on your own server: the hub with sign-in, for phone and web AI apps.
# Build from the repository root:  docker build -t legendary-memory .
# It speaks plain HTTP on 8787; put HTTPS in front of it (see docs/SELF-HOST.md).
FROM node:22-alpine AS build
WORKDIR /app
COPY hub/package.json hub/package-lock.json ./
RUN npm ci
COPY hub/ ./
RUN npm run build:local

FROM node:22-alpine
ENV NODE_ENV=production \
    LEGENDARY_MEMORY_DIR=/data \
    LEGENDARY_MEMORY_BIND=0.0.0.0 \
    LEGENDARY_MEMORY_BEHIND_PROXY=1
COPY --from=build /app/dist/legendary-memory.mjs /app/legendary-memory.mjs
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["node", "/app/legendary-memory.mjs"]
# Needs LEGENDARY_MEMORY_URL (your https address) and LEGENDARY_MEMORY_PASSPHRASE (12+ characters).
CMD ["host"]
