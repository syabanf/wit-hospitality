# Console image: Vite builds the static app, nginx serves it and proxies /api/ to the Go API, so
# the browser talks to one origin and the auth cookie needs no CORS.
FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# An empty VITE_API_URL builds the mock-data demo with no API behind it.
ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/dist /usr/share/nginx/html
# host:port of the API; split mode points this at the gateway.
ENV API_UPSTREAM=monolith:8080
EXPOSE 8080
