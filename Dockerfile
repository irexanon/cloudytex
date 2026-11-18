# Use Node 22 as the base image
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies required for node-gyp/native modules
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build frontend
RUN npm run build

# Remove dev dependencies
RUN npm prune --production


# Production stage
FROM node:22-alpine

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
COPY server.ts telegram.ts provider-transfer-protocol.ts ./



EXPOSE 3000

CMD ["npm", "start"]
