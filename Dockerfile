# The model bridge: Node, the Claude Agent SDK at the release that
# package-lock.json pins, and the bridge. No secret and no config is in the
# image: the keys and the sign-in of the plan come as env vars at run time.
FROM docker.io/library/node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="tnwks-model-bridge" \
      org.opencontainers.image.description="A Messages API service that runs each conversation through the Claude Agent SDK" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

WORKDIR /app
COPY package.json package-lock.json ./
# Exact versions from the lock file. The native engine of the SDK comes from
# its optional package for this platform.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force && rm -rf /root/.npm
COPY src/ ./src/

# The root file system can be read-only: the bridge writes only under /tmp,
# which the manifest mounts as an empty dir.
ENV NODE_ENV=production \
    HOME=/tmp \
    BRIDGE_VERSION=${VERSION} \
    BRIDGE_PORT=8080
USER 65532:65532
EXPOSE 8080
CMD ["node", "src/bridge.mjs"]
