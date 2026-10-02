FROM node:20-alpine

WORKDIR /app

# Copy package manifests first for layer caching
COPY tools/package.json tools/package-lock.json ./tools/

RUN cd tools && npm ci

# Copy Solidity sources, pre-compiled artifacts, and TypeScript tools
COPY evm/src ./evm/src
COPY evm/out ./evm/out
COPY evm/deployments.json ./evm/deployments.json
COPY evm/stablecoins.json ./evm/stablecoins.json
COPY tools/tsconfig.json ./tools/tsconfig.json
COPY tools/src ./tools/src

WORKDIR /app/tools

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["npm", "run", "watch"]
