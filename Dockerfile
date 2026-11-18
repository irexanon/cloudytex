# Node 22 Debian Bookworm Slim (glibc — required for Rollup 4 native parser & Sharp prebuilt binaries)
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Toolchain for native addons with no prebuilt binary for this platform
# (e.g. utf-8-validate / bufferutil pulled in by `telegram` on arm64).
# Builder stage only, so it doesn't bloat the final image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies (npm ci if package-lock.json exists, otherwise npm install)
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy source code
COPY . .

# Build frontend
RUN npm run build

# Remove dev dependencies
RUN npm prune --omit=dev


# Production stage
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV THUMB_DIR=/app/data/thumbs

# Directory and volume for cached thumbnails
RUN mkdir -p /app/data/thumbs
VOLUME ["/app/data/thumbs"]

# Copy package files
COPY package*.json ./

# Copy production dependencies (already compiled in the builder stage)
COPY --from=builder /app/node_modules ./node_modules

# Copy built frontend
COPY --from=builder /app/dist ./dist

# Copy backend files
COPY server.ts ./
COPY backend ./backend

EXPOSE 3000

CMD ["npm", "start"]
