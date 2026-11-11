# Peer Lab

One Umbrel app for your node's peers: where they are and what they are, which
of them brings new blocks first, Slot Fill for Core's manual slots, and Stratum
Race for mining pools. Test build, app ID `bltest-peerlab`, port **8796**.
Bitcoin Node is the only dependency.

The test build starts read-only (`LAB_READ_ONLY=1`): it never adds, removes or
disconnects Core's peers, so it can run next to other apps. It keeps its own
data and starts empty.

## Layout

- `lab/` – dashboard, measurements, Slot Fill, Stratum Race (Node)
- `map/` – world map and peer classification (Go), served under `/map/`
- `umbrel/` – the store entry the publish workflow fills in
- `Dockerfile` – one image for all five services

Settings: [lab/docs/configuration.md](lab/docs/configuration.md).

## Build and test

```sh
cd peer-lab/lab && npm ci && PEER_MAP_DIR=../map npm test
cd ../map && go test ./...
```

**Publish Peer Lab test build** (GitHub Actions) runs the tests, builds the
image for amd64 and arm64, checks that it can be pulled publicly and then
creates `bltest-peerlab/` with the exact digest.

## Licence

MIT. Geolocation and ASN data by DB-IP (CC BY 4.0), map data by Natural Earth
(public domain). Sources of the bundled data: `map/geo/SOURCE.md`,
`map/asn/SOURCE.md`, `map/torexit/SOURCE.md`, `lab/src/data/`.
