#!/system/bin/sh
# the manager removes the module directory itself, only the resident loader
# has to go away
if type ui_print >/dev/null 2>&1; then
	ui_print "- unloading lkmloader"
fi
grep -q '^lkmloader ' /proc/modules 2>/dev/null && rmmod lkmloader 2>/dev/null
exit 0
