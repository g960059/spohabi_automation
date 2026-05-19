FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

CMD ["node", "dist/src/index.js", "http"]
