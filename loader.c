// SPDX-License-Identifier: GPL-2.0-only
/*
 * lkmloader.c - load kernel modules that reference non-exported symbols.
 *
 * symbol reconstruction : KallRecon (https://github.com/Dere3046/KallRecon)
 * load flow             : inspired by Kernel-SU/lkmloader.ko
 *
 * how it works
 *   1. KallRecon rebuilds the kallsyms table from kernel image memory and
 *      hands back a working kallsyms_lookup_name().
 *   2. the target .ko is read into vmalloc memory. every SHN_UNDEF entry of
 *      its .symtab is resolved against kallsyms and rewritten to SHN_ABS,
 *      except symbols that carry a __versions entry: those were exported at
 *      build time, so the kernel resolves and CRC checks them natively.
 *   3. the patched image is handed to the kernel's own load_module().
 *
 * the loader stays resident and is driven through /proc:
 *   echo 'load /path/to/foo.ko key=value' > /proc/lkmctl
 *   cat /proc/lkmctl   # status, key=value lines
 *   cat /proc/lkmlog   # ring buffer log
 */

#define pr_fmt(fmt) "lkmload: " fmt

#include <linux/version.h>
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/moduleparam.h>
#include <linux/init.h>
#include <linux/fs.h>
#include <linux/file.h>
#include <linux/slab.h>
#include <linux/vmalloc.h>
#include <linux/uaccess.h>
#include <linux/string.h>
#include <linux/elf.h>
#include <linux/proc_fs.h>
#include <linux/mutex.h>
#include <linux/ktime.h>
#include <linux/mm.h>
#include <linux/sched.h>
#include <linux/errno.h>

#if LINUX_VERSION_CODE >= KERNEL_VERSION(6, 1, 0)
#include "kernel/module/internal.h"
#else
#include "kernel/module-internal.h"
#endif

#include "deps/KallRecon/lib/core.h"
#include "deps/KallRecon/lib/variant.h"

#ifndef MODULE_INIT_IGNORE_MODVERSIONS
#define MODULE_INIT_IGNORE_MODVERSIONS 1
#endif
#ifndef MODULE_INIT_IGNORE_VERMAGIC
#define MODULE_INIT_IGNORE_VERMAGIC 2
#endif

/*
 * the kernel's uapi elf.h has no SHN_XINDEX (glibc's elf.h does), so define
 * it here: the extended section index sentinel is the same value as
 * SHN_HIRESERVE
 */
#ifndef SHN_XINDEX
#define SHN_XINDEX 0xffff
#endif

#define LKM_VERSION		"1.1.0"
#define LKM_LOG_SZ		(16 * 1024)
#define LKM_MSG_SZ		224
#define LKM_NAME_SZ		64
#define LKM_CMD_SZ		4096
#define LKM_PATH_SZ		1024
#define LKM_ARGS_SZ		2048
#define LKM_MAX_IMAGE		(256UL << 20)
#define LKM_MAX_MISS		12

/* struct modversion_info: crc + name[MODULE_NAME_LEN], MODULE_NAME_LEN = 56 */
#define LKM_VER_NAME_LEN	56

/* ------------------------------------------------------------------ params */

static bool verbose = true;
module_param(verbose, bool, 0644);
MODULE_PARM_DESC(verbose, "print every resolved symbol");

static bool strict_symbols = true;
module_param(strict_symbols, bool, 0644);
MODULE_PARM_DESC(strict_symbols, "refuse to load when a symbol stays unresolved");

static int symbol_mode;
module_param(symbol_mode, int, 0644);
MODULE_PARM_DESC(symbol_mode,
		 "0 = leave versioned (exported) symbols to the kernel, 1 = patch everything");

static bool ignore_vermagic;
module_param(ignore_vermagic, bool, 0644);
MODULE_PARM_DESC(ignore_vermagic, "pass MODULE_INIT_IGNORE_VERMAGIC to load_module");

static bool ignore_modversions;
module_param(ignore_modversions, bool, 0644);
MODULE_PARM_DESC(ignore_modversions, "pass MODULE_INIT_IGNORE_MODVERSIONS to load_module");

