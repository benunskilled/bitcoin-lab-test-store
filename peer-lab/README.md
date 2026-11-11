# Peer Lab

A new Umbrel app replacing Bitcoin Lab and Peer Map, with one installation,
one origin and the full feature set of both. App ID: `bltest-peerlab`.
Host port: **8796**. Bitcoin Node is the only app dependency.

## Status

This is a source/build candidate, not a published store release. The two existing
store entries remain available until the replacement passes an Umbrel migration
and release check. The candidate manifest is staged under `umbrel/`; it must not
be copied to the store root with the development image reference.

## Included

| Area | Preserved capabilities |
| --- | --- |
| Delivery | First/Eligible rankings, history, high-bandwidth marks, mining-pool attribution, live events |
| Peers & Map | World/region filters, ASN/provider information, inbound/outbound/manual grouping, behavioural classification and explanations, hidden-network counts, Tor exits |
| Block route | First delivery, estimated peer hop, Core/template timing, own-pool job, route medians and compact-block reconstruction |
| Manual peers | Add/probe/remove/disconnect, saved selection, locks, restoration after Core restart |
| Slot Fill | Region/provider diversity, free-slot filling, offline retirement, event log; off on fresh installs |
| Stratum Race | Local-pool discovery, custom pools, public pools, timing, misses and history; off on fresh installs |
| Data | Daily/weekly/monthly traffic, storage accounting, separate history resets, persistent SQLite, worker health, Umbrel traffic widget |

The navigation combines the two interfaces without an iframe. Peer links stay
on the same origin and carry the selected address between map and ranking.
The dashboard serves the map at `/map/` through a read-only internal proxy;
dashboard mutations retain their original CSRF/source checks. No Docker socket
is mounted. Location and classifier data remain local.

## Source and architecture

`lab/` and `map/` contain complete source snapshots with tests and bundled data.
Exact upstream commits are recorded in `UPSTREAM.json`. The Node module keeps
the existing database schema, collection workers and timing methods; the Go
module keeps the geographic lookup, classifications and map. One image contains
both and runs five separately monitored services:

- dashboard (UI, API, SSE, map proxy)
- peer-profiler (observations, saved peers, Slot Fill)
- relay-profiler (ZMQ and delivery measurements)
- stratum-race (pool connections and timing)
- peer-map (stateless, read-only map/classification service)

In write mode, workers refuse to start when the old Bitcoin Lab dashboard responds. Every
15 seconds they check again and shut down if it returns. This is a safeguard,
not atomic coordination with the old app: keep the old app stopped throughout
the cutover. The dashboard stays available when workers are blocked.

## Test-store mode

The staged test package sets `LAB_READ_ONLY=1` for all four Node services, like
the existing test app. It can run alongside the production apps in that mode.
Manual-peer mutations and Slot Fill remain disabled; map, collection, rankings,
traffic, history and Stratum Race are available. To test peer mutations, stop
all other peer managers first and explicitly set `LAB_READ_ONLY=0` in all four
Node services, then restart the app. Data is independent.

## Build and test

Requirements: Node 22 or newer, Go matching `map/go.mod`, Docker with Compose
for the complete container build. No live Bitcoin Node is needed for unit tests.

```sh
cd peer-lab/lab
npm ci
PEER_MAP_DIR=../map npm test
cd ../map
go test ./...
cd ..
docker compose -f compose.dev.yml build dashboard
docker compose -f compose.dev.yml up -d
```

Set the `APP_BITCOIN_*` RPC credentials, host, ports and network for a local
deployment; `compose.dev.yml` binds the UI only to `127.0.0.1:8792`. Production
uses Umbrel's authenticated app proxy. Do not publish the development port to
an untrusted network. Existing configuration variables remain documented in
`lab/docs/configuration.md`.

## Migration

See [MIGRATION.md](MIGRATION.md). Import is explicit, offline and non-destructive.
The tool refuses existing destination data, verifies SQLite integrity and
preserves all tables/settings except stale worker heartbeats. Peer Map has no
persistent data to import. Browser-local UI preferences are not migrated to the
new port; they can be selected again.

## Release

For this test repository, run **Publish Peer Lab test build** after the source
has been pushed. It runs the test/build gates, publishes a uniquely versioned
multi-arch test image, smoke-tests both architectures, verifies anonymous public
pull access, then creates `bltest-peerlab/` with the exact digest. Its commit
is made as `github-actions[bot]`.

The first new GHCR package may need to be made public in GitHub package settings
before anonymous verification can pass. Until that succeeds, the workflow does
not create an installable store listing. The promotion helper currently refuses
an existing listing; subsequent release updates require an explicit reviewed
update of that listing.

The `Peer Lab CI` workflow tests both modules and builds the combined image for
amd64 and arm64 without publishing it. After reviewing a green build and testing
the cutover on Umbrel:

1. Build and publish `ghcr.io/benunskilled/peer-lab:0.1.0-test.1` for both architectures
   from this directory, with `VERSION=0.1.0`.
2. Obtain the published multi-architecture index digest, make the package public,
   then run `python3 peer-lab/prepare-store.py IMAGE:TAG@sha256:DIGEST` from the
   repository root. It checks the real public registry before adding the entry.
3. Review the generated `bltest-peerlab/` files, add current screenshots,
   run the store checks, and commit the new entry.
4. Keep the old apps available during migration. Retire their listings only
   after the new install, upgrade, migration and rollback checks pass.

This candidate does not change or stop any installed app, publish an image, or
remove the old store entries automatically.

## Licensing

Both source modules are MIT licensed; their original `LICENSE` files are retained.
DB-IP geographic/ASN data is CC BY 4.0, Natural Earth map data is public domain.
Bundled mining-pool and Tor-exit data retain their source documentation and
attributions. See `map/geo/SOURCE.md`, `map/asn/SOURCE.md`, `map/torexit/SOURCE.md`
and `lab/src/data/`.
