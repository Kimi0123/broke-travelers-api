# Multi-stage production build for broke-travelers-api
# Stage 1: Builder
FROM node:22-slim AS builder

WORKDIR /app

# Copy dependency manifests and prisma schema
COPY package.json package-lock.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy TypeScript source code and configs
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src/

# Generate Prisma client and compile TypeScript to dist/
RUN npx prisma generate
RUN npm run build

# Stage 2: Production Runner
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy dependency manifests and prisma schema
COPY package.json package-lock.json ./
COPY prisma ./prisma/

# Install only production dependencies and generate client
RUN npm ci --omit=dev && npx prisma generate

# Copy compiled JavaScript output from builder
COPY --from=builder /app/dist ./dist

# Run as non-root user for security
USER node

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
