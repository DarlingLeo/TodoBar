(() => {
  'use strict';
  // 错误上报(GUI 环境下弹窗会被全局兜底吞掉,这里走 console.error 便于主进程捕获写入 error.log)
  window.addEventListener('error', (e) => { try { console.error('WIN_ERR:', e.message, '@', e.filename + ':' + e.lineno, e.error && e.error.stack); } catch (_) {} });
  window.addEventListener('unhandledrejection', (e) => { try { console.error('REJ:', (e.reason && (e.reason.stack || e.reason.message)) || e.reason); } catch (_) {} });
  const api = window.api;
  const $ = (id) => document.getElementById(id);

  let todos = [];
  let settings = null;
  let docked = false;
  let viewDate = null; // 非空 = 正在查看历史日期的待办/已完成
  let layoutMode = 'v'; // v=上下(待办在上/已完成在下), h=左右(并排)
  let theme = 'blue'; // blue=经典蓝白, google=经典谷歌配色

  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const TWO_HOURS = 2 * 3600 * 1000;

  // ---------- 工具 ----------
  // 统一紧急程度为 1-5 星(旧数据 urgent 布尔 → 4 星)
  function normalizeTodos(list) {
    return (list || []).map((t) => Object.assign({}, t, {
      urgency: Math.min(5, Math.max(1, parseInt(t.urgency, 10) || (t.urgent ? 4 : 1))),
    }));
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fmtDateTime(d) { return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function fmtDue(t) {
    const now = new Date();
    const today = fmtDate(now);
    const tomorrow = fmtDate(new Date(now.getTime() + 86400000));
    const d = t.dueDate || today; // 没选日期默认今天
    const hm = t.dueTime ? ' ' + t.dueTime : '';
    if (d === today) return '今天' + hm;
    if (d === tomorrow) return '明天' + hm;
    return d.slice(5) + hm;
  }
  function fmtDur(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + ' 分钟';
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  }
  function effDate(t) { return t.dueDate || fmtDate(new Date()); } // 没选日期默认今天
  function dueTs(t) {
    if (!t.dueDate && !t.dueTime) return Infinity;
    return new Date(`${effDate(t)}T${t.dueTime || '23:59'}`).getTime();
  }
  function getStatus(t) {
    // 没选日期也没选时间 → 长期有效(一直显示,直到完成)
    if (!t.dueDate && !t.dueTime) return { group: 'normal', label: '长期有效' };
    const due = dueTs(t);
    const now = Date.now();
    if (due < now) return { group: 'overdue', label: '已过期' };
    if (due - now <= TWO_HOURS) return { group: 'soon', label: '剩 ' + fmtDur(due - now) };
    return { group: 'normal', label: '截止 ' + fmtDue(t) };
  }

  // ---------- 渲染 ----------
  function starsHTML(u) {
    const n = Math.min(5, Math.max(1, parseInt(u, 10) || 1));
    let s = '';
    for (let i = 1; i <= 5; i++) s += `<span class="star-i ${i <= n ? 'on' : 'off'}">${i <= n ? '★' : '☆'}</span>`;
    return `<span class="urgency clickable" data-edit-urgency="1" title="紧急程度 ${n}/5,点击修改">${s}</span>`;
  }

  let remindExpanded = false; // 提醒列表折叠状态

  function itemHTML(t, st, completed) {
    const badges = [];
    if (t.important) badges.push('<span class="badge imp">重要</span>'); // 仅兼容旧数据
    let statusHtml = '';
    if (!completed) {
      if (st.group === 'overdue') statusHtml = `<span class="due overdue clickable" data-edit-due="1" title="点击修改截止时间">⚠ ${esc(st.label)}</span>`;
      else if (st.group === 'soon') statusHtml = `<span class="due soon clickable" data-edit-due="1" title="点击修改截止时间">⚠ ${esc(st.label)}</span>`;
      else if (st.label) statusHtml = `<span class="due clickable" data-edit-due="1" title="点击修改截止时间">${esc(st.label)}</span>`;
    } else {
      statusHtml = `<span class="done-time">完成于 ${fmtDateTime(new Date(t.completedAt))}</span>`;
    }
    const cls = completed ? 'done'
      : st.group === 'overdue' ? 'overdue-item'
      : st.group === 'soon' ? 'soon-item' : '';
    return `<div class="todo-item ${cls}" data-id="${t.id}">
      <label class="cb"><input type="checkbox" class="cb-input" ${completed ? 'checked' : ''} /><span class="box"></span></label>
      <div class="body">
        <div class="title clickable" data-edit-title="1" title="点击修改标题">${esc(t.title)}</div>
        <div class="meta">${badges.join('')}${starsHTML(t.urgency)}${statusHtml}</div>
      </div>
      <button class="del" title="删除待办">🗑</button>
    </div>`;
  }

  function render() {
    const now = new Date();
    const isHistory = !!viewDate;
    const viewKey = isHistory ? viewDate : fmtDate(now);
    // 顶栏状态
    $('btnToday').classList.toggle('hidden', !isHistory);
    $('btnAdd').classList.toggle('hidden', isHistory);
    const shown = isHistory ? new Date(viewKey + 'T00:00:00') : now;
    $('todayLabel').textContent = `${fmtDate(shown)} 星期${WEEKDAYS[shown.getDay()]}`;
    $('titleHeading').textContent = isHistory ? '历史记录' : '今日待办';
    $('sectionTitleDayText').textContent = isHistory ? '该日待办' : '今日待办';
    $('sectionTitleDoneText').textContent = isHistory ? '该日已完成' : '已完成列表';

    // 三区数据
    // 该日待办 = 该日"活跃"的待办:创建日期 <= 查看日期,且(未设截止日期 或 截止日期 >= 查看日期)
    const dayTodos = todos.filter((t) =>
      !t.completedAt &&
      fmtDate(new Date(t.createdAt || 0)) <= viewKey &&
      (t.dueDate == null || t.dueDate >= viewKey));
    const dayDone = todos.filter((t) => t.completedAt && fmtDate(new Date(t.completedAt)) === viewKey);
    // 提醒列表 = 累计:截止日期早于查看日期的未完成待办(跨日期累计,与该日待办天然不重复)
    const remindTodos = todos.filter((t) => !t.completedAt && t.dueDate != null && t.dueDate < viewKey);

    dayTodos.sort((a, b) => {
      const u = (b.urgency || 1) - (a.urgency || 1);
      if (u) return u;
      const d = dueTs(a) - dueTs(b);
      if (d) return d;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    dayDone.sort((a, b) => b.completedAt - a.completedAt);
    remindTodos.sort((a, b) => dueTs(a) - dueTs(b));

    // 渲染三区
    $('dayList').innerHTML = dayTodos.map((t) => itemHTML(t, getStatus(t), false)).join('');
    $('dayCount').textContent = dayTodos.length;
    $('dayEmpty').textContent = isHistory
      ? '该日没有活跃的待办'
      : '今日没有活跃的待办,点击右上角 ＋ 添加';
    $('dayEmpty').classList.toggle('hidden', dayTodos.length > 0);

    $('doneList').innerHTML = dayDone.map((t) => itemHTML(t, { group: 'done' }, true)).join('');
    $('doneCount').textContent = dayDone.length;
    $('doneEmpty').textContent = isHistory ? '该日没有完成的待办' : '今日没有完成的待办';
    $('doneEmpty').classList.toggle('hidden', dayDone.length > 0);

    $('remindList').innerHTML = remindTodos.map((t) => itemHTML(t, getStatus(t), false)).join('');
    $('remindCount').textContent = remindTodos.length;
    $('remindToggle').setAttribute('aria-expanded', remindExpanded ? 'true' : 'false');
    $('remindList').classList.toggle('collapsed', !remindExpanded);
    $('remindCaret').textContent = remindExpanded ? '▴' : '▾';
  }

  // ---------- 事件委托(删除/改期/勾选) ----------
  document.addEventListener('click', (e) => {
    const item = e.target.closest('.todo-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('.del')) {
      api.remove(id).then((list) => { todos = normalizeTodos(list); render(); toast('已删除该待办'); });
      return;
    }
    // 改期:保存 / 取消
    if (e.target.closest('.due-ok')) {
      const date = item.querySelector('.due-date').value || null;
      const time = item.querySelector('.due-time').value || null;
      api.updateDue(id, date, time).then((list) => {
        todos = normalizeTodos(list); render();
        toast(date || time ? '已更新截止时间' : '已改为长期有效');
      });
      return;
    }
    if (e.target.closest('.due-cancel')) { render(); return; }
    // 点击截止时间 → 打开行内编辑器
    if (e.target.closest('.due[data-edit-due]')) {
      const t = todos.find((x) => x.id === id);
      if (!t) return;
      const meta = item.querySelector('.meta');
      meta.innerHTML = `<span class="due-edit-box">
        <input type="date" class="due-date" value="${t.dueDate || ''}" />
        <input type="time" class="due-time" value="${t.dueTime || ''}" />
        <button class="due-ok" title="保存">✓</button>
        <button class="due-cancel" title="取消">✕</button>
      </span>`;
      const di = meta.querySelector('.due-date');
      if (di) di.focus();
      return;
    }
    // 点击标题 → 行内输入框编辑(回车/失焦=保存,Esc=取消)
    if (e.target.closest('.title[data-edit-title]')) {
      if (item.querySelector('.title-input')) return; // 已在编辑中
      const t = todos.find((x) => x.id === id);
      if (!t) return;
      const titleEl = item.querySelector('.title');
      titleEl.innerHTML = `<div class="title-edit-box"><input class="title-input" value="${esc(t.title)}" maxlength="200" autocomplete="off" /></div>`;
      const inp = titleEl.querySelector('.title-input');
      inp.focus();
      inp.select();
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); inp.value = t.title; inp.blur(); }
      });
      inp.addEventListener('blur', () => {
        const val = inp.value.trim();
        if (val && val !== t.title) {
          api.updateTitle(id, val).then((list) => { todos = normalizeTodos(list); render(); toast('已更新标题'); });
        } else {
          render(); // 空或未变 → 恢复原样
        }
      });
      return;
    }
    // 星级:预览(点星即时高亮)
    if (e.target.closest('.ue-star')) {
      const s = e.target.closest('.ue-star');
      const v = Number(s.dataset.v);
      const urgencyEl = item.querySelector('.urgency');
      urgencyEl.dataset.cur = v;
      urgencyEl.querySelectorAll('.ue-star').forEach((el) => {
        const on = Number(el.dataset.v) <= v;
        el.classList.toggle('on', on);
        el.textContent = on ? '★' : '☆';
      });
      return;
    }
    // 星级:保存 / 取消
    if (e.target.closest('.ue-ok')) {
      const urgencyEl = item.querySelector('.urgency');
      const v = Number(urgencyEl.dataset.cur) || 1;
      api.updateUrgency(id, v).then((list) => { todos = normalizeTodos(list); render(); toast('已更新紧急程度为 ' + v + ' 星'); });
      return;
    }
    if (e.target.closest('.ue-cancel')) { render(); return; }
    // 点击星级 → 打开星级选择器
    if (e.target.closest('.urgency[data-edit-urgency]')) {
      if (item.querySelector('.ue-ok')) return; // 已在编辑中
      const t = todos.find((x) => x.id === id);
      if (!t) return;
      const n = Math.min(5, Math.max(1, parseInt(t.urgency, 10) || 1));
      const urgencyEl = item.querySelector('.urgency');
      let stars = '';
      for (let i = 1; i <= 5; i++) stars += `<span class="ue-star${i <= n ? ' on' : ''}" data-v="${i}">${i <= n ? '★' : '☆'}</span>`;
      urgencyEl.dataset.cur = n;
      urgencyEl.innerHTML = `<span class="urgency-edit-box">${stars}<button class="ue-ok" title="保存">✓</button><button class="ue-cancel" title="取消">✕</button></span>`;
      return;
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.classList && e.target.classList.contains('cb-input')) {
      const item = e.target.closest('.todo-item');
      if (item) {
        api.toggle(item.dataset.id).then((list) => {
          todos = normalizeTodos(list); render();
          toast(e.target.checked ? '已标记完成,完成时间: ' + fmtDateTime(new Date()) : '已恢复为待办');
        });
      }
    }
  });

  // ---------- 历史日期浏览(点击顶栏日期) ----------
  $('dateBtn').onclick = () => {
    const dp = $('datePicker');
    if (typeof dp.showPicker === 'function') {
      try { dp.showPicker(); return; } catch (e) { /* 继续走兜底 */ }
    }
    dp.focus();
    dp.click();
  };
  $('datePicker').onchange = () => {
    const v = $('datePicker').value;
    if (v) {
      // 选中的就是今天 → 直接回到今天视图(隐藏 ◀,显示 ＋);其他日期 → 历史视图
      viewDate = v === fmtDate(new Date()) ? null : v;
      closeAdd();
      render();
      toast(viewDate ? '已切换到 ' + viewDate : '已回到今天');
    }
  };
  $('btnToday').onclick = () => { viewDate = null; render(); };

  // ---------- 布局切换(上下 ⇄ 左右) ----------
  function updateLayoutBtn() {
    // 按钮显示"点击后要切到的布局"图标
    const target = layoutMode === 'v' ? 'h' : 'v';
    $('btnLayout').innerHTML = target === 'h'
      ? '<svg viewBox="0 0 16 16" width="15" height="15"><rect x="1.5" y="2" width="5.5" height="12" rx="1.5"/><rect x="9" y="2" width="5.5" height="12" rx="1.5"/></svg>'
      : '<svg viewBox="0 0 16 16" width="15" height="15"><rect x="2" y="1.5" width="12" height="5.5" rx="1.5"/><rect x="2" y="9" width="12" height="5.5" rx="1.5"/></svg>';
    $('btnLayout').title = layoutMode === 'v' ? '切换为左右布局' : '切换为上下布局';
  }
  function applyLayout() {
    document.body.classList.toggle('layout-h', layoutMode === 'h');
    updateLayoutBtn();
  }
  $('btnLayout').onclick = () => {
    layoutMode = layoutMode === 'v' ? 'h' : 'v';
    applyLayout();
    api.saveSettings({ ...settings, layout: layoutMode });
    toast(layoutMode === 'h' ? '已切换为左右布局' : '已切换为上下布局');
  };

  // ---------- 配色风格切换(经典蓝白 ⇄ 经典谷歌) ----------
  function applyTheme() {
    document.body.dataset.theme = theme;
    $('btnTheme').title = theme === 'google' ? '切换配色风格(当前:谷歌,点击切回蓝白)' : '切换配色风格(当前:蓝白,点击切为谷歌)';
    applyOpacity((settings && settings.opacity) || 0.92); // 背景色跟随主题重新应用
  }
  $('btnTheme').onclick = () => {
    theme = theme === 'blue' ? 'google' : 'blue';
    applyTheme();
    api.saveSettings({ ...settings, theme });
    toast(theme === 'google' ? '已切换为经典谷歌配色' : '已切换为经典蓝白配色');
  };
  $('remindToggle').onclick = () => {
    remindExpanded = !remindExpanded;
    $('remindToggle').setAttribute('aria-expanded', remindExpanded ? 'true' : 'false');
    $('remindList').classList.toggle('collapsed', !remindExpanded);
    $('remindCaret').textContent = remindExpanded ? '▴' : '▾';
  };

  // ---------- 新增待办 ----------
  let addUrgency = 1; // 紧急程度 1-5 星,默认 1 星
  function syncStars() {
    document.querySelectorAll('#starPicker .star').forEach((el) => {
      el.classList.toggle('on', Number(el.dataset.v) <= addUrgency);
    });
    $('starNote').textContent = addUrgency + ' 星';
  }
  function closeAdd() {
    $('addForm').classList.add('hidden');
    $('inpTitle').value = '';
    addUrgency = 1;
    $('inpDate').value = ''; // 默认不预填:都不填 = 长期有效;只填时间才默认今天
    $('inpTime').value = '';
    syncStars();
  }
  $('btnAdd').onclick = () => {
    const f = $('addForm');
    f.classList.toggle('hidden');
    if (!f.classList.contains('hidden')) $('inpTitle').focus();
  };
  $('btnAddCancel').onclick = closeAdd;
  $('starPicker').addEventListener('click', (e) => {
    const s = e.target.closest('.star');
    if (!s) return;
    addUrgency = Number(s.dataset.v);
    syncStars();
  });
  $('btnAddOk').onclick = submitAdd;
  $('inpTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAdd(); });
  function submitAdd() {
    const title = $('inpTitle').value.trim();
    if (!title) { $('inpTitle').focus(); return; }
    const timeVal = $('inpTime').value || null;
    const todo = {
      title,
      urgency: addUrgency,
      // 日期时间都没选 → 长期有效;只填了时间 → 默认今天该时刻;选了日期 → 按所选日期
      dueDate: $('inpDate').value || (timeVal ? fmtDate(new Date()) : null),
      dueTime: timeVal,
    };
    api.add(todo).then((list) => {
      todos = normalizeTodos(list); render(); closeAdd(); toast('已添加待办');
    });
  }

  // ---------- 贴边折叠 ----------
  $('btnDock').onclick = () => api.toggleDock();
  $('btnHide').onclick = () => api.hideWindow();

  function applyDock(d) {
    docked = d.docked;
    document.body.classList.toggle('docked', d.docked);
    document.body.dataset.side = d.side || '';
    $('strip').classList.toggle('hidden', !d.docked); // 确保贴边条随贴边状态显隐
  }
  api.onDockState(applyDock);
  api.getState().then(applyDock);

  // 折叠条:点击展开,拖动可沿屏幕边缘移动
  const strip = $('strip');
  let stripDragging = false, stripLast = null, stripMoved = 0;
  strip.addEventListener('pointerdown', (e) => {
    stripDragging = true; stripMoved = 0;
    stripLast = { x: e.screenX, y: e.screenY };
    strip.setPointerCapture(e.pointerId);
  });
  strip.addEventListener('pointermove', (e) => {
    if (!stripDragging) return;
    const dx = e.screenX - stripLast.x;
    const dy = e.screenY - stripLast.y;
    stripMoved += Math.abs(dx) + Math.abs(dy);
    stripLast = { x: e.screenX, y: e.screenY };
    if (stripMoved > 4) api.stripMove(dx, dy);
  });
  const endStripDrag = () => { stripDragging = false; };
  strip.addEventListener('pointerup', endStripDrag);
  strip.addEventListener('pointercancel', endStripDrag);
  strip.addEventListener('click', () => { if (stripMoved > 4) return; api.toggleDock(); });

  // ---------- 设置 ----------
  $('btnSettings').onclick = openSettings;
  $('btnSettingsClose').onclick = closeSettings;
  $('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) closeSettings(); });

  function applyOpacity(v) {
    // 背景色 RGB 跟随主题:蓝白 #F7F9FC / 谷歌嫩黄 #FFFFED
    const rgb = theme === 'google' ? '255, 255, 237' : '247, 249, 252';
    document.documentElement.style.setProperty('--panel-bg', `rgba(${rgb}, ${v})`);
  }
  $('setOpacity').oninput = function () {
    $('opacityVal').textContent = this.value + '%';
    applyOpacity(this.value / 100);
  };

  async function openSettings() {
    settings = await api.getSettings();
    const s = settings, e = s.email;
    $('setOpacity').value = Math.round(s.opacity * 100);
    $('opacityVal').textContent = Math.round(s.opacity * 100) + '%';
    $('setWidth').value = s.width || 380;
    $('setHeight').value = s.height || 620;
    $('setAutoStart').checked = !!s.autoStart;
    $('setMailEnabled').checked = e.enabled;
    $('setMailHost').value = e.host || '';
    $('setMailPort').value = e.port || 465;
    $('setMailUser').value = e.user || '';
    $('setMailAuth').value = e.authCode || '';
    $('setMailTo').value = e.to || '';
    $('setMailFreq').value = e.frequency || 'daily';
    $('setMailTime').value = e.pushTime || '20:00';
    api.getEmailInfo().then((info) => {
      $('mailInfo').textContent = info.lastPushAt ? '上次推送:' + info.lastPushAt : '尚未推送过';
    });
    $('settingsModal').classList.remove('hidden');
  }
  function closeSettings() { $('settingsModal').classList.add('hidden'); }

  function collectEmail() {
    const e = settings.email || {};
    return {
      enabled: $('setMailEnabled').checked,
      host: $('setMailHost').value.trim(),
      port: Number($('setMailPort').value) || 465,
      secure: Number($('setMailPort').value) === 465,
      user: $('setMailUser').value.trim(),
      authCode: $('setMailAuth').value.trim(),
      to: $('setMailTo').value.trim(),
      frequency: $('setMailFreq').value,
      pushTime: $('setMailTime').value || '20:00',
      lastPushKey: e.lastPushKey || '',
      lastPushAt: e.lastPushAt || '',
    };
  }
  async function saveSettingsNow() {
    settings = { ...settings, email: collectEmail() };
    await api.saveSettings(settings);
  }
  $('btnSettingsSave').onclick = async () => {
    settings = {
      opacity: Number($('setOpacity').value) / 100,
      width: Math.max(300, Number($('setWidth').value) || 380),
      height: Math.max(420, Number($('setHeight').value) || 620),
      layout: settings.layout || 'v',
      autoStart: $('setAutoStart').checked,
      email: collectEmail(),
    };
    await api.saveSettings(settings);
    closeSettings();
    toast('设置已保存');
  };
  $('btnMailTest').onclick = async () => {
    await saveSettingsNow();
    const r = await api.testEmail();
    toast(r.ok ? '测试邮件已发送,请查收' : '发送失败:' + (r.msg || ''));
  };
  $('btnMailNow').onclick = async () => {
    await saveSettingsNow();
    const r = await api.sendNow();
    toast(r.ok ? '已推送邮件' : '推送失败:' + (r.msg || ''));
  };

  $('btnExport').onclick = async () => {
    const r = await api.exportData();
    toast(r.ok ? '已导出到 ' + r.path : '已取消');
  };
  $('btnImport').onclick = async () => {
    const r = await api.importData();
    if (r.ok) {
      todos = normalizeTodos(r.todos);
      settings = r.settings;
      render();
      toast('导入成功');
    } else if (!r.canceled) {
      toast('导入失败:' + (r.msg || ''));
    }
  };
  $('btnOpenDir').onclick = () => api.openDataDir();

  // ---------- 提示 ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
  }
  // 主进程通知(如:已有实例在运行)
  api.onNotice((msg) => toast(msg));

  // ---------- 初始化 ----------
  async function init() {
    todos = normalizeTodos(await api.list());
    settings = await api.getSettings();
    applyOpacity(settings.opacity || 0.92);
    layoutMode = settings.layout === 'h' ? 'h' : 'v';
    applyLayout();
    theme = settings.theme === 'google' ? 'google' : 'blue';
    applyTheme();
    $('datePicker').value = fmtDate(new Date()); // 日历默认定位到今天
    render();
    syncStars();
    // 每 30 秒刷新倒计时 / 过期状态
    setInterval(render, 30000);
  }
  init();
})();
