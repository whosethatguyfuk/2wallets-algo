FROM node:20-slim
WORKDIR /app

# Copy shared executor/laser from sibling dir (Railway: include both services)
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 2500
CMD ["node", "runner.js"]
