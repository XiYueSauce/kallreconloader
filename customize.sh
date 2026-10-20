#!/system/bin/sh
# runs inside the installer staging directory ($MODPATH)

if ! type ui_print >/dev/null 2>&1; then
	ui_print() { echo "$1"; }
fi

LKM_MODDIR=$MODPATH
. "$MODPATH/common/funcs.sh"

ui_print " "
ui_print "  LKM Loader $(sed -n 's/^version=//p' "$MODPATH/module.prop")"
ui_print "  loader + kallsyms reconstruction (KallRecon)"
ui_print " "

KMI=$(lkm_kmi)
ui_print "- kernel    : $(uname -r)"
ui_print "- build KMI : $KMI"

# ---------------------------------------------------------------- pick the ko
# exact match first; a fallback is only used when it is unambiguous, because
# android12-5.10 and android13-5.10 share the "5.10" suffix

SRC=""
if [ -f "$MODPATH/ko/$KMI/lkmloader.ko" ]; then
	SRC="$MODPATH/ko/$KMI/lkmloader.ko"
else
	SUFFIX=${KMI#*-}
	CAND=""
	NCAND=0
	for d in "$MODPATH"/ko/*/; do
		[ -d "$d" ] || continue
		case "${d%/}" in
		*-"$SUFFIX")
			NCAND=$((NCAND + 1))
			CAND="${d%/}"
			;;
		esac
	done
	if [ "$NCAND" -eq 1 ]; then
		SRC="$CAND/lkmloader.ko"
		ui_print "- fallback  : $(basename "$CAND") (only build for kernel $SUFFIX)"
	elif [ "$NCAND" -gt 1 ]; then
		ui_print "! $NCAND builds match kernel $SUFFIX, not guessing:"
		for d in "$MODPATH"/ko/*/; do
			[ -d "$d" ] || continue
			case "${d%/}" in
			*-"$SUFFIX") ui_print "    $(basename "${d%/}")" ;;
			esac
		done
		ui_print "! this package cannot decide which one is ABI compatible"
		if type abort >/dev/null 2>&1; then
			abort "! installation aborted"
		fi
		exit 1
	fi
fi

if [ -z "$SRC" ]; then
	ui_print "! this build has no lkmloader.ko for $KMI"
	ui_print "! bundled targets:"
	for d in "$MODPATH"/ko/*/; do
		[ -d "$d" ] && ui_print "    $(basename "${d%/}")"
	done
	if type abort >/dev/null 2>&1; then
		abort "! installation aborted"
	fi
	exit 1
fi

ui_print "- using ko  : ${SRC#$MODPATH/}"
cp -f "$SRC" "$MODPATH/ko/lkmloader.ko" || {
	ui_print "! copy failed"
	exit 1
}
for d in "$MODPATH"/ko/*/; do
	[ -d "$d" ] && rm -rf "$d"
done

mkdir -p "$MODPATH/lkm" "$MODPATH/logs"

if [ ! -f "$MODPATH/ko/options" ]; then
	cat >"$MODPATH/ko/options" <<'EOF'
verbose=1
strict_symbols=1
symbol_mode=0
ignore_vermagic=0
ignore_modversions=0
cleanup_mode=-1
EOF
fi

if [ ! -f "$MODPATH/config.json" ]; then
	cat >"$MODPATH/config.json" <<'EOF'
{
"version":1,
"defaultStage":"service",
"options":{"ignoreVermagic":false,"ignoreModversions":false,"strictSymbols":true,"verbose":true,"keepExported":true},
"modules":[]
}
EOF
fi

chmod 0755 "$MODPATH/post-fs-data.sh" "$MODPATH/service.sh" \
	"$MODPATH/uninstall.sh" "$MODPATH/customize.sh" 2>/dev/null
chmod -R 0755 "$MODPATH/common" "$MODPATH/webroot" 2>/dev/null
chmod 0644 "$MODPATH/ko/lkmloader.ko" "$MODPATH/ko/options" \
	"$MODPATH/config.json" 2>/dev/null
find "$MODPATH/webroot" -type f -exec chmod 0644 {} + 2>/dev/null

# ------------------------------------------------------------------ self test
# the /proc node alone proves nothing (an already loaded instance provides it),
# so check the identity string and keep insmod's stderr for the log

if [ -f "$MODPATH/ko/lkmloader.ko" ]; then
	WAS_LOADED=0
	[ -n "$(lkm_mod_name lkmloader)" ] && WAS_LOADED=1

	INSMOD_ERR=$(insmod "$MODPATH/ko/lkmloader.ko" $(lkm_options_args) 2>&1)
	_i=0
	while [ "$_i" -lt 20 ]; do
		[ -e /proc/lkmctl ] && break
		sleep 0.1
		_i=$((_i + 1))
	done

	if [ -e /proc/lkmctl ] && [ "$(lkm_ctl_get loader)" = "lkmloader" ]; then
		ui_print "- loader    : active $(lkm_ctl_get version), $(lkm_ctl_get num_syms) symbols"
		[ "$(lkm_ctl_get kallsyms)" = "1" ] || ui_print "- warn      : kallsyms reconstruction reported failure"
		if [ "$WAS_LOADED" = 0 ]; then
			rmmod lkmloader 2>/dev/null
			[ -n "$(lkm_mod_name lkmloader)" ] && ui_print "- warn      : rmmod failed, loader stays resident"
		else
			ui_print "- note      : an older loader instance was already resident"
		fi
	else
		ui_print "- loader    : self test failed, it will be retried at boot"
		[ -n "$INSMOD_ERR" ] && ui_print "  $INSMOD_ERR"
	fi
fi

ui_print "- done, open the WebUI to import .ko files"
ui_print " "
