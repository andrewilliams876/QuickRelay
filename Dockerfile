FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV WS_PORT=3001
ENV WS_HOST=0.0.0.0

COPY --from=builder /app ./

EXPOSE 3000
EXPOSE 3001

CMD ["npm", "run", "start"]
