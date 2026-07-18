; ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
;  customInit — make SILENT updates safe against file-lock races.
;
;  Clients on v4.0.7/v4.0.8 run this installer with /S from their
;  quit-time updater, which tears the app down IN PARALLEL with the
;  installer. Stock NSIS oneClick in silent mode does not wait for the
;  dying process to release its locks on the installed .exe/.dll/.asar;
;  when the copy section hits locked files it leaves the old files in
;  place, and electron-updater's isForceRunAfter then relaunches the
;  OLD binary — the "updated to 4.0.9, reopened, it's 4.0.7 again"
;  field report. The updater code already in the field can't be fixed
;  remotely, but every update executes THIS installer, so the installer
;  now guarantees its own preconditions:
;    1. force-kill every process of the app image (main/renderer/gpu
;       all share the image name; the installer has a different image
;       name, so it never matches itself — deliberately NO /T, because
;       the installer is a child of the app process it is replacing)
;    2. poll the installed exe with a write-open until Windows has
;       actually released the image locks (AV scans and handle teardown
;       outlive process death), capped at ~20s so a wedged machine
;       still proceeds instead of hanging the update forever.
;
;  $INSTDIR is not reliably resolved this early in oneClick .onInit, so
;  the path is derived from $LOCALAPPDATA + the package name — pinned
;  by build config (oneClick, per-user, no dir choice) and stable
;  across every release ever shipped.
;
;  The IfFileExists guard skips all of this on a FRESH install: the
;  write-open probe uses append mode, which would otherwise create a
;  stray empty file, and a fresh install has no locks to wait out.
; ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
!macro customInit
  IfFileExists "$LOCALAPPDATA\Programs\interview-copilot-ai\Interview Copilot.exe" 0 icInitDone
  ; Absolute path — System32 is not reliably on PATH on every machine
  ; (observed in the field), and the stock templates use $SYSDIR for the
  ; same reason.
  nsExec::Exec '"$SYSDIR\taskkill.exe" /f /im "Interview Copilot.exe"'
  Pop $R7
  StrCpy $R9 0
  icWaitUnlock:
    ClearErrors
    FileOpen $R8 "$LOCALAPPDATA\Programs\interview-copilot-ai\Interview Copilot.exe" a
    IfErrors icExeLocked
    FileClose $R8
    Goto icInitDone
  icExeLocked:
    Sleep 500
    IntOp $R9 $R9 + 1
    IntCmp $R9 40 icInitDone icWaitUnlock icInitDone
  icInitDone:
!macroend
