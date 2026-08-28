# -*- coding: utf-8 -*-
# 用 ctypes 调 Windows IShellLink COM 接口,创建真正的 .lnk 快捷方式(绕过 WScript.Shell 限制)
import ctypes
from ctypes import wintypes, POINTER, byref, cast, c_void_p, c_ulonglong, sizeof

class GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_uint8 * 8)]

CLSID_ShellLink = GUID(0x00021401, 0x0000, 0x0000, (0xC0,0,0,0,0,0,0,0x46))
IID_IShellLinkW = GUID(0x000214F9, 0x0000, 0x0000, (0xC0,0,0,0,0,0,0,0x46))
IID_IPersistFile = GUID(0x0000010B, 0x0000, 0x0000, (0xC0,0,0,0,0,0,0,0x46))

# IShellLinkW 接口 vtable(方法顺序)
IUnknown = [('QueryInterface', 0), ('AddRef', 1), ('Release', 2)]

def make_vtable():
    return ctypes.c_void_p * 21

shell = ctypes.oledll.ole32
shell.CoCreateInstance.restype = ctypes.c_long
shell.CoCreateInstance.argtypes = [POINTER(GUID), c_void_p, ctypes.c_uint32, POINTER(GUID), POINTER(c_void_p)]

psl = c_void_p()
hr = shell.CoCreateInstance(byref(CLSID_ShellLink), None, 1, byref(IID_IShellLinkW), byref(psl))  # 1=CLSCTX_INPROC_SERVER
if hr != 0:
    raise SystemExit('CoCreateInstance failed: %08x' % (hr & 0xffffffff))

vt = cast(cast(psl, POINTER(c_void_p))[0], POINTER(c_void_p))

WINFUNCTYPE = ctypes.WINFUNCTYPE
# 定义所需方法
# SetPath(psl, LPCWSTR)
SetPath = WINFUNCTYPE(ctypes.c_long, c_void_p, wintypes.LPCWSTR)(vt[20])
# SetArguments(psl, LPCWSTR)
SetArguments = WINFUNCTYPE(ctypes.c_long, c_void_p, wintypes.LPCWSTR)(vt[11])
# SetWorkingDirectory(psl, LPCWSTR)
SetWorkingDirectory = WINFUNCTYPE(ctypes.c_long, c_void_p, wintypes.LPCWSTR)(vt[9])
# SetIconLocation(psl, LPCWSTR, int)
SetIconLocation = WINFUNCTYPE(ctypes.c_long, c_void_p, wintypes.LPCWSTR, ctypes.c_int)(vt[17])
# SetDescription(psl, LPCWSTR)
SetDescription = WINFUNCTYPE(ctypes.c_long, c_void_p, wintypes.LPCWSTR)(vt[7])
# QueryInterface(psl, IID, &out)  -> 取 IPersistFile
QueryInterface = WINFUNCTYPE(ctypes.c_long, c_void_p, POINTER(GUID), POINTER(c_void_p))(vt[0])
# Release
Release = WINFUNCTYPE(ctypes.c_ulong, c_void_p)(vt[2])

exe = r'C:\Users\HP\WorkBuddy\2026-08-04-17-09-52\todo-desktop\node_modules\electron\dist\electron.exe'
app = r'C:\Users\HP\WorkBuddy\2026-08-04-17-09-52\todo-desktop'
args = '--no-sandbox --disable-gpu "%s"' % app
icon = r'C:\Users\HP\WorkBuddy\2026-08-04-17-09-52\todo-desktop\build\icon.ico'

SetPath(psl, exe)
SetArguments(psl, args)
SetWorkingDirectory(psl, app)
SetIconLocation(psl, icon, 0)
SetDescription(psl, 'TodoBar 桌面待办清单')

# 取 IPersistFile
ppf = c_void_p()
hr2 = QueryInterface(psl, byref(IID_IPersistFile), byref(ppf))
if hr2 != 0:
    Release(psl)
    raise SystemExit('QueryInterface(IPersistFile) failed: %08x' % (hr2 & 0xffffffff))

pf_vt = cast(cast(ppf, POINTER(c_void_p))[0], POINTER(c_void_p))
# IPersistFile::Save(ppf, LPCOLESTR pszFileName, BOOL fRemember)  -> vtable index 6
Save = WINFUNCTYPE(ctypes.c_long, c_void_p, wintypes.LPCWSTR, ctypes.c_int)(pf_vt[6])

import os
lnk = os.path.join(os.path.expanduser('~'), 'Desktop', 'TodoBar.lnk')
hr3 = Save(ppf, lnk, 1)
# 释放
pf_release = WINFUNCTYPE(ctypes.c_ulong, c_void_p)(pf_vt[2])
pf_release(ppf)
Release(psl)

if hr3 == 0:
    print('SHORTCUT_OK: ' + lnk)
else:
    print('Save failed: %08x' % (hr3 & 0xffffffff))
