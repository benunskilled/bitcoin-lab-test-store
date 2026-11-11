# Candidate validation

Validated locally on 11 November 2026:

- 420 JavaScript tests pass (0 failures, 0 skips), including the original
  measurement, peer management, CSRF, read-only and database tests.
- Added tests cover read-only map proxying, credential stripping, upstream
  failures, migration preserving table contents/settings/locks/history, refusal
  to overwrite destination data, and the legacy-worker guard including test mode.
- Go tests pass in the map, geographic, ASN and Tor-exit packages.
- The Go binary builds successfully.
- Both real HTTP modules pass the cross-module smoke test with synthetic peers:
  shared origin, map API, internal measurement linkage, assets, navigation
  targets and traffic widget. No live node or peer writes were used.
- Test-store manifest and Compose YAML parse; ID `bltest-peerlab`, port 8796,
  scoped service names and read-only mode on all four Node services verified.
- JavaScript syntax checks and Git whitespace checks pass.

Still required before calling this an installed, validated Umbrel release:

- Combined Docker image build and amd64/arm64 runtime checks (workflow provided;
  Docker is not available in the authoring environment).
- Actual browser rendering/navigation on desktop and mobile. Browser execution
  was blocked by the authoring environment; HTTP checks do not establish visual QA.
- Fresh install and stopped-source migration on a real Umbrel, with live Core,
  ZMQ, pool discovery, authenticated writes and the widget.
- Explicit write-mode test with all other peer managers stopped, then rollback.

No registry image was published and no installed app or production-store entry
was changed during local validation.
