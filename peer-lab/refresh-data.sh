#!/bin/sh
# Rebuild Peer Lab's three IP tables from ONE download of DB-IP's Lite
# databases (CC BY 4.0, https://db-ip.com, via the `latest` release of
# sapics/ip-location-db - not npm, see the SOURCE files):
#
#   peers/asn/asn.bin          operator  (peer list, map)        asn/SOURCE.md
#   peers/geo/geo.bin          region    (map)                   geo/SOURCE.md
#   app/src/data/network.bin   operator + country (dashboard)    src/data/NETWORK.md
#
# Built separately they came from different days, and the same peer could
# show one operator in the list and another under the manual peers. Run from
# peer-lab/; it prints each database's build date for the three .md files,
# then runs the tests that check the tables against the source databases.
#
#   sh refresh-data.sh            needs python3, go, node; ~150 MB download
set -eu
cd "$(dirname "$0")"
work=$(mktemp -d "${TMPDIR:-/tmp}/peerlab-data.XXXXXX")
trap 'rm -rf "$work"' EXIT

python3 -m venv "$work/venv"
"$work/venv/bin/pip" install -q maxminddb pycountry-convert
py="$work/venv/bin/python"

base=https://github.com/sapics/ip-location-db/releases/download/latest
for f in dbip-asn-ipv4 dbip-asn-ipv6 dbip-country-ipv4 dbip-country-ipv6 dbip-city-ipv4 dbip-city-ipv6; do
  curl -fsSL -o "$work/$f.mmdb" "$base/$f.mmdb"
done

echo "Database builds:"
for f in "$work"/*.mmdb; do
  "$py" -c 'import sys, maxminddb, datetime
m = maxminddb.open_database(sys.argv[1]).metadata()
print("  %-24s %s" % (sys.argv[1].rsplit("/", 1)[1], datetime.datetime.fromtimestamp(m.build_epoch, datetime.timezone.utc).date()))' "$f"
done

# Both generators write their test vectors relative to peers/.
(cd peers && "$py" tools/genasn.py "$work/dbip-asn-ipv4.mmdb" "$work/dbip-asn-ipv6.mmdb" asn/asn.bin)
(cd peers && "$py" tools/gengeo.py "$work/dbip-city-ipv4.mmdb" "$work/dbip-city-ipv6.mmdb" geo/geo.bin)
(cd app && "$py" scripts/gennet.py "$work" src/data/network.bin test/data/network-vectors.json)

(cd peers && go test ./asn/ ./geo/)
(cd app && node --test test/network.test.js)
echo "Now put the build dates and counts above into the three .md files."
