obj-m := lkmloader.o

MDIR := $(realpath $(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
KDIR := $(KDIR)
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

OBJDIRS := $(sort $(addprefix $(ODIR)/,$(dir $(lkmloader-y))))

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
