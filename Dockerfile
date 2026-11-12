# The model bridge: Node, the Claude Agent SDK at the release that
# package-lock.json pins, and the bridge. The service itself comes in the
# next change; this image holds the SDK and the pure parts only. No secret and no config is in the
# image: the keys and the sign-in of the plan come as env vars at run time.
FROM docker.io/library/node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0

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
