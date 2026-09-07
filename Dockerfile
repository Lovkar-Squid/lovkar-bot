FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY bot.js web.js triage.js llm.js youtube.js ./

# COPY keeps whatever mode the files had on the way in, and a copy that arrived over scp
# from a Windows mount arrives 0700 - which the unprivileged user below cannot read.
RUN chmod -R a+rX /app

USER node
CMD ["node", "bot.js"]
