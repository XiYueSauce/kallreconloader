/*
 * lkm.js - domain layer: module directory, config.json, loader control
 */
(function (global) {
  'use strict';

  var MOD_DIRS = ['/data/adb/modules/lkmloader', '/data/adb/modules_update/lkmloader'];
  var q = global.Shell.q;

  var state = {
    modDir: null,
    config: null
  };

  var DEFAULT_CONFIG = {
    version: 1,
    defaultStage: 'service',
    options: {
      ignoreVermagic: false,
      ignoreModversions: false,
      strictSymbols: true,
      verbose: true,
      keepExported: true
    },
    modules: []
  };

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /* ------------------------------------------------------------- utilities */

  function sanitizeName(name) {
    return String(name || '')
      .replace(/\.ko$/i, '')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^[._-]+/, '')
      .slice(0, 64) || 'module';
  }

  function nameVariants(name) {
    var set = [name, name.replace(/-/g, '_')];
    return set.filter(function (v, i) { return v && set.indexOf(v) === i; });
  }

  /*
   * Args travel through a shell command, a JSON string and the loader's
   * space separated protocol, so anything needing escaping is dropped instead
   * of silently corrupting the stored value.
   */
  function sanitizeArgs(args) {
    return String(args == null ? '' : args)
      .replace(/[\r\n\t"\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 512);
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return round1(bytes / 1024) + ' KB';
    return round1(bytes / 1048576) + ' MB';
  }

  function kmiFromKernel(kernel) {
    if (!kernel) return '—';
    var ver = kernel.split('-')[0].split('.').slice(0, 2).join('.');
    var m = kernel.match(/android(\d+)/);
    if (m) return 'android' + m[1] + '-' + ver;
    var table = { '5.10': 'android12', '5.15': 'android13', '6.1': 'android14', '6.6': 'android15', '6.12': 'android16' };
    return (table[ver] || 'android' + ver.split('.')[0]) + '-' + ver;
  }

  function parseVermagic(v, kernel, kmi) {
    if (!v) return null;
    var m = v.match(/android\d+-\d+\.\d+/);
    if (m) return m[0] === kmi;
    var ver = v.split(' ')[0].split('-')[0].split('.').slice(0, 2).join('.');
    return ver === String(kernel || '').split('-')[0].split('.').slice(0, 2).join('.');
  }

  /* --------------------------------------------------------------- storage */

  function resolveModDir() {
    if (state.modDir) return Promise.resolve(state.modDir);
    var script = MOD_DIRS.map(function (d) {
      return '[ -f ' + q(d + '/module.prop') + ' ] && echo ' + q(d);
    }).join('\n');
    return global.Shell.execOk(script).then(function (out) {
      var first = out.split('\n').filter(Boolean)[0];
      state.modDir = first || MOD_DIRS[0];
      return state.modDir;
    });
  }

  function configPath() {
    return state.modDir + '/config.json';
  }

  function serialize(cfg) {
    var mods = (cfg.modules || []).map(function (m) {
      return '{"name":' + JSON.stringify(m.name) +
        ',"path":' + JSON.stringify(m.path) +
        ',"args":' + JSON.stringify(m.args || '') +
        ',"stage":' + JSON.stringify(m.stage || 'service') +
        ',"enabled":' + (m.enabled === false ? 'false' : 'true') +
        ',"delay":' + (parseInt(m.delay, 10) || 0) + '}';
    });
    return [
      '{',
      '"version":1,',
      '"defaultStage":' + JSON.stringify(cfg.defaultStage || 'service') + ',',
      '"options":' + JSON.stringify(cfg.options || DEFAULT_CONFIG.options) + ',',
      '"modules":[',
      mods.join(',\n'),
      ']',
      '}',
      ''
    ].join('\n');
  }

  function loadConfig() {
    if (state.config) return Promise.resolve(state.config);
    return resolveModDir().then(function () {
      return global.Shell.readFile(configPath()).catch(function () { return ''; });
    }).then(function (text) {
      var cfg = clone(DEFAULT_CONFIG);
      try {
        var parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          cfg = {
            version: 1,
            defaultStage: parsed.defaultStage || 'service',
            options: Object.assign({}, DEFAULT_CONFIG.options, parsed.options || {}),
            modules: Array.isArray(parsed.modules) ? parsed.modules : []
          };
        }
      } catch (e) { /* first run, keep defaults */ }
      state.config = cfg;
      return cfg;
    });
  }

  function saveConfig(cfg) {
    state.config = cfg;
    return resolveModDir()
      .then(function () { return global.Shell.writeFile(configPath(), serialize(cfg)); })
      .then(function () { return cfg; });
  }

  /* ---------------------------------------------------------------- status */

  function readCtl() {
    return global.Shell.exec('cat /proc/lkmctl 2>/dev/null').then(function (res) {
      var map = {};
      res.out.split('\n').forEach(function (line) {
        var i = line.indexOf('=');
        if (i > 0) map[line.slice(0, i)] = line.slice(i + 1).trim();
      });
      return map;
    });
  }

  function readOptionsFile() {
    return resolveModDir().then(function () {
      return global.Shell.readFile(state.modDir + '/ko/options').catch(function () { return ''; });
    }).then(function (text) {
      var map = {};
      text.split('\n').forEach(function (line) {
        var m = line.match(/^([a-z_]+)=(.*)$/i);
        if (m) map[m[1]] = m[2].trim();
      });
      return map;
    });
  }

  function status() {
    return Promise.all([
      global.Shell.deviceInfo(),
      loadConfig(),
      readCtl(),
      resolveModDir().then(function () {
        return global.Shell.exists(state.modDir + '/ko/lkmloader.ko');
      })
    ]).then(function (r) {
      var info = r[0], cfg = r[1], ctl = r[2], koExists = r[3];
      var kmi = kmiFromKernel(info.kernel);
      var loaderUp = ctl.loader === 'lkmloader';
      var brand = (info.brand || '').replace(/^\w/, function (c) { return c.toUpperCase(); });
      var model = info.model || '未知设备';
      var device = brand && brand.toLowerCase() !== model.toLowerCase().split(' ')[0].toLowerCase()
        ? brand + ' ' + model
        : model;
      if (info.abi) device += ' (' + info.abi + ')';

      var compat = null;

      return {
        loaderUp: loaderUp,
        koExists: koExists,
        kernel: info.kernel || '—',
        kmi: kmi,
        device: device,
        soc: info.soc2 || info.soc || '—',
        android: info.android || '—',
        abi: info.abi || '—',
        selinux: info.selinux || '—',
        manager: info.manager || 'Unknown',
        blocked: String(info.moddis) === '1',
        symbols: parseInt(ctl.num_syms || '0', 10) || 0,
        layout: ctl.layout != null ? ctl.layout : '',
        loads: parseInt(ctl.loads || '0', 10) || 0,
        fails: parseInt(ctl.fails || '0', 10) || 0,
        symbolMode: ctl.symbol_mode === '1' ? 1 : 0,
        loaderVersion: ctl.version || '',
        lastTarget: ctl.last_target || '',
        lastPatched: parseInt(ctl.last_patched || '0', 10) || 0,
        lastNative: parseInt(ctl.last_native || '0', 10) || 0,
        lastErrno: ctl.last_errno,
        lastMsg: ctl.last_msg || '',
        compat: compat
      };
    });
  }

  /* --------------------------------------------------------------- modules */

  function refreshModules() {
    return loadConfig().then(function (cfg) {
      var mods = cfg.modules || [];
      if (!mods.length) return [];

      var check = mods.map(function (m) {
        return nameVariants(m.name).map(function (n) {
          return 'grep -q "^' + n + ' " /proc/modules 2>/dev/null && echo "' + m.name + ':1"';
        }).join('\n');
      }).join('\n');

      var vm = mods.map(function (m) {
        var f = q(m.path);
        return 'echo "##' + m.name + '"; ' +
          'v=$(strings -a ' + f + ' 2>/dev/null | grep -m1 "vermagic="); ' +
          '[ -n "$v" ] || v=$(grep -a -o "vermagic=[^ ]*" ' + f + ' 2>/dev/null | head -n1); ' +
          'echo "$v"';
      }).join('\n');

      return Promise.all([
        global.Shell.exec(check + '\n' + vm),
        global.Shell.deviceInfo()
      ]).then(function (r) {
        var out = r[0].out;
        var info = r[1];
        var kmi = kmiFromKernel(info.kernel);
        var loaded = {};
        var vermagic = {};
        var cur = null;
        out.split('\n').forEach(function (line) {
          line = line.trim();
          if (!line) return;
          if (line.slice(0, 2) === '##') { cur = line.slice(2); vermagic[cur] = ''; return; }
          if (/^[^:]+:[01]$/.test(line)) {
            var p = line.split(':');
            loaded[p[0]] = p[1] === '1';
            return;
          }
          if (cur && line.indexOf('vermagic=') === 0) vermagic[cur] = line.slice(9);
        });

        return mods.map(function (m) {
          var on = !!loaded[m.name];
          return Object.assign({}, m, {
            loaded: on,
            vermagic: vermagic[m.name] || '',
            _compatible: parseVermagic(vermagic[m.name], info.kernel, kmi)
          });
        });
      });
    });
  }

  /* ---------------------------------------------------------------- actions */

  function run(script) {
    return global.Shell.exec(script);
  }

  function loaderScript(body) {
    return [
      'LKM_MODDIR=' + q(state.modDir),
      'export LKM_MODDIR',
      '. "$LKM_MODDIR/common/funcs.sh"',
      body
    ].join('\n');
  }

  function loadOne(m) {
    return run(loaderScript(
      'lkm_load_one ' + q(m.name) + ' ' + q(m.path) + ' ' + q(sanitizeArgs(m.args))
    )).then(function (r) {
      return { ok: r.code === 0, out: (r.out || '').trim(), err: (r.err || '').trim() };
    });
  }

  function unloadOne(m) {
    return run(loaderScript('lkm_unload_one ' + q(m.name))).then(function (r) {
      var out = (r.out || '').trim();
      var m2 = out.match(/state=(\w+)(?::([\s\S]*))?/);
      var state = m2 ? m2[1] : 'failed';
      return {
        ok: state === 'unloaded' || state === 'absent',
        state: state,
        out: out,
        err: m2 && m2[2] ? m2[2] : (r.err || '').trim()
      };
    });
  }

  function reloadOne(m) {
    return unloadOne(m).then(function (u) {
      if (!u.ok) {
        return { ok: false, state: 'unload-failed', err: u.err || '卸载失败，已取消重载' };
      }
      return new Promise(function (res) { setTimeout(res, 180); }).then(function () {
        return loadOne(m);
      });
    });
  }

  function restartLoader() {
    return loadConfig().then(function (cfg) {
      var opts = cfg.options || {};
      var lines = [
        'verbose=' + (opts.verbose === false ? 0 : 1),
        'strict_symbols=' + (opts.strictSymbols === false ? 0 : 1),
        'symbol_mode=' + (opts.keepExported === false ? 1 : 0),
        'ignore_vermagic=' + (opts.ignoreVermagic ? 1 : 0),
        'ignore_modversions=' + (opts.ignoreModversions ? 1 : 0),
        'cleanup_mode=-1'
      ];
      return global.Shell.writeFile(state.modDir + '/ko/options', lines.join('\n') + '\n');
    }).then(function () {
      return run(loaderScript([
        'rmmod lkmloader 2>/dev/null',
        'sleep 0.2',
        'lkm_loader_up || { echo "state=unavailable"; exit 0; }',
        'echo "state=up"',
        'echo "code=$(lkm_ctl_get kallsyms)"',
        'echo "syms=$(lkm_ctl_get num_syms)"',
        'echo "version=$(lkm_ctl_get version)"',
        'echo "mode=$(lkm_ctl_get symbol_mode)"'
      ].join('\n')));
    }).then(function (r) {
      var out = r.out || '';
      var pick = function (key) {
        var m = out.match(new RegExp('^' + key + '=(.*)$', 'm'));
        return m ? m[1].trim() : '';
      };
      var syms = parseInt(pick('syms') || '0', 10);
      return {
        ok: /state=up/.test(out) && pick('code') === '1' && syms > 0,
        up: /state=up/.test(out),
        syms: syms,
        version: pick('version'),
        mode: pick('mode'),
        out: out
      };
    });
  }

  function logs() {
    return global.Shell.exec(
      'cat /proc/lkmlog 2>/dev/null; echo "@@BOOT@@"; ' +
      'tail -n 40 ' + q(state.modDir + '/logs/boot.log') + ' 2>/dev/null'
    ).then(function (r) {
      var parts = r.out.split('@@BOOT@@');
      return {
        loader: (parts[0] || '').replace(/^\s+|\s+$/g, ''),
        boot: (parts[1] || '').replace(/^\s+|\s+$/g, '')
      };
    });
  }

  function clearLog() {
    return run('printf "clear\\n" > /proc/lkmctl 2>/dev/null; ' +
      ': > ' + q(state.modDir + '/logs/boot.log') + ' 2>/dev/null; echo ok');
  }

  /*
   * Import validates what can be validated without a kernel: file type, size,
   * ELF class/type/machine and the copy itself. Anything deeper (vermagic,
   * modversions) is reported as a static hint only, never as a guarantee.
   */
  function importKo(src, displayName) {
    var base = sanitizeName(displayName || src.split('/').pop());
    var dest = state.modDir + '/lkm/' + base + '.ko';

    var check = [
      'src=' + q(src),
      '[ -f "$src" ] || { echo "!missing"; exit 0; }',
      'sz=$(stat -c %s "$src" 2>/dev/null)',
      '[ -n "$sz" ] || { echo "!stat"; exit 0; }',
      '[ "$sz" -gt 4096 ] && [ "$sz" -lt 67108864 ] || { echo "!size:$sz"; exit 0; }',
      'h=$(od -An -tx1 -N20 "$src" 2>/dev/null | tr -d " \\n")',
      '[ "${#h}" -ge 40 ] || { echo "!elf"; exit 0; }',
      'case "$h" in 7f454c46*) ;; *) echo "!elf"; exit 0 ;; esac',
      '[ "$(printf %s "$h" | cut -c5-6)" = "02" ] || { echo "!class"; exit 0; }',
      '[ "$(printf %s "$h" | cut -c33-34)" = "01" ] || { echo "!type"; exit 0; }',
      'em=$(printf %s "$h" | cut -c37-40)',
      'case "$(uname -m)" in aarch64) want=b700 ;; x86_64) want=3e00 ;; *) want=$em ;; esac',
      '[ "$em" = "$want" ] || { echo "!arch:$em"; exit 0; }',
      'mkdir -p ' + q(state.modDir + '/lkm'),
      'cp -f "$src" ' + q(dest) + ' || { echo "!copy"; exit 0; }',
      'chmod 0644 ' + q(dest) + ' 2>/dev/null',
      'dsz=$(stat -c %s ' + q(dest) + ' 2>/dev/null)',
      '[ "$dsz" = "$sz" ] || { echo "!verify"; exit 0; }',
      'echo "!ok"'
    ].join('\n');

    return run(check).then(function (r) {
      var out = (r.out || '').trim();
      if (out.indexOf('!ok') < 0) {
        var m = out.match(/!(\w+)(?::([^\n]*))?/);
        var kind = m ? m[1] : '';
        var extra = m && m[2] ? m[2] : '';
        var why = {
          missing: '源文件不存在',
          stat: '无法读取文件信息',
          size: '文件大小异常（' + extra + ' 字节）',
          elf: '不是有效的 ELF 文件',
          class: '不是 64 位 ELF',
          type: '不是可重定位目标（ET_REL），可能不是内核模块',
          arch: '架构不匹配：文件 ' + extra + '，设备 ' + (window.navigator.platform || '')
        }[kind] || '导入失败';
        if (kind === 'copy') why = '复制失败，请检查权限或存储空间';
        if (kind === 'verify') why = '复制校验失败（大小不一致）';
        throw new Error(why);
      }

      return loadConfig().then(function (cfg) {
        var exist = cfg.modules.filter(function (m) { return m.name === base; })[0];
        if (exist) {
          exist.path = dest;
          exist.enabled = true;
        } else {
          cfg.modules.push({
            name: base,
            path: dest,
            args: '',
            stage: cfg.defaultStage || 'service',
            enabled: true,
            delay: 0
          });
        }
        return saveConfig(cfg).then(function () {
          return { name: base, path: dest, replaced: !!exist };
        });
      });
    });
  }

  function updateModule(name, patch) {
    return loadConfig().then(function (cfg) {
      cfg.modules.forEach(function (m) {
        if (m.name === name) Object.assign(m, patch);
      });
      return saveConfig(cfg);
    });
  }

  function removeModule(name) {
    return loadConfig().then(function (cfg) {
      var target = cfg.modules.filter(function (m) { return m.name === name; })[0];
      cfg.modules = cfg.modules.filter(function (m) { return m.name !== name; });
      return saveConfig(cfg).then(function () {
        if (target) {
          var unload = nameVariants(target.name).map(function (n) {
            return 'grep -q "^' + n + ' " /proc/modules 2>/dev/null && rmmod ' + q(n) + ' 2>/dev/null';
          }).join('\n');
          return run(unload + '\nrm -f ' + q(target.path) + ' 2>/dev/null; echo ok');
        }
      });
    });
  }

  function saveOptions(patch) {
    return loadConfig().then(function (cfg) {
      cfg.options = Object.assign({}, cfg.options, patch);
      return saveConfig(cfg);
    });
  }

  function saveDefaultStage(stage) {
    return loadConfig().then(function (cfg) {
      cfg.defaultStage = stage;
      return saveConfig(cfg);
    });
  }

  /* ------------------------------------------------------------------- demo */

  function meta() {
    return resolveModDir().then(function () {
      return global.Shell.readFile(state.modDir + '/module.prop');
    }).then(function (text) {
      var out = {};
      text.split('\n').forEach(function (line) {
        var i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      return { id: out.id, version: out.version, name: out.name };
    }).catch(function () { return {}; });
  }

  var demoConfig = {
    version: 1,
    defaultStage: 'service',
    options: { ignoreVermagic: false, ignoreModversions: false, strictSymbols: true, verbose: true, keepExported: true },
    modules: [
      { name: 'droid_lkm', path: '/data/adb/modules/lkmloader/lkm/droid_lkm.ko', args: '', stage: 'post-fs-data', enabled: true, delay: 0 },
      { name: 'kpatch_probe', path: '/data/adb/modules/lkmloader/lkm/kpatch_probe.ko', args: 'log=1', stage: 'service', enabled: true, delay: 2 }
    ]
  };

  var demoLogs = {
    loader: [
      '[  0.842] kallsyms: 142103 symbols, layout 2, base 0xffffffc080000000',
      '[  0.844] load_module @ 0xffffffc080a3c1a4',
      '[  2.418] image /data/adb/modules/lkmloader/lkm/droid_lkm.ko: 184320 bytes',
      '[  2.425]   kallsyms_lookup_name                -> 0xffffffc080a3b8d0',
      '[  2.425]   register_kprobe                    -> 0xffffffc0803b2174',
      '[  2.426]   commit_creds                       -> 0xffffffc08021c1ac',
      '[  2.428] patch: 11 resolved, 0 unresolved, 0 weak',
      '[  2.431] load_module -> 0',
      '[  2.431] ok: loaded droid_lkm.ko (patched 11)'
    ].join('\n'),
    boot: [
      '[10-20 00:05:48] boot: stage=post-fs-data kmi=android16-6.12 manager=KernelSU uid=0',
      '[10-20 00:05:52] ok droid_lkm: loaded droid_lkm.ko (patched 11)',
      '[10-20 00:05:52] boot: stage=post-fs-data done'
    ].join('\n')
  };

  function demo() {
    var cfg = clone(demoConfig);
    return {
      demo: true,
      isDemo: true,
      humanSize: humanSize,
      sanitizeName: sanitizeName,
      kmiFromKernel: kmiFromKernel,
      status: function () {
        return Promise.resolve({
          loaderUp: true, koExists: true,
          kernel: '6.12.69-android16-6-g43b5ab7e247d-abogki61813157-4k',
          kmi: 'android16-6.12',
          device: 'Xiaomi 23127PN0CC (arm64-v8a)',
          soc: 'sun', android: '16', abi: 'arm64-v8a', selinux: 'Enforcing',
          manager: 'KernelSU', blocked: false,
          symbols: 142103, layout: '2', loads: 1, fails: 0,
          symbolMode: 0, loaderVersion: '1.1.0', lastTarget: 'droid_lkm.ko',
          lastPatched: 11, lastNative: 6,
          lastErrno: '0', lastMsg: 'loaded droid_lkm.ko (patched 11, native 6)',
          compat: true
        });
      },
      modules: function () {
        return Promise.resolve(cfg.modules.map(function (m, i) {
          return Object.assign({}, m, {
            loaded: i === 0,
            vermagic: '6.12.69-android16-6-g43b5ab7e247d SMP preempt mod_unload modversions aarch64',
            _compatible: true
          });
        }));
      },
      logs: function () { return Promise.resolve(demoLogs); },
      loadConfig: function () { return Promise.resolve(clone(cfg)); },
      options: function () { return Promise.resolve(cfg.options); },
      defaultStage: function () { return Promise.resolve(cfg.defaultStage); },
      loadOne: function () { return Promise.resolve({ ok: true, out: 'demo' }); },
      unloadOne: function () { return Promise.resolve({ ok: true, state: 'unloaded', out: 'state=unloaded' }); },
      reloadOne: function () { return Promise.resolve({ ok: true, out: 'demo' }); },
      restartLoader: function () {
        return Promise.resolve({ ok: true, up: true, syms: 142103, version: '1.1.0', mode: '0', out: 'state=up' });
      },
      clearLog: function () { demoLogs.loader = ''; return Promise.resolve(); },
      sanitizeArgs: sanitizeArgs,
      importKo: function (src, name) {
        return Promise.resolve({ name: sanitizeName(name || 'demo'), path: src, replaced: false });
      },
      updateModule: function (name, patch) {
        cfg.modules.forEach(function (m) { if (m.name === name) Object.assign(m, patch); });
        return Promise.resolve();
      },
      removeModule: function (name) {
        cfg.modules = cfg.modules.filter(function (m) { return m.name !== name; });
        return Promise.resolve();
      },
      saveOptions: function (patch) { Object.assign(cfg.options, patch); return Promise.resolve(); },
      saveDefaultStage: function (s) { cfg.defaultStage = s; return Promise.resolve(); },
      readOptionsFile: function () {
        return Promise.resolve({
          verbose: '1', strict_symbols: '1', symbol_mode: '0', ignore_vermagic: '0',
          ignore_modversions: '0', cleanup_mode: '-1'
        });
      },
      meta: function () {
        return Promise.resolve({ id: 'lkmloader', version: 'v1.1.0', name: 'LKM Loader' });
      },
      listDir: function (path) {
        var rows = path === '/sdcard/Download' ? [
          { type: 'dir', size: 0, name: 'Magisk' },
          { type: 'file', size: 188416, name: 'droid_lkm.ko' },
          { type: 'file', size: 92160, name: 'kpatch_probe.ko' },
          { type: 'file', size: 4211, name: 'readme.txt' }
        ] : [
          { type: 'dir', size: 0, name: 'Download' },
          { type: 'dir', size: 0, name: 'Android' },
          { type: 'file', size: 51200, name: 'demo.ko' }
        ];
        return Promise.resolve(rows);
      }
    };
  }

  var api = {
    isDemo: !global.Shell.available,
    resolveModDir: resolveModDir,
    get modDir() { return state.modDir; },
    kmiFromKernel: kmiFromKernel,
    humanSize: humanSize,
    sanitizeName: sanitizeName,
    sanitizeArgs: sanitizeArgs,
    status: status,
    modules: refreshModules,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    readOptionsFile: readOptionsFile,
    loadOne: loadOne,
    unloadOne: unloadOne,
    reloadOne: reloadOne,
    restartLoader: restartLoader,
    logs: logs,
    clearLog: clearLog,
    importKo: function (src, name) {
      return resolveModDir().then(function () { return importKo(src, name); });
    },
    updateModule: function (name, patch) {
      return loadConfig().then(function () { return updateModule(name, patch); });
    },
    removeModule: function (name) {
      return loadConfig().then(function () { return removeModule(name); });
    },
    saveOptions: function (patch) {
      return loadConfig().then(function () { return saveOptions(patch); });
    },
    saveDefaultStage: function (stage) {
      return loadConfig().then(function () { return saveDefaultStage(stage); });
    },
    meta: meta,
    listDir: function (path) {
      return global.Shell.listDir(path);
    }
  };

  global.LKM = global.Shell.available ? api : demo();
  global.LKM.real = api;
})(window);
