#!/usr/bin/bash
# assemble the flashable module zip from out/<target>/lkmloader.ko
#
#   ./scripts/package.sh                 package whatever is in out/, all verified
#   TARGETS="android14-6.1 android16-6.12" ./scripts/package.sh
#                                        require exactly those targets
set -euo pipefail

cd "$(dirname "$0")/.."

VER=$(sed -n 's/^version=//p' module.prop)
NAME=lkmloader-$VER
STAGE=build/$NAME
TARGETS=${TARGETS:-}

die() { echo "!! $*" >&2; exit 1; }

# ELF64 relocatable object, arm64 (or x86_64) machine, non trivial size
verify_ko() {
	ko=$1
	[ -s "$ko" ] || die "empty ko: $ko"
	sz=$(wc -c <"$ko" | tr -d ' ')
	[ "$sz" -gt 4096 ] || die "suspiciously small ko: $ko ($sz bytes)"

	h=$(od -An -tx1 -N20 "$ko" | tr -d ' \n')
	case "$h" in
	7f454c46*) ;;
	*) die "not an ELF file: $ko" ;;
	esac
	[ "$(printf %s "$h" | cut -c9-10)" = "02" ] || die "not ELF64: $ko"
	[ "$(printf %s "$h" | cut -c33-34)" = "01" ] || die "not ET_REL (not a module): $ko"
	mach=$(printf %s "$h" | cut -c37-40)
	case "$mach" in
	b700 | 3e00) ;;
	*) die "unexpected ELF machine 0x$mach: $ko" ;;
	esac
	# vermagic must be present, otherwise it is not a kernel module.
	# anchor the pattern: a loose grep also matches "ignore_vermagic=%d"
	vm=$(strings -a "$ko" 2>/dev/null | grep -m1 '^vermagic=')
	if [ -z "$vm" ]; then
		vm=$(grep -a -o 'vermagic=[0-9][^ ]*' "$ko" 2>/dev/null | head -n1)
	fi
	case "$vm" in
	vermagic=*) ;;
	*) die "no vermagic in $ko" ;;
	esac
}

rm -rf "$STAGE"
mkdir -p "$STAGE"

cp module.prop customize.sh post-fs-data.sh service.sh uninstall.sh "$STAGE"/
cp -r common webroot "$STAGE"/
mkdir -p "$STAGE/META-INF/com/google/android"
cp META-INF/com/google/android/update-binary "$STAGE/META-INF/com/google/android/"
cp META-INF/com/google/android/updater-script "$STAGE/META-INF/com/google/android/"

mkdir -p "$STAGE/ko"
found=0

if [ -n "$TARGETS" ]; then
	for kmi in $TARGETS; do
		ko="out/$kmi/lkmloader.ko"
		[ -f "$ko" ] || die "missing build output: $ko"
		verify_ko "$ko"
		mkdir -p "$STAGE/ko/$kmi"
		cp "$ko" "$STAGE/ko/$kmi/lkmloader.ko"
		echo "  + $kmi"
		found=$((found + 1))
	done
else
	for d in out/*/; do
		[ -f "$d/lkmloader.ko" ] || continue
		kmi=$(basename "$d")
		verify_ko "$d/lkmloader.ko"
		mkdir -p "$STAGE/ko/$kmi"
		cp "$d/lkmloader.ko" "$STAGE/ko/$kmi/lkmloader.ko"
		echo "  + $kmi"
		found=$((found + 1))
	done
fi

[ "$found" -gt 0 ] || die "no lkmloader.ko in out/, run ./build-all.sh first"

chmod 0755 "$STAGE/customize.sh" "$STAGE/post-fs-data.sh" \
	"$STAGE/service.sh" "$STAGE/uninstall.sh"
chmod -R 0755 "$STAGE/common" "$STAGE/webroot"

mkdir -p dist
rm -f "dist/$NAME.zip"
(cd "$STAGE" && zip -r9 "../../dist/$NAME.zip" . -x '.*' >/dev/null)

# ------------------------------------------------------- verify the zip itself
need="module.prop customize.sh post-fs-data.sh service.sh uninstall.sh
webroot/index.html webroot/css/style.css webroot/js/app.js webroot/js/lkm.js
webroot/js/shell.js common/funcs.sh
META-INF/com/google/android/update-binary META-INF/com/google/android/updater-script"

listing=$(unzip -Z1 "dist/$NAME.zip")
for f in $need; do
	case "$listing" in
	*"$f"*) ;;
	*) die "zip is missing $f" ;;
	esac
done
case "$listing" in
*ko/*/lkmloader.ko*) ;;
*) die "zip contains no ko payload" ;;
esac

echo "packaged dist/$NAME.zip ($found kernel targets, $(wc -c <"dist/$NAME.zip" | tr -d ' ') bytes)"
