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

cp module.prop customize.sh post-fs-data.sh service.sh uninstall.sh hotinstall.sh "$STAGE"/
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
	"$STAGE/service.sh" "$STAGE/uninstall.sh" "$STAGE/hotinstall.sh"
chmod -R 0755 "$STAGE/common" "$STAGE/webroot"

mkdir -p dist
rm -f "dist/$NAME.zip"

# `zip` is missing on plenty of Windows shells, so fall back to python and keep
# the exec bits that the installer needs
make_zip() {
	src=$1
	out=$2
	if command -v zip >/dev/null 2>&1; then
		(cd "$src" && zip -r9 "$out" . -x '.*' >/dev/null)
		return
	fi

	py=
	for c in python3 python; do
		if command -v "$c" >/dev/null 2>&1; then
			py=$c
			break
		fi
	done
	[ -n "$py" ] || die "need zip or python3 to package"

	"$py" - "$src" "$out" <<'PY'
import os, stat, sys, zipfile

src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _dirs, files in os.walk(src):
        for name in files:
            full = os.path.join(root, name)
            arc = os.path.relpath(full, src).replace(os.sep, '/')
            exec_bit = name.endswith('.sh') or name == 'update-binary'
            info = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | (0o755 if exec_bit else 0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(full, 'rb') as fh:
                z.writestr(info, fh.read())
PY
}

make_zip "$(pwd)/$STAGE" "$(pwd)/dist/$NAME.zip"

# ------------------------------------------------------- verify the zip itself
need="module.prop customize.sh post-fs-data.sh service.sh uninstall.sh hotinstall.sh
webroot/index.html webroot/css/style.css webroot/js/app.js webroot/js/lkm.js
webroot/js/shell.js common/funcs.sh
META-INF/com/google/android/update-binary META-INF/com/google/android/updater-script"

listing=$(unzip -Z1 "dist/$NAME.zip" 2>/dev/null || python3 -c "
import sys, zipfile
print('\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))
" "dist/$NAME.zip")
[ -n "$listing" ] || die "cannot read back dist/$NAME.zip"
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
