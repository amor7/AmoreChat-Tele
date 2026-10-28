# The AmoreChat image from its two release parts: the runtime (Node.js, ffmpeg, libraries)
# that is already on the server, plus this folder's app code. Builds with no network at all.
ARG RUNTIME=latest
FROM amorechat-runtime:${RUNTIME}
COPY . /app/
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 NODE_NO_WARNINGS=1
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.js"]
