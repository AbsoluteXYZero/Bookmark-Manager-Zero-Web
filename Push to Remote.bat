@echo off
setlocal

:: Ask user for commit message
set /p COMMITMSG="Enter commit message: "

:: Stage all changes
git add .

:: Commit changes
git commit -m "%COMMITMSG%"

:: Define remotes
set REMOTES=origin gitlab gitea

:: Loop through each remote
for %%R in (%REMOTES%) do (
    echo.
    echo Pushing to %%R...
    git push %%R main
    if %errorlevel% neq 0 (
        echo First push to %%R failed. Retrying...
        git push %%R main
        if %errorlevel% neq 0 (
            echo ERROR: Push to %%R failed twice!
        ) else (
            echo Success on second attempt to %%R.
        )
    ) else (
        echo Success on first attempt to %%R.
    )
)

echo.
echo All push attempts finished.
pause
