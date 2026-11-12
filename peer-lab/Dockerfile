# The build stage runs on the build machine's own architecture and
# cross-compiles, so the arm64 image needs no QEMU to build - Go does it
# natively with CGO off. The result is one static binary with the dashboard,
# the world map and the region and network tables embedded.
# The Go release is the one go.mod names, pinned by digest - the multi-arch
# index, so this stage resolves on any build machine - like the images the
# store pins. toolchain_test.go keeps the two in step.
FROM --platform=$BUILDPLATFORM golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS peers-build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY peers/go.mod ./
COPY peers/*.go ./
COPY peers/geo ./geo
COPY peers/asn ./asn
COPY peers/torexit ./torexit
COPY peers/web ./web
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.Version=${VERSION}" -o /out/peers .


# Debian slim (glibc) rather than Alpine: the zeromq native bindings have
# far more reliable prebuilt binaries for glibc than for musl across both
# amd64 and arm64, which keeps this buildable without compiling libzmq
# from source in CI.
#
# Pinned by digest - the multi-arch index, so it resolves on amd64 and arm64
# alike - like everything the store pins: the same Dockerfile then builds from
# the same base on every run. The price is that base-image updates (Node and
# Debian security fixes) arrive only when this digest is moved on, together
# with the tag, as part of a release.

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS builder
WORKDIR /app

# Only needed as a fallback if a native dependency has no prebuilt binary
# for the target platform (e.g. under qemu emulation during multi-arch CI).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# `npm ci` rather than `npm install`, and no glob on the lockfile: this image
# is published under a tag+digest that the app store pins as "exactly this
# artifact", so the build has to actually be reproducible. The old
# `package-lock.json*` glob meant a missing lockfile still produced a happy
# build from whatever the registry served that day.
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Both native packages ship more than this image can ever load. zeromq
# includes a prebuilt binary for every platform it supports - Windows, macOS,
# and musl alongside glibc - and better-sqlite3 ships the SQLite C sources it
# was compiled from, which are a build input and nothing else. Since 13.0
# better-sqlite3 also bundles a prebuilt binary per platform (prebuilds/), so
# the same platforms go there too. This image is
# Debian (glibc) Linux and compiles nothing at runtime, so all of that is
# weight that can never be used.
#
# Only what provably cannot match is removed. Both linux/glibc architectures
# stay, because the same Dockerfile builds amd64 and arm64.
#
# Measured on a full install: node_modules 43MB -> 20MB, with the whole test
# suite still passing against the pruned tree.
RUN rm -rf node_modules/zeromq/build/win32 \
           node_modules/zeromq/build/darwin \
           node_modules/better-sqlite3/deps \
           node_modules/better-sqlite3/src \
           node_modules/better-sqlite3/prebuilds/darwin-* \
           node_modules/better-sqlite3/prebuilds/win32-* \
           node_modules/better-sqlite3/prebuilds/linuxmusl-* \
    && find node_modules/zeromq/build/linux -type d -name 'musl-*' -prune -exec rm -rf {} +

COPY app/src ./src

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY app/package.json ./

# The stock node:* image already ships a non-root "node" user at uid/gid
# 1000, matching what Umbrel expects to own ${APP_DATA_DIR}.
COPY --from=peers-build /out/peers /peers

RUN mkdir -p /data/sqlite && chown -R node:node /data

USER node

# Overridden per compose service (dashboard-server.js / peer-profiler.js /
# relay-profiler.js / stratum-race.js) via `command:`.
CMD ["node", "src/dashboard-server.js"]
