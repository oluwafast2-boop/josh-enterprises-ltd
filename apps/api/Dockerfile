FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
ENV API_PORT=4000
EXPOSE 4000
CMD ["node", "server.js"]
