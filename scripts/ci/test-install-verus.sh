#!/usr/bin/env bash
# Negative control for install-verus.sh: a tampered archive must be rejected
# before anything is extracted.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

head -c 65536 /dev/urandom > "$tmp/verus.zip"

if VERUS_SKIP_DOWNLOAD=1 VERUS_ZIP="$tmp/verus.zip" VERUS_DIR="$tmp/verus" \
	bash "$here/install-verus.sh" > "$tmp/out" 2>&1; then
	cat "$tmp/out" >&2
	echo "FAIL: install-verus.sh accepted a tampered verus.zip" >&2
	exit 1
fi

if [ -e "$tmp/verus" ]; then
	echo "FAIL: install-verus.sh extracted files from a tampered verus.zip" >&2
	exit 1
fi

if ! grep -q "checksum mismatch" "$tmp/out"; then
	cat "$tmp/out" >&2
	echo "FAIL: install-verus.sh failed, but not on the checksum" >&2
	exit 1
fi

echo "PASS: tampered verus.zip rejected"
