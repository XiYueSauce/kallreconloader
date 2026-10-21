#!/usr/bin/bash
# static checks that need no kernel toolchain:
#   - shell syntax of every script
#   - javascript syntax of the webui
#   - the shell config parser against a fixture written the way the webui
#     serializes it
set -uo pipefail

cd "$(dirname "$0")/.."
fail=0

note() { echo "-- $*"; }
bad() { echo "!! $*" >&2; fail=1; }

# --------------------------------------------------------------- shell syntax
for f in $(find . -name '*.sh' -not -path './.sdk/*' -not -path './deps/*' -not -path './build/*') \
	META-INF/com/google/android/update-binary; do
	sh -n "$f" || bad "shell syntax: $f"
done

# ------------------------------------------------------------------ js syntax
if command -v node >/dev/null 2>&1; then
	for f in webroot/js/*.js; do
		node --check "$f" || bad "js syntax: $f"
	done
	node scripts/test-webui.js || bad "webui tests"
else
	note "node not found, skipping javascript syntax"
fi

# ------------------------------------------------------------- html sanity
for f in webroot/index.html; do
	for ref in $(grep -o 'src="[^"]*"' "$f" | cut -d'"' -f2) \
		$(grep -o 'href="[^"]*\.css"' "$f" | cut -d'"' -f2); do
		case "$ref" in
		http*) continue ;;
		esac
		[ -f "webroot/$ref" ] || bad "$f references missing file: $ref"
	done
done

# ------------------------------------------------------- config parser fixture
tmp=build/.check-tmp
rm -rf "$tmp"
mkdir -p "$tmp/logs" "$tmp/lkm"
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/config.json" <<'EOF'
{
"version":1,
"defaultStage":"service",
"options":{"ignoreVermagic":false,"ignoreModversions":false,"strictSymbols":true,"verbose":true,"keepExported":true},
"modules":[
{"name":"alpha","path":"/data/adb/modules/lkmloader/lkm/alpha.ko","args":"","stage":"post-fs-data","enabled":true,"delay":0},
{"name":"beta-kmod","path":"/data/adb/modules/lkmloader/lkm/beta-kmod.ko","args":"log=1 debug=0","stage":"service","enabled":false,"delay":3}
]
}
EOF

got=$(LKM_MODDIR="$tmp" sh -c '. ./common/funcs.sh; lkm_entries | while IFS= read -r l; do
	printf "%s|%s|%s|%s|%s|%s\n" \
		"$(lkm_json_str "$l" name)" "$(lkm_json_str "$l" path)" \
		"$(lkm_json_str "$l" stage)" "$(lkm_json_bool "$l" enabled)" \
		"$(lkm_json_num "$l" delay)" "$(lkm_json_str "$l" args)"
done')

want='alpha|/data/adb/modules/lkmloader/lkm/alpha.ko|post-fs-data|1|0|
beta-kmod|/data/adb/modules/lkmloader/lkm/beta-kmod.ko|service|0|3|log=1 debug=0'

if [ "$got" != "$want" ]; then
	bad "config parser output differs:
--- got
$got
--- want
$want"
else
	note "config parser ok"
fi

# module name normalisation must treat - and _ as the same module
got=$(LKM_MODDIR="$tmp" sh -c '. ./common/funcs.sh; printf "%s\n" "$(lkm_mod_name lkmloader)"')
[ -z "$got" ] || bad "lkm_mod_name returned something for an unloaded module"

# --------------------------------------------------------------- webui assets
for f in module.prop customize.sh post-fs-data.sh service.sh uninstall.sh \
	META-INF/com/google/android/update-binary \
	webroot/index.html webroot/css/style.css webroot/js/app.js \
	webroot/js/lkm.js webroot/js/shell.js common/funcs.sh; do
	[ -f "$f" ] || bad "missing required file: $f"
done

if [ "$fail" = 0 ]; then
	echo "all checks passed"
else
	echo "checks failed" >&2
fi
exit "$fail"
