/*
 * lkm.js - domain layer: module directory, config.json, loader control
 */
(function (global) {
  'use strict';

  var MOD_DIRS = ['/data/adb/modules/lkmloader', '/data/adb/modules_update/lkmloader'];
  var q = global.Shell.q;

  var state = {
    modDir: null,
    config: null,
    device: null,
    vermagic: {},
    /* modules loaded through the WebUI without being added to config.json;
       they only live for this session, they are never written to disk */
    hot: []
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

  /* the kernel derives a module name from the file name by replacing every
     byte outside [A-Za-z0-9_] with '_'; /proc/modules only shows that form */
  function kernelName(name) {
    return String(name || '')
      .replace(/\.ko$/i, '')
      .replace(/[^A-Za-z0-9_]/g, '_');
  }

  /*
   * A renamed file is the same module: file managers add " (1)", " - copy",
   * "_1" and so on, and the kernel keeps the name it was loaded under. Strip
   * those decorations so an entry can still be matched to its module.
   */
  function cleanName(name) {
    var k = kernelName(name);
    var prev = '';
    while (k && k !== prev) {
      prev = k;
      k = k
        .replace(/\s*\(\d+\)$/, '')          /* module (1) */
        .replace(/[_\-.]{1,2}\d+$/, '')       /* module_1 / module__1 / module-1 */
        .replace(/_+$/, '');
    }
    return k || kernelName(name);
  }

  function baseName(path) {
    return String(path || '').split('/').pop();
  }

  function nameVariants(name) {
    var k = kernelName(name);
    var set = [name, k, k.replace(/_/g, '-')];
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

  /* the promise itself is memoized: several parts of the UI ask for the
     module dir at once and none of them should pay for a second shell */
  var modDirPromise = null;

  function resolveModDir() {
    if (state.modDir) return Promise.resolve(state.modDir);
    if (modDirPromise) return modDirPromise;

    var script = MOD_DIRS.map(function (d) {
      return '[ -f ' + q(d + '/module.prop') + ' ] && echo ' + q(d);
    }).join('\n');

    modDirPromise = global.Shell.execOk(script).then(function (out) {
      var first = out.split('\n').filter(Boolean)[0];
      state.modDir = first || MOD_DIRS[0];
      return state.modDir;
    }, function (e) {
      modDirPromise = null;
      throw e;
    });

    return modDirPromise;
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
        ',"delay":' + (parseInt(m.delay, 10) || 0) +
        (m.loadedAs ? ',"loadedAs":' + JSON.stringify(m.loadedAs) : '') +
        '}';
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

  var configPromise = null;

  function loadConfig() {
    if (state.config) return Promise.resolve(state.config);
    if (configPromise) return configPromise;

    configPromise = resolveModDir().then(function () {
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
      configPromise = null;
      return cfg;
    }, function (e) {
      configPromise = null;
      throw e;
    });

    return configPromise;
  }

  function saveConfig(cfg) {
    state.config = cfg;
    return resolveModDir()
      .then(function () { return global.Shell.writeFile(configPath(), serialize(cfg)); })
      .then(function () { return cfg; });
  }

  /* ---------------------------------------------------------------- status */

  /*
   * One shell for the whole status page. Every exec costs a WebView round
   * trip, so device properties, the loader's /proc/lkmctl dump and the
   * presence checks are collected together instead of in four calls.
   */
  function probe() {
    var ko = state.modDir + '/ko/lkmloader.ko';
    var script = [
      'echo "@kernel=$(uname -r 2>/dev/null)"',
      'echo "@model=$(getprop ro.product.model 2>/dev/null)"',
      'echo "@brand=$(getprop ro.product.brand 2>/dev/null)"',
      'echo "@soc=$(getprop ro.board.platform 2>/dev/null)"',
      'echo "@soc2=$(getprop ro.soc.model 2>/dev/null)"',
      'echo "@android=$(getprop ro.build.version.release 2>/dev/null)"',
      'echo "@abi=$(getprop ro.product.cpu.abi 2>/dev/null)"',
      'echo "@selinux=$(getenforce 2>/dev/null)"',
      'echo "@moddis=$(cat /proc/sys/kernel/modules_disabled 2>/dev/null)"',
      'if [ -d /data/adb/ksu ] || [ -d /data/adb/ksud ]; then echo "@manager=KernelSU"; ' +
        'elif [ -d /data/adb/ap ]; then echo "@manager=APatch"; ' +
        'elif [ -d /data/adb/magisk ]; then echo "@manager=Magisk"; ' +
        'else echo "@manager=Unknown"; fi',
      'echo "@uid=$(id -u 2>/dev/null)"',
      '[ -f ' + q(ko) + ' ] && echo "@ko=1" || echo "@ko=0"',
      'echo "@lmod=$(awk \'$1=="lkmloader"{f=1} END{print f+0}\' /proc/modules 2>/dev/null)"',
      'echo "@ctl_begin"',
      'cat /proc/lkmctl 2>/dev/null',
      'echo "@ctl_end"'
    ].join('\n');

    return global.Shell.exec(script, { timeout: 12000 }).then(function (res) {
      var dev = {};
      var ctl = {};
      var inCtl = false;

      res.out.split('\n').forEach(function (line) {
        var t = line.replace(/\s+$/, '');
        if (t === '@ctl_begin') { inCtl = true; return; }
        if (t === '@ctl_end') { inCtl = false; return; }
        if (inCtl) {
          var i = t.indexOf('=');
          if (i > 0) ctl[t.slice(0, i)] = t.slice(i + 1).trim();
          return;
        }
        var m = t.match(/^@([a-z0-9_]+)=(.*)$/i);
        if (m) dev[m[1]] = m[2].trim();
      });

      return { dev: dev, ctl: ctl };
    });
  }

  function status() {
    return resolveModDir().then(function () {
      return probe();
    }).then(function (p) {
      var info = p.dev;
      var ctl = p.ctl;
      var kmi = kmiFromKernel(info.kernel);

      state.device = info;
      global.Shell.setDevice(info);

      var ctlReadable = ctl.loader === 'lkmloader';
      var inModules = info.lmod === '1';
      var brand = (info.brand || '').replace(/^\w/, function (c) { return c.toUpperCase(); });
      var model = info.model || '未知设备';
      var device = brand && brand.toLowerCase() !== model.toLowerCase().split(' ')[0].toLowerCase()
        ? brand + ' ' + model
        : model;
      if (info.abi) device += ' (' + info.abi + ')';

      return {
        /* /proc/lkmctl is the authoritative source, but a loaded module also
           shows up in /proc/modules - if only the latter is true the loader
           runs and the proc file is unreadable, which is not "not loaded" */
        loaderUp: ctlReadable || inModules,
        ctlReadable: ctlReadable,
        koExists: info.ko === '1',
        kernel: info.kernel || '—',
        kmi: kmi,
        device: device,
        soc: info.soc2 || info.soc || '—',
        android: info.android || '—',
        abi: info.abi || '—',
        selinux: info.selinux || '—',
        manager: info.manager || 'Unknown',
        uid: info.uid || '',
        blocked: String(info.moddis) === '1',
        symbols: parseInt(ctl.num_syms || '0', 10) || 0,
        layout: ctl.layout != null ? ctl.layout : '',
        loads: parseInt(ctl.loads || '0', 10) || 0,
        fails: parseInt(ctl.fails || '0', 10) || 0,
        seq: parseInt(ctl.seq || '0', 10) || 0,
        cacheHits: parseInt(ctl.cache_hits || '0', 10) || 0,
        cacheUsed: parseInt(ctl.cache_used || '0', 10) || 0,
        symbolMode: ctl.symbol_mode === '1' ? 1 : 0,
        loaderVersion: ctl.version || '',
        lastTarget: ctl.last_target || '',
        lastPatched: parseInt(ctl.last_patched || '0', 10) || 0,
        lastNative: parseInt(ctl.last_native || '0', 10) || 0,
        lastErrno: ctl.last_errno,
        lastMsg: ctl.last_msg || ''
      };
    });
  }

  /* cheap tick for the poll: loader seq + liveness, nothing else */
  function tick() {
    var script = [
      'awk \'$1=="lkmloader"{f=1} END{print "lmod=" f+0}\' /proc/modules 2>/dev/null',
      'sed -n "s/^seq=//p" /proc/lkmctl 2>/dev/null | head -n1 | sed "s/^/seq=/"',
      'sed -n "s/^loads=//p" /proc/lkmctl 2>/dev/null | head -n1 | sed "s/^/loads=/"',
      'sed -n "s/^fails=//p" /proc/lkmctl 2>/dev/null | head -n1 | sed "s/^/fails=/"',
      'sed -n "s/^num_syms=//p" /proc/lkmctl 2>/dev/null | head -n1 | sed "s/^/num_syms=/"',
      'sed -n "s/^cache_used=//p" /proc/lkmctl 2>/dev/null | head -n1 | sed "s/^/cache_used=/"',
      'sed -n "s/^cache_hits=//p" /proc/lkmctl 2>/dev/null | head -n1 | sed "s/^/cache_hits=/"',
      'sed -n "s/^last_msg=//p" /proc/lkmctl 2>/dev/null | head -n1 | sed "s/^/last_msg=/"'
    ].join('\n');

    return global.Shell.exec(script, { timeout: 8000 }).then(function (res) {
      var map = {};
      res.out.split('\n').forEach(function (line) {
        var i = line.indexOf('=');
        if (i > 0) map[line.slice(0, i)] = line.slice(i + 1).trim();
      });
      return {
        loaderUp: map.lmod === '1' || map.seq !== undefined,
        ctlReadable: map.seq !== undefined,
        seq: parseInt(map.seq || '0', 10) || 0,
        loads: parseInt(map.loads || '0', 10) || 0,
        fails: parseInt(map.fails || '0', 10) || 0,
        symbols: parseInt(map.num_syms || '0', 10) || 0,
        cacheUsed: parseInt(map.cache_used || '0', 10) || 0,
        cacheHits: parseInt(map.cache_hits || '0', 10) || 0,
        lastMsg: map.last_msg || ''
      };
    });
  }

  function readCtl() {
    return global.Shell.exec('cat /proc/lkmctl 2>/dev/null', { timeout: 8000 }).then(function (res) {
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

  /* --------------------------------------------------------------- modules */

  function moduleEntries(cfg) {
    var list = (cfg.modules || []).map(function (m) {
      return Object.assign({}, m, { hot: false });
    });
    state.hot.forEach(function (h) {
      var dup = list.some(function (m) { return kernelName(m.name) === kernelName(h.name); });
      if (dup) return;
      list.push({
        name: h.name,
        path: h.path,
        args: h.args || '',
        stage: 'manual',
        enabled: false,
        delay: 0,
        hot: true
      });
    });
    return list;
  }

  /* one awk pass over /proc/modules answers "which of these are loaded" */
  function loadedSet(entries) {
    if (!entries.length) return Promise.resolve({});

    var want = [];
    entries.forEach(function (m) {
      nameVariants(m.name)
        .concat(m.loadedAs ? nameVariants(m.loadedAs) : [])
        .concat(nameVariants(cleanName(m.loadedAs || m.name)))
        .forEach(function (v) {
          if (v && want.indexOf(v) < 0) want.push(v);
        });
    });

    var script = 'awk -v want=' + q(want.join(' ')) + ' \'BEGIN{' +
      'n=split(want,a," "); for(i=1;i<=n;i++) w[a[i]]=1}' +
      '{ name=$1; if (name in w) print name; gsub(/-/,"_",name); if (name in w) print name }\' ' +
      '/proc/modules 2>/dev/null';

    return global.Shell.exec(script, { timeout: 8000 }).then(function (res) {
      var set = {};
      res.out.split('\n').forEach(function (line) {
        var k = line.trim();
        if (k) set[k] = true;
      });
      return set;
    });
  }

  /*
   * vermagic is read once per file per session. .modinfo is a run of NUL
   * terminated strings, so it is turned into lines first: anchoring on
   * `^vermagic=` keeps module parameters such as ignore_vermagic out of the
   * result, and `-m1` stops reading at the first hit. The plain grep is the
   * fallback for images where tr trips over binary data.
   */
  function loadVermagic(entries) {
    var todo = entries.filter(function (m) {
      return m.path && state.vermagic[m.path] === undefined;
    });
    if (!todo.length) return Promise.resolve();

    var script = todo.map(function (m) {
      var f = q(m.path);
      return 'echo "##' + m.path + '"; ' +
        'v=$(tr "\\0" "\\n" <' + f + ' 2>/dev/null | grep -m1 \'^vermagic=\' | cut -d= -f2-); ' +
        '[ -n "$v" ] || v=$(grep -a -o -m1 \'vermagic=[0-9][^ ]*\' ' + f + ' 2>/dev/null | cut -d= -f2-); ' +
        'echo "$v"';
    }).join('\n');

    return global.Shell.exec(script, { timeout: 20000 }).then(function (res) {
      var cur = null;
      res.out.split('\n').forEach(function (line) {
        var t = line.replace(/\r$/, '');
        if (!t) return;                  /* the trailing newline would blank the last entry */
        if (t.slice(0, 2) === '##') { cur = t.slice(2); state.vermagic[cur] = ''; return; }
        if (cur && t.indexOf('vermagic=') !== 0) state.vermagic[cur] = t.trim();
      });
    }, function () { /* vermagic is a hint only, never fail the page on it */ });
  }

  function forgetVermagic(path) {
    delete state.vermagic[path];
  }

  /*
   * Match an entry to a loaded module. Exact names first (config name and the
   * name recorded at load time), then one cleaned-name pass. The fallback
   * refuses a name another entry already owns, so two builds of the same
   * module cannot both claim one loaded instance.
   */
  function matchLoaded(entry, set, owners) {
    var exact = nameVariants(entry.name);
    if (entry.loadedAs) exact = exact.concat(nameVariants(entry.loadedAs));

    for (var i = 0; i < exact.length; i++) {
      if (set[exact[i]]) return { name: exact[i], alias: false };
    }

    var cands = nameVariants(cleanName(entry.loadedAs || entry.name));
    for (var j = 0; j < cands.length; j++) {
      if (!set[cands[j]]) continue;
      if (owners[cands[j]] && owners[cands[j]] !== entry.name) continue;
      return { name: cands[j], alias: true };
    }
    return null;
  }

  function refreshModules() {
    return loadConfig().then(function (cfg) {
      var entries = moduleEntries(cfg);
      var owners = {};
      entries.forEach(function (m) {
        nameVariants(m.name)
          .concat(m.loadedAs ? nameVariants(m.loadedAs) : [])
          .forEach(function (v) { owners[v] = m.name; });
      });

      return loadVermagic(entries).then(function () {
        return loadedSet(entries);
      }).then(function (set) {
        return global.Shell.deviceInfo().catch(function () { return {}; }).then(function (info) {
          var kmi = kmiFromKernel(info.kernel);
          return entries.map(function (m) {
            var hit = matchLoaded(m, set, owners);
            var vm = state.vermagic[m.path] || '';
            return Object.assign({}, m, {
              loaded: !!hit,
              loadedName: hit ? hit.name : '',
              loadedAlias: hit ? hit.alias : false,
              vermagic: vm,
              _compatible: parseVermagic(vm, info.kernel, kmi)
            });
          });
        });
      });
    });
  }

  /* ---------------------------------------------------------------- actions */

  function run(script, options) {
    return global.Shell.exec(script, options);
  }

  function loaderScript(body) {
    return [
      'LKM_MODDIR=' + q(state.modDir),
      'export LKM_MODDIR',
      '. "$LKM_MODDIR/common/funcs.sh"',
      body
    ].join('\n');
  }

  /*
   * The kernel names a module after the file it was handed, so record that name
   * on a successful load: renaming the file afterwards must not make the entry
   * look unloaded, and the next boot loads it under the new file name.
   */
  function noteLoaded(m) {
    var actual = kernelName(baseName(m.path));
    if (!actual) return Promise.resolve();

    var hot = state.hot.filter(function (h) {
      return h.path === m.path || kernelName(h.name) === kernelName(m.name);
    })[0];
    if (hot) {
      hot.loadedAs = actual;
      return Promise.resolve();
    }

    return loadConfig().then(function (cfg) {
      var e = cfg.modules.filter(function (x) { return x.name === m.name; })[0];
      if (!e || e.loadedAs === actual) return null;
      e.loadedAs = actual;
      return saveConfig(cfg);
    }).catch(function () { return null; });
  }

  function loadOne(m) {
    return run(loaderScript(
      'lkm_load_one ' + q(m.name) + ' ' + q(m.path) + ' ' + q(sanitizeArgs(m.args))
    )).then(function (r) {
      var res = { ok: r.code === 0, out: (r.out || '').trim(), err: (r.err || '').trim() };
      if (!res.ok) return res;
      return noteLoaded(m).then(function () { return res; });
    });
  }

  function unloadOne(m) {
    /* a renamed entry carries the kernel name it was matched by */
    var target = m.loadedName || m.name;
    return run(loaderScript('lkm_unload_one ' + q(target))).then(function (r) {
      var out = (r.out || '').trim();
      var m2 = out.match(/state=(\w+)(?::([\s\S]*))?/);
      var st = m2 ? m2[1] : 'failed';
      return {
        ok: st === 'unloaded' || st === 'absent',
        state: st,
        out: out,
        err: m2 && m2[2] ? m2[2] : (r.err || '').trim()
      };
    });
  }

  /*
   * Hot load: hand any .ko to the loader straight from where it lies. Nothing
   * is copied and nothing is written to config.json, so it disappears on
   * reboot unless the user later adds it to the boot list.
   */
  function hotLoad(path, args) {
    var name = kernelName(baseName(path));
    return run(loaderScript(
      'lkm_load_one ' + q(name) + ' ' + q(path) + ' ' + q(sanitizeArgs(args))
    ), { timeout: 40000 }).then(function (r) {
      var out = (r.out || '').trim();
      var err = (r.err || '').trim();
      var ok = r.code === 0;
      if (ok) {
        var exist = state.hot.filter(function (h) { return h.path === path; })[0];
        if (exist) {
          exist.args = sanitizeArgs(args);
          exist.name = name;
          exist.loadedAs = name;
        } else {
          state.hot.push({ name: name, path: path, args: sanitizeArgs(args), loadedAs: name });
        }
        forgetVermagic(path);
      }
      return { ok: ok, name: name, out: out, err: err || (ok ? '' : out) };
    });
  }

  /* unload anything currently in /proc/modules, hot or configured */
  function unloadByName(name) {
    return run(loaderScript('lkm_unload_one ' + q(name)), { timeout: 30000 }).then(function (r) {
      var out = (r.out || '').trim();
      var m = out.match(/state=(\w+)(?::([\s\S]*))?/);
      var st = m ? m[1] : 'failed';
      if (st !== 'failed') {
        state.hot = state.hot.filter(function (h) {
          return kernelName(h.name) !== kernelName(name);
        });
      }
      return {
        ok: st === 'unloaded' || st === 'absent',
        state: st,
        err: m && m[2] ? m[2] : (r.err || '').trim()
      };
    });
  }

  /* register a hot loaded file for boot without copying it into the module */
  function addToBoot(path, args) {
    return loadConfig().then(function (cfg) {
      var name = kernelName(baseName(path));
      var exist = cfg.modules.filter(function (m) { return kernelName(m.name) === name; })[0];
      if (exist) {
        exist.path = path;
        exist.args = sanitizeArgs(args);
        exist.enabled = true;
      } else {
        cfg.modules.push({
          name: name,
          path: path,
          args: sanitizeArgs(args),
          stage: cfg.defaultStage || 'service',
          enabled: true,
          delay: 0
        });
      }
      return saveConfig(cfg).then(function () {
        state.hot = state.hot.filter(function (h) { return kernelName(h.name) !== name; });
        return { name: name };
      });
    });
  }

  /* every module the kernel currently has, for the "loaded" sheet */
  function loadedModules() {
    var script = 'awk \'{ printf "%s\\037%s\\037%s\\037%s\\037%s\\n", $1, $2, $3, $4, $5 }\' ' +
      '/proc/modules 2>/dev/null';

    return global.Shell.exec(script, { timeout: 10000 }).then(function (res) {
      var rows = [];
      res.out.split('\n').forEach(function (line) {
        if (!line) return;
        var p = line.split('\u001f');
        if (p.length < 5) return;
        rows.push({
          name: p[0],
          size: parseInt(p[1], 10) || 0,
          refs: parseInt(p[2], 10) || 0,
          deps: p[3] === '-' ? '' : p[3],
          modState: p[4]
        });
      });
      rows.sort(function (a, b) { return a.name.localeCompare(b.name, 'en'); });
      return rows;
    });
  }

  /* ---------------------------------------------------------------- upload */

  var HOT_DIR = '/data/local/tmp/lkm_hot';

  function bytesToBase64(bytes) {
    var step = 0x8000;
    var out = '';
    for (var i = 0; i < bytes.length; i += step) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return global.btoa(out);
  }

  /* a file picked through the Android chooser is a content:// blob: no path,
     so the bytes are checked here before anything touches the device */
  function readBlob(file) {
    if (!file) return Promise.reject(new Error('没有选择文件'));
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      if (bytes.length < 4096 || bytes.length > 67108864) {
        throw new Error('文件大小异常（' + bytes.length + ' 字节）');
      }
      if (!(bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)) {
        throw new Error('不是有效的 ELF 文件');
      }
      if (bytes[4] !== 2) throw new Error('不是 64 位 ELF');
      if (bytes[16] !== 1) throw new Error('不是可重定位目标（ET_REL），可能不是内核模块');
      return bytes;
    });
  }

  /*
   * base64 in 32 KB appends, decoded on the device, then the byte count is
   * read back. One command per chunk keeps every exec well below any bridge
   * or argv limit.
   */
  function uploadBlob(bytes, dest) {
    var tmp = dest + '.b64';
    var b64 = bytesToBase64(bytes);
    var CHUNK = 32000;
    var parts = [];
    for (var i = 0; i < b64.length; i += CHUNK) parts.push(b64.slice(i, i + CHUNK));

    return global.Shell.exec(
      'mkdir -p ' + q(dest.replace(/\/[^/]+$/, '')) + '\n: > ' + q(tmp)
    ).then(function () {
      return parts.reduce(function (chain, part) {
        return chain.then(function () {
          return global.Shell.exec('printf %s ' + q(part) + ' >> ' + q(tmp), { timeout: 20000 })
            .then(function (r) {
              if (r.code !== 0) throw new Error((r.err || '写入失败').trim());
            });
        });
      }, Promise.resolve());
    }).then(function () {
      return global.Shell.exec(
        'base64 -d ' + q(tmp) + ' > ' + q(dest) + ' 2>/dev/null; ' +
        'rm -f ' + q(tmp) + '; stat -c %s ' + q(dest) + ' 2>/dev/null'
      );
    }).then(function (r) {
      var size = parseInt((r.out || '').trim(), 10) || 0;
      if (size !== bytes.length) {
        throw new Error('写入校验失败（' + size + '/' + bytes.length + ' 字节）');
      }
      forgetVermagic(dest);
      return { path: dest, size: size };
    });
  }

  /* import: keep the file in the module, add it to the boot list */
  function importBlob(file) {
    var base = sanitizeName(file && file.name ? file.name : 'module');

    return readBlob(file).then(function (bytes) {
      return resolveModDir().then(function () {
        var dest = state.modDir + '/lkm/' + base + '.ko';
        return uploadBlob(bytes, dest).then(function (up) {
          return loadConfig().then(function (cfg) {
            var exist = cfg.modules.filter(function (m) { return nameVariants(m.name).indexOf(base) >= 0; })[0];
            if (exist) {
              exist.path = up.path;
              exist.enabled = true;
            } else {
              cfg.modules.push({
                name: base,
                path: up.path,
                args: '',
                stage: cfg.defaultStage || 'service',
                enabled: true,
                delay: 0
              });
            }
            return saveConfig(cfg).then(function () {
              return { name: base, path: up.path, replaced: !!exist, size: up.size };
            });
          });
        });
      });
    });
  }

  /*
   * hot load: the picked file is dropped in /data/local/tmp and handed to the
   * loader from there. Nothing is added to config.json, so it is gone after a
   * reboot unless the user keeps it from the module card.
   */
  function hotLoadBlob(file) {
    var base = sanitizeName(file && file.name ? file.name : 'module');

    return readBlob(file).then(function (bytes) {
      return uploadBlob(bytes, HOT_DIR + '/' + base + '.ko').then(function (up) {
        var name = kernelName(base);
        return run(loaderScript(
          'lkm_load_one ' + q(name) + ' ' + q(up.path) + " ''"
        ), { timeout: 40000 }).then(function (r) {
          var out = (r.out || '').trim();
          var err = (r.err || '').trim();
          var ok = r.code === 0;
          if (ok) {
            var exist = state.hot.filter(function (h) { return h.path === up.path; })[0];
            if (exist) { exist.name = name; exist.loadedAs = name; }
            else state.hot.push({ name: name, path: up.path, args: '', loadedAs: name });
          }
          return { ok: ok, name: name, path: up.path, out: out, err: err || (ok ? '' : out) };
        });
      });
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
      ].join('\n')), { timeout: 40000 });
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
      'tail -n 40 ' + q(state.modDir + '/logs/boot.log') + ' 2>/dev/null',
      { timeout: 12000 }
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
      '[ "$(printf %s "$h" | cut -c9-10)" = "02" ] || { echo "!class"; exit 0; }',
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
          arch: '架构不匹配：文件 ' + extra + '，设备 ' +
            ((global.navigator && global.navigator.platform) || '')
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
        forgetVermagic(dest);
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

  function removeModule(name, loadedName) {
    return loadConfig().then(function (cfg) {
      var target = cfg.modules.filter(function (m) { return m.name === name; })[0];
      cfg.modules = cfg.modules.filter(function (m) { return m.name !== name; });
      return saveConfig(cfg).then(function () {
        if (!target) return;
        /* only files the module itself copied may be deleted; a hot loaded
           module still lives wherever the user picked it */
        var owned = target.path && target.path.indexOf(state.modDir + '/') === 0;
        var names = nameVariants(target.name);
        if (loadedName) names = names.concat(nameVariants(loadedName));
        if (target.loadedAs) names = names.concat(nameVariants(target.loadedAs));
        var unload = names.map(function (n) {
          return 'grep -q "^' + n + ' " /proc/modules 2>/dev/null && rmmod ' + q(n) + ' 2>/dev/null';
        }).join('\n');
        var lines = [unload];
        if (owned) lines.push('rm -f ' + q(target.path) + ' 2>/dev/null');
        lines.push('echo ok');
        return run(lines.join('\n')).then(function () { return { removedFile: !!owned }; });
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
    var demoLoaded = [
      { name: 'droid_lkm', size: 184320, refs: 0, deps: '', modState: 'Live' },
      { name: 'lkmloader', size: 347112, refs: 0, deps: '', modState: 'Live' },
      { name: 'wlan', size: 9124864, refs: 1, deps: 'cfg80211', modState: 'Live' }
    ];

    return {
      demo: true,
      isDemo: true,
      humanSize: humanSize,
      sanitizeName: sanitizeName,
      kernelName: kernelName,
      baseName: baseName,
      sanitizeArgs: sanitizeArgs,
      kmiFromKernel: kmiFromKernel,
      status: function () {
        return Promise.resolve({
          loaderUp: true, ctlReadable: true, koExists: true,
          kernel: '6.12.69-android16-6-g43b5ab7e247d-abogki61813157-4k',
          kmi: 'android16-6.12',
          device: 'Xiaomi 23127PN0CC (arm64-v8a)',
          soc: 'sun', android: '16', abi: 'arm64-v8a', selinux: 'Enforcing',
          manager: 'KernelSU', uid: '0', blocked: false,
          symbols: 142103, layout: '2', loads: 1, fails: 0, seq: 7,
          cacheUsed: 38, cacheHits: 12,
          symbolMode: 0, loaderVersion: '1.2.9', lastTarget: 'droid_lkm.ko',
          lastPatched: 11, lastNative: 6,
          lastErrno: '0', lastMsg: 'loaded droid_lkm.ko (patched 11, native 6)'
        });
      },
      tick: function () {
        return Promise.resolve({
          loaderUp: true, ctlReadable: true, seq: 7, loads: 1, fails: 0,
          symbols: 142103, cacheUsed: 38, cacheHits: 12, lastMsg: 'demo'
        });
      },
      ctl: function () {
        return Promise.resolve({
          loader: 'lkmloader', version: '1.2.9', num_syms: '142103',
          layout: '2', seq: '7', loads: '1', fails: '0', symbol_mode: '0',
          cache_used: '38', cache_hits: '12', cache_misses: '94',
          last_target: 'droid_lkm.ko', last_patched: '11', last_native: '6',
          last_miss: '0', last_errno: '0',
          last_msg: 'loaded droid_lkm.ko (patched 11, native 6)'
        });
      },
      modules: function () {
        return Promise.resolve(cfg.modules.map(function (m, i) {
          return Object.assign({}, m, {
            hot: false,
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
      hotLoad: function (path) {
        return Promise.resolve({ ok: true, name: sanitizeName(path.split('/').pop()), out: 'demo' });
      },
      unloadByName: function () { return Promise.resolve({ ok: true, state: 'unloaded' }); },
      addToBoot: function (path) {
        return Promise.resolve({ name: sanitizeName(path.split('/').pop()) });
      },
      loadedModules: function () { return Promise.resolve(demoLoaded.slice()); },
      restartLoader: function () {
        return Promise.resolve({ ok: true, up: true, syms: 142103, version: '1.2.9', mode: '0', out: 'state=up' });
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
        return Promise.resolve({ id: 'lkmloader', version: 'v1.2.9', name: 'LKM Loader' });
      },
      importBlob: function (file) {
        return Promise.resolve({ name: sanitizeName(file && file.name), path: '/lkm', replaced: false, size: 1 });
      },
      hotLoadBlob: function (file) {
        return Promise.resolve({
          ok: true,
          name: sanitizeName(file && file.name),
          path: '/data/local/tmp/lkm_hot/x.ko',
          out: 'demo'
        });
      }
    };
  }

  var api = {
    isDemo: !global.Shell.available,
    resolveModDir: resolveModDir,
    get modDir() { return state.modDir; },
    get hot() { return state.hot; },
    kmiFromKernel: kmiFromKernel,
    humanSize: humanSize,
    sanitizeName: sanitizeName,
    sanitizeArgs: sanitizeArgs,
    baseName: baseName,
    kernelName: kernelName,
    status: status,
    tick: tick,
    ctl: readCtl,
    modules: refreshModules,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    readOptionsFile: readOptionsFile,
    loadOne: loadOne,
    unloadOne: unloadOne,
    reloadOne: reloadOne,
    hotLoad: function (path, args) {
      return resolveModDir().then(function () { return hotLoad(path, args); });
    },
    unloadByName: function (name) {
      return resolveModDir().then(function () { return unloadByName(name); });
    },
    addToBoot: function (path, args) {
      return resolveModDir().then(function () { return addToBoot(path, args); });
    },
    loadedModules: loadedModules,
    restartLoader: restartLoader,
    logs: logs,
    clearLog: clearLog,
    importKo: function (src, name) {
      return resolveModDir().then(function () { return importKo(src, name); });
    },
    importBlob: importBlob,
    hotLoadBlob: hotLoadBlob,
    updateModule: function (name, patch) {
      return loadConfig().then(function () { return updateModule(name, patch); });
    },
    removeModule: function (name, loadedName) {
      return loadConfig().then(function () { return removeModule(name, loadedName); });
    },
    saveOptions: function (patch) {
      return loadConfig().then(function () { return saveOptions(patch); });
    },
    saveDefaultStage: function (stage) {
      return loadConfig().then(function () { return saveDefaultStage(stage); });
    },
    meta: meta
  };

  global.LKM = global.Shell.available ? api : demo();
  global.LKM.real = api;
})(window);
