#!/usr/bin/bash
# build every kernel target with ddk in host mode, then sanity check the output
set -uo pipefail

TARGETS=${TARGETS:-$(ls /opt/ddk/src 2>/dev/null)}
[ -n "$TARGETS" ] || { echo "!! no ddk targets found (is /opt/ddk installed?)" >&2; exit 1; }

fail=0

for ver in $TARGETS; do
	echo "== build $ver"
	if ! echo "make" | ddk shell "$ver"; then
		echo "!! build failed: $ver" >&2
		fail=1
		continue
	fi

	ko="out/$ver/lkmloader.ko"
	if [ ! -s "$ko" ]; then
		echo "!! missing output: $ko" >&2
		fail=1
		continue
	fi

	h=$(od -An -tx1 -N20 "$ko" 2>/dev/null | tr -d ' \n')
	case "$h" in
	7f454c46*) ;;
	*)
		echo "!! not an ELF file: $ko" >&2
		fail=1
		continue
		;;
	esac
	[ "$(printf %s "$h" | cut -c9-10)" = "02" ] || { echo "!! not ELF64: $ko" >&2; fail=1; continue; }
	[ "$(printf %s "$h" | cut -c33-34)" = "01" ] || { echo "!! not ET_REL: $ko" >&2; fail=1; continue; }

	echo "   ok $(wc -c <"$ko" | tr -d ' ') bytes"
done

[ "$fail" = 0 ] || { echo "!! some targets failed" >&2; exit 1; }
echo "build all done"
