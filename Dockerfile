# syntax=docker/dockerfile:1
FROM node:22-alpine AS web
WORKDIR /app
COPY web/package.json web/package-lock.json web/
RUN npm ci --prefix web
# The web app compiles shared code from the server: the block model and the page model's browser-safe part
# (the @pagemodel alias in web/vite.config.ts and web/tsconfig.json). Keep these in step with that alias.
COPY server/src/blocks server/src/blocks
COPY server/src/pagemodel/shared server/src/pagemodel/shared
COPY web web
RUN npm run build --prefix web

FROM node:22-alpine AS server
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN npm ci --prefix server
COPY server server
RUN npm run build --prefix server && npm prune --omit=dev --prefix server

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/funnels.db
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app && mkdir /data && chown app:app /data
COPY --from=server /app/server/node_modules server/node_modules
COPY --from=server /app/server/dist server/dist
COPY --from=server /app/server/package.json server/package.json
COPY --from=web /app/web/dist web/dist
USER app
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server/dist/index.js"]
