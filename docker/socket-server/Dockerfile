FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY socket-server.mjs ./

EXPOSE 4000

CMD ["npm", "run", "start"]
