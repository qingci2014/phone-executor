FROM node:22-alpine

WORKDIR /app

COPY package.json server.mjs config.example.json ./

ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["node", "server.mjs"]
