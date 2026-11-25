FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json server.json glama.json LICENSE README.md ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY beispiel ./beispiel
USER node
ENTRYPOINT ["node", "src/server.mjs"]