static int cleanup_mode = -1;
module_param(cleanup_mode, int, 0644);
MODULE_PARM_DESC(cleanup_mode, "KallRecon name cleanup: -1 default, 0 auto, 1 seqs, 2 llvm, 3 dollar");

/* ------------------------------------------------------------- module state */

static int (*lkm_load_module_fn)(struct load_info *info,
				 const char __user *uargs, int flags);

static DEFINE_MUTEX(lkm_lock);
static char lkm_log[LKM_LOG_SZ];
static size_t lkm_log_len;

static char lkm_last_msg[LKM_MSG_SZ] = "ready";
static char lkm_last_target[LKM_NAME_SZ] = "-";
static int lkm_last_errno;
static int lkm_last_patched;
static int lkm_last_native;
static int lkm_last_miss;
static unsigned int lkm_loads;
static unsigned int lkm_fails;
static unsigned int lkm_seq;

/* -------------------------------------------------------------------- log */

static void lkm_log_add(const char *fmt, ...)
{
	char line[256];
	va_list args;
	u64 now = ktime_get_ns();
	size_t n;

	va_start(args, fmt);
	vsnprintf(line, sizeof(line), fmt, args);
	va_end(args);

	n = scnprintf(lkm_log + lkm_log_len, LKM_LOG_SZ - lkm_log_len,
		      "[%3llu.%03llu] %s\n", now / NSEC_PER_SEC,
		      (now % NSEC_PER_SEC) / USEC_PER_MSEC, line);
	lkm_log_len += n;

	/* compact from the second line when the buffer is nearly full */
	if (lkm_log_len > LKM_LOG_SZ - 512) {
		size_t drop = lkm_log_len / 2;
		char *nl = memchr(lkm_log + drop, '\n', lkm_log_len - drop);

		if (nl)
			drop = nl - lkm_log + 1;
		memmove(lkm_log, lkm_log + drop, lkm_log_len - drop);
		lkm_log_len -= drop;
	}
}

/* --------------------------------------------------------- bounds checking */

/* true when [off, off + size) fits inside len, without overflowing */
static inline bool lkm_range_ok(u64 off, u64 size, size_t len)
{
	if (off > (u64)len)
		return false;
	return size <= (u64)len - off;
}

static bool lkm_str_in(const char *s, const char *base, u64 end)
{
	u64 pos = (u64)(s - base);

	if (s < base || pos >= end)
		return false;
	return memchr(s, '\0', end - pos) != NULL;
}

/* ------------------------------------------------------- section utilities */

struct lkm_section {
	u64 off;
	u64 size;
};

static bool lkm_find_section(void *buf, Elf64_Ehdr *eh, Elf64_Shdr *sh,
			     unsigned int shnum, unsigned int entsize,
			     size_t len, const char *name,
			     struct lkm_section *out)
{
	unsigned int i, shstrndx = eh->e_shstrndx;
	Elf64_Shdr *sstr;
	const char *names;
	u64 end;

	if (shstrndx == SHN_XINDEX)
		shstrndx = (unsigned int)sh[0].sh_link;
	if (shstrndx == SHN_UNDEF || shstrndx >= shnum)
		return false;

	sstr = &sh[shstrndx];
	if (!sstr->sh_size || !lkm_range_ok(sstr->sh_offset, sstr->sh_size, len))
		return false;

	names = (const char *)buf + sstr->sh_offset;
	end = sstr->sh_size;

	for (i = 0; i < shnum; i++) {
		const char *p;

		if (!sh[i].sh_name || sh[i].sh_name >= end)
			continue;
		p = names + sh[i].sh_name;
		if (!lkm_str_in(p, names, end))
			continue;
		if (!strcmp(p, name)) {
			out->off = sh[i].sh_offset;
			out->size = sh[i].sh_size;
			return true;
		}
	}

	return false;
}

struct lkm_ver_entry {
	unsigned long crc;
	char name[LKM_VER_NAME_LEN];
};

struct lkm_versions {
	const struct lkm_ver_entry *tab;
	unsigned int count;
	bool valid;
};

