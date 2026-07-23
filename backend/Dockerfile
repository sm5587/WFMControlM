FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json tsconfig.json ./
COPY prisma ./prisma/

RUN npm install

COPY src ./src/

RUN npx prisma generate
RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/prisma ./prisma/
COPY --from=builder /app/node_modules ./node_modules/

RUN mkdir -p /app/logs

EXPOSE 4000

# Run migrations then start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
