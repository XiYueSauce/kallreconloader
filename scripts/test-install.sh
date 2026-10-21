#!/usr/bin/bash
# offline check of the update path: an update unpacks into an empty staging
# directory, so customize.sh has to carry the user's data over by itself
set -uo pipefail

cd "$(dirname "$0")/.."

tmp=build/.test-install
rm -rf "$tmp"
mkdir -p "$tmp/old/ko" "$tmp/old/lkm" "$tmp/new/ko/android16-6.12" "$tmp/bin"
trap 'rm -rf "$tmp"' EXIT

# the module as it is installed today
printf '{"version":1,"modules":[{"name":"mhsrc"}]}\n' >"$tmp/old/config.json"
printf 'verbose=0\n' >"$tmp/old/ko/options"
printf 'OLD-KO\n' >"$tmp/old/ko/lkmloader.ko"
printf 'USER-KO\n' >"$tmp/old/lkm/mhsrc.ko"

# a freshly unpacked update
printf 'NEW-KO\n' >"$tmp/new/ko/android16-6.12/lkmloader.ko"
cp module.prop customize.sh hotinstall.sh "$tmp/new/"
cp -r common webroot META-INF "$tmp/new/"

# the KMI is derived from uname, so fake it to match the staged directory
printf '#!/bin/sh\necho 6.12.69-android16-6-gabc-4k\n' >"$tmp/bin/uname"
chmod +x "$tmp/bin/uname"

PATH="$tmp/bin:$PATH" MODPATH="$tmp/new" LKM_OLD_MODDIR="$tmp/old" \
	sh "$tmp/new/customize.sh" >"$tmp/out.txt" 2>&1

fail=0
chk() {
	if [ "$1" = "$2" ]; then
		echo "ok  $3"
	else
		echo "!! $3" >&2
		echo "   got  [$1]" >&2
		echo "   want [$2]" >&2
		fail=1
	fi
}

chk "$(cat "$tmp/new/config.json" 2>/dev/null)" '{"version":1,"modules":[{"name":"mhsrc"}]}' "config.json carried over"
chk "$(cat "$tmp/new/ko/options" 2>/dev/null)" 'verbose=0' "ko/options carried over"
chk "$(cat "$tmp/new/lkm/mhsrc.ko" 2>/dev/null)" 'USER-KO' "imported .ko carried over"
chk "$(cat "$tmp/new/ko/lkmloader.prev.ko" 2>/dev/null)" 'OLD-KO' "previous loader kept for rollback"
chk "$(cat "$tmp/new/ko/lkmloader.ko" 2>/dev/null)" 'NEW-KO' "new loader selected for the kernel"

if grep -q '^export MODULE_HOT_INSTALL_REQUEST=true$' "$tmp/new/customize.sh"; then
	echo "ok  hot install requested"
else
	echo "!! hot install flag missing" >&2
	fail=1
fi

if [ "$fail" = 0 ]; then
	echo "install test passed"
else
	echo "install test failed" >&2
fi
exit "$fail"
