@echo off
chcp 65001 >nul
setlocal

REM ================================================================
REM  使用前请修改以下三处路径，改为你的本机 BrowserSkill 安装位置
REM ================================================================
set "BSK_HOME=你的bsk-home路径"
set "PATH=你的bsk-cli目录;%PATH%"
set "EXTENSION_PATH=你的BrowserSkill扩展路径"

set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"

echo ========================================
echo   知乎查成分 - 启动器
echo ========================================
echo.

echo [1/4] 启动 bsk 守护进程...
bsk daemon start 2>nul
timeout /t 2 >nul
bsk --quiet doctor 2>&1 | findstr /C:"daemon running"
echo.

echo [2/4] 关闭现有 Edge 进程 (确保扩展能加载)...
taskkill /f /im msedge.exe >nul 2>&1
timeout /t 2 >nul
echo   已关闭。
echo.

echo [3/4] 启动 Edge (带 BrowserSkill 扩展)...
echo   如果弹出"关闭开发人员模式下的扩展"提示, 请点"以后再说"。
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --user-data-dir="%LOCALAPPDATA%\Microsoft\Edge\User Data" --profile-directory="Default" --load-extension="%EXTENSION_PATH%" --no-first-run --no-default-browser-check "http://127.0.0.1:9588"
echo   等待 Edge 启动和扩展连接...
timeout /t 10 >nul
bsk --quiet doctor 2>&1 | findstr /C:"extension connected" /C:"FAIL"
echo.
timeout /t 5 >nul
bsk --quiet doctor 2>&1 | findstr /C:"extension connected" /C:"FAIL"
echo.

echo [4/4] 启动本地分析服务...
echo.
echo   打开浏览器访问 http://127.0.0.1:9588 开始使用
echo   按 Ctrl+C 停止服务
echo.

python server.py

echo.
echo 服务已停止。按任意键退出...
pause >nul
