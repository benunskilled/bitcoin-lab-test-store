#!/usr/bin/env python3
"""Promote a candidate only after the public multi-arch image is verified."""
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: prepare-store.py ghcr.io/OWNER/peer-lab:VERSION@sha256:DIGEST')
    image = sys.argv[1]
    match = re.fullmatch(r'ghcr\.io/[a-z0-9._-]+/peer-lab:([A-Za-z0-9._-]+)@sha256:[0-9a-f]{64}', image)
    if not match:
        raise SystemExit('A pinned Peer Lab multi-architecture image is required.')
    project = pathlib.Path(__file__).resolve().parent
    root = project.parent
    destination = root / 'bltest-peerlab'
    with tempfile.TemporaryDirectory(prefix='peerlab-release-', dir=root) as temporary:
        package = pathlib.Path(temporary) / 'bltest-peerlab'
        shutil.copytree(project / 'umbrel' / 'bltest-peerlab', package)
        compose = package / 'docker-compose.yml'
        compose.write_text(compose.read_text().replace('image: peer-lab:dev', 'image: ' + image))
        manifest = (package / 'umbrel-app.yml').read_text()
        version = re.search(r'^version:\s*[\'"]?([^\s\'"]+)', manifest, re.M).group(1)
        if match[1] != version:
            raise SystemExit('Image tag must match the candidate manifest version.')
        subprocess.run(['sh', str(root / '.github/scripts/check-app.sh'), str(package)], check=True)
        # A later test build replaces the entry of the one before; what the app
        # stored is on the Umbrel, not here.
        if destination.exists():
            shutil.rmtree(destination)
        shutil.move(str(package), destination)
    print('Verified package created at bltest-peerlab/. Review before publishing the store update.')


if __name__ == '__main__':
    main()
