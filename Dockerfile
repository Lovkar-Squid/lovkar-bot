FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY bot.js web.js triage.js llm.js youtube.js packs.js pack.js db.js ./

# COPY keeps whatever mode the files had on the way in, and a copy that arrived over scp
# from a Windows mount arrives 0700 - which the unprivileged user below cannot read.
RUN chmod -R a+rX /app

# Where the book lives. A volume is mounted over this in the compose; if none is, the bot finds
# nothing writable, says so once, and runs the way it did before it had one.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
# SQLite is still marked experimental in Node 22 and says so on every start. It is a built-in and
# the bot has been running on it since; the notice is not worth a line in the log every time.
CMD ["node", "--disable-warning=ExperimentalWarning", "bot.js"]
