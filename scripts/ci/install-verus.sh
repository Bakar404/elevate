#!/usr/bin/env bash
# Downloads the Verus release pinned in verus.lock, checks its sha256 and
# unzips it. Prints the directory that holds the verus binary.
#
#   bash scripts/ci/install-verus.sh
#
# VERUS_ZIP (default $RUNNER_TEMP/verus.zip) is where the archive goes,
# VERUS_DIR (default $HOME/verus) is where it is unzipped, and
# VERUS_SKIP_DOWNLOAD=1 checks and unzips an existing VERUS_ZIP.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=verus.lock
. "$here/verus.lock"

zip="${VERUS_ZIP:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/verus.zip}"
dir="${VERUS_DIR:-$HOME/verus}"

if [ "${VERUS_SKIP_DOWNLOAD:-0}" != "1" ]; then
	if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
		echo "error: verus.lock only pins the Linux x86_64 release, not $(uname -s)-$(uname -m)" >&2
		exit 1
	fi
	echo "Downloading Verus $VERUS_VERSION to $zip" >&2
	curl -fsSL --retry 3 -o "$zip" "$VERUS_URL_LINUX_X86_64"
fi

if [ ! -f "$zip" ]; then
	echo "error: $zip does not exist" >&2
	exit 1
fi

if ! echo "$VERUS_SHA256_LINUX_X86_64  $zip" | sha256sum -c - >&2; then
	echo "error: checksum mismatch for $zip: expected sha256 $VERUS_SHA256_LINUX_X86_64 (Verus $VERUS_VERSION, scripts/ci/verus.lock). Refusing to install." >&2
	exit 1
fi

mkdir -p "$dir"
unzip -q -o "$zip" -d "$dir"
bin="$(dirname "$(find "$dir" -name verus -type f | head -1)")"
echo "Installed Verus $VERUS_VERSION to $bin" >&2
echo "$bin"
