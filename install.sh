#!/bin/sh
# Install the standalone vigent: a binary that needs git on the machine, and no
# Node.
#
#   curl -fsSL https://raw.githubusercontent.com/farming-labs/vigent/main/install.sh | sh
#
# It downloads the archive for this machine from the GitHub release, checks it
# against the release's SHA256SUMS, puts it in ~/.vigent and links `vigent`
# into ~/.local/bin.
#
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

have tar || fail "needs tar"
target="${VIGENT_TARGET:-$(detect_target)}"
archive="vigent-$target.tar.gz"
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
[ -f "$tmp/vigent-$target/vigent" ] || fail "$archive has no vigent in it"

mkdir -p "$INSTALL" "$BIN_DIR"
for f in vigent riftri README.md LICENSE; do
	[ -f "$tmp/vigent-$target/$f" ] || continue
	# over a running vigent too: the old file is replaced, not written into
	cp "$tmp/vigent-$target/$f" "$INSTALL/.$f.new"
	mv -f "$INSTALL/.$f.new" "$INSTALL/$f"
done
chmod 755 "$INSTALL/vigent"
[ -f "$INSTALL/riftri" ] && chmod 755 "$INSTALL/riftri"
ln -sf "$INSTALL/vigent" "$BIN_DIR/vigent"

if ! version="$("$INSTALL/vigent" --version 2>&1)"; then
	case "$target" in
		*musl) fail "installed in $INSTALL, but vigent doesn't start; on Alpine it needs: apk add libstdc++ libgcc" ;;
		*) fail "installed in $INSTALL, but vigent doesn't start: $version" ;;
	esac
fi
say "installed $version in $INSTALL"
have git || say "note: vigent needs git, and it isn't on your PATH"
case ":$PATH:" in
	*":$BIN_DIR:"*) say "run: vigent" ;;
	*) say "add $BIN_DIR to your PATH, then run: vigent"
	   say "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
