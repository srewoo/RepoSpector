# Aegis image. Two roles share one image — `npm start` for the API,
# `npm run worker` for the BullMQ consumer.
FROM node:20-alpine AS deps
RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY apps/api/package.json apps/api/
COPY packages/review-core/package.json packages/review-core/
# src/services lives in the extension repo; bake it in (re-export shim only
# needs the source path to resolve at runtime).
COPY src/services src/services
COPY apps/api/package.json package.json
RUN cd apps/api && npm install --omit=dev

FROM node:20-alpine
RUN apk add --no-cache git ca-certificates && \
    addgroup -g 1001 aegis && adduser -D -u 1001 -G aegis aegis
WORKDIR /app
COPY --from=deps /app /app
COPY apps/api/src apps/api/src
COPY apps/api/migrations apps/api/migrations
COPY packages/review-core/src packages/review-core/src
COPY src/services src/services

USER aegis
ENV NODE_ENV=production NODE_OPTIONS="--max-old-space-size=512"
EXPOSE 8080
CMD ["node", "apps/api/src/server.js"]
