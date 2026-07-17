@echo off
chcp 65001 >nul
title QuickPaste Build

echo ============================================
echo  QuickPaste - Build to EXE
echo ============================================
echo.

REM Check dependencies
echo [1/3] Checking dependencies...
pip install -r requirements.txt >nul 2>&1

REM Build with PyInstaller
echo [2/3] Building executable...
pyinstaller --onefile --windowed ^
    --name "QuickPaste" ^
    --icon "icon.ico" ^
    --add-data "icon.ico;." ^
    --clean ^
    --noconfirm ^
    main.py

REM Check result
echo [3/3] Checking result...
if exist "dist\QuickPaste.exe" (
    echo.
    echo ============ BUILD SUCCESS ============
    echo Output: dist\QuickPaste.exe
    echo Size: 
    for %%f in (dist\QuickPaste.exe) do echo %%~zf bytes
    echo =======================================
) else (
    echo.
    echo ============ BUILD FAILED ============
    echo Check the error messages above.
    echo =======================================
)

pause