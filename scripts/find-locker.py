# -*- coding: utf-8 -*-
# 用 Windows RestartManager API 查找当前锁定指定文件的进程
# 用法: python find-locker.py <文件路径>
import ctypes
import sys
from ctypes import wintypes

class RM_UNIQUE_PROCESS(ctypes.Structure):
    _fields_ = [('dwProcessId', wintypes.DWORD), ('ProcessStartTime', ctypes.c_longlong)]

class RM_PROCESS_INFO(ctypes.Structure):
    _fields_ = [
        ('Process', RM_UNIQUE_PROCESS),
        ('strAppName', ctypes.c_wchar * 256),
        ('strServiceShortName', ctypes.c_wchar * 64),
        ('ApplicationType', ctypes.c_int),
        ('AppStatus', wintypes.DWORD),
        ('TSSessionId', wintypes.DWORD),
        ('bRestartable', wintypes.BOOL),
    ]

def find_lockers(path):
    rstrtmgr = ctypes.windll.rstrtmgr
    session = wintypes.DWORD(0)
    key = 'TodoBarLocker-' + str(ctypes.windll.kernel32.GetTickCount())
    r = rstrtmgr.RmStartSession(ctypes.byref(session), 0, ctypes.c_wchar_p(key))
    if r != 0:
        return 'RmStartSession failed %d' % r
    try:
        arr = (ctypes.c_wchar_p * 1)(path)
        r = rstrtmgr.RmRegisterResources(session, 1, arr, 0, None, 0, None)
        if r != 0:
            return 'RmRegisterResources failed %d' % r
        needed = wintypes.DWORD(0)
        count = wintypes.DWORD(0)
        reboot = wintypes.DWORD(0)
        rstrtmgr.RmGetList(session, ctypes.byref(needed), ctypes.byref(count), None, ctypes.byref(reboot))
        if needed.value == 0:
            return ''
        infos = (RM_PROCESS_INFO * needed.value)()
        count = wintypes.DWORD(needed.value)
        rstrtmgr.RmGetList(session, ctypes.byref(needed), ctypes.byref(count), infos, ctypes.byref(reboot))
        names = []
        for i in range(count.value):
            if infos[i].strAppName:
                names.append('PID %d %s' % (infos[i].Process.dwProcessId, infos[i].strAppName))
        return '; '.join(names)
    finally:
        rstrtmgr.RmEndSession(session)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('NO_ARG'); sys.exit(1)
    out = find_lockers(sys.argv[1])
    print(out if out else 'NO_LOCKER')
