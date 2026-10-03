@echo off
rem 双击这个文件 = 把本地改动提交并推到 GitHub。
rem 真正的逻辑在同目录的 推送.mjs 里（那个文件里有详细说明）。
rem
rem ⚠️ 中文用 chcp 65001 才不会变乱码。
chcp 65001 >nul
cd /d "%~dp0"
node "推送.mjs"
echo.
pause
