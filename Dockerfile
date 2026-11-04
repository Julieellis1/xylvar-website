FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
ENV PORT=3000 NODE_ENV=production
CMD ["node", "server/index.js"]
