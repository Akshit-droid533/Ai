FROM node:22-slim

# Tools Alpha can use when running commands
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip git curl ca-certificates zip unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Run as a normal user, not root, so commands can't touch the system
RUN mkdir -p /app/workspace && chown -R node:node /app
USER node

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WORKSPACE=/app/workspace
EXPOSE 3000
VOLUME /app/workspace
CMD ["node", "server.js"]
