# Build from the repository root:  docker build -f apps/office-api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/office-api/package.json apps/office-api/
COPY apps/office-web/package.json apps/office-web/
RUN npm ci
COPY packages/shared packages/shared
COPY apps/office-api apps/office-api
RUN npm run build -w @kx/shared && npm run build -w @kx/office-api && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production TZ=Asia/Tehran PORT=4100 STORAGE_DIR=/data/storage
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/office-api/package.json apps/office-api/
COPY --from=build /app/apps/office-api/dist apps/office-api/dist
COPY --from=build /app/apps/office-api/openapi.yaml apps/office-api/
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
WORKDIR /app/apps/office-api
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4100/health || exit 1
CMD ["node", "dist/server.js"]