/*
 * Symbols listed in __versions were exported when the module was linked, so
 * the kernel can resolve them itself and still verify the CRC. Leaving them
 * alone keeps the native check intact; only the rest is patched.
 */
static void lkm_versions_load(void *buf, Elf64_Ehdr *eh, Elf64_Shdr *sh,
			      unsigned int shnum, unsigned int entsize,
			      size_t len, struct lkm_versions *v)
{
	struct lkm_section sec;

	v->tab = NULL;
	v->count = 0;
	v->valid = false;

	if (!lkm_find_section(buf, eh, sh, shnum, entsize, len, "__versions", &sec))
		return;
	if (!sec.size || sec.size % sizeof(struct lkm_ver_entry))
		return;
	if (!lkm_range_ok(sec.off, sec.size, len))
		return;

	v->tab = (const struct lkm_ver_entry *)((char *)buf + sec.off);
	v->count = (unsigned int)(sec.size / sizeof(struct lkm_ver_entry));
	v->valid = true;
}

static bool lkm_versions_has(const struct lkm_versions *v, const char *name)
{
	size_t l = strnlen(name, LKM_VER_NAME_LEN);
	unsigned int i;

	if (!v->valid || !l || l >= LKM_VER_NAME_LEN)
		return false;

	for (i = 0; i < v->count; i++) {
		const char *n = v->tab[i].name;

		if (n[l] != '\0')
			continue;
		if (!memcmp(n, name, l))
			return true;
	}

	return false;
}

/* ------------------------------------------------------------- symbol layer */

static unsigned long lkm_resolve(const char *name, bool *via_variant)
{
	unsigned long addr = 0;

	if (via_variant)
		*via_variant = false;

	if (kallrecon_klp)
		addr = kallrecon_klp(name);
	if (!addr)
		addr = kallsyms_name_to_addr(name);
	if (!addr) {
		addr = kallrecon_find_variant(name, 1);
		if (addr && via_variant)
			*via_variant = true;
	}

	return addr;
}

/* ------------------------------------------------------------- elf patching */

