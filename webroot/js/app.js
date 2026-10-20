/*
 * app.js - view rendering and interaction
 */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var state = {
    view: 'status',
    status: null,
    modules: [],
    options: {},
    optFile: {},
    defaultStage: 'service',
    logs: { loader: '', boot: '' },
    picker: { path: '/sdcard/Download', parent: '/sdcard', selected: null, onlyKo: true },
    editing: null,
    busy: false,
    poll: null
  };

  var ACTION_BUTTONS = [
    '#btn-refresh', '#btn-reload', '#btn-clear', '#btn-import',
    '#md-reload', '#md-toggle', '#md-delete', '#btn-restart-loader'
  ];

  /* ------------------------------------------------------------------ utils */

  var toastTimer;
  function toast(msg, ms) {
    var box = $('#toast');
    box.textContent = msg;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.hidden = true; }, ms || 2600);
  }

  function stageLabel(id) {
    if (id === 'post-fs-data') return 'post-fs-data';
    if (id === 'service') return 'service';
    return '手动';
  }

  function dirname(path) {
    var i = String(path).replace(/\/+$/, '').lastIndexOf('/');
    return i > 0 ? path.slice(0, i) : '/';
  }

  function shortenPath(path) {
    var p = String(path || '');
    var base = '/data/adb/modules/lkmloader/';
    if (p.indexOf(base) === 0) return p.slice(base.length);
    if (p.length <= 46) return p;
    return p.slice(0, 20) + '…' + p.slice(-22);
  }

  function pill(text, kind) {
    var span = document.createElement('span');
    span.className = 'pill' + (kind ? ' ' + kind : '');
    span.textContent = text;
    return span;
  }

  function row(label, value, valueClass) {
    var div = document.createElement('div');
    div.className = 'row';
    var k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    var v = document.createElement('span');
    v.className = 'v' + (valueClass ? ' ' + valueClass : '');
    v.textContent = value;
    div.appendChild(k);
    div.appendChild(v);
    return div;
  }

  /* every kernel action goes through here: one at a time, controls locked,
     failures surfaced instead of swallowed */
  function setControlsDisabled(disabled) {
    ACTION_BUTTONS.forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      if (disabled) {
        el.dataset.wasOff = el.disabled ? '1' : '0';
        el.disabled = true;
      } else {
        el.disabled = el.dataset.wasOff === '1';
      }
    });
  }

  function guard(fn) {
    if (state.busy) {
      toast('上一个操作还没结束');
      return Promise.resolve(null);
    }
    state.busy = true;
    setControlsDisabled(true);
    return Promise.resolve()
      .then(fn)
      .catch(function (e) {
        toast((e && e.message) || '操作失败', 3800);
        return null;
      })
      .then(function (result) {
        state.busy = false;
        setControlsDisabled(false);
        return result;
      });
  }

  /* ------------------------------------------------------------- navigation */

  function setView(view) {
    state.view = view;
    ['status', 'modules', 'settings'].forEach(function (v) {
      $('#view-' + v).hidden = v !== view;
    });
    $$('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.view === view);
    });
    try { history.replaceState(null, '', '#' + view); } catch (e) { /* file:// in some shells */ }
    if (view === 'modules') refreshModules().catch(function (e) { toast('读取模块失败：' + e.message); });
    if (view === 'settings') renderSettings();
    if (view === 'status') refreshLogs();
  }

  /* ------------------------------------------------------------------ status */

  function renderStatus() {
    var s = state.status;
    if (!s) return;

    var loaderPill = $('#st-loader');
    loaderPill.className = 'pill';
    if (s.loaderUp) {
      loaderPill.textContent = '已加载';
      loaderPill.classList.add('ok');
    } else if (!s.koExists) {
      loaderPill.textContent = '缺少 ko';
      loaderPill.classList.add('bad');
    } else {
      loaderPill.textContent = '未加载';
    }

    $('#st-kernel').textContent = s.kernel;
    $('#st-kmi').textContent = s.kmi;
    $('#st-device').textContent = s.device;
    $('#st-soc').textContent = s.soc;

    var compat = $('#st-compat');
    compat.className = 'pill';
    if (state.modules.length === 0) {
      compat.textContent = '无模块';
    } else if (state.modules.every(function (m) { return m._compatible !== false; })) {
      compat.textContent = '匹配';
      compat.classList.add('ok');
    } else {
      compat.textContent = '不匹配';
      compat.classList.add('warn');
    }

    var blocked = $('#st-blocked');
    blocked.className = 'pill';
    if (s.blocked) {
      blocked.textContent = '是';
      blocked.classList.add('bad');
    } else {
      blocked.textContent = '否';
      blocked.classList.add('ok');
    }

    $('#ui-manager').textContent = s.manager;
    $('#about-manager').textContent = s.manager;
    $('#about-android').textContent = s.android;

    $('#set-syms').textContent = s.symbols ? s.symbols.toLocaleString('en-US') : '—';
    $('#set-layout').textContent = s.layout === '' ? '—' : 'v' + s.layout;
    $('#set-mode').textContent = s.symbolMode ? '全部回填' : '仅非导出';
    $('#set-counts').textContent = s.loads + ' / ' + s.fails;

    renderParams();
  }

  function renderParams() {
    var o = state.options || {};
    var lines = [
      ['cleanup_mode', state.optFile && state.optFile.cleanup_mode !== undefined
        ? cleanupLabel(state.optFile.cleanup_mode) : 'default'],
      ['ignore_modversions', o.ignoreModversions ? 'Y' : 'N'],
      ['ignore_vermagic', o.ignoreVermagic ? 'Y' : 'N'],
      ['strict_symbols', o.strictSymbols === false ? 'N' : 'Y'],
      ['symbol_mode', o.keepExported === false ? 'patch-all' : 'keep-exported'],
      ['verbose', o.verbose === false ? 'N' : 'Y']
    ];
    lines.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
    $('#st-params').textContent = lines.map(function (l) {
      return l[0] + ' = ' + l[1];
    }).join('\n');
  }

  function cleanupLabel(v) {
    return ({ '-1': 'default', '0': 'auto', '1': 'seqs', '2': 'llvm', '3': 'dollar' })[String(v)] || String(v);
  }

  function renderLogs() {
    var box = $('#st-logs');
    box.textContent = '';
    var loader = (state.logs.loader || '').split('\n').filter(Boolean);
    var boot = (state.logs.boot || '').split('\n').filter(Boolean);

    if (!loader.length && !boot.length) {
      var p = document.createElement('p');
      p.className = 'muted';
      p.textContent = '暂无日志';
      box.appendChild(p);
      return;
    }

    loader.forEach(function (line) { box.appendChild(logLine(line)); });

    if (boot.length) {
      var sep = document.createElement('div');
      sep.className = 'ts';
      sep.style.margin = '10px 0 3px';
      sep.textContent = '— 开机日志 —';
      box.appendChild(sep);
      boot.forEach(function (line) { box.appendChild(logLine(line)); });
    }
    box.scrollTop = box.scrollHeight;
  }

  function logLine(line) {
    var div = document.createElement('div');
    var m = line.match(/^(\[[^\]]+\])\s?(.*)$/);
    if (m) {
      var ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = m[1] + ' ';
      div.appendChild(ts);
      div.appendChild(document.createTextNode(m[2]));
    } else {
      div.textContent = line;
    }
    if (/(fail|error|abort|not found|reject|miss )/i.test(line)) div.classList.add('err');
    return div;
  }

  function refreshStatus() {
    return LKM.status().then(function (s) {
      state.status = s;
      renderStatus();
    });
  }

  function refreshLogs() {
    return LKM.logs().then(function (l) {
      state.logs = l;
      renderLogs();
    }).catch(function () { /* ignore */ });
  }

  /* ----------------------------------------------------------------- modules */

  function refreshModules() {
    return LKM.modules().then(function (mods) {
      state.modules = mods;
      renderModules();
      renderStatus();
    });
  }

  function renderModules() {
    var list = $('#mod-list');
    list.textContent = '';
    $('#mod-empty').hidden = state.modules.length > 0;
    $('#mod-count').textContent = state.modules.length
      ? state.modules.length + ' 个已导入 · ' + state.modules.filter(function (m) { return m.loaded; }).length + ' 个已加载'
      : '尚未导入模块';

    state.modules.forEach(function (m) {
      var card = document.createElement('div');
      card.className = 'card mod';

      var head = document.createElement('div');
      head.className = 'row';
      var name = document.createElement('span');
      name.className = 'k';
      name.style.color = 'var(--text)';
      name.style.fontWeight = '600';
      name.textContent = m.name + '.ko';
      head.appendChild(name);
      head.appendChild(m.loaded ? pill('已加载', 'ok') : pill('未加载'));
      card.appendChild(head);

      var pathRow = document.createElement('div');
      pathRow.className = 'row path-row';
      var path = document.createElement('span');
      path.className = 'path';
      path.textContent = shortenPath(m.path);
      path.title = m.path;
      pathRow.appendChild(path);
      card.appendChild(pathRow);

      var foot = document.createElement('div');
      foot.className = 'mod-foot';

      var chips = document.createElement('div');
      chips.className = 'chips';
      var stage = document.createElement('button');
      stage.className = 'chip stage' + (m.stage === 'manual' ? ' manual' : '');
      stage.textContent = stageLabel(m.stage);
      stage.addEventListener('click', function (e) {
        e.stopPropagation();
        cycleStage(m);
      });
      chips.appendChild(stage);

      if (m._compatible === false) {
        var warn = document.createElement('span');
        warn.className = 'chip';
        warn.style.color = 'var(--warn)';
        warn.style.borderColor = 'transparent';
        warn.style.background = 'var(--warn-bg)';
        warn.textContent = 'Vermagic 不匹配';
        chips.appendChild(warn);
      }

      foot.appendChild(chips);

      var sw = document.createElement('label');
      sw.className = 'switch';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = m.enabled !== false;
      input.addEventListener('change', function () {
        var want = input.checked;
        LKM.updateModule(m.name, { enabled: want }).then(function () {
          m.enabled = want;
          toast(want ? m.name + ' 将在开机时加载' : m.name + ' 已停止开机加载');
        }).catch(function (e) {
          input.checked = !want;      /* roll the UI back */
          toast('保存失败：' + (e.message || '未知错误'));
        });
      });
      var i = document.createElement('i');
      sw.appendChild(input);
      sw.appendChild(i);
      foot.appendChild(sw);

      card.appendChild(foot);

      card.addEventListener('click', function () { openModuleSheet(m); });
      list.appendChild(card);
    });
  }

  function cycleStage(m) {
    var order = ['post-fs-data', 'service', 'manual'];
    var prev = m.stage;
    var next = order[(order.indexOf(prev) + 1) % order.length];
    LKM.updateModule(m.name, { stage: next }).then(function () {
      m.stage = next;
      renderModules();
      toast(m.name + ' 加载时机：' + stageLabel(next));
    }).catch(function (e) {
      m.stage = prev;
      renderModules();
      toast('保存失败：' + (e.message || '未知错误'));
    });
  }

  /* ------------------------------------------------------------ module sheet */

  function openModuleSheet(m) {
    state.editing = m;
    $('#md-title').textContent = m.name + '.ko';

    var info = $('#md-info');
    info.textContent = '';
    info.appendChild(row('状态', m.loaded ? '已加载' : '未加载'));
    info.appendChild(row('路径', m.path, 'num'));
    info.appendChild(row('Vermagic', m.vermagic || '未找到', 'num small'));
    info.appendChild(row('静态匹配', m._compatible === null || m._compatible === undefined
      ? '未知' : (m._compatible ? '是' : '否')));

    $('#md-args').value = m.args || '';
    $$('#md-stage button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.stage === m.stage);
    });
    $('#md-toggle').textContent = m.loaded ? '卸载' : '加载';
    openSheet('#sheet-module');
  }

  function closeModuleSheet() {
    closeSheet('#sheet-module');
    state.editing = null;
  }

  /* ----------------------------------------------------------------- picker */

  function openSheet(sel) {
    $(sel).hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeSheet(sel) {
    $(sel).hidden = true;
    document.body.style.overflow = '';
  }

  function openPicker() {
    state.picker.selected = null;
    $('#pick-confirm').disabled = true;
    $('#pick-confirm').textContent = '导入';
    openSheet('#sheet');
    loadDir(state.picker.path);
  }

  function loadDir(path) {
    var list = $('#filelist');
    list.textContent = '';
    var loading = document.createElement('div');
    loading.className = 'empty';
    loading.innerHTML = '<p class="muted">读取中…</p>';
    list.appendChild(loading);

    $('#crumb-path').textContent = path;
    state.picker.path = path;
    state.picker.parent = dirname(path);

    LKM.listDir(path).then(function (rows) {
      list.textContent = '';
      var onlyKo = state.picker.onlyKo;
      var shown = rows.filter(function (r) {
        if (r.type === 'dir') return true;
        return !onlyKo || /\.ko$/i.test(r.name);
      });

      if (!shown.length) {
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML = '<p class="muted">这里没有' + (onlyKo ? ' .ko 文件' : '文件') + '</p>';
        list.appendChild(empty);
      }

      shown.forEach(function (r) {
        var btn = document.createElement('button');
        btn.className = 'file';

        var ico = document.createElement('span');
        ico.className = 'ico' + (r.type === 'dir' ? ' dir' : (/\.ko$/i.test(r.name) ? ' ko' : ''));
        ico.textContent = r.type === 'dir' ? 'DIR' : (/\.ko$/i.test(r.name) ? 'KO' : 'FILE');

        var meta = document.createElement('span');
        meta.className = 'meta';
        var nm = document.createElement('span');
        nm.className = 'name';
        nm.textContent = r.name;
        meta.appendChild(nm);
        var sz = document.createElement('span');
        sz.className = 'sz';
        sz.textContent = r.type === 'dir' ? '文件夹' : LKM.humanSize(r.size);
        meta.appendChild(sz);

        btn.appendChild(ico);
        btn.appendChild(meta);

        var full = (path === '/' ? '' : path) + '/' + r.name;
        btn.addEventListener('click', function () {
          if (r.type === 'dir') {
            loadDir(full);
          } else if (/\.ko$/i.test(r.name)) {
            $$('.file', list).forEach(function (x) { x.classList.remove('selected'); });
            btn.classList.add('selected');
            state.picker.selected = { path: full, name: r.name };
            $('#pick-confirm').disabled = false;
            $('#pick-confirm').textContent = '导入 ' + r.name;
          } else {
            toast('请选择 .ko 文件');
          }
        });

        list.appendChild(btn);
      });
    }).catch(function (e) {
      list.textContent = '';
      var err = document.createElement('div');
      err.className = 'empty';
      var p = document.createElement('p');
      p.className = 'muted';
      p.textContent = e.message;
      err.appendChild(p);
      list.appendChild(err);
    });
  }

  function doImport() {
    var sel = state.picker.selected;
    if (!sel) return;

    var base = LKM.sanitizeName(sel.name);
    var dup = state.modules.filter(function (m) { return m.name === base; })[0];
    if (dup && !window.confirm(base + '.ko 已存在，覆盖并重新加载？')) return;

    guard(function () {
      $('#pick-confirm').disabled = true;
      return LKM.importKo(sel.path, sel.name).then(function (r) {
        closeSheet('#sheet');
        toast((r.replaced ? '已覆盖 ' : '已导入 ') + r.name + '.ko，正在加载…');
        return LKM.loadOne({ name: r.name, path: r.path, args: '' });
      }).then(function (res) {
        if (res && res.ok) toast('加载成功');
        else toast('已导入，但加载失败：' + ((res && (res.err || res.out)) || '未知错误'), 4200);
        return Promise.all([refreshModules(), refreshStatus()]);
      });
    }).then(function () {
      $('#pick-confirm').disabled = !state.picker.selected;
    });
  }

  /* ---------------------------------------------------------------- settings */

  function renderSettings() {
    var o = state.options || {};
    $('#opt-vermagic').checked = !!o.ignoreVermagic;
    $('#opt-modversions').checked = !!o.ignoreModversions;
    $('#opt-strict').checked = o.strictSymbols !== false;
    $('#opt-verbose').checked = o.verbose !== false;
    $('#opt-keep').checked = o.keepExported !== false;

    $$('#st-default-stage button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.stage === state.defaultStage);
    });
  }

  /* ------------------------------------------------------------------ actions */

  function refreshAll() {
    return Promise.all([refreshStatus(), refreshModules(), refreshLogs()]);
  }

  function reloadAll() {
    guard(function () {
      toast('正在重启 loader…');
      return LKM.restartLoader().then(function (r) {
        if (!r.ok) {
          throw new Error(r.up
            ? 'loader 已加载，但 kallsyms 重建失败（看日志）'
            : 'loader 无法加载，确认 ko/ 下的 lkmloader.ko 存在');
        }
        var targets = state.modules.filter(function (m) {
          return m.enabled !== false && m.stage !== 'manual';
        });
        if (!targets.length) {
          toast('loader 已就绪（v' + (r.version || '?') + '，' + r.syms + ' 符号），没有需要重载的模块', 3600);
          return refreshAll();
        }
        var ok = 0;
        var fail = 0;
        var reasons = [];
        return targets.reduce(function (chain, m) {
          return chain.then(function () {
            return LKM.reloadOne(m).then(function (x) {
              if (x && x.ok) {
                ok++;
              } else {
                fail++;
                if (reasons.length < 2) {
                  reasons.push(m.name + ': ' + ((x && (x.err || x.out)) || '失败'));
                }
              }
            });
          });
        }, Promise.resolve()).then(function () {
          toast('重载完成：成功 ' + ok + '，失败 ' + fail +
            (reasons.length ? '\n' + reasons.join('\n') : ''), 4600);
          return refreshAll();
        });
      });
    });
  }

  /* -------------------------------------------------------------------- init */

  function bind() {
    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () { setView(tab.dataset.view); });
    });

    $('#btn-refresh').addEventListener('click', function () {
      guard(function () {
        return refreshAll().then(function () { toast('已刷新'); });
      });
    });

    $('#btn-reload').addEventListener('click', reloadAll);

    $('#btn-clear').addEventListener('click', function () {
      guard(function () {
        return LKM.clearLog().then(function () {
          toast('日志已清空');
          return refreshLogs();
        });
      });
    });

    $('#btn-import').addEventListener('click', openPicker);

    $('#sheet-close').addEventListener('click', function () { closeSheet('#sheet'); });
    $('#pick-cancel').addEventListener('click', function () { closeSheet('#sheet'); });
    $('#sheet-mask').addEventListener('click', function () { closeSheet('#sheet'); });
    $('#pick-confirm').addEventListener('click', doImport);
    $('#crumb-up').addEventListener('click', function () {
      loadDir(state.picker.parent || '/sdcard');
    });
    $$('#quick-jumps button').forEach(function (b) {
      b.addEventListener('click', function () { loadDir(b.dataset.path); });
    });
    $('#only-ko').addEventListener('change', function () {
      state.picker.onlyKo = this.checked;
      loadDir(state.picker.path);
    });
    $('#pick-manual').addEventListener('click', function () {
      var p = window.prompt('输入 .ko 的完整路径', state.picker.path + '/');
      if (!p) return;
      var name = p.split('/').pop();
      state.picker.selected = { path: p, name: name };
      $('#pick-confirm').disabled = false;
      $('#pick-confirm').textContent = '导入 ' + name;
      toast('已选择 ' + name);
    });

    $('#md-close').addEventListener('click', closeModuleSheet);
    $('#md-mask').addEventListener('click', closeModuleSheet);
    $$('#md-stage button').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#md-stage button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
      });
    });

    $('#md-reload').addEventListener('click', function () {
      var m = state.editing;
      if (!m) return;
      var stageBtn = $('#md-stage button.active');
      var patch = {
        args: LKM.sanitizeArgs($('#md-args').value),
        stage: stageBtn ? stageBtn.dataset.stage : m.stage
      };
      guard(function () {
        return LKM.updateModule(m.name, patch).then(function () {
          m.args = patch.args;
          m.stage = patch.stage;
          toast('重载 ' + m.name + '…');
          return LKM.reloadOne(m);
        }).then(function (r) {
          if (r && r.ok) toast('重载成功');
          else toast('重载失败：' + ((r && (r.err || r.out)) || '未知错误'), 4200);
          closeModuleSheet();
          return Promise.all([refreshModules(), refreshStatus()]);
        });
      });
    });

    $('#md-toggle').addEventListener('click', function () {
      var m = state.editing;
      if (!m) return;
      var wasLoaded = m.loaded;
      guard(function () {
        var job = wasLoaded ? LKM.unloadOne(m) : LKM.loadOne(m);
        return job.then(function (r) {
          if (wasLoaded) {
            if (r.ok) toast(r.state === 'absent' ? '本来就未加载' : '已卸载 ' + m.name);
            else toast('卸载失败：' + (r.err || '模块仍在使用'), 4200);
          } else {
            toast(r && r.ok ? '加载成功' : '加载失败：' + ((r && (r.err || r.out)) || '未知错误'), 4200);
          }
          closeModuleSheet();
          return Promise.all([refreshModules(), refreshStatus()]);
        });
      });
    });

    $('#md-delete').addEventListener('click', function () {
      var m = state.editing;
      if (!m) return;
      if (!window.confirm('删除 ' + m.name + '.ko？文件会一并删除。')) return;
      guard(function () {
        return LKM.removeModule(m.name).then(function () {
          toast('已删除 ' + m.name);
          closeModuleSheet();
          return Promise.all([refreshModules(), refreshStatus()]);
        });
      });
    });

    ['vermagic', 'modversions', 'strict', 'verbose', 'keep'].forEach(function (key) {
      var map = {
        vermagic: 'ignoreVermagic',
        modversions: 'ignoreModversions',
        strict: 'strictSymbols',
        verbose: 'verbose',
        keep: 'keepExported'
      };
      var input = $('#opt-' + key);
      input.addEventListener('change', function () {
        var want = input.checked;
        var patch = {};
        patch[map[key]] = want;
        LKM.saveOptions(patch).then(function (cfg) {
          state.options = cfg.options;
          renderParams();
          toast('已保存，点「重启 loader」生效');
        }).catch(function (e) {
          input.checked = !want;
          toast('保存失败：' + (e.message || '未知错误'));
        });
      });
    });

    $$('#st-default-stage button').forEach(function (b) {
      b.addEventListener('click', function () {
        var prev = state.defaultStage;
        var next = b.dataset.stage;
        state.defaultStage = next;
        LKM.saveDefaultStage(next).then(function () {
          renderSettings();
          toast('默认加载时机：' + stageLabel(next));
        }).catch(function (e) {
          state.defaultStage = prev;
          renderSettings();
          toast('保存失败：' + (e.message || '未知错误'));
        });
      });
    });

    $('#btn-restart-loader').addEventListener('click', function () {
      guard(function () {
        toast('正在重启 loader…');
        return LKM.restartLoader().then(function (r) {
          toast(r.ok
            ? 'loader 已重启 v' + (r.version || '?') + '，' + r.syms + ' 符号'
            : '重启失败：' + (r.up ? 'kallsyms 重建失败' : 'ko 无法加载'), 3600);
          return refreshStatus();
        });
      });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPoll();
      else startPoll();
    });
  }

  function startPoll() {
    stopPoll();
    state.poll = setInterval(function () {
      if (document.hidden || state.busy) return;
      if (state.view === 'status') refreshLogs();
      if (state.view === 'modules') refreshModules().catch(function () {});
    }, 8000);
  }

  function stopPoll() {
    if (state.poll) clearInterval(state.poll);
    state.poll = null;
  }

  function init() {
    if (LKM.isDemo) $('#demo-banner').hidden = false;
    bind();

    var hash = (location.hash || '').replace('#', '');
    setView(['status', 'modules', 'settings'].indexOf(hash) >= 0 ? hash : 'status');

    LKM.loadConfig().then(function (cfg) {
      state.options = cfg.options;
      state.defaultStage = cfg.defaultStage;
      return LKM.readOptionsFile();
    }).then(function (optFile) {
      state.optFile = optFile || {};
      renderParams();
      renderSettings();
    }).catch(function () {});

    LKM.meta().then(function (meta) {
      if (meta && meta.version) {
        $('#ui-version').textContent = meta.version;
        $('#about-version').textContent = meta.version;
      }
      if (meta && meta.id) {
        $('#ui-id').textContent = meta.id;
        $('#about-id').textContent = meta.id;
      }
    }).catch(function () {});

    guard(function () {
      return refreshAll();
    }).then(function () {
      if (window.ksu && typeof window.ksu.fullScreen === 'function') {
        try { window.ksu.fullScreen(true); } catch (e) { /* ignore */ }
      }
      startPoll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
