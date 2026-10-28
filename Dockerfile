FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
# android-dist/amorechat.apk is added by the release workflow (served at /app); optional.
RUN npm run build && npm prune --omit=dev && mkdir -p android-dist

FROM node:24-alpine
# ffmpeg is used for voice/video processing (bundled now so offline installs already have it).
RUN apk add --no-cache ffmpeg tini && mkdir /data && chown node:node /data
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
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.js"]