static int lkm_patch_image(void *buf, size_t len, int *out_patched,
			   int *out_native, int *out_miss)
{
	Elf64_Ehdr *eh = buf;
	Elf64_Shdr *sh, *sh_end, *sym_sh = NULL, *str_sh = NULL;
	Elf64_Sym *sym, *sym_end;
	const char *strtab;
	u64 strtab_size;
	unsigned int i, shnum, entsize;
	int patched = 0, native = 0, miss = 0, weak = 0;
	bool quiet = false;
	struct lkm_versions versions;

	if (len < sizeof(*eh))
		return -EINVAL;
	if (memcmp(eh->e_ident, ELFMAG, SELFMAG) != 0)
		return -ENOEXEC;
	if (eh->e_ident[EI_CLASS] != ELFCLASS64)
		return -ENOEXEC;
	if (eh->e_type != ET_REL) {
		lkm_log_add("reject: not a relocatable object (e_type=%u)",
			    eh->e_type);
		return -ENOEXEC;
	}

	entsize = eh->e_shentsize ? eh->e_shentsize : sizeof(Elf64_Shdr);
	if (entsize != sizeof(Elf64_Shdr))
		return -EINVAL;
	if (!eh->e_shoff || !lkm_range_ok(eh->e_shoff, entsize, len))
		return -EINVAL;

	shnum = eh->e_shnum;
	if (shnum == 0)	/* extended section numbering */
		shnum = (unsigned int)((Elf64_Shdr *)((char *)buf + eh->e_shoff))->sh_size;
	if (shnum < 2 || shnum > 65535)
		return -EINVAL;
	/* shnum * entsize without overflowing: compare against the bytes left */
	if ((u64)shnum > (((u64)len - eh->e_shoff) / entsize))
		return -EINVAL;

	sh = (Elf64_Shdr *)((char *)buf + eh->e_shoff);
	sh_end = (Elf64_Shdr *)((char *)sh + (size_t)shnum * entsize);

	for (; sh < sh_end; sh++) {
		if (sh->sh_type == SHT_SYMTAB) {
			sym_sh = sh;
			break;
		}
	}
	if (!sym_sh) {
		lkm_log_add("reject: no .symtab (stripped image)");
		return -ENOENT;
	}
	if (sym_sh->sh_link >= shnum)
		return -EINVAL;
	if (sym_sh->sh_entsize != sizeof(Elf64_Sym))
		return -EINVAL;
	if (!sym_sh->sh_size || sym_sh->sh_size % sizeof(Elf64_Sym))
		return -EINVAL;
	if (!lkm_range_ok(sym_sh->sh_offset, sym_sh->sh_size, len))
		return -EINVAL;

	str_sh = (Elf64_Shdr *)((char *)buf + eh->e_shoff +
				(size_t)sym_sh->sh_link * entsize);
	if (str_sh->sh_type != SHT_STRTAB)
		return -EINVAL;
	if (!str_sh->sh_size || !lkm_range_ok(str_sh->sh_offset, str_sh->sh_size, len))
		return -EINVAL;
	/* the string table must at least end with a NUL */
	if (((const char *)buf)[str_sh->sh_offset + str_sh->sh_size - 1] != '\0')
		return -EINVAL;

	sym = (Elf64_Sym *)((char *)buf + sym_sh->sh_offset);
	sym_end = (Elf64_Sym *)((char *)sym + sym_sh->sh_size);
	strtab = (const char *)buf + str_sh->sh_offset;
	strtab_size = str_sh->sh_size;

	lkm_versions_load(buf, eh, (Elf64_Shdr *)((char *)buf + eh->e_shoff),
			  shnum, entsize, len, &versions);
	if (versions.valid)
		lkm_log_add("__versions: %u entries, mode %s", versions.count,
			    symbol_mode ? "patch-all" : "keep-exported");
	else
		lkm_log_add("__versions: none%s", symbol_mode ? "" : " (patching all)");

	for (sym = sym + 1, i = 1; sym < sym_end; sym++, i++) {
		const char *name;
		unsigned long addr;
		bool variant;

		if (sym->st_shndx != SHN_UNDEF)
			continue;
		if (!sym->st_name || sym->st_name >= strtab_size)
			continue;

		name = strtab + sym->st_name;
		if (!lkm_str_in(name, strtab, strtab_size))
			continue;
		if (!*name)
			continue;

		/* exported at build time: the kernel resolves and CRC checks it */
		if (!symbol_mode && lkm_versions_has(&versions, name)) {
			native++;
			continue;
		}

		addr = lkm_resolve(name, &variant);
		if (!addr) {
			if (ELF64_ST_BIND(sym->st_info) == STB_WEAK) {
				weak++;
				continue;
			}
			if (miss < LKM_MAX_MISS)
				lkm_log_add("  miss %-40s (sym %u)", name, i);
			miss++;
			continue;
		}

		sym->st_value = addr;
		sym->st_shndx = SHN_ABS;
		patched++;

		if (verbose && !quiet) {
			lkm_log_add("  %-40s -> 0x%lx%s", name, addr,
				    variant ? " (variant)" : "");
			if (patched == 8) {
				quiet = true;
				lkm_log_add("  ...");
			}
		}
	}

	*out_patched = patched;
	*out_native = native;
	*out_miss = miss;
	lkm_log_add("symbols: %d patched, %d native, %d unresolved, %d weak",
		    patched, native, miss, weak);

	if (miss && strict_symbols) {
		lkm_log_add("abort: %d unresolved symbol(s), strict mode", miss);
		return -ENOENT;
	}

	return 0;
}

/* ---------------------------------------------------------------- the load */

