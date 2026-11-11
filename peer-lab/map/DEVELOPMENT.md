# Peer Map development

[Back to the README](README.md).

## Try it without a node

From a checkout of this repository, with Go installed:

```sh
PEERMAP_MOCK=1 go run .
```

Open `http://localhost:8789`. Demo mode is labelled on the page and uses only
documentation IP addresses (RFC 5737 and RFC 3849).

## Configuration

Umbrel supplies the Bitcoin Core connection settings automatically.

| Variable | Purpose |
|---|---|
| `APP_BITCOIN_NODE_IP` | Bitcoin Core RPC host |
| `APP_BITCOIN_RPC_PORT` | Bitcoin Core RPC port |
| `APP_BITCOIN_RPC_USER` | RPC username |
| `APP_BITCOIN_RPC_PASS` | RPC password |
| `PEERMAP_PORT` | App HTTP port; defaults to `8789` inside the container |
| `PEERMAP_MOCK=1` | Use demo data instead of connecting to Core |

## Development and tests

Run unit tests:

```sh
go test ./...
```

With `bitcoind` on your `PATH`, run the Core integration test:

```sh
go test -tags integration -run TestAgainstBitcoinCore -v -count=1 .
```

The integration test starts four regtest nodes and checks that real manual,
inbound and outbound connections appear in the correct groups.

### Resource measurements

For a look at how lightweight the app can be, these measurements were taken
on x86-64 Linux with v0.2.0 and a mock RPC server returning 200 peers with random
public addresses. Figures vary with the release and workload.

| Measurement | Result |
|---|---|
| Binary size | 46.4 MB, including 39.7 MB of location and network tables |
| Idle for 20 seconds, no dashboard open | 6.3 MB RSS; 0 ms measured CPU time |
| 70 dashboard requests over 35 seconds | 21.4 MB RSS; 50 ms CPU time |
| Simulated 24 hours, 8,640 refreshes | Heap: 513 KB before, 511 KB after |
| Region lookup | About 39 ns, no allocation |
| Operator lookup | About 30 ns, no allocation |

The data tables are searched in place. Of the 21.4 MB RSS in the request test,
16.7 MB consisted of table pages the operating system could reclaim.
