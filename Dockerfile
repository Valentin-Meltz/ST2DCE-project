# Stage 1: install the production dependencies only.
FROM node:24.22.3-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4 AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: minimal runtime image (Node.js only: no shell, no package manager, no npm).
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:675c532423b908f9e56f9d60a4e62309b63cd2a3175acb90a46b96f7ee68e121
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY app/package.json ./
COPY app/src ./src

# Numeric non-root user, so Kubernetes runAsNonRoot can verify it.
USER 65532:65532
EXPOSE 3000

# Commit SHA, passed by the pipeline. Declared last so a new commit does not invalidate the cached layers.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# The base image entrypoint is node: it runs as PID 1 and receives SIGTERM directly.
CMD ["src/server.js"]
