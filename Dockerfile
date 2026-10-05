FROM node:20-alpine

WORKDIR /app

# Copy package manifests first for layer caching
COPY tools/package.json tools/package-lock.json ./tools/

RUN cd tools && npm ci

# Copy Solidity sources and TypeScript tools.
# `evm/out` is deliberately NOT copied: it is a git-ignored build product that does not exist in a
# fresh clone, so copying it made `docker build` fail on every VPS/CI machine while only working on
# hosts that had compiled locally. The artifacts are generated from `evm/src` instead.
COPY evm/src ./evm/src
COPY evm/deployments.json ./evm/deployments.json
COPY evm/stablecoins.json ./evm/stablecoins.json
COPY tools/tsconfig.json ./tools/tsconfig.json
COPY tools/src ./tools/src

# Compile with the embedded solc (no Foundry required) so the image is self-contained.
RUN cd tools && npm run compile:contracts

WORKDIR /app/tools

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["npm", "run", "watch"]
