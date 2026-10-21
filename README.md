# LKM Loader

> 架构取舍、坑位与实现细节见 [`docs/DESIGN.md`](docs/DESIGN.md)；本文只讲怎么用。

带 WebUI 的 LKM 加载模块，支持 **KernelSU / APatch / Magisk**。
用于加载引用了**非导出内核符号**的 `.ko`：内核符号表由 [KallRecon](https://github.com/Dere3046/KallRecon) 从内核镜像内存中重建，
加载流程参考 [Kernel-SU/lkmloader.ko](https://github.com/Kernel-SU/lkmloader.ko)，依赖统一由
[KMSDK](https://github.com/Dere3046/KMSDK) 部署。

```
webroot (HTML/CSS/JS)  ──ksu/apatch exec──┐
                                          ▼
post-fs-data.sh / service.sh  ──  shell 逻辑（时机、去重、日志）
                                          │  insmod ko/lkmloader.ko
                                          │  echo 'load <path> [args]' > /proc/lkmctl
                                          ▼
lkmloader.ko ── KallRecon 重建 kallsyms ── patch 目标 ko 的 SHN_UNDEF 符号
             └─ 调用内核 load_module() 完成真正的加载
```

## 特性

- **符号重建**：`find_kallsyms_base()` 扫出 kallsyms 各子表，拿到可用的 `kallsyms_lookup_name`；
  覆盖 GKI 5.10 ~ 6.12 的三种 layout，并支持 CFI 变体（`.cfi_jt`）回退查找。
- **有区分的 ELF 回填**：读取目标 `.ko`，把 `.symtab` 中 `SHN_UNDEF` 条目解析成地址并改写为 `SHN_ABS`。
  带 `__versions` 条目的符号说明它链接时是导出的，默认**交还内核**自行解析并做 CRC 校验，
  只有非导出符号才由 loader 回填（`symbol_mode=0`，可在设置里改成全量回填）。
  注意：不带内核 Module.symvers 编出来的 ko，`__versions` 是空的，此时两种模式等价。
- **常驻 loader + /proc 控制**：`/proc/lkmctl` 收命令与状态，`/proc/lkmlog` 输出环形日志，
  UI 可实时看到“解析了多少符号、缺了哪些、返回码是多少”。
- **两种加载时机**：每个 ko 可单独选择 `post-fs-data` / `service` / 手动，支持延迟秒数。
- **热挂载 / 热卸载**：任选一个 `.ko` 直接挂进运行中的内核（只落到 `/data/local/tmp`，不写配置，
  重启即失效，需要的话一键「加入开机」）；「已加载」列表可卸载任意已加载的 LKM，
  包括不是本模块导入的。
- **WebUI**：状态面板、模块管理、参数与开关、日志查看；HTML/CSS/JS 分离。
  导入与热加载都走系统文件选择器，已加载列表读 `/proc/modules`，页面里没有目录浏览器。
  同时适配管理器的两代 exec 接口（回调式 `ksu.exec(cmd, opts, name)` 与 Promise 式）。
- **KMI 适配**：多内核版本的 ko 打进同一个 zip，安装时按设备的 `androidNN-M.m` 自动挑选。

## 目录结构

```
lkmloader/
├── loader.c                 内核模块（符号重建 + ELF 回填 + /proc 接口）
├── Makefile                 out-of-tree 构建（含 6.10+ 的 src/obj 规则修正）
├── deps.lst / .sdk-version  KMSDK 依赖与 SDK 版本锁定
├── scripts/
│   ├── fetch-deps.sh        拉取 KMSDK 与 KallRecon
│   └── package.sh           组装可刷入 zip
├── build-all.sh             用 ddk host 模式构建所有内核版本
├── module.prop
├── customize.sh             安装：按 KMI 选 ko、写默认配置、尝试自检
├── post-fs-data.sh          时机一
├── service.sh               时机二
├── common/funcs.sh          共享 shell 逻辑（配置解析、加载、日志）
├── webroot/
│   ├── index.html
│   ├── css/style.css
│   └── js/{shell.js,lkm.js,app.js}
└── META-INF/com/google/android/{update-binary,updater-script}
```

## 构建

内核模块必须针对目标内核的 KMI 与 modversions 编译，无法“一个 ko 通吃”。推荐用
[ddk](https://github.com/Ylarod/ddk)：

```bash
# 1. 部署依赖（KallRecon 会出现在 deps/ 下）
./scripts/fetch-deps.sh

# 2. 静态检查（shell/js 语法、资源引用、配置解析）
./scripts/check.sh

# 3. 单个版本
make KDIR=/opt/ddk/kdir/android16-6.12                     # VER 按目录名推导

# 4. 全部版本（输出 out/<target>/lkmloader.ko）
./build-all.sh

# 5. 打包（每个 ko 都会校验 ELF/ET_REL/vermagic，并回读 zip 内容）
./scripts/package.sh     # -> dist/lkmloader-v1.2.8.zip
```

CI 见 `.github/workflows/build.yml`，用 docker 版 ddk 逐个 target 构建后打包。

依赖只用 KallRecon（`deps.lst` 固定 rev，SDK 版本在 `.sdk-version`），可复现。
要升级：`./.sdk/scripts/sdk update KallRecon`，或直接改 `deps.lst`。

## 使用

### 1. 导入 ko

WebUI → 模块 → 导入 .ko：直接拉起**Android 的文件选择器**（`<input type="file">`），
第三方文件管理器能接管就由它接管，模块自己不再画目录树。

文件先在前端校验（ELF64、`ET_REL`、大小），再以 base64 分段写进
`/data/adb/modules/lkmloader/lkm/<name>.ko`，写完回读字节数确认，然后写入配置并加载一次。
`content://` 拿不到真实路径，所以这一段必须走字节流。想先试试、不留痕就用下一条的「热加载」。

### 2. 选择加载时机

点模块卡片进入详情：

| 时机 | 执行点 | 适合 |
| --- | --- | --- |
| `post-fs-data` | `/data` 挂载后、`system_server` 之前 | 需要尽早接管、影响系统服务启动的模块 |
| `service` | `late_start service` | 依赖系统服务、需要等待 `/data` 完全就绪的模块 |
| 手动 | 不自动加载 | 调试用，随时在 UI 里点“加载” |

延迟字段（`delay`）用于少数需要在 `service` 阶段再等几秒的模块。

### 3. 观察状态

状态页展示：loader 是否就绪、内核版本、构建 KMI、设备、平台、已导入模块的 KMI 是否匹配、
`modules_disabled` 是否打开；`参数` 区显示 loader 当前开关；`日志` 区同时给出 loader 环形日志与开机加载日志。

loader 是否加载以 `/proc/lkmctl` 为准，读不到时回退看 `/proc/modules`——两者都拿不到才提示未加载。
若 WebUI 连命令都执行不了，状态卡会写「无法读取」，而不是假装「未加载」。

### 4. 热加载 / 卸载别的 LKM

- **热加载**：模块页右上角「热加载」选一个 `.ko`，字节落到 `/data/local/tmp/lkm_hot/<name>.ko`
  并立即交给 loader 挂进内核。不写 `config.json`，重启即失效；模块卡片带「临时」标记，
  可随时卸载，也可以点「加入开机」转成常驻条目。
- **已加载**：点「查看内核里已加载的模块」读 `/proc/modules`，本模块加载的排在最前并带「本模块」标记，
  可搜索；点条目即卸载（引用计数大于 0 的和 loader 自身会禁用）。

已加载列表只看内核当前状态，不去扫描 `/data/adb/modules`、Download 这类目录——
文件在那儿不等于已经加载，扫盘还慢。

文件被改名（`mhsrc.ko` → `mhsrc (1).ko`、`mhsrc - 副本.ko` 之类）不影响判定：内核用的是加载时的
文件名，所以加载成功时会把真实模块名记进 `config.json` 的 `loadedAs`；没有记录的历史条目则按
去掉 `(1)` / `_1_` / 末尾下划线的名字再匹配一次。命中别名时卡片直接显示内核名（`已加载 mhsrc`），
卸载也按这个名字走，不会出现"看着已加载、点卸载说没加载"的情况。

## 内核侧接口

```sh
# 常驻 loader，参数见下表
insmod /data/adb/modules/lkmloader/ko/lkmloader.ko verbose=1 strict_symbols=1

# 加载一个 ko，路径后用空格跟模块参数（命令必须以换行结尾）
echo 'load /data/adb/modules/lkmloader/lkm/foo.ko debug=1' > /proc/lkmctl

# 状态（key=value）
cat /proc/lkmctl        # kallsyms / num_syms / seq / cache_* / loads / fails / last_* ...
cat /proc/lkmlog        # 环形日志，包含每个被回填的符号
printf 'clear\n' > /proc/lkmctl   # 只清日志
printf 'flush\n' > /proc/lkmctl   # 清空符号缓存（卸载模块后脚本会自动发）
```

符号解析结果会缓存在 loader 里（509 槽开放寻址）：`kallsyms` 查询是十万级的线性扫描，
同一符号在重载、多模块共享时不必重复扫表。缓存只记录**命中**，查不到的名字每次都重试，
因为后加载的模块可能正好提供它；卸载时由脚本触发 `flush`，避免拿到已卸载模块的旧地址。
`cat /proc/lkmctl` 里的 `cache_used` / `cache_hits` / `cache_misses` 可以直接看出效果。

协议约定：**一次 `write()` 一条命令，且必须以 `\n` 结尾**。内核需要把命令末尾的换行改写成 NUL
才能得到 `load_module()` 需要的用户空间参数指针，没有换行时无法在不越界的前提下做到，命令会被拒绝。
`write()` 的返回值就是这次加载的 errno —— 失败时返回负值，脚本据此判定，不依赖全局状态。

模块参数（`insmod` 时指定，改完需 `rmmod lkmloader` 重载）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `verbose` | `1` | 逐个打印被回填的符号（每个 ko 最多 8 条） |
| `strict_symbols` | `1` | 有符号解析失败就放弃加载，避免半残模块进内核 |
| `symbol_mode` | `0` | `0` 只回填非导出符号（带 `__versions` 的交给内核自己做 CRC 校验）；`1` 全部回填 |
| `ignore_vermagic` | `0` | 传给 `load_module` 的 `MODULE_INIT_IGNORE_VERMAGIC` |
| `ignore_modversions` | `0` | 跳过符号 CRC 校验，**跨版本使用有崩溃风险** |
| `cleanup_mode` | `-1` | KallRecon 名字清洗策略：`-1` 默认 / `0` auto / `1` seqs / `2` llvm / `3` dollar |

> 命令行里的模块参数用空格分隔即可；内核侧会自动把 `load` 命令的尾部参数原样交给目标模块的
> `parse_args()`。
>
> `loads` / `fails` 是**累计**计数，不能用来判断某一次加载是否成功；单次结果看 `write()` 返回值，
> 细节看 `seq` / `last_target` / `last_errno` / `last_patched` / `last_native` / `last_miss`。

## 配置格式

`/data/adb/modules/lkmloader/config.json`，由 WebUI 维护。为了在设备上无需 `jq` 也能解析，
模块对象固定“一行一个”：

```json
{
"version":1,
"defaultStage":"service",
"options":{"ignoreVermagic":false,"ignoreModversions":false,"strictSymbols":true,"verbose":true,"keepExported":true},
"modules":[
{"name":"foo","path":"/data/adb/modules/lkmloader/lkm/foo.ko","args":"","stage":"service","enabled":true,"delay":0}
]
}
```

`common/funcs.sh` 用 `sed` 逐行取字段，因此**不要手动把对象拆成多行**。
`args` 由 WebUI 清洗过（不接受引号、反斜杠、换行和制表符），因为它们同时要穿过 shell 命令、
JSON 字符串和 loader 的空格分隔协议。

## 原理备注

1. `load_module()` 不导出，需要先用 kallsyms 找到地址；而找 `kallsyms_lookup_name` 本身又需要
   一个锚点。KallRecon 用 `sprint_symbol`（GPL 导出）做锚点向上扫描，重建 token/offset/names 表。
2. 目标 ko 的未定义符号在 `simplify_symbols()` 阶段才会被解析，失败就是 `Unknown symbol`。
   把 `.symtab` 里这些条目的 `st_shndx` 改成 `SHN_ABS` 并直接写入地址，等于替内核完成了这一步。
   带 `__versions` 条目的符号说明它在链接时就已导出，内核自己能解析并做 CRC 校验，所以默认**不回填**
   它们（`symbol_mode=0`），免得白白绕开校验。
3. 参数通过 `load_module(info, uargs, flags)` 的 `uargs` 传入，必须是**用户空间**字符串；
   实现里把 `write()` 缓冲区末尾的换行改写成 NUL，再用该缓冲区内的偏移作为 `uargs`，
   避免依赖用户栈布局。

## 已知限制

- 需要内核导出 `sprint_symbol`（GKI 默认导出）。没有导出的自编译内核需要改 KallRecon 的锚点。
- 只支持 ARM64（x86_64 需自行在 ddk 里加 target，KallRecon 本身支持）。
- 目标 ko 不能被 strip 掉 `.symtab`，否则无法回填（会在日志里明确报 “no .symtab”）。
- `modversions` 严格匹配同 KMI 编译产物；跨版本请谨慎使用 `ignore_modversions`。
- Magisk 本身没有 WebUI 宿主，需要 KsuWebUI / MMRL 之类的容器打开 `webroot`。

## 致谢

- [KallRecon](https://github.com/Dere3046/KallRecon) — kallsyms 重建
- [KMSDK](https://github.com/Dere3046/KMSDK) — 依赖管理
- [Kernel-SU/lkmloader.ko](https://github.com/Kernel-SU/lkmloader.ko) — 加载流程与 ELF patch 思路
- [ddk](https://github.com/Ylarod/ddk) — 多版本内核构建

GPL-2.0
