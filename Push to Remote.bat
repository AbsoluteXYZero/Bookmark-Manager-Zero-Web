@echo off
setlocal

REM Ask for commit message
set /p msg="Enter commit message: "

REM Commit changes
git add .
git commit -m "%msg%"

REM List of remotes
set remotes=origin gitlab gitea

for %%r in (%remotes%) do (
    echo.
    echo Pushing to %%r...
    git push %%r main
    if errorlevel 1 (
        echo First push to %%r failed, retrying...
        git push %%r main
        if errorlevel 1 (
            echo ERROR: Push to %%r failed twice.
        ) else (
            echo Success on second attempt to %%r.
        )
    ) else (
        echo Success on first attempt to %%r.
    )
)

echo.
echo All push attempts finished.
pause