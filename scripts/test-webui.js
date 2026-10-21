/*
 * scripts/test-webui.js - regression tests for the WebUI bridge
 *
 * Run from the repository root. Covers the failure that shipped in v1.2.0:
 * a callback style manager (KernelSU) returns undefined from exec(), which was
 * read as "empty output" and made the UI claim the loader was not loaded.
 *
 * The second half runs every shell snippet the WebUI builds through `sh -n`
 * so a quoting mistake cannot reach the device.
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const cp = require('child_process');
const assert = require('assert');
const path = require('path');

const ROOT = process.cwd();

function context(win) {
  win.window = win;
  /* the WebView provides window.btoa, the sandbox has to fake it */
  if (!win.btoa) win.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
  return vm.createContext({
    window: win, setTimeout, clearTimeout, console, Promise, JSON,
    Date, Number, String, Array, Object, Uint8Array
  });
}

function loadShim(win) {
  const ctx = context(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'webroot/js/shell.js'), 'utf8'), ctx, { filename: 'shell.js' });
  return ctx;
}

function loadLkm(win) {
  const ctx = loadShim(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'webroot/js/lkm.js'), 'utf8'), ctx, { filename: 'lkm.js' });
  return win;
}

const pendingCallbacks = (win) => Object.keys(win).filter((k) => k.indexOf('__lkm_cb_') === 0);

const PROBE = [
  '@kernel=6.12.69-android16-6-g43b5ab7e247d-abogki61813157-4k',
  '@model=23127PN0CC',
  '@brand=Redmi',
  '@soc2=sm8750',
  '@android=16',
  '@abi=arm64-v8a',
  '@selinux=Enforcing',
  '@moddis=0',
  '@manager=KernelSU',
  '@uid=0',
  '@ko=1',
  '@lmod=1',
  '@ctl_begin',
  'loader=lkmloader',
  'version=1.2.1',
  'kallsyms=1',
  'num_syms=142103',
  'layout=2',
  'seq=12',
  'loads=3',
  'fails=0',
  'symbol_mode=0',
  'cache_used=38',
  'cache_hits=12',
  'last_msg=loaded droid_lkm.ko (patched 11, native 6)',
  '@ctl_end'
].join('\n');

const CONFIG = [
  '{',
  '"version":1,',
  '"defaultStage":"service",',
  '"options":{"ignoreVermagic":false,"ignoreModversions":false,"strictSymbols":true,"verbose":true,"keepExported":true},',
  '"modules":[',
  '{"name":"droid_lkm","path":"/data/adb/modules/lkmloader/lkm/droid_lkm.ko","args":"","stage":"service","enabled":true,"delay":0},',
  '{"name":"beta-kmod","path":"/sdcard/some dir/beta-kmod.ko","args":"log=1","stage":"manual","enabled":false,"delay":0}',
  ']',
  '}',
  ''
].join('\n');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------------------- the bridge */

test('callback style: (errno, stdout, stderr)', async () => {
  const win = { ksu: { exec(cmd, opts, cb) { setTimeout(() => win[cb](0, 'hello\n', ''), 5); } } };
  loadShim(win);
  const r = await win.Shell.exec('echo hello');
  assert.deepStrictEqual([r.code, r.out, r.err], [0, 'hello\n', '']);
  assert.strictEqual(pendingCallbacks(win).length, 0, 'callback left on window');
});

test('callback style: single result object', async () => {
  const win = { ksu: { exec(cmd, opts, cb) { setTimeout(() => win[cb]({ errno: 2, stdout: '', stderr: 'nope' }), 5); } } };
  loadShim(win);
  const r = await win.Shell.exec('x');
  assert.deepStrictEqual([r.code, r.err], [2, 'nope']);
});

test('callback style: json string', async () => {
  const win = { ksu: { exec(cmd, opts, cb) { setTimeout(() => win[cb](JSON.stringify({ errno: 0, stdout: 'j' })), 5); } } };
  loadShim(win);
  const r = await win.Shell.exec('x');
  assert.deepStrictEqual([r.code, r.out], [0, 'j']);
});

