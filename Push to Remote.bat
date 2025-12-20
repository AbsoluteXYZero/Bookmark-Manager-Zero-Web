@echo off
set /p msg="Enter commit message: "

git add .
git commit -m "%msg%"

REM Define remotes
set remotes=origin gitlab gitea

REM Loop through each remote
for %%r in (%remotes%) do (
    set push_success=0

    REM First push attempt
    git push %%r main
    if %ERRORLEVEL% EQU 0 (
        echo Push to %%r succeeded.
        set push_success=1
    ) else (
        echo First push to %%r failed. Retrying...
        REM Second push attempt
        git push %%r main
        if %ERRORLEVEL% EQU 0 (
            echo Second push to %%r succeeded.
            set push_success=1
        ) else (
            echo Second push to %%r FAILED.
        )
    )

    REM Show final status per remote
    if %push_success% EQU 1 (
        echo Final status for %%r: SUCCESS
    ) else (
        echo Final status for %%r: FAILURE
    )
)

echo.
echo All push attempts completed.
pause