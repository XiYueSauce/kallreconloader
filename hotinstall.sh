#!/system/bin/sh
#
# MODULE_HOT_RUN_SCRIPT - runs right after KernelSU has swapped the module
# directory for a hot install.
#
# At this point every file on disk is already the new version (WebUI included),
# but the loader in the kernel is still the old build: a loaded module cannot be
# replaced while it is resident. So the only real work here is rmmod + insmod,
# with the previous build kept around in case the new one is refused.
#
# The installer captures stdout and waits at most 30 s, so keep this short and
# do not start daemons here.

MODDIR=${0%/*}
[ -f "$MODDIR/common/funcs.sh" ] || exit 0
. "$MODDIR/common/funcs.sh"

KO=$MODDIR/ko/lkmloader.ko
PREV=$MODDIR/ko/lkmloader.prev.ko

[ -f "$KO" ] || {
	echo "- hot       : no lkmloader.ko in the new version, nothing to start"
	exit 0
}

lkm_log "hotinstall: module files swapped, restarting loader"

if [ -n "$(lkm_mod_name lkmloader)" ]; then
	echo "- hot       : unloading the old loader"
	rmmod lkmloader 2>/dev/null

	_i=0
	while [ -n "$(lkm_mod_name lkmloader)" ] && [ "$_i" -lt 20 ]; do
		sleep 0.1
		_i=$((_i + 1))
	done

	if [ -n "$(lkm_mod_name lkmloader)" ]; then
		echo "- hot       : the old loader is still resident, reboot to apply"
		lkm_log "hotinstall: rmmod refused, reboot needed"
		exit 0
	fi
fi

if lkm_loader_up; then
	echo "- hot       : loader $(lkm_ctl_get version) active, $(lkm_ctl_get num_syms) symbols"
	lkm_log "hotinstall: loader $(lkm_ctl_get version) active, $(lkm_ctl_get num_syms) symbols"
	echo "- hot       : already loaded .ko files keep running; reload them from the WebUI if needed"
	exit 0
fi

# insmod refused the new build (vermagic of another kernel, truncated copy...).
# Put the previous build back so the device keeps a working loader; boot will
# retry the new one and its failure will show up in the WebUI log.
if [ -f "$PREV" ]; then
	insmod "$PREV" $(lkm_options_args) 2>/dev/null
	sleep 0.2
	if [ -e /proc/lkmctl ] && [ "$(lkm_ctl_get loader)" = "lkmloader" ]; then
		echo "- hot       : new loader refused by this kernel, rolled back to the previous build"
		echo "- hot       : this package needs a ko built for $(uname -r)"
		lkm_log "hotinstall: new ko refused, rolled back to the previous build"
		exit 0
	fi
fi

echo "- hot       : loader did not start, it will be retried at boot"
lkm_log "hotinstall: insmod failed, will retry at boot"
exit 0
