const { app, BrowserWindow, ipcMain, screen, Tray, Menu, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu'); // 简单列表界面无需 GPU,避免弱/虚拟/远程环境 GPU 进程崩溃
app.setAppUserModelId('com.todobar.app');

// 全局兜底:GUI 应用无控制台时,任何残留的 EPIPE/broken-pipe 异常一律静默,避免 Electron 弹窗骚扰
process.on('uncaughtException', (e) => {
  if (e && (e.code === 'EPIPE' || /broken pipe/i.test(String(e.message || e)))) return;
});

const DATA_DIR = app.getPath('userData');
const DATA_FILE = path.join(DATA_DIR, 'todos.json');
const ERROR_LOG = path.join(DATA_DIR, 'error.log');
const CHANGE_LOG = path.join(DATA_DIR, 'changes.log'); // 写前日志:每次增删改先落一条,可据此重建数据
// GUI 应用无控制台时,console.* 会抛 EPIPE → 触发错误弹窗。统一用此函数安全降级
function logErr(msg) {
  try { console.error(msg); } catch (_) { /* EPIPE 静默 */ }
  try { fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()} ${msg}\n`); } catch (_) {
    // error.log 被占用时降级到备用日志,绝不静默
    try { fs.appendFileSync(path.join(DATA_DIR, 'error-fallback.log'), `${new Date().toISOString()} ${msg}\n`); } catch (_) {}
  }
}
// 写前日志(JSONL,一行一条):在数据变更写入 todos.json 之前先记录,保证任何失败都可追溯/重建
function logChange(entry) {
  try {
    fs.appendFileSync(CHANGE_LOG, JSON.stringify(Object.assign({ ts: Date.now() }, entry)) + '\n', 'utf8');
  } catch (e) {
    logErr('操作日志写入失败: ' + ((e && e.message) || e));
  }
}

const SNAP_THRESHOLD = 3; // 窗口与屏幕边缘重叠或贴近多少像素内触发贴边
const STRIP_SIZE = 24; // 贴边收纳后的小图标尺寸(约 48 的一半,像小任务栏图标)

let win = null;
let tray = null;
let state = { docked: false, dockSide: null, expandedBounds: null };
let programmaticMove = false; // 程序主动移动窗口时跳过贴边检测

const DEFAULT_SETTINGS = {
  opacity: 0.92,
  width: 380,
  height: 620,
  layout: 'v', // v=上下(待办在上/已完成在下), h=左右(并排)
  theme: 'blue', // blue=经典蓝白, google=经典谷歌配色
  autoStart: false, // 开机自动启动
  email: {
    enabled: false,
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: '',
    authCode: '',
    to: '',
    frequency: 'daily', // daily | '0'..'6' (0=周日)
    pushTime: '20:00',
    lastPushKey: '',
    lastPushAt: '',
  },
};

// ---------- 数据存储 ----------
// 统一紧急程度:1-5 星(旧数据 urgent 布尔值 → 4 星)
function normalizeTodos(list) {
  return (list || []).map((t) => Object.assign({}, t, {
    urgency: Math.min(5, Math.max(1, parseInt(t.urgency, 10) || (t.urgent ? 4 : 1))),
  }));
}
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    return {
      settings: Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), d.settings || {}),
      todos: normalizeTodos(d.todos),
    };
  } catch (e) {
    return { settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), todos: [] };
  }
}
let db = loadData();
// 会话启动时备份上一份数据(防丢失;文件被锁/损坏时可用 .bak 恢复);失败则记录到 error.log
function backupOnStart() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak');
    }
  } catch (e) {
    try { fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()} 启动备份失败: ${(e && e.message) || e}\n`); } catch (_) {}
  }
}
backupOnStart();
let saveTimer = null;
let retrySaveTimer = null; // 保存被锁时,每 30 秒自动补存,锁一释放即补上
let pendingLogs = []; // 写前日志被锁(安全软件扫描等)时缓存在内存,定时补写

