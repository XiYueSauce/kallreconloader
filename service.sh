#!/system/bin/sh
MODDIR=${0%/*}
. "$MODDIR/common/funcs.sh"
lkm_boot service
