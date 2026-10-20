#!/system/bin/sh
#
# shared helpers, sourced by customize.sh / post-fs-data.sh / service.sh
# and by the WebUI (via `sh -c ". funcs.sh; <action>"`)
#

LKM_ID=lkmloader
LKM_MODDIR=${LKM_MODDIR:-${MODDIR:-/data/adb/modules/$LKM_ID}}
LKM_KO=$LKM_MODDIR/ko/lkmloader.ko
LKM_KO_DIR=$LKM_MODDIR/ko
LKM_LIB=$LKM_MODDIR/lkm
LKM_CONF=$LKM_MODDIR/config.json
LKM_LOG_DIR=$LKM_MODDIR/logs
LKM_BOOT_LOG=$LKM_LOG_DIR/boot.log
LKM_OPTIONS=$LKM_KO_DIR/options
LKM_MAX_DELAY=60

# ---------------------------------------------------------------- utilities

lkm_log() {
	mkdir -p "$LKM_LOG_DIR" 2>/dev/null
	printf '[%s] %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >>"$LKM_BOOT_LOG" 2>/dev/null
	printf 'lkmloader: %s\n' "$*" >/dev/kmsg 2>/dev/null
	return 0
}

lkm_rotate() {
	mkdir -p "$LKM_LOG_DIR" 2>/dev/null
	if [ -f "$LKM_BOOT_LOG" ]; then
		_sz=$(wc -c <"$LKM_BOOT_LOG" 2>/dev/null | tr -d ' ')
		if [ -n "$_sz" ] && [ "$_sz" -gt 131072 ]; then
			mv -f "$LKM_BOOT_LOG" "$LKM_BOOT_LOG.1" 2>/dev/null
		fi
	fi
}

lkm_manager() {
	if [ -d /data/adb/ksu ] || [ -d /data/adb/ksud ]; then
		echo KernelSU
	elif [ -d /data/adb/ap ]; then
		echo APatch
	elif [ -d /data/adb/magisk ]; then
		echo Magisk
	else
		echo Unknown
	fi
}

# androidNN-M.m of the running kernel, e.g. android16-6.12
lkm_kmi() {
	_u=$(uname -r)
	_k=${_u%%-*}
	_maj=${_k%%.*}
	_rest=${_k#*.}
	_min=${_rest%%.*}
	_a=$(printf '%s' "$_u" | sed -n 's/.*\(android[0-9][0-9]*\).*/\1/p')
	if [ -z "$_a" ]; then
		case "$_maj.$_min" in
		5.10) _a=android12 ;;
		5.15) _a=android13 ;;
		6.1) _a=android14 ;;
		6.6) _a=android15 ;;
		6.12) _a=android16 ;;
		*) _a=android$_maj ;;
		esac
	fi
	printf '%s-%s.%s\n' "$_a" "$_maj" "$_min"
}

# ------------------------------------------------------------ config parsing
# config.json is written by the WebUI with one module object per line, so a
# line oriented parse is enough and needs no jq on the device. The WebUI keeps
# values free of quotes/backslashes/newlines; anything else is rejected there.

lkm_entries() {
	[ -f "$LKM_CONF" ] || return 0
	sed -n 's/^[[:space:]]*\({"name".*}\).*$/\1/p' "$LKM_CONF"
}

lkm_json_str() {
	printf '%s\n' "$1" | sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p'
}

lkm_json_num() {
	printf '%s\n' "$1" | sed -n 's/.*"'"$2"'":\([0-9][0-9]*\).*/\1/p'
}

lkm_json_bool() {
	case "$1" in
	*'"'"$2"'":true'*) echo 1 ;;
	*) echo 0 ;;
	esac
}

# ------------------------------------------------------------------- loading

# the kernel derives the module name from the file name, replacing anything
# outside [A-Za-z0-9_] with '_', so '-' and '_' have to be treated as equal
lkm_mod_name() {
	[ -n "$1" ] || return 0
	awk -v raw="$1" -v norm="$(printf '%s' "$1" | tr '-' '_')" \
		'$1 == raw || $1 == norm { print $1; exit }' /proc/modules 2>/dev/null
}

lkm_is_loaded() {
	[ -n "$(lkm_mod_name "$1")" ]
}

lkm_options_args() {
	[ -f "$LKM_OPTIONS" ] || return 0
	tr '\n' ' ' <"$LKM_OPTIONS" 2>/dev/null
}

