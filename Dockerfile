FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --no-audit --no-fund \
  && npm install -w server tdl@^8.1.0 prebuilt-tdlib@^0.1008069.0 --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev && mkdir -p android-dist

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates wget \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir /data && chown node:node /data \
  # npm is not used at run time (and brings its own packages with known issues): out of the image.
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# sing-box: the tunnel that carries only Telegram traffic through the admin's proxy. Bundled (and
# checksum-verified) so offline servers have it; SING_BOX_PATH or data/bin/sing-box can override it.
ARG SING_BOX_VERSION=1.14.4
ARG TARGETARCH=amd64
RUN set -e; case "$TARGETARCH" in \
    amd64) sum=699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968 ;; \
    arm64) sum=436441f76ee2f7fe21b5b2d426d3cb261a480455a704865789ad533e4273ec26 ;; \
    *) echo "no sing-box for $TARGETARCH"; exit 1 ;; esac; \
  wget -qO /tmp/sb.tgz "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/sing-box-${SING_BOX_VERSION}-linux-${TARGETARCH}.tar.gz"; \
  echo "$sum  /tmp/sb.tgz" | sha256sum -c -; \
  tar xzf /tmp/sb.tgz -C /tmp; install -m 755 /tmp/sing-box-*/sing-box /usr/local/bin/sing-box; \
  rm -rf /tmp/sb.tgz /tmp/sing-box-*; sing-box version
WORKDIR /app
COPY --from=build /app/package.json /app/CHANGELOG.md ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/android-dist ./android-dist
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 NODE_NO_WARNINGS=1
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/src/index.js"]