function flushPendingLogs() {
  if (!pendingLogs.length) return;
  const ok = [];
  for (const entry of pendingLogs) {
    try { fs.appendFileSync(CHANGE_LOG, JSON.stringify(entry) + '\n', 'utf8'); ok.push(entry); }
    catch (_) { break; } // 仍被锁,本轮停止,下轮再试
  }
  if (ok.length) pendingLogs = pendingLogs.filter((e) => !ok.includes(e));
}
function logChange(entry) {
  const line = JSON.stringify(Object.assign({ ts: Date.now() }, entry)) + '\n';
  try {
    fs.appendFileSync(CHANGE_LOG, line, 'utf8');
  } catch (e) {
    try { pendingLogs.push(JSON.parse(line)); } catch (_) {}
    logErr('操作日志写入失败(已缓存,稍后自动补写): ' + ((e && e.message) || e));
  }
}
function scheduleRetrySave() {
  if (retrySaveTimer) return;
  retrySaveTimer = setTimeout(() => {
    retrySaveTimer = null;
    try { flushPendingLogs(); } catch (_) {}
    saveData(); // 若仍失败,saveData 内部会再次 scheduleRetrySave
  }, 30000);
}
function saveData() {
  const tmp = DATA_FILE + '.tmp';
  const payload = JSON.stringify(db, null, 2);
  let lastErr = null;
  // 原子写入(tmp + rename)+ 重试 3 次(间隔 200ms),应对杀毒/编辑器/预览窗格的瞬时文件锁
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, DATA_FILE);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } catch (_) {} // 短暂等待锁释放
      }
    }
  }
  // 3 次都失败:降级为直接覆盖写(绕过 rename 目标被锁的场景)
  try {
    fs.writeFileSync(DATA_FILE, payload, 'utf8');
    return;
  } catch (e) {
    lastErr = e;
  }
  // 彻底失败:记录日志 + 通知界面 + 启动自动补存(锁释放后无需用户操作即可补上)
  logErr('保存数据失败(30 秒后自动重试): ' + ((lastErr && lastErr.message) || lastErr));
  try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.corrupt'); } catch (_) {} // 保留现场便于排查
  try { identifyLocker(DATA_FILE); } catch (_) {} // 抓现行:记录是谁锁住了数据文件
  scheduleRetrySave();
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('notice', '⚠ 保存暂未成功(文件被占用),30 秒后会自动重试,无需操作。'); } catch (_) {}
  }
}

// 用 RestartManager 查出当前锁定数据文件的进程,写进日志(便于定位安全软件/同步组件等元凶)
function identifyLocker(file) {
  try {
    const cp = require('child_process');
    const script = path.join(__dirname, 'scripts', 'find-locker.py');
    if (!fs.existsSync(script)) return;
    const r = cp.spawnSync('python', [script, file], { encoding: 'utf8', timeout: 5000 });
    const out = (r.stdout || '').trim();
    if (out && out !== 'NO_LOCKER') logErr('锁文件进程: ' + out);
  } catch (e) {
    logErr('identifyLocker 失败: ' + ((e && e.message) || e));
  }
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveData, 300);
}

