const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 窗口
  getState: () => ipcRenderer.invoke('state:get'),
  toggleDock: () => ipcRenderer.invoke('window:toggle-dock'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  stripMove: (dx, dy) => ipcRenderer.send('strip:move', { dx, dy }),
  onDockState: (cb) => ipcRenderer.on('dock-state', (_e, d) => cb(d)),
  onNotice: (cb) => ipcRenderer.on('notice', (_e, msg) => cb(msg)),
  // 待办
  list: () => ipcRenderer.invoke('todo:list'),
  add: (t) => ipcRenderer.invoke('todo:add', t),
  toggle: (id) => ipcRenderer.invoke('todo:toggle', id),
  updateDue: (id, dueDate, dueTime) => ipcRenderer.invoke('todo:update-due', id, dueDate, dueTime),
  remove: (id) => ipcRenderer.invoke('todo:remove', id),
  // 设置 / 数据
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  openDataDir: () => ipcRenderer.invoke('data:open-dir'),
  // 邮件
  testEmail: () => ipcRenderer.invoke('email:test'),
  sendNow: () => ipcRenderer.invoke('email:send-now'),
  getEmailInfo: () => ipcRenderer.invoke('email:info'),
});