static int lkm_load(const char *path, const char __user *uargs)
{
	struct load_info info = { };
	struct file *f;
	void *buf = NULL;
	loff_t pos = 0;
	size_t size, alloc, max;
	ssize_t rd;
	unsigned int flags = 0;
	int ret = 0, patched = 0, native = 0, miss = 0;

	snprintf(lkm_last_target, sizeof(lkm_last_target), "%s",
		 strrchr(path, '/') ? strrchr(path, '/') + 1 : path);
	lkm_last_patched = 0;
	lkm_last_native = 0;
	lkm_last_miss = 0;

	if (!lkm_load_module_fn) {
		ret = -ENOSYS;
		goto out_msg;
	}

	f = filp_open(path, O_RDONLY, 0);
	if (IS_ERR(f)) {
		ret = PTR_ERR(f);
		goto out_msg;
	}

	size = i_size_read(file_inode(f));
	if (size < sizeof(Elf64_Ehdr) || size > LKM_MAX_IMAGE) {
		filp_close(f, NULL);
		ret = -EINVAL;
		goto out_msg;
	}
	/* struct load_info.len is unsigned int */
	max = min_t(size_t, size, (size_t)UINT_MAX);

	alloc = PAGE_ALIGN(max);
	buf = vmalloc(alloc);
	if (!buf) {
		filp_close(f, NULL);
		ret = -ENOMEM;
		goto out_msg;
	}
	memset(buf, 0, alloc);

	while (pos < (loff_t)max) {
		rd = kernel_read(f, (char *)buf + pos, max - pos, &pos);
		if (rd < 0) {
			ret = rd;
			filp_close(f, NULL);
			goto out_free;
		}
		if (!rd)
			break;
	}
	filp_close(f, NULL);
	size = pos;

	lkm_log_add("image %s: %zu bytes (seq %u)", lkm_last_target, size, lkm_seq);

	ret = lkm_patch_image(buf, size, &patched, &native, &miss);
	lkm_last_patched = patched;
	lkm_last_native = native;
	lkm_last_miss = miss;
	if (ret)
		goto out_free;

	info.hdr = buf;
	info.len = (unsigned int)size;

	if (ignore_modversions)
		flags |= MODULE_INIT_IGNORE_MODVERSIONS;
	if (ignore_vermagic)
		flags |= MODULE_INIT_IGNORE_VERMAGIC;
	if (flags)
		lkm_log_add("load_module flags=0x%x", flags);

	ret = lkm_load_module_fn(&info, uargs, flags);
	lkm_log_add("load_module -> %d", ret);
	/*
	 * load_module() owns info.hdr: free_copy() vfree()s it on both the
	 * success and the failure path. Drop our pointer so the error path
	 * below cannot free it a second time.
	 */
	buf = NULL;

	if (ret && native)
		lkm_log_add("hint: %d symbol(s) were left to the kernel, "
			    "try symbol_mode=1 if they are missing", native);

out_free:
	vfree(buf);
out_msg:
	if (ret) {
		lkm_fails++;
		scnprintf(lkm_last_msg, sizeof(lkm_last_msg),
			  "%s: error %d (patched %d, native %d, missing %d)",
			  lkm_last_target, ret, patched, native, miss);
		lkm_log_add("fail: %s", lkm_last_msg);
	} else {
		lkm_loads++;
		scnprintf(lkm_last_msg, sizeof(lkm_last_msg),
			  "loaded %s (patched %d, native %d)",
			  lkm_last_target, patched, native);
		lkm_log_add("ok: %s", lkm_last_msg);
	}
	lkm_last_errno = ret;

	return ret;
}

/* -------------------------------------------------------------- /proc glue */

