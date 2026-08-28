@echo off
rem TodoBar 待办应用启动器 - 双击运行
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
start "" "node_modules\electron\dist\electron.exe" --no-sandbox --disable-gpu .
