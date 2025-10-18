# Optional: Docker-based deployment (Render can auto-detect)
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production || npm install --production --legacy-peer-deps
COPY . .
ENV NODE_ENV=production
EXPOSE 10000
# Render injects PORT; we ignore EXPOSE at runtime
CMD ["node", "server.js"]
