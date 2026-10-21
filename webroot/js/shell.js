/*
 * shell.js - root shell bridge + filesystem helpers
 *
 * Works on top of the WebUI API exposed by KernelSU, APatch, KsuWebUI and
 * MMRL. Two generations of that API exist and both must be supported:
 *
 *   promise style   ksu.exec(cmd, opts)              -> Promise<result>
 *   callback style  ksu.exec(cmd, opts, cbName)      -> nothing
 *
 * KernelSU's own WebUI uses the callback form and returns undefined. Treating
 * that undefined as a result used to make every read look like "empty output",
 * which is why the UI claimed the loader was not loaded while it was. So the
 * third argument is always passed, the return value is inspected for a
 * thenable, and the named global callback is the fallback path.
 */
(function (global) {
  'use strict';

  var CANDIDATES = [
    ['KernelSU', 'ksu'],
    ['APatch', 'apatch'],
    ['KernelSU', 'kernelsu'],
    ['Magisk', 'magisk'],
    ['KsuWebUI', 'ksuwebui'],
    ['MMRL', 'mmrl']
  ];

  var bridge = null;
  var seq = 0;
  var DEFAULT_TIMEOUT = 20000;

  function detect() {
    bridge = null;
    for (var i = 0; i < CANDIDATES.length; i++) {
      var api = global[CANDIDATES[i][1]];
      if (api && typeof api.exec === 'function') {
        bridge = { name: CANDIDATES[i][0], api: api };
        return bridge;
      }
    }
    return null;
  }

  function quote(value) {
    return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'";
  }

  function normalize(value) {
    if (value == null) return { code: 0, out: '', err: '' };
    if (typeof value === 'string') {
      /* some bridges hand back the whole result as JSON */
      if (value.charAt(0) === '{') {
        try { return normalize(JSON.parse(value)); } catch (e) { /* plain text */ }
      }
      return { code: 0, out: value, err: '' };
    }
    var code = 0;
    if (value.errno != null) code = Number(value.errno) || 0;
    else if (value.code != null) code = Number(value.code) || 0;
    return {
      code: code,
      out: value.stdout != null ? String(value.stdout)
        : (value.out != null ? String(value.out) : ''),
      err: value.stderr != null ? String(value.stderr)
        : (value.err != null ? String(value.err) : '')
    };
  }

  /* callback(errno, stdout, stderr) is the documented form; a single result
     object is accepted too so one code path covers every manager */
  function fromCallback(args) {
    if (!args || !args.length) return { code: 0, out: '', err: '' };
    if (args.length >= 2) {
      return {
        code: Number(args[0]) || 0,
        out: args[1] == null ? '' : String(args[1]),
        err: args[2] == null ? '' : String(args[2])
      };
    }
    return normalize(args[0]);
  }

  function exec(command, options) {
    if (!bridge) return Promise.reject(new Error('NO_BRIDGE'));

    var opts = options || {};
    var timeout = opts.timeout || DEFAULT_TIMEOUT;

    return new Promise(function (resolve, reject) {
      var name = '__lkm_cb_' + (++seq).toString(36) + '_' + Date.now().toString(36);
      var settled = false;
      var timer = 0;

      function cleanup() {
        if (timer) { clearTimeout(timer); timer = 0; }
        try { delete global[name]; } catch (e) { global[name] = undefined; }
      }
      function done(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }
      function fail(err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }

      global[name] = function () { done(fromCallback(arguments)); };
      timer = setTimeout(function () { fail(new Error('TIMEOUT')); }, timeout);

      var ret;
      try {
        ret = bridge.api.exec(command, opts.raw || '{}', name);
      } catch (e) {
        fail(e);
        return;
      }
      /* promise style managers ignore the extra argument and return a promise */
      if (ret && typeof ret.then === 'function') {
        ret.then(function (value) { done(normalize(value)); }, fail);
      }
    });
  }

  function execOk(command, options) {
    return exec(command, options).then(function (res) {
      return res.out.trim();
    });
  }

  function readFile(path) {
    return exec('cat ' + quote(path)).then(function (res) {
      if (res.code !== 0) throw new Error(res.err || ('读取失败: ' + path));
      return res.out;
    });
  }

  /* heredoc keeps JSON/plain text intact without needing base64 */
  function writeFile(path, text) {
    var mark = 'LKM_EOF_' + Date.now().toString(36);
    var script = [
      'mkdir -p ' + quote(String(path).replace(/\/[^/]+$/, '')),
      'cat > ' + quote(path) + " <<'" + mark + "'",
      String(text).replace(/\n+$/, ''),
      mark
    ].join('\n');
    return exec(script).then(function (res) {
      if (res.code !== 0) throw new Error(res.err || ('写入失败: ' + path));
      return true;
    });
  }

  function exists(path) {
    return exec('[ -e ' + quote(path) + ' ] && echo 1 || echo 0').then(function (res) {
      return res.out.trim() === '1';
    });
  }

  /* the device never changes under us, so it is fetched once and cached;
     lkm.js seeds this cache from its own probe to avoid a second shell */
  var deviceCache = null;
  var devicePromise = null;

  function setDevice(info) {
    if (info && info.kernel) deviceCache = info;
  }

  function deviceInfo() {
    if (deviceCache) return Promise.resolve(deviceCache);
    if (devicePromise) return devicePromise;

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
      'echo "@uid=$(id -u 2>/dev/null)"'
    ].join('\n');

    devicePromise = exec(script, { timeout: 12000 }).then(function (res) {
      var info = {};
      res.out.split('\n').forEach(function (line) {
        var m = line.match(/^@([a-z0-9]+)=(.*)$/i);
        if (m) info[m[1]] = m[2].trim();
      });
      deviceCache = info;
      devicePromise = null;
      return info;
    }, function (e) {
      devicePromise = null;
      throw e;
    });

    return devicePromise;
  }

  detect();

  global.Shell = {
    get available() { return !!bridge; },
    get manager() { return bridge ? bridge.name : 'Browser'; },
    exec: exec,
    execOk: execOk,
    readFile: readFile,
    writeFile: writeFile,
    exists: exists,
    deviceInfo: deviceInfo,
    setDevice: setDevice,
    q: quote,
    redetect: detect
  };
})(window);
