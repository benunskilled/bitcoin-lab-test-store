# Security

## Reporting a vulnerability

If you find a security issue in Peer Map, please report it privately through **Security → Report a vulnerability** in this repository.

Include the affected version, steps to reproduce the issue and its potential impact. Please leave out passwords, RPC credentials and other private information.

## Supported versions

Security fixes are provided for the latest release. Please update before checking whether an issue still occurs.

## Access to your node

Peer Map reads Bitcoin Core's peer list over RPC (`getpeerinfo` only) and changes nothing: it makes no write calls, and its dashboard only shows information. If Bitcoin Lab runs on the same node, Peer Map also reads its block information over the local network.

Locations and network providers are looked up in databases bundled with the app, so no peer address is sent to an outside service. Your node's own place on the map is looked up the same way, from the address its peers see. Only the region is shown.

On Umbrel, the app proxy handles dashboard authentication. The dashboard has no login of its own, so anyone who reaches its internal port directly can see your peer list.

## Other reports

For ordinary bugs, display issues or wrong locations, please open a GitHub issue. Report problems in Bitcoin Core, Bitcoin Lab or Umbrel to their respective maintainers.