test('promise style', async () => {
  const win = { ksu: { async exec() { return { errno: 0, stdout: 'promised', stderr: '' }; } } };
  loadShim(win);
  const r = await win.Shell.exec('x');
  assert.strictEqual(r.out, 'promised');
});

test('a silent bridge must time out, not look like empty output', async () => {
  const win = { ksu: { exec() { /* returns undefined, never calls back */ } } };
  loadShim(win);
  await assert.rejects(win.Shell.exec('x', { timeout: 60 }), /TIMEOUT/);
});

/* --------------------------------------------------------------- the data */

test('status parses one probe shell', async () => {
  const win = {
    ksu: {
      exec(cmd) {
        if (cmd.indexOf('module.prop') >= 0) return Promise.resolve({ errno: 0, stdout: '/data/adb/modules/lkmloader\n' });
        if (cmd.indexOf('@ctl_begin') >= 0) return Promise.resolve({ errno: 0, stdout: PROBE });
        return Promise.resolve({ errno: 0, stdout: '' });
      }
    }
  };
  loadLkm(win);
  const s = await win.LKM.real.status();
  assert.strictEqual(s.loaderUp, true);
  assert.strictEqual(s.ctlReadable, true);
  assert.strictEqual(s.symbols, 142103);
  assert.strictEqual(s.kmi, 'android16-6.12');
  assert.strictEqual(s.seq, 12);
  assert.ok(s.device.indexOf('23127PN0CC') >= 0, s.device);
});

test('loaded module with unreadable /proc/lkmctl still counts as loaded', async () => {
  const probe = PROBE.replace('loader=lkmloader\n', '');
  const win = {
    ksu: {
      exec(cmd) {
        if (cmd.indexOf('module.prop') >= 0) return Promise.resolve({ errno: 0, stdout: '/data/adb/modules/lkmloader\n' });
        if (cmd.indexOf('@ctl_begin') >= 0) return Promise.resolve({ errno: 0, stdout: probe });
        return Promise.resolve({ errno: 0, stdout: '' });
      }
    }
  };
  loadLkm(win);
  const s = await win.LKM.real.status();
  assert.strictEqual(s.loaderUp, true);
  assert.strictEqual(s.ctlReadable, false);
});

/* ------------------------------------------- generated shell is valid shell */

test('hotLoadBlob drops the file in tmp and hands it to the loader', async () => {
  const bytes = new Uint8Array(5000);
  bytes[0] = 0x7f; bytes[1] = 0x45; bytes[2] = 0x4c; bytes[3] = 0x46;
  bytes[4] = 2;
  bytes[16] = 1;

  const cmds = [];
  const win = {
    ksu: {
      exec(cmd, opts, cb) {
        cmds.push(cmd);
        let out = '';
        if (cmd.indexOf('module.prop') >= 0) out = '/data/adb/modules/lkmloader\n';
        else if (cmd.indexOf('stat -c %s') >= 0) out = String(bytes.length) + '\n';
        setTimeout(() => win[cb](0, out, ''), 1);
      }
    }
  };
  loadLkm(win);

  const file = { name: 'demo-mod.ko', size: bytes.length, arrayBuffer: () => Promise.resolve(bytes.buffer) };
  const r = await win.LKM.real.hotLoadBlob(file);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, 'demo_mod', 'module name the kernel will use');
  assert.strictEqual(r.path, '/data/local/tmp/lkm_hot/demo-mod.ko');
  assert.ok(cmds.some((c) => c.indexOf("lkm_load_one 'demo_mod'") > 0), 'loaded through lkm_load_one');
  assert.ok(cmds.some((c) => c.indexOf('/data/local/tmp/lkm_hot/') > 0), 'file staged in tmp');
  assert.ok(!cmds.some((c) => c.indexOf('config.json') >= 0 && c.indexOf('cat >') >= 0),
    'hot load must not write the config');
});

