#!/bin/sh
# Install the standalone vigent: one binary with its runtime inside, so the
# machine needs git but no Node.
#
#   curl -fsSL https://raw.githubusercontent.com/farming-labs/vigent/main/install.sh | sh
#
# It downloads the archive for this machine from the GitHub release, checks it
# against the release's SHA256SUMS, puts vigent and riftri in ~/.vigent and
# links `vigent` into ~/.local/bin.
#
# A machine that already has Node 20 or newer gets the small build instead: the
# same vigent as one JavaScript file that Node runs, about 2 MB to download
# where the binary is about 50.
#
#   VIGENT_BUILD=binary      the binary, even with Node here (or: node, to insist on the small build)
#   VIGENT_VERSION=0.9.3     install that version instead of the latest
#   VIGENT_INSTALL=<dir>     where the files go (default ~/.vigent)
#   VIGENT_BIN_DIR=<dir>     where the `vigent` link goes (default ~/.local/bin)
#   VIGENT_TARGET=<target>   skip detection (linux-x64, linux-arm64-musl, darwin-arm64, ...)
#   VIGENT_DOWNLOAD_BASE=<url>  download from here instead of the GitHub release
set -eu

REPO="farming-labs/vigent"
INSTALL="${VIGENT_INSTALL:-$HOME/.vigent}"
BIN_DIR="${VIGENT_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'vigent install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

detect_target() {
	os="$(uname -s)"
	arch="$(uname -m)"
	case "$arch" in
		x86_64 | amd64) arch=x64 ;;
		arm64 | aarch64) arch=arm64 ;;
		*) fail "no binary for $arch yet; with Node 20 or newer: npm install -g @vigent/cli" ;;
	esac
	case "$os" in
		Darwin)
			# a terminal under Rosetta says x86_64 on Apple silicon
			if [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
			echo "darwin-$arch"
			;;
		Linux)
			suffix=""
			if ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 || true) | grep -qi musl; then
				suffix="-musl"
			elif [ "$arch" = x64 ] && [ -r /proc/cpuinfo ] && ! grep -qw avx2 /proc/cpuinfo; then
				# an older CPU: the build that doesn't need AVX2
				suffix="-baseline"
			fi
			echo "linux-$arch$suffix"
			;;
		*) fail "no binary for $os here; on Windows use WSL, or with Node 20 or newer: npm install -g @vigent/cli" ;;
	esac
}

download() {
	case "$1" in
		file://*) cp "${1#file://}" "$2"; return ;;
	esac
	if have curl; then curl -fsSL "$1" -o "$2"
	elif have wget; then wget -qO "$2" "$1"
	else fail "needs curl or wget"
	fi
}

sha256() {
	if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
	elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
	else fail "needs sha256sum or shasum to check the download"
	fi
}

# Node 20 or newer on PATH?
node_ok() {
	have node && [ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 20' 2>/dev/null || true)" = true ]
}

have tar || fail "needs tar"
target="${VIGENT_TARGET:-$(detect_target)}"
case "${VIGENT_BUILD:-auto}" in
	binary) build=binary ;;
	node) node_ok || fail "VIGENT_BUILD=node needs Node 20 or newer on your PATH"; build=node ;;
	auto) if node_ok; then build=node; else build=binary; fi ;;
	*) fail "VIGENT_BUILD is binary or node, not '$VIGENT_BUILD'" ;;
esac
if [ "$build" = node ]; then
	# the JavaScript is the same on an older CPU; -baseline is about the binary's runtime
	name="vigent-${target%-baseline}-node"
	program="vigent.mjs"
	other="vigent"
else
	name="vigent-$target"
	program="vigent"
	other="vigent.mjs"
fi
archive="$name.tar.gz"
if [ -n "${VIGENT_DOWNLOAD_BASE:-}" ]; then base="$VIGENT_DOWNLOAD_BASE"
elif [ -n "${VIGENT_VERSION:-}" ]; then base="https://github.com/$REPO/releases/download/v${VIGENT_VERSION#v}"
else base="https://github.com/$REPO/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "downloading $archive"
download "$base/$archive" "$tmp/$archive" || fail "couldn't download $base/$archive"
download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "couldn't download $base/SHA256SUMS"

want="$(grep " $archive\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 || true)"
[ -n "$want" ] || fail "SHA256SUMS has no line for $archive"
got="$(sha256 "$tmp/$archive")"
[ "$want" = "$got" ] || fail "checksum mismatch for $archive (expected $want, got $got); nothing was installed"

tar -xzf "$tmp/$archive" -C "$tmp"
[ -f "$tmp/$name/$program" ] || fail "$archive has no $program in it"

mkdir -p "$INSTALL" "$BIN_DIR"
for f in "$program" riftri README.md LICENSE; do
	[ -f "$tmp/$name/$f" ] || continue
	# over a running vigent too: the old file is replaced, not written into
	cp "$tmp/$name/$f" "$INSTALL/.$f.new"
	mv -f "$INSTALL/.$f.new" "$INSTALL/$f"
done
chmod 755 "$INSTALL/$program"
[ -f "$INSTALL/riftri" ] && chmod 755 "$INSTALL/riftri"
# the other build, from an earlier install, would only go stale
rm -f "$INSTALL/$other"
ln -sf "$INSTALL/$program" "$BIN_DIR/vigent"

if ! version="$("$INSTALL/$program" --version 2>&1)"; then
	case "$target" in
		*musl) fail "installed in $INSTALL, but vigent doesn't start; on Alpine it needs: apk add libstdc++ libgcc" ;;
		*) fail "installed in $INSTALL, but vigent doesn't start: $version" ;;
	esac
fi
say "installed $version in $INSTALL"
[ "$build" = node ] && say "this is the small build, run by your Node $(node -p process.versions.node); VIGENT_BUILD=binary installs the one that needs no Node"
have git || say "note: vigent needs git, and it isn't on your PATH"
case ":$PATH:" in
	*":$BIN_DIR:"*) say "run: vigent" ;;
	*) say "add $BIN_DIR to your PATH, then run: vigent"
	   say "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
