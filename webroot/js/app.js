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
    logKey: '',
    loaded: [],
    pickMode: 'import',
    editing: null,
    busy: false,
    poll: null,
    downTicks: 0
  };

  var ACTION_BUTTONS = [
    '#btn-refresh', '#btn-reload', '#btn-clear', '#btn-import', '#btn-hot',
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

  /*
   * An unresolved symbol is the one load failure the user cannot fix from the
   * UI: the name is neither in kallsyms nor exported by a loaded module, which
   * in practice means the .ko was linked against a library object it did not
   * include. Say that instead of repeating the loader's errno.
   */
  function explain(text) {
    var s = String(text == null ? '' : text).trim();
    if (/unresolved symbol/i.test(s)) {
      return s + '\n缺失的符号既不在内核符号表里，也不是已加载模块导出的——通常是这个 ko 少链了依赖库的对象文件，需要在构建端补上。';
    }
    return s;
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
    /* no fetching here: the bootstrap already filled state, switching tabs is
       pure DOM work so the UI stays instant */
    if (view === 'settings') renderSettings();
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
      loaderPill.classList.add('warn');
    }

    var hint = $('#st-hint');
    if (s.loaderUp && !s.ctlReadable) {
      hint.hidden = false;
      hint.textContent = 'loader 进程在运行，但 /proc/lkmctl 没有输出（权限或 SELinux 限制），符号与缓存数字不可用。';
    } else if (!s.loaderUp && !s.koExists) {
      hint.hidden = false;
      hint.textContent = 'ko/lkmloader.ko 不存在：安装时没有匹配到当前内核的 KMI，重装模块即可。';
    } else if (!s.loaderUp) {
      hint.hidden = false;
      hint.textContent = 'loader 未加载。点「重新加载」按 ko/options 里的参数重新 insmod。';
    } else {
      hint.hidden = true;
      hint.textContent = '';
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
    $('#set-cache').textContent = s.cacheUsed
      ? s.cacheUsed + ' 条 · 命中 ' + (s.cacheHits || 0)
      : '—';

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

  /* the log box is the most expensive thing to rebuild: only touch the DOM
     when the text really changed, and keep the scroll position when the user
     has scrolled up to read something */
  function renderLogs() {
    var key = (state.logs.loader || '') + '\u0000' + (state.logs.boot || '');
    if (key === state.logKey) return;
    state.logKey = key;

    var box = $('#st-logs');
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;

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
    if (atBottom) box.scrollTop = box.scrollHeight;
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
    var loaded = state.modules.filter(function (m) { return m.loaded; }).length;
    var hot = state.modules.filter(function (m) { return m.hot; }).length;

    $('#mod-empty').hidden = state.modules.length > 0;
    $('#mod-count').textContent = state.modules.length
      ? state.modules.length + ' 个模块 · ' + loaded + ' 个已加载' + (hot ? ' · ' + hot + ' 个临时' : '')
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

      if (m.hot) {
        var tmp = document.createElement('span');
        tmp.className = 'chip';
        tmp.style.color = 'var(--warn)';
        tmp.style.borderColor = 'transparent';
        tmp.style.background = 'var(--warn-bg)';
        tmp.textContent = '临时';
        chips.appendChild(tmp);

        var boot = document.createElement('button');
        boot.className = 'chip action';
        boot.textContent = '加入开机';
        boot.addEventListener('click', function (e) {
          e.stopPropagation();
          guard(function () {
            return LKM.addToBoot(m.path, m.args).then(function (r) {
              toast(r.name + ' 已加入开机加载');
              return Promise.all([refreshModules(), refreshStatus()]);
            });
          });
        });
        chips.appendChild(boot);
      } else {
        var stage = document.createElement('button');
        stage.className = 'chip stage' + (m.stage === 'manual' ? ' manual' : '');
        stage.textContent = stageLabel(m.stage);
        stage.addEventListener('click', function (e) {
          e.stopPropagation();
          cycleStage(m);
        });
        chips.appendChild(stage);
      }

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

      if (!m.hot) {
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
      }

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
    var owned = String(m.path).indexOf(String(LKM.modDir || '') + '/') === 0;
    $('#md-delete').textContent = (m.hot || !owned) ? '移除' : '删除';
    $('#md-reload').textContent = m.hot ? '加入开机' : '重载';
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

  /*
   * Import goes through the Android file chooser: a plain <input type=file>
   * in the WebView opens the system picker, so third party file managers can
   * handle it and the module no longer ships a directory browser of its own.
   */
  function pickFile(mode) {
    state.pickMode = mode === 'hot' ? 'hot' : 'import';
    var input = $('#file-pick');
    input.value = '';
    input.click();
  }

  function onFilePicked(ev) {
    var input = ev.target;
    var file = input.files && input.files[0];
    var mode = state.pickMode;
    input.value = '';
    if (!file) return;

    if (mode === 'hot') {
      guard(function () {
        toast('正在热加载 ' + file.name + '（' + LKM.humanSize(file.size) + '）…', 6000);
        return LKM.hotLoadBlob(file).then(function (r) {
          if (r.ok) toast('已热加载 ' + r.name + '.ko（重启后失效）', 3600);
          else toast('热加载失败：' + explain(r.err || '查看日志'), 6000);
          return Promise.all([refreshModules(), refreshStatus(), refreshLogs()]);
        });
      });
      return;
    }

    guard(function () {
      toast('正在写入 ' + file.name + '（' + LKM.humanSize(file.size) + '）…', 6000);
      return LKM.importBlob(file).then(function (r) {
        toast((r.replaced ? '已覆盖 ' : '已导入 ') + r.name + '.ko，正在加载…');
        return LKM.loadOne({ name: r.name, path: r.path, args: '' });
      }).then(function (res) {
        if (res && res.ok) toast('加载成功');
        else toast('已导入，但加载失败：' + explain((res && (res.err || res.out)) || '未知错误'), 6000);
        return Promise.all([refreshModules(), refreshStatus(), refreshLogs()]);
      });
    });
  }

  /* ------------------------------------------------------- loaded modules */

  function openLoaded() {
    openSheet('#sheet-loaded');
    $('#ld-search').value = '';
    if (!state.loaded.length) {
      $('#ld-list').innerHTML = '<div class="empty"><p class="muted">读取中…</p></div>';
    }
    refreshLoaded();
  }

  function refreshLoaded() {
    return LKM.loadedModules().then(function (rows) {
      state.loaded = rows;
      renderLoaded();
    }).catch(function (e) {
      $('#ld-list').textContent = '';
      var err = document.createElement('div');
      err.className = 'empty';
      var p = document.createElement('p');
      p.className = 'muted';
      p.textContent = '读取失败：' + (e.message || '未知错误');
      err.appendChild(p);
      $('#ld-list').appendChild(err);
    });
  }

  /* names this module manages, so its own LKMs can be picked out of the
     couple of hundred vendor modules /proc/modules reports */
  function managedSet() {
    var set = {};
    state.modules.forEach(function (m) {
      set[LKM.kernelName(m.name)] = true;
    });
    return set;
  }

  function renderLoaded() {
    var list = $('#ld-list');
    var kw = ($('#ld-search').value || '').trim().toLowerCase();
    var managed = managedSet();

    var rows = state.loaded.filter(function (r) {
      return !kw || r.name.toLowerCase().indexOf(kw) >= 0;
    });

    rows.sort(function (a, b) {
      var ma = managed[a.name] ? 1 : 0;
      var mb = managed[b.name] ? 1 : 0;
      if (ma !== mb) return mb - ma;
      return a.name.localeCompare(b.name, 'en');
    });

    $('#ld-count').textContent = state.loaded.length
      ? rows.length + ' / ' + state.loaded.length
      : '—';

    list.textContent = '';
    if (!rows.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<p class="muted">没有匹配的模块</p>';
      list.appendChild(empty);
      return;
    }

    rows.forEach(function (r) {
      var btn = document.createElement('button');
      btn.className = 'file';

      var ico = document.createElement('span');
      ico.className = 'ico ko';
      ico.textContent = 'LKM';

      var meta = document.createElement('span');
      meta.className = 'meta';
      var head = document.createElement('span');
      head.className = 'name-row';
      var nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = r.name;
      head.appendChild(nm);
      if (managed[r.name]) {
        var tag = document.createElement('span');
        tag.className = 'pill ok';
        tag.textContent = '本模块';
        head.appendChild(tag);
      }
      meta.appendChild(head);
      var sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = LKM.humanSize(r.size) + (r.refs ? ' · 被引用 ' + r.refs : ' · 可卸载');
      meta.appendChild(sz);

      btn.appendChild(ico);
      btn.appendChild(meta);

      var self = r.name === 'lkmloader';
      if (self || r.refs > 0) {
        btn.disabled = true;
        var why = document.createElement('span');
        why.className = 'sz right';
        why.textContent = self ? 'loader 本身' : '被引用 ' + r.refs;
        btn.appendChild(why);
      }

      btn.addEventListener('click', function () {
        if (self) {
          toast('lkmloader 是 loader 本身，要重启请用设置页的「重启 loader」');
          return;
        }
        if (!window.confirm('卸载 ' + r.name + '？\n\n它会立刻从运行中的内核里移除，' +
          '依赖它的功能可能立即失效。')) return;
        guard(function () {
          return LKM.unloadByName(r.name).then(function (res) {
            if (res.ok) toast(res.state === 'absent' ? r.name + ' 本来就没加载' : '已卸载 ' + r.name);
            else toast('卸载失败：' + (res.err || '模块仍在使用'), 4200);
            return Promise.all([refreshLoaded(), refreshModules(), refreshStatus(), refreshLogs()]);
          });
        });
      });

      list.appendChild(btn);
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

  function renderMeta(meta) {
    if (meta && meta.version) {
      $('#ui-version').textContent = meta.version;
      $('#about-version').textContent = meta.version;
    }
    if (meta && meta.id) {
      $('#ui-id').textContent = meta.id;
      $('#about-id').textContent = meta.id;
    }
  }

  /* ------------------------------------------------------------------ actions */

  function refreshAll() {
    return refreshStatus().then(function () {
      return Promise.all([refreshModules(), refreshLogs()]);
    });
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
          return !m.hot && m.enabled !== false && m.stage !== 'manual';
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

    $('#btn-import').addEventListener('click', function () { pickFile('import'); });
    $('#btn-hot').addEventListener('click', function () { pickFile('hot'); });
    $('#btn-loaded').addEventListener('click', openLoaded);
    $('#file-pick').addEventListener('change', onFilePicked);

    $('#ld-close').addEventListener('click', function () { closeSheet('#sheet-loaded'); });
    $('#ld-mask').addEventListener('click', function () { closeSheet('#sheet-loaded'); });
    $('#ld-done').addEventListener('click', function () { closeSheet('#sheet-loaded'); });
    $('#ld-refresh').addEventListener('click', function () { refreshLoaded(); });
    $('#ld-search').addEventListener('input', renderLoaded);

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

      /* a hot module is not in config.json: the useful action is to keep it */
      if (m.hot) {
        guard(function () {
          return LKM.addToBoot(m.path, m.args).then(function (r) {
            toast(r.name + ' 已加入开机加载');
            closeModuleSheet();
            return Promise.all([refreshModules(), refreshStatus()]);
          });
        });
        return;
      }

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
          return Promise.all([refreshModules(), refreshStatus(), refreshLogs()]);
        });
      });
    });

    $('#md-toggle').addEventListener('click', function () {
      var m = state.editing;
      if (!m) return;

      /* hot modules unload through the kernel directly */
      if (m.hot) {
        guard(function () {
          return LKM.unloadByName(m.name).then(function (r) {
            if (r.ok) toast('已卸载 ' + m.name);
            else toast('卸载失败：' + (r.err || '模块仍在使用'), 4200);
            closeModuleSheet();
            return Promise.all([refreshModules(), refreshStatus(), refreshLogs()]);
          });
        });
        return;
      }

      var wasLoaded = m.loaded;
      guard(function () {
        var job = wasLoaded ? LKM.unloadOne(m) : LKM.loadOne(m);
        return job.then(function (r) {
          if (wasLoaded) {
            if (r.ok) toast(r.state === 'absent' ? '本来就未加载' : '已卸载 ' + m.name);
            else toast('卸载失败：' + (r.err || '模块仍在使用'), 4200);
          } else {
            toast(r && r.ok ? '加载成功' : '加载失败：' + explain((r && (r.err || r.out)) || '未知错误'), 6000);
          }
          closeModuleSheet();
          return Promise.all([refreshModules(), refreshStatus(), refreshLogs()]);
        });
      });
    });

    $('#md-delete').addEventListener('click', function () {
      var m = state.editing;
      if (!m) return;

      if (m.hot) {
        guard(function () {
          return LKM.unloadByName(m.name).then(function (r) {
            toast(r.ok ? '已从列表移除并卸载 ' + m.name : '卸载失败：' + (r.err || '模块仍在使用'), 3800);
            closeModuleSheet();
            return Promise.all([refreshModules(), refreshStatus()]);
          });
        });
        return;
      }

      /* only files that live inside the module dir are deleted with the entry;
         a module added to boot from elsewhere keeps its file */
      var owned = String(m.path).indexOf(String(LKM.modDir || '') + '/') === 0;
      if (!window.confirm(owned
        ? '删除 ' + m.name + '.ko？文件会一并删除。'
        : '把 ' + m.name + ' 从开机列表移除？原文件（' + m.path + '）会保留。')) return;

      guard(function () {
        return LKM.removeModule(m.name).then(function (r) {
          toast(r && r.removedFile ? '已删除 ' + m.name : '已移除 ' + m.name + '（原文件保留）');
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
          return refreshAll();
        });
      });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPoll();
      else startPoll();
    });
  }

  /*
   * Cheap poll: one shell that only reads the loader's counters. The loader
   * bumps `seq` on every operation, so the log is re-read only when something
   * really happened.
   */
  function pollStatus() {
    return LKM.tick().then(function (t) {
      var prev = state.status || {};

      if (!t.loaderUp) {
        state.downTicks++;
        if (state.downTicks % 3 === 0) return refreshStatus();
        if (prev.loaderUp) {
          state.status = Object.assign({}, prev, { loaderUp: false, ctlReadable: false });
          renderStatus();
        }
        return;
      }
      state.downTicks = 0;

      var changed = t.seq !== prev.seq;
      state.status = Object.assign({}, prev, {
        loaderUp: true,
        ctlReadable: t.ctlReadable,
        seq: t.seq,
        /* with an unreadable /proc/lkmctl the counters come back empty:
           keep the last known values instead of showing zeros */
        loads: t.ctlReadable ? t.loads : (prev.loads || 0),
        fails: t.ctlReadable ? t.fails : (prev.fails || 0),
        symbols: t.symbols || prev.symbols || 0,
        cacheUsed: t.cacheUsed || prev.cacheUsed || 0,
        cacheHits: t.cacheHits || prev.cacheHits || 0,
        lastMsg: t.lastMsg || prev.lastMsg || ''
      });
      renderStatus();
      if (changed) return refreshLogs();
    });
  }

  function startPoll() {
    stopPoll();
    state.poll = setInterval(function () {
      if (document.hidden || state.busy) return;
      /* a modal owns the screen: polling behind it only steals shell time
         from whatever the user is doing in there */
      if (!$('#sheet-loaded').hidden || !$('#sheet-module').hidden) return;
      if (state.view === 'status') {
        pollStatus().catch(function () {});
      } else if (state.view === 'modules') {
        refreshModules().catch(function () {});
      }
    }, 6000);
  }

  function stopPoll() {
    if (state.poll) clearInterval(state.poll);
    state.poll = null;
  }

  function fullScreen() {
    if (window.ksu && typeof window.ksu.fullScreen === 'function') {
      try { window.ksu.fullScreen(true); } catch (e) { /* ignore */ }
    }
  }

  function renderBridgeError(e) {
    var pill = $('#st-loader');
    pill.className = 'pill bad';
    pill.textContent = '无法读取';
    var hint = $('#st-hint');
    hint.hidden = false;
    hint.textContent = 'WebUI 执行命令失败（' + ((e && e.message) || '未知错误') +
      '）。状态无法确认，这不代表 loader 没有加载。';
    $('#ui-manager').textContent = LKM.isDemo ? 'Browser' : 'Unknown';
  }

  function bootstrap() {
    /* everything that needs the module dir is fired at once: the dir lookup
       and config read are shared through memoized promises */
    return guard(function () {
      return Promise.all([
        LKM.status().catch(function (e) { return { error: e }; }),
        LKM.loadConfig().catch(function () { return null; }),
        LKM.readOptionsFile().catch(function () { return {}; }),
        LKM.meta().catch(function () { return {}; })
      ]).then(function (r) {
        var s = r[0];
        var cfg = r[1];

        if (cfg) {
          state.options = cfg.options;
          state.defaultStage = cfg.defaultStage;
        }
        state.optFile = r[2] || {};
        renderMeta(r[3]);
        renderParams();
        renderSettings();

        if (s && !s.error) {
          state.status = s;
          renderStatus();
        } else {
          renderBridgeError(s && s.error);
        }

        return Promise.all([
          refreshModules().catch(function () {}),
          refreshLogs()
        ]);
      });
    }).then(function () {
      fullScreen();
      startPoll();
    });
  }

  function init() {
    if (LKM.isDemo) $('#demo-banner').hidden = false;
    bind();

    var hash = (location.hash || '').replace('#', '');
    setView(['status', 'modules', 'settings'].indexOf(hash) >= 0 ? hash : 'status');

    bootstrap();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
