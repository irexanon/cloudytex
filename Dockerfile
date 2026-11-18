# Use Node 22 Debian Bookworm Slim (glibc — required for Rollup 4 native parser & Sharp prebuilt binaries)
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (use npm ci if package-lock.json exists, otherwise npm install)
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

# Create directory and declare volume for cached thumbnails
RUN mkdir -p /app/data/thumbs
VOLUME ["/app/data/thumbs"]

# Copy package files
COPY package*.json ./

# Copy production dependencies
COPY --from=builder /app/node_modules ./node_modules

# Copy built frontend
COPY --from=builder /app/dist ./dist

# Copy backend files
COPY server.ts ./
COPY backend ./backend



EXPOSE 3000

CMD ["npm", "start"]