// ---------- 工具 ----------
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dateKey(d) { return fmtDate(d); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function weekKey(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day + 3);
  const firstThu = new Date(date.getFullYear(), 0, 4);
  const week = 1 + Math.round(((date - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${date.getFullYear()}-W${pad(week)}`;
}
function isOverdue(t) {
  if (!t.dueDate && !t.dueTime) return false;
  // 只填了时间没填日期 → 默认按今天算
  const date = t.dueDate || fmtDate(new Date());
  const due = new Date(`${date}T${t.dueTime || '23:59'}`).getTime();
  return due < Date.now();
}
function displayOf(b) {
  let best = null;
  let bestOverlap = -1;
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea;
    const ox = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
    const oy = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);
    const overlap = ox * oy;
    if (overlap > bestOverlap) { bestOverlap = overlap; best = d; }
  }
  return best || screen.getPrimaryDisplay();
}

// ---------- 贴边折叠 ----------
// 只要窗口与屏幕边缘重叠(或贴近 3px 内),松手即收纳成小图标贴边
function checkSnap() {
  if (!win || state.docked) return;
  const b = win.getBounds();
  const d = displayOf(b);
  const wa = d.workArea;
  if (b.x <= wa.x + SNAP_THRESHOLD) return dock('left', d);
  if (b.x + b.width >= wa.x + wa.width - SNAP_THRESHOLD) return dock('right', d);
  if (b.y <= wa.y + SNAP_THRESHOLD) return dock('top', d);
  if (b.y + b.height >= wa.y + wa.height - SNAP_THRESHOLD) return dock('bottom', d);
}

function dock(side, display) {
  if (!win) return;
  const d = display || displayOf(win.getBounds());
  const wa = d.workArea;
  state.expandedBounds = win.getBounds(); // 记录展开时的窗口位置尺寸
  state.docked = true;
  state.dockSide = side;
  let nb;
  if (side === 'left') {
    nb = { x: wa.x, y: clamp(state.expandedBounds.y, wa.y, wa.y + wa.height - STRIP_SIZE), width: STRIP_SIZE, height: STRIP_SIZE };
  } else if (side === 'right') {
    nb = { x: wa.x + wa.width - STRIP_SIZE, y: clamp(state.expandedBounds.y, wa.y, wa.y + wa.height - STRIP_SIZE), width: STRIP_SIZE, height: STRIP_SIZE };
  } else if (side === 'top') {
    nb = { x: clamp(state.expandedBounds.x, wa.x, wa.x + wa.width - STRIP_SIZE), y: wa.y, width: STRIP_SIZE, height: STRIP_SIZE };
  } else {
    nb = { x: clamp(state.expandedBounds.x, wa.x, wa.x + wa.width - STRIP_SIZE), y: wa.y + wa.height - STRIP_SIZE, width: STRIP_SIZE, height: STRIP_SIZE };
  }
  programmaticMove = true;
  win.setMinimumSize(STRIP_SIZE, STRIP_SIZE); // 允许缩到小图标尺寸
  win.setBounds(nb, false);
  programmaticMove = false;
  win.setAlwaysOnTop(true);
  win.webContents.send('dock-state', { docked: true, side });
}

function expand() {
  if (!win || !state.docked) return;
  const d = displayOf(win.getBounds());
  const wa = d.workArea;
  const eb = state.expandedBounds || {};
  // 尺寸:以设置值为下限(用户配置的默认大小),如果上次停靠时窗口更大则保留更大的。
  // 这样无论中间是否被手动缩到很小再停靠,展开后都至少回到设置大小,符合"配置默认"的预期。
  const width = clamp(Math.max(db.settings.width || 380, eb.width || 0), 300, wa.width - 10);
  const height = clamp(Math.max(db.settings.height || 620, eb.height || 0), 420, wa.height - 10);
  const nb = {
    x: eb.x !== undefined ? clamp(eb.x, wa.x, wa.x + wa.width - width) : wa.x,
    y: eb.y !== undefined ? clamp(eb.y, wa.y, wa.y + wa.height - height) : wa.y,
    width,
    height,
  };
  programmaticMove = true;
  win.setMinimumSize(300, 420); // 恢复常规最小尺寸
  win.setBounds(nb, false);
  programmaticMove = false;
  state.docked = false;
  state.dockSide = null;
  win.setAlwaysOnTop(false);
  win.webContents.send('dock-state', { docked: false, side: null });
}

function toggleDock() {
  if (!win) return;
  if (state.docked) expand();
  else dock(state.dockSide || 'right');
}

// ---------- 窗口 ----------
function createWindow() {
  const s = db.settings;
  const wa = screen.getPrimaryDisplay().workArea;
  const width = clamp(Math.round(s.width || 380), 300, wa.width - 20);
  const height = clamp(Math.round(s.height || 620), 420, wa.height - 20);

  win = new BrowserWindow({
    width,
    height,
    x: wa.x + wa.width - width - 10,
    y: wa.y + Math.max(30, Math.round((wa.height - height) / 2)),
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 300,
    minHeight: 420,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.on('close', (e) => {
    if (!app.isQuiting) { e.preventDefault(); win.hide(); } // 关闭 = 隐藏到托盘
  });

  // 修复:点击任务栏图标"最小化→还原"后,透明窗口偶发整窗只显示应用图标(不重绘)。
  // 根因:transparent 窗口 + 禁用 GPU 时,系统还原动画结束后渲染层未触发重绘;
  // 手动拖动窗口会强制重排所以又能恢复。这里在还原/显示时主动强制重绘一次。
  const forceRepaint = () => {
    setImmediate(() => {
      if (!win || win.isDestroyed()) return;
      try {
        const b = win.getBounds();
        programmaticMove = true; // 尺寸微调属于程序行为,不要触发贴边检测
        win.setBounds({ ...b, width: b.width + 1 }); // 尺寸变化强制重排+重绘
        win.setBounds(b);
        programmaticMove = false;
        win.webContents.invalidate(); // 双保险:整窗标记为脏区强制重画
      } catch (_) { programmaticMove = false; }
    });
  };
  win.on('restore', forceRepaint);
  win.on('show', forceRepaint);

  // 拖动/缩放结束后检测贴边
  let moveTimer = null;
  const arm = () => {
    if (state.docked || programmaticMove) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(checkSnap, 150);
  };
  win.on('move', arm);
  win.on('resize', arm);

  // 渲染进程异常(崩溃/卡死)时自动重启应用:避免"坏窗口占着单实例锁",导致后续启动都被挡住
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details && details.reason !== 'clean-exit') {
      logErr('渲染进程异常退出(' + details.reason + '),自动重启应用');
      setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
    }
  });
  let unresponsiveTimer = null;
  win.webContents.on('unresponsive', () => {
    logErr('界面无响应,10 秒后自动重启');
    unresponsiveTimer = setTimeout(() => { app.relaunch(); app.exit(0); }, 10000);
  });
  win.webContents.on('responsive', () => { clearTimeout(unresponsiveTimer); });
}

function toggleMainWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { if (state.docked) expand(); win.show(); win.focus(); }
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('今日待办 TodoBar');
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: toggleMainWindow },
    { label: '折叠到屏幕边缘', click: () => { if (win) { state.docked ? expand() : dock(state.dockSide || 'right'); } } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuiting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', toggleMainWindow);
}

// ---------- 邮件 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function tableHtml(list) {
  if (!list.length) return '<p style="color:#999">暂无</p>';
  const rows = list.map((t) => {
    const badges = [];
    if (t.important) badges.push('<span style="background:#fee2e2;color:#dc2626;padding:1px 6px;border-radius:4px;font-size:12px">重要</span>');
    const u = Math.min(5, Math.max(1, parseInt(t.urgency, 10) || 1));
    badges.push(`<span style="color:#f59e0b;font-size:12px" title="紧急程度 ${u}/5">${'★'.repeat(u)}${'☆'.repeat(5 - u)}</span>`);
    const due = t.dueDate ? `${t.dueDate}${t.dueTime ? ' ' + t.dueTime : ''}` : '—';
    const status = isOverdue(t) ? '<span style="color:#dc2626;font-weight:bold">已过期</span>' : '';
    return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(t.title)} ${badges.join(' ')}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">${esc(due)} ${status}</td></tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>`;
}

async function sendSummaryEmail(mode) {
  const s = db.settings.email;
  if (mode === 'test' || mode === 'now') {
    // 手动发送:只要配置了账号/授权码/收件人即可,不要求勾选"启用"
    if (!s.user || !s.authCode || !s.to) {
      return { ok: false, msg: '请先在设置里填写完整的邮箱配置(账号/授权码/收件人)' };
    }
  } else {
    if (!s.enabled || !s.user || !s.authCode || !s.to) {
      return { ok: false, msg: '邮件配置不完整或未启用:请勾选「启用邮件推送」并填写账号/授权码/收件人' };
    }
  }
  const now = new Date();
  const isDaily = mode === 'daily' || (mode === 'now' && s.frequency === 'daily');
  const startTs = isDaily ? startOfDay(now) : now.getTime() - 6 * 86400000;
  const pending = db.todos.filter((t) => !t.completedAt);
  const done = db.todos.filter((t) => t.completedAt && t.completedAt >= startTs);
  const overdue = pending.filter(isOverdue);

  const subject = isDaily
    ? `【待办日报】${fmtDate(now)}`
    : `【待办周报】${fmtDate(new Date(now.getTime() - 6 * 86400000))} ~ ${fmtDate(now)}`;

  const html = `<div style="font-family:'Microsoft YaHei',sans-serif;color:#333;max-width:640px">
  <h2 style="margin:0 0 4px">${esc(subject)}</h2>
  <p style="color:#888;margin:0 0 16px">未完成 ${pending.length} 项 · 已完成 ${done.length} 项 · 已过期 ${overdue.length} 项</p>
  <h3 style="color:#ef4444;border-bottom:2px solid #ef4444;padding-bottom:4px">⚠ 提醒(过期 / 临期)</h3>
  ${tableHtml(overdue)}
  <h3 style="color:#1d4ed8;border-bottom:2px solid #3b82f6;padding-bottom:4px">📌 待办中</h3>
  ${tableHtml(pending)}
  <h3 style="color:#16a34a;border-bottom:2px solid #22c55e;padding-bottom:4px">✔ 已完成(${isDaily ? '今日' : '最近 7 天'})</h3>
  ${tableHtml(done)}
  <p style="color:#aaa;margin-top:20px;font-size:12px">— 来自 TodoBar 桌面待办清单</p>
</div>`;

  const transport = nodemailer.createTransport({
    host: s.host,
    port: Number(s.port) || 465,
    secure: Number(s.port) === 465,
    auth: { user: s.user, pass: s.authCode },
  });
  try {
    await transport.sendMail({ from: `"TodoBar 待办清单" <${s.user}>`, to: s.to, subject, html });
    // 只有定时推送才记录 lastPush,手动发送不干扰定时计划
    if (mode === 'daily' || mode === 'week') {
      s.lastPushKey = mode === 'daily' ? dateKey(now) : weekKey(now);
      s.lastPushAt = now.toISOString();
      scheduleSave();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: String((e && e.message) || e) };
  }
}

// 判断当前时刻是否该推送邮件;返回 null 表示不推,否则 { key, mode }
// 周推:frequency 为 '0'..'6'(0=周日...6=周六),必须当天星期匹配才推
function emailDueNow(now) {
  const s = db.settings.email;
  const [hh, mm] = (s.pushTime || '20:00').split(':').map(Number);
  if (now.getHours() < hh || (now.getHours() === hh && now.getMinutes() < mm)) return null;
  if (s.frequency === 'daily') return { key: dateKey(now), mode: 'daily' };
  const weekday = parseInt(s.frequency, 10);
  if (isNaN(weekday) || now.getDay() !== weekday) return null; // 不是约定星期几,不发
  return { key: weekKey(now), mode: 'week' };
}

function checkEmailSchedule() {
  if (!db.settings.email.enabled) return;
  const r = emailDueNow(new Date());
  if (!r) return;
  if (db.settings.email.lastPushKey === r.key) return;
  sendSummaryEmail(r.mode).then((res) => {
    if (!res.ok) logErr('定时邮件推送失败: ' + res.msg);
  });
}

// ---------- IPC ----------
ipcMain.handle('state:get', () => ({ docked: state.docked, side: state.dockSide }));
ipcMain.handle('window:toggle-dock', () => toggleDock());
ipcMain.handle('window:hide', () => { if (win) win.hide(); });
ipcMain.on('strip:move', (_e, { dx, dy }) => {
  if (!win || !state.docked) return;
  const b = win.getBounds();
  const wa = displayOf(b).workArea;
  let nb = b;
  if (state.dockSide === 'left' || state.dockSide === 'right') {
    nb = { ...b, y: clamp(b.y + (dy || 0), wa.y, wa.y + wa.height - b.height) };
  } else {
    nb = { ...b, x: clamp(b.x + (dx || 0), wa.x, wa.x + wa.width - b.width) };
  }
  programmaticMove = true;
  win.setBounds(nb);
  programmaticMove = false;
  if (state.expandedBounds) {
    state.expandedBounds = { ...state.expandedBounds, x: nb.x, y: nb.y };
  }
});

ipcMain.handle('todo:list', () => db.todos);
ipcMain.handle('todo:add', (_e, t) => {
  const id = genId();
  const todo = {
    id,
    title: String(t.title || '').slice(0, 200),
    urgency: Math.min(5, Math.max(1, parseInt(t.urgency, 10) || 1)),
    important: false, // 已不再提供"重要"选项,仅兼容旧数据
    dueDate: t.dueDate || null,
    dueTime: t.dueTime || null,
    createdAt: Date.now(),
    completedAt: null,
  };
  db.todos.push(todo);
  logChange({ op: 'add', id, title: todo.title, urgency: todo.urgency, dueDate: todo.dueDate, dueTime: todo.dueTime, createdAt: todo.createdAt });
  saveData(); // 必须同步立即落盘:之前 scheduleSave 300ms 防抖会在 app 关闭/崩溃时丢数据
  return db.todos;
});
ipcMain.handle('todo:toggle', (_e, id) => {
  const t = db.todos.find((x) => x.id === id);
  if (t) {
    t.completedAt = t.completedAt ? null : Date.now();
    logChange({ op: t.completedAt ? 'complete' : 'uncomplete', id, title: t.title });
  }
  saveData();
  return db.todos;
});
ipcMain.handle('todo:update-due', (_e, id, dueDate, dueTime) => {
  const t = db.todos.find((x) => x.id === id);
  if (t) {
    t.dueDate = dueDate || null;
    t.dueTime = dueTime || null;
    logChange({ op: 'due', id, title: t.title, dueDate: t.dueDate, dueTime: t.dueTime });
    saveData();
  }
  return db.todos;
});
ipcMain.handle('todo:update-title', (_e, id, title) => {
  const t = db.todos.find((x) => x.id === id);
  if (t) {
    const newTitle = String(title || '').trim().slice(0, 200);
    if (newTitle) {
      t.title = newTitle;
      logChange({ op: 'title', id, title: t.title });
      saveData();
    }
  }
  return db.todos;
});
ipcMain.handle('todo:update-urgency', (_e, id, urgency) => {
  const t = db.todos.find((x) => x.id === id);
  if (t) {
    t.urgency = Math.min(5, Math.max(1, parseInt(urgency, 10) || 1));
    logChange({ op: 'urgency', id, title: t.title, urgency: t.urgency });
    saveData();
  }
  return db.todos;
});
ipcMain.handle('todo:remove', (_e, id) => {
  const t = db.todos.find((x) => x.id === id);
  logChange({ op: 'remove', id, title: t && t.title });
  db.todos = db.todos.filter((x) => x.id !== id);
  saveData();
  return db.todos;
});

ipcMain.handle('settings:get', () => db.settings);
ipcMain.handle('settings:save', (_e, s) => {
  db.settings = s;
  saveData();
  applyAutoStart(!!s.autoStart); // 开机自启立即生效
  if (win && !state.docked) {
    const wa = displayOf(win.getBounds()).workArea;
    const width = clamp(Math.round(s.width || 380), 300, wa.width - 20);
    const height = clamp(Math.round(s.height || 620), 420, wa.height - 20);
    programmaticMove = true;
    win.setBounds({ width, height });
    programmaticMove = false;
  }
  return { ok: true };
});

ipcMain.handle('data:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出待办备份',
    defaultPath: `待办备份-${dateKey(new Date())}.json`,
    filters: [{ name: 'JSON 备份', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify(db, null, 2), 'utf8');
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
});
ipcMain.handle('data:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入待办备份',
    filters: [{ name: 'JSON 备份', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return { ok: false, canceled: true };
  try {
    const d = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (!Array.isArray(d.todos)) throw new Error('备份文件格式不正确');
    db = { settings: Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), d.settings || {}), todos: normalizeTodos(d.todos) };
    logChange({ op: 'import', count: db.todos.length });
    saveData();
    return { ok: true, todos: db.todos, settings: db.settings };
  } catch (e) {
    return { ok: false, msg: String((e && e.message) || e) };
  }
});
ipcMain.handle('data:open-dir', () => shell.openPath(DATA_DIR));

ipcMain.handle('email:test', async () => sendSummaryEmail('test'));
ipcMain.handle('email:send-now', async () => sendSummaryEmail('now'));
ipcMain.handle('email:info', () => {
  const s = db.settings.email;
  return {
    lastPushAt: s.lastPushAt ? new Date(s.lastPushAt).toLocaleString('zh-CN') : '',
    lastPushKey: s.lastPushKey,
  };
});

// ---------- 应用生命周期 ----------
app.isQuiting = false;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (state.docked) expand();
      win.show();
      win.focus();
      // 明确告知:打开的是"正在运行"的实例,避免误以为是全新会话
      win.webContents.send('notice', '已有 TodoBar 实例在运行,已为你打开当前窗口(数据均为最新)');
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    applyAutoStart(!!db.settings.autoStart);
    createWindow();
    createTray();
    // 定时邮件调度:每分钟检查一次
    setInterval(checkEmailSchedule, 60 * 1000);
    setTimeout(checkEmailSchedule, 15000);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { /* 常驻托盘,不退出 */ });
  app.on('before-quit', () => {
    app.isQuiting = true;
    // 退出前兜底:清掉未触发的定时器,强制同步落盘 + 补写操作日志
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (retrySaveTimer) { clearTimeout(retrySaveTimer); retrySaveTimer = null; }
    try { flushPendingLogs(); } catch (_) {}
    try { saveData(); } catch (_) {}
  });
}

// 开机自启动(Windows):设置注册表登录项
function applyAutoStart(on) {
  try {
    if (process.platform !== 'win32') return;
    const args = ['--no-sandbox', '--disable-gpu'];
    if (app.isPackaged) args.length = 0; // 打包版 disable-gpu 已内置,无需参数
    else args.push(app.getAppPath()); // 开发版:需传入应用目录
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args });
  } catch (e) {
    logErr('开机自启动设置失败: ' + ((e && e.message) || e));
  }
}
