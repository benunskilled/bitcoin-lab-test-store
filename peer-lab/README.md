# Peer Lab test builds

Peer Lab's code lives in [benunskilled/peer-lab](https://github.com/benunskilled/peer-lab).
This folder holds only the store entry template (`umbrel/`) and
`prepare-store.py`, which pins the verified image into it.

**Publish Peer Lab test build** (GitHub Actions) takes a commit of
benunskilled/peer-lab whose CI is green, builds the image for amd64 and arm64,
runs it on both, checks that it can be pulled publicly and then commits
`bltest-peerlab/` with the exact digest.