static ssize_t lkmctl_read(struct file *file, char __user *ubuf,
			   size_t count, loff_t *ppos)
{
	char *tmp;
	int n = 0;
	ssize_t ret;

	tmp = kmalloc(1536, GFP_KERNEL);
	if (!tmp)
		return -ENOMEM;

	mutex_lock(&lkm_lock);
	n += scnprintf(tmp + n, 1536 - n, "loader=lkmloader\n");
	n += scnprintf(tmp + n, 1536 - n, "version=%s\n", LKM_VERSION);
	n += scnprintf(tmp + n, 1536 - n, "kallsyms=%d\n", klnum_val ? 1 : 0);
	n += scnprintf(tmp + n, 1536 - n, "num_syms=%u\n", klnum_val);
	n += scnprintf(tmp + n, 1536 - n, "layout=%d\n", (int)kl_layout);
	n += scnprintf(tmp + n, 1536 - n, "kernel_base=0x%lx\n", kernel_base);
	n += scnprintf(tmp + n, 1536 - n, "seq=%u\n", lkm_seq);
	n += scnprintf(tmp + n, 1536 - n, "loads=%u\n", lkm_loads);
	n += scnprintf(tmp + n, 1536 - n, "fails=%u\n", lkm_fails);
	n += scnprintf(tmp + n, 1536 - n, "symbol_mode=%d\n", symbol_mode ? 1 : 0);
	n += scnprintf(tmp + n, 1536 - n, "strict_symbols=%d\n",
		       strict_symbols ? 1 : 0);
	n += scnprintf(tmp + n, 1536 - n, "ignore_vermagic=%d\n",
		       ignore_vermagic ? 1 : 0);
	n += scnprintf(tmp + n, 1536 - n, "ignore_modversions=%d\n",
		       ignore_modversions ? 1 : 0);
	n += scnprintf(tmp + n, 1536 - n, "last_target=%s\n", lkm_last_target);
	n += scnprintf(tmp + n, 1536 - n, "last_patched=%d\n", lkm_last_patched);
	n += scnprintf(tmp + n, 1536 - n, "last_native=%d\n", lkm_last_native);
	n += scnprintf(tmp + n, 1536 - n, "last_miss=%d\n", lkm_last_miss);
	n += scnprintf(tmp + n, 1536 - n, "last_errno=%d\n", lkm_last_errno);
	n += scnprintf(tmp + n, 1536 - n, "last_msg=%s\n", lkm_last_msg);
	mutex_unlock(&lkm_lock);

	ret = simple_read_from_buffer(ubuf, count, ppos, tmp, n);
	kfree(tmp);

	return ret;
}

/*
 * The kernel duplicates the module arguments with strndup_user(), so
 * load_module() needs a real user space string. The write() buffer is the only
 * user memory we know is mapped, so the terminating newline is turned into a
 * NUL and the arguments substring is handed over in place.
 *
 * Protocol: one command per write(), terminated by '\n'. Without the
 * terminator the buffer has no byte we may safely overwrite, so the command
 * is rejected instead of poking past the caller's data.
 */
static ssize_t lkmctl_write(struct file *file, const char __user *ubuf,
			    size_t count, loff_t *ppos)
{
	char *kbuf, *cmd, *arg, *args;
	const char __user *uargs;
	size_t len;
	int ret = 0;

	if (!count || count > LKM_CMD_SZ)
		return -EINVAL;

	kbuf = memdup_user_nul(ubuf, count);
	if (IS_ERR(kbuf))
		return PTR_ERR(kbuf);

	if (kbuf[count - 1] != '\n') {
		pr_info_once("command rejected: missing trailing newline\n");
		ret = -EINVAL;
		goto out;
	}

	len = count - 1;
	if (len && kbuf[len - 1] == '\r')
		len--;
	kbuf[len] = '\0';

	if (!len) {
		ret = -EINVAL;
		goto out;
	}

	/* len <= count - 1, so this writes inside the range we just read */
	if (put_user('\0', (char __user *)ubuf + len)) {
		ret = -EFAULT;
		goto out;
	}

	cmd = kbuf;
	while (*cmd == ' ')
		cmd++;

	arg = strchr(cmd, ' ');
	if (arg)
		*arg++ = '\0';

	mutex_lock(&lkm_lock);
	lkm_seq++;

	if (!strcmp(cmd, "clear")) {
		lkm_log_len = 0;
		snprintf(lkm_last_msg, sizeof(lkm_last_msg), "log cleared");
		lkm_last_target[0] = '-';
		lkm_last_target[1] = '\0';
		lkm_last_errno = 0;
		lkm_log_add("log cleared");
		goto unlock;
	}

	if (strcmp(cmd, "load")) {
		lkm_last_errno = -EINVAL;
		snprintf(lkm_last_msg, sizeof(lkm_last_msg), "unknown command: %s", cmd);
		lkm_log_add("bad command: %s", cmd);
		ret = -EINVAL;
		goto unlock;
	}

	if (!arg)
		arg = cmd + strlen(cmd);
	while (*arg == ' ')
		arg++;

	if (!*arg) {
		lkm_last_errno = -EINVAL;
		snprintf(lkm_last_msg, sizeof(lkm_last_msg), "load: empty path");
		lkm_log_add("load: empty path");
		ret = -EINVAL;
		goto unlock;
	}
	if (strlen(arg) > LKM_PATH_SZ + LKM_ARGS_SZ) {
		lkm_last_errno = -ENAMETOOLONG;
		snprintf(lkm_last_msg, sizeof(lkm_last_msg), "load: path/args too long");
		lkm_log_add("load: path/args too long");
		ret = -ENAMETOOLONG;
		goto unlock;
	}

	/* split "path [args]" */
	args = strchr(arg, ' ');
	if (args) {
		*args++ = '\0';
		while (*args == ' ')
			args++;
	} else {
		args = arg + strlen(arg);
	}
	if (strlen(arg) > LKM_PATH_SZ) {
		lkm_last_errno = -ENAMETOOLONG;
		snprintf(lkm_last_msg, sizeof(lkm_last_msg), "load: path too long");
		lkm_log_add("load: path too long");
		ret = -ENAMETOOLONG;
		goto unlock;
	}

	/* the user side string must stay inside the bytes we validated */
	if ((size_t)(args - kbuf) > len) {
		lkm_last_errno = -EINVAL;
		snprintf(lkm_last_msg, sizeof(lkm_last_msg), "load: bad argument offset");
		ret = -EINVAL;
		goto unlock;
	}

	uargs = ubuf + (args - kbuf);
	ret = lkm_load(arg, uargs);

unlock:
	mutex_unlock(&lkm_lock);
out:
	kfree(kbuf);

	if (ret)
		return ret;
	return count;
}

