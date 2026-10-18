# Build from the repository root:  docker build -f apps/api/Dockerfile .
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
COPY apps/api apps/api
RUN npm run build -w @kx/shared && npm run build -w @kx/api && npm prune --omit=dev

FROM node:22-alpine
# Presenting documents in meetings (ارائه مستقیم): Poppler renders PDF pages to images (with Persian fonts
# for PDFs that do not embed them); LibreOffice converts PowerPoint/Word to PDF. Build with OFFICE_CONVERT=0
# to leave LibreOffice out (~500 MB); PDFs and images are presented either way.
ARG OFFICE_CONVERT=1
RUN apk add --no-cache poppler-utils font-noto font-noto-arabic ttf-dejavu \
      || echo "poppler-utils could not be installed; presentations fall back to the in-browser PDF viewer"
RUN if [ "$OFFICE_CONVERT" = "1" ]; then \
      apk add --no-cache libreoffice-impress libreoffice-writer \
      || echo "LibreOffice could not be installed; PowerPoint/Word presenting stays off"; \
    fi
ENV NODE_ENV=production TZ=Asia/Tehran PORT=4000 UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/openapi.yaml apps/api/
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "dist/server.js"]
