obj-m := lkmloader.o

MDIR := $(realpath $(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
KDIR := $(KDIR)

# ddk exports DDK_TARGET (and KDIR) instead of VER, so derive the output
# directory from whatever is available; the directory name of KDIR is the
# kernel target, e.g. /opt/ddk/kdir/android16-6.12
VER ?= $(DDK_TARGET)
ifeq ($(strip $(VER)),)
VER := $(notdir $(patsubst %/,%,$(KDIR)))
endif

ifeq ($(strip $(KBUILD_EXTMOD)),)
ifeq ($(strip $(KDIR)),)
$(error KDIR is not set, pass KDIR=/opt/ddk/kdir/<target>)
endif
endif

ODIR := $(MDIR)/out/$(VER)

# KMSDK deploys KallRecon into deps/, deps.mk describes the objects to link.
KALLRECON := deps/KallRecon
ifeq ($(wildcard $(MDIR)/$(KALLRECON)/deps.mk),)
$(error $(KALLRECON) is missing, run ./scripts/fetch-deps.sh first)
endif
include $(MDIR)/$(KALLRECON)/deps.mk
KALLRECON_OBJS := $(addprefix $(KALLRECON)/,$(DEPS_LIB_OBJS))

lkmloader-y := loader.o $(KALLRECON_OBJS)

ccflags-y += -std=gnu11
ccflags-y += -I$(MDIR)
ccflags-y += -I$(srctree)
ccflags-y += -Wno-declaration-after-statement
ccflags-y += -Wno-unused-variable
ccflags-y += -Wno-unused-function
ccflags-y += -Wno-strict-prototypes
ccflags-y += -Wno-int-conversion
ccflags-y += -Wno-unused-result
ccflags-y += -Wno-builtin-macro-redefined

$(info -- KDIR: $(KDIR))
$(info -- MDIR: $(MDIR))
$(info -- ODIR: $(ODIR))
$(info -- objs: $(lkmloader-y))

.PHONY: all clean

OBJDIRS := $(sort $(addprefix $(ODIR)/,$(filter-out ./,$(dir $(lkmloader-y)))))

all:
	mkdir -p $(ODIR) $(OBJDIRS)
	make -C $(KDIR) M=$(ODIR) src=$(MDIR) srcroot=$(MDIR) modules

clean:
	rm -rf $(ODIR)

# 6.10+ resolves %.c against $(obj) instead of $(src); mirror the built-in
# rules here so out-of-tree builds into $(ODIR) keep working.
$(obj)/%.o: $(src)/%.c $(recordmcount_source) FORCE
	$(call if_changed_rule,cc_o_c)
	$(call cmd,force_checksrc)

$(obj)/%.o: $(src)/%.S FORCE
	$(call if_changed_rule,as_o_S)
