# Build from the repository root:  docker build -f apps/web/Dockerfile .
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
COPY apps/web apps/web
RUN npm run build -w @kx/shared && npm run build -w @kx/web

FROM nginx:1.27-alpine
# The site (HTTP, or HTTPS with a mounted certificate) is written from the environment at start: see the script.
COPY apps/web/nginx/40-kx-site.sh /docker-entrypoint.d/40-kx-site.sh
RUN chmod 755 /docker-entrypoint.d/40-kx-site.sh && rm -f /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80 443
