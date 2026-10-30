# Two stages: build the static UI, then a small runtime with only what the server needs (zero runtime npm deps).
FROM node:24.13.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY ui ./ui
RUN npm run build

FROM node:24.13.0-slim
ENV NODE_ENV=production PORT=3000 KEEL_DB=/tmp/keel/keel.db
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY fixtures ./fixtures
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
# The SQLite log lives for the container's life. Agent crash recovery is in-process from this file;
# a host redeploy or spin-down starts a fresh, empty demo database.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
