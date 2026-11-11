# Move to Peer Lab

The new app uses its own ID, port and data directory. It does not depend on the
old apps being installed. Do not uninstall Bitcoin Lab until you have verified
the imported history and saved configuration: uninstalling may remove its data.

## Before migration

1. Back up the existing Bitcoin Lab data with your normal backup procedure.
2. Record custom environment settings, if any. They are outside SQLite and must
   also be applied to Peer Lab; do not publish RPC credentials in Git.
3. Stop Bitcoin Lab through Umbrel. Stop all Peer Lab services if already started.
   Keep Bitcoin Node running. Stop Peer Map as part of the cutover too.
4. Locate the old `bitcoinlab-node/data/sqlite/bitcoinlab.db` and new
   `bltest-peerlab/data/` directories on your installation. Paths depend on
   your Umbrel installation; do not assume a fixed host root.

## Copy and verify

The destination database must not exist. If Peer Lab has already created data,
back up and move that entire new data directory aside while it is stopped, then
create an empty target owned by UID/GID 1000. The import never overwrites it.

Run the migration using the built/released Peer Lab image, substituting the two
absolute data paths. The old directory is mounted read-only. This command runs
only the import script, not the application workers:

```sh
docker run --rm --user 1000:1000 --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -v /ABSOLUTE/OLD/data:/legacy:ro \
  -v /ABSOLUTE/NEW/data:/data \
  peer-lab:dev \
  node scripts/migrate-peer-lab.js \
  /legacy/sqlite/bitcoinlab.db /data/sqlite/bitcoinlab.db --confirm-stopped
```

For a published image replace `peer-lab:dev` with its exact tag and digest.
`--confirm-stopped` confirms the operator has stopped both installations; the
script does not control Docker and cannot independently enforce that condition.
It uses SQLite's backup API so committed WAL records are included, validates the
database, and atomically publishes it without replacing an existing file. A
read-only WAL source must include its existing sidecars and be readable by UID
1000; do not copy only the `.db` file out of a running installation.

Saved peers (including locks/offline peers), pool settings, toggles, measurements,
traffic and logs remain intact. Old worker heartbeats are removed. Fresh installs
keep the upstream defaults; imports preserve the operator's previous toggles.

## Start and accept

Start Peer Lab only. Check:

- all five containers healthy; workers are not blocked by the legacy guard;
- history, traffic, own pools, manual peers and locks match the old app;
- map, classifications, filters and peer links work at the new origin;
- a new real block produces delivery data and the map's block route;
- enabled Stratum Race receives new jobs and enabled Slot Fill manages only its
  intended slots;
- the Umbrel widget and authenticated write controls work;
- Core restart restores the saved manual selection.

Test on both supported architectures before a public replacement release. The
unit/browser tests are not a substitute for an actual Umbrel cutover.

## Roll back

Stop Peer Lab completely, then start the old Bitcoin Lab and Peer Map apps.
Their data was not modified by the import. Measurements made only in Peer Lab
after the cutover are not copied back automatically. Never run both peer managers
at the same time. Keep a copy of Peer Lab's data if investigating a rollback.
