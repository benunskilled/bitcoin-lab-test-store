# The build stage runs on the build machine's own architecture and
# cross-compiles, so the arm64 image needs no QEMU to build - Go does it
# natively with CGO off. The result is one static binary with the dashboard,
# the world map and the region and network tables embedded.
# The Go release is the one go.mod names, pinned by digest - the multi-arch
# index, so this stage resolves on any build machine - like the images the
# store pins. toolchain_test.go keeps the two in step.
FROM --platform=$BUILDPLATFORM golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY geo ./geo
COPY asn ./asn
COPY torexit ./torexit
COPY web ./web
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.Version=${VERSION}" -o /out/peermap .

# Nothing but the binary: no shell, no package manager, no libc. It talks
# plain HTTP to Bitcoin Core on the local Docker network, so it needs no CA
# certificates either.
FROM scratch
COPY --from=build /out/peermap /peermap
USER 1000:1000
EXPOSE 8789
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/peermap", "healthcheck"]
ENTRYPOINT ["/peermap"]
