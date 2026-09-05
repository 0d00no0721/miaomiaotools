@echo off
chcp 65001 >nul
cd /d %~dp0
echo Installing dependencies...
pip install requests pyinstaller
echo Building...
python -m PyInstaller --noconfirm --onefile --name GroupChat server.py
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
if exist config.json copy /y config.json dist\ >nul
if exist members.json copy /y members.json dist\ >nul
if not exist dist\history mkdir dist\history
xcopy /e /i /y web dist\web\ >nul
echo Done. Output: dist\GroupChat.exe
echo Run it and open http://127.0.0.1:8765 in your browser.
pause