test('importBlob uploads in chunks and verifies the size', async () => {
  const bytes = new Uint8Array(70000);
  bytes[0] = 0x7f; bytes[1] = 0x45; bytes[2] = 0x4c; bytes[3] = 0x46;   /* ELF  */
  bytes[4] = 2;                                                        /* ELF64 */
  bytes[16] = 1;                                                       /* ET_REL */

  const cmds = [];
  const win = {
    ksu: {
      exec(cmd, opts, cb) {
        cmds.push(cmd);
        let out = '';
        if (cmd.indexOf('config.json') >= 0) out = CONFIG;
        else if (cmd.indexOf('module.prop') >= 0) out = '/data/adb/modules/lkmloader\n';
        else if (cmd.indexOf('stat -c %s') >= 0) out = String(bytes.length) + '\n';
        setTimeout(() => win[cb](0, out, ''), 1);
      }
    }
  };
  loadLkm(win);

  const file = { name: 'big.ko', size: bytes.length, arrayBuffer: () => Promise.resolve(bytes.buffer) };
  const r = await win.LKM.real.importBlob(file);

  assert.strictEqual(r.name, 'big');
  assert.strictEqual(r.path, '/data/adb/modules/lkmloader/lkm/big.ko');

  const appends = cmds.filter((c) => c.indexOf('printf %s') === 0);
  assert.ok(appends.length >= 2, 'expected several appends, got ' + appends.length);
  const b64 = Buffer.from(bytes).toString('base64');
  const joined = appends.map((c) => {
    const m = c.match(/^printf %s '([^']*)'/);
    return m ? m[1] : '';
  }).join('');
  assert.strictEqual(joined, b64, 'the appends must reproduce the file byte for byte');
});

test('every generated shell snippet parses', async () => {
  const recorded = [];
  const win = {
    ksu: {
      exec(cmd) {
        recorded.push(cmd);
        let out = '';
        if (cmd.indexOf('module.prop') >= 0) out = '/data/adb/modules/lkmloader\n';
        else if (cmd.indexOf('config.json') >= 0) out = CONFIG;
        else if (cmd.indexOf('/proc/modules') >= 0) out = 'droid_lkm\n';
        return Promise.resolve({ errno: 0, stdout: out, stderr: '' });
      }
    }
  };
  loadLkm(win);

  const L = win.LKM.real;
  const step = (fn) => Promise.resolve().then(fn).catch(() => {});
  await step(() => L.status());
  await step(() => L.tick());
  await step(() => L.modules());
  await step(() => L.loadedModules());
  await step(() => L.hotLoadBlob({ name: 'x.ko', arrayBuffer: () => Promise.resolve(new Uint8Array(5000).fill(0).map((_, i) => (i < 4 ? [0x7f, 0x45, 0x4c, 0x46][i] : i === 4 ? 2 : i === 16 ? 1 : 0)).buffer) }));
  await step(() => L.hotLoad("/data/local/tmp/joe's ko.ko", "x=1 y='2'"));
  await step(() => L.unloadByName('beta-kmod'));
  await step(() => L.addToBoot('/data/local/tmp/joe.ko', ''));
  await step(() => L.importKo("/data/local/tmp/joe's ko.ko", "joe's ko.ko"));
  await step(() => L.logs());
  await step(() => L.clearLog());
  await step(() => L.restartLoader());
  await step(() => L.removeModule('droid_lkm'));

  if (!cp.spawnSync('sh', ['-c', 'command -v sh']).status) {
    const dir = path.join(ROOT, 'build/.webui-snippets');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let bad = 0;
    recorded.forEach((cmd, i) => {
      const file = path.join(dir, `${String(i).padStart(3, '0')}.sh`);
      fs.writeFileSync(file, cmd + '\n');
      const r = cp.spawnSync('sh', ['-n', file], { encoding: 'utf8' });
      if (r.status !== 0) {
        bad++;
        console.error(`!! snippet ${file}\n${r.stderr}\n--- command ---\n${cmd}\n`);
      }
    });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(bad, 0, `${bad} snippet(s) do not parse`);
  }
  assert.ok(recorded.length >= 10, 'expected the webui to build a few shells');
});

/* ------------------------------------------------------------------- main */

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok  ${t.name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${t.name}\n${(e && e.stack) || e}\n`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} webui tests passed`);
  process.exit(failed ? 1 : 0);
})();
