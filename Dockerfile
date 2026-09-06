FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY bot.js triage.js llm.js ./

USER node
CMD ["node", "bot.js"]