static ssize_t lkmlog_read(struct file *file, char __user *ubuf,
			   size_t count, loff_t *ppos)
{
	ssize_t ret;

	mutex_lock(&lkm_lock);
	ret = simple_read_from_buffer(ubuf, count, ppos, lkm_log, lkm_log_len);
	mutex_unlock(&lkm_lock);

	return ret;
}

/* no .proc_lseek: no_llseek was dropped in 6.12 and these files are only
 * ever read sequentially */
static const struct proc_ops lkmctl_ops = {
	.proc_read	= lkmctl_read,
	.proc_write	= lkmctl_write,
};

static const struct proc_ops lkmlog_ops = {
	.proc_read	= lkmlog_read,
};

/* --------------------------------------------------------------- lifecycle */

static int __init lkm_init(void)
{
	unsigned long addr;

	pr_info("init %s\n", LKM_VERSION);

	if (cleanup_mode >= 0)
		kallrecon_set_cleanup_mode((enum kallrecon_cleanup)cleanup_mode);

	find_kallsyms_base();
	if (!kallrecon_klp || !klnum_val) {
		pr_err("kallsyms discovery failed\n");
		return -ENODATA;
	}

	mutex_lock(&lkm_lock);
	lkm_log_add("kallsyms: %u symbols, layout %d, base 0x%lx",
		    klnum_val, (int)kl_layout, kernel_base);
	mutex_unlock(&lkm_lock);

	addr = lkm_resolve("load_module", NULL);
	if (!addr) {
		pr_err("load_module not found\n");
		return -ENOSYS;
	}
	lkm_load_module_fn =
		(int (*)(struct load_info *, const char __user *, int))addr;
	lkm_log_add("load_module @ 0x%lx, symbol_mode %d", addr, symbol_mode);

	if (!proc_create("lkmctl", 0600, NULL, &lkmctl_ops))
		return -ENOMEM;
	if (!proc_create("lkmlog", 0400, NULL, &lkmlog_ops)) {
		remove_proc_entry("lkmctl", NULL);
		return -ENOMEM;
	}

	pr_info("ready, /proc/lkmctl\n");

	return 0;
}

static void __exit lkm_exit(void)
{
	remove_proc_entry("lkmlog", NULL);
	remove_proc_entry("lkmctl", NULL);
	pr_info("exit\n");
}

module_init(lkm_init);
module_exit(lkm_exit);

MODULE_LICENSE("GPL");
MODULE_AUTHOR("lkmloader");
MODULE_DESCRIPTION("LKM loader: resolve non-exported symbols via KallRecon");
MODULE_VERSION(LKM_VERSION);