lkm_loader_up() {
	[ -e /proc/lkmctl ] && return 0
	[ -f "$LKM_KO" ] || return 1

	insmod "$LKM_KO" $(lkm_options_args) 2>/dev/null

	_i=0
	while [ "$_i" -lt 40 ]; do
		[ -e /proc/lkmctl ] && return 0
		sleep 0.1
		_i=$((_i + 1))
	done
	return 1
}

lkm_ctl_get() {
	sed -n "s/^$1=//p" /proc/lkmctl 2>/dev/null | head -n1
}

# lkm_load_one <name> <path> [args]
# exit code is authoritative: the write() itself returns the loader's errno,
# so a failure can never be mistaken for a stale last_errno
lkm_load_one() {
	_n=$1
	_p=$2
	_a=$3

	if lkm_is_loaded "$_n"; then
		lkm_log "skip $_n: already loaded"
		return 0
	fi
	if [ -z "$_p" ] || [ ! -f "$_p" ]; then
		lkm_log "fail $_n: $_p not found"
		return 1
	fi
	if ! lkm_loader_up; then
		lkm_log "fail $_n: loader unavailable (insmod rejected?)"
		return 1
	fi

	if ! printf 'load %s %s\n' "$_p" "$_a" >/proc/lkmctl 2>/dev/null; then
		_e=$(lkm_ctl_get last_errno)
		_m=$(lkm_ctl_get last_msg)
		lkm_log "fail $_n: write rejected (${_e:-?}) ${_m}"
		return 1
	fi

	_m=$(lkm_ctl_get last_msg)
	lkm_log "ok $_n: $_m"
	return 0
}

# lkm_unload_one <name>
# prints "state=unloaded|absent|failed:<reason>" and exits non zero on failure
lkm_unload_one() {
	_name=$(lkm_mod_name "$1")
	if [ -z "$_name" ]; then
		echo "state=absent"
		return 0
	fi
	_out=$(rmmod "$_name" 2>&1)
	if [ -n "$(lkm_mod_name "$1")" ]; then
		echo "state=failed:${_out:-rmmod failed}"
		return 1
	fi
	# some cached addresses may have come from the module that just left
	printf 'flush\n' >/proc/lkmctl 2>/dev/null
	echo "state=unloaded"
	return 0
}

# lkm_load_stage <post-fs-data|service>
lkm_load_stage() {
	_stage=$1
	_ok=0
	_fail=0
	_skip=0
	_queue=$LKM_LOG_DIR/.queue

	mkdir -p "$LKM_LOG_DIR" 2>/dev/null
	lkm_entries >"$_queue" 2>/dev/null || : >"$_queue"

	# read from a file instead of a pipe so the counters survive
	while IFS= read -r _line; do
		[ -n "$_line" ] || continue
		[ "$(lkm_json_bool "$_line" enabled)" = "1" ] || { _skip=$((_skip + 1)); continue; }
		[ "$(lkm_json_str "$_line" stage)" = "$_stage" ] || { _skip=$((_skip + 1)); continue; }

		_name=$(lkm_json_str "$_line" name)
		_path=$(lkm_json_str "$_line" path)
		_args=$(lkm_json_str "$_line" args)
		_delay=$(lkm_json_num "$_line" delay)

		if [ -z "$_name" ] || [ -z "$_path" ]; then
			lkm_log "config: bad entry for stage $_stage: $_line"
			_fail=$((_fail + 1))
			continue
		fi

		case "$_delay" in
		'' | *[!0-9]*) _delay=0 ;;
		esac
		if [ "$_delay" -gt "$LKM_MAX_DELAY" ]; then
			lkm_log "config: $_name delay $_delay clamped to $LKM_MAX_DELAY"
			_delay=$LKM_MAX_DELAY
		fi
		[ "$_delay" -gt 0 ] && sleep "$_delay"

		if lkm_load_one "$_name" "$_path" "$_args"; then
			_ok=$((_ok + 1))
		else
			_fail=$((_fail + 1))
		fi
	done <"$_queue"

	rm -f "$_queue" 2>/dev/null
	lkm_log "stage=$_stage summary: ok=$_ok fail=$_fail skipped=$_skip"
}

lkm_boot() {
	mkdir -p "$LKM_LOG_DIR" "$LKM_LIB" 2>/dev/null
	lkm_rotate
	lkm_log "boot: stage=$1 kmi=$(lkm_kmi) manager=$(lkm_manager) uid=$(id -u)"
	lkm_load_stage "$1"
	lkm_log "boot: stage=$1 done"
}
