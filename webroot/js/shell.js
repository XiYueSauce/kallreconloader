/*
 * shell.js - root shell bridge + filesystem helpers
 *
 * Works on top of the WebUI API exposed by KernelSU, APatch, KsuWebUI and
 * MMRL. When nothing is available (opened in a normal browser) every call
 * rejects with NO_BRIDGE and the UI falls back to demo data.
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
  var TIMEOUT = 30000;

  function detect() {
    for (var i = 0; i < CANDIDATES.length; i++) {
      var name = CANDIDATES[i][0];
      var key = CANDIDATES[i][1];
      var api = global[key];
      if (api && typeof api.exec === 'function') {
        bridge = { name: name, api: api };
        return bridge;
      }
    }
    return null;
  }

  function quote(value) {
    return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'";
  }

  function normalize(result) {
    if (result == null) return { code: 0, out: '', err: '' };
    if (typeof result === 'string') return { code: 0, out: result, err: '' };
    var code = 0;
    if (result.errno != null) code = Number(result.errno) || 0;
    else if (result.code != null) code = Number(result.code) || 0;
    return {
      code: code,
      out: result.stdout != null ? String(result.stdout) : '',
      err: result.stderr != null ? String(result.stderr) : ''
    };
  }

  function exec(command) {
    if (!bridge) return Promise.reject(new Error('NO_BRIDGE'));
    var run;
    try {
      run = bridge.api.exec(command);
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.race([
      Promise.resolve(run).then(normalize),
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('TIMEOUT')); }, TIMEOUT);
      })
    ]);
  }

  function execOk(command) {
    return exec(command).then(function (res) {
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

  function listDir(dir) {
    /* \037 (unit separator) instead of '|': pipes are legal in file names */
    var script = [
      'd=' + quote(dir),
      '[ -d "$d" ] || { echo "!nodir"; exit 0; }',
      'cd "$d" || { echo "!noperm"; exit 0; }',
      'for f in * .[!.]*; do',
      '  [ -e "$f" ] || continue',
      '  if [ -d "$f" ]; then t=d; else t=f; fi',
      '  s=$(stat -c %s "$f" 2>/dev/null); [ -n "$s" ] || s=0',
      "  printf '%s\\037%s\\037%s\\n' \"$t\" \"$s\" \"$f\"",
      'done'
    ].join('\n');

    return exec(script).then(function (res) {
      var out = res.out;
      if (out.indexOf('!nodir') >= 0) throw new Error('目录不存在');
      if (out.indexOf('!noperm') >= 0) throw new Error('没有权限读取该目录');
      var rows = [];
      out.split('\n').forEach(function (line) {
        if (!line) return;
        var parts = line.split('\u001f');
        if (parts.length < 3) return;
        rows.push({
          type: parts[0] === 'd' ? 'dir' : 'file',
          size: parseInt(parts[1], 10) || 0,
          name: parts.slice(2).join('\u001f')
        });
      });
      rows.sort(function (x, y) {
        if (x.type !== y.type) return x.type === 'dir' ? -1 : 1;
        return x.name.localeCompare(y.name, 'en', { numeric: true });
      });
      return rows;
    });
  }

  function deviceInfo() {
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
      'if [ -d /data/adb/ksu ]; then echo "@manager=KernelSU"; ' +
        'elif [ -d /data/adb/ap ]; then echo "@manager=APatch"; ' +
        'elif [ -d /data/adb/magisk ]; then echo "@manager=Magisk"; ' +
        'else echo "@manager=Unknown"; fi',
      'echo "@loader=$(grep -c \'^lkmloader \' /proc/modules 2>/dev/null || echo 0)"',
      'echo "@uid=$(id -u 2>/dev/null)"'
    ].join('\n');

    return exec(script).then(function (res) {
      var info = {};
      res.out.split('\n').forEach(function (line) {
        var m = line.match(/^@([a-z0-9]+)=(.*)$/i);
        if (m) info[m[1]] = m[2].trim();
      });
      return info;
    });
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
    listDir: listDir,
    deviceInfo: deviceInfo,
    q: quote,
    redetect: detect
  };
})(window);
