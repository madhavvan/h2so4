; ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
;  customInit — three protections, in this order:
;
;  1. DOWNGRADE GUARD. On 2026-07-18 a 3.4.9-era `installer.exe` left in
;     %LOCALAPPDATA%\interview-copilot-ai-updater\ by the old differential
;     downloader was executed on a machine running 4.0.11 and silently
;     downgraded the entire install (registry + binaries) — the app then
;     reported v3.4.9 with "update available". Any stale installer — the
;     updater cache copy, an old Setup.exe in Downloads — can do this,
;     because NSIS happily installs over a newer version. Now: read the
;     installed DisplayVersion (written by the stock installer to
;     SHELL_CONTEXT UNINSTALL_REGISTRY_KEY); if it is NEWER than this
;     installer's ${VERSION}, a silent run ABORTS (silent downgrades are
;     always a bug, never an intent) and an interactive run tells the user
;     the app is already installed, opens the installed copy and leaves.
;     It used to ASK "install the older version anyway?" — a question no
;     customer can answer well, put to exactly the people re-running an
;     old download because something went wrong (reported 2026-09-06).
;     There is no downgrade path here any more: the installed app checks
;     for updates on launch, so "already installed" also means it stays
;     aligned with the latest release without the user doing anything.
;     The guard runs FIRST so an aborted downgrade never kills the app.
;
;  2. FILE-LOCK-SAFE KILL. Clients on v4.0.7/v4.0.8 run this installer
;     with /S in parallel with their own teardown; stock NSIS checks for
;     the running PROCESS but never for FILE LOCKS (which outlive it —
;     handle teardown, AV scans), and on locked files it leaves the old
;     binaries in place while --force-run relaunches the OLD app. So:
;     force-kill the app image (absolute $SYSDIR path — System32 is not
;     reliably on PATH on every machine; no /T because this installer is
;     a child of the app process it replaces), then poll the installed
;     exe with a write-open until Windows actually releases the locks
;     (500ms x 40, ~20s cap). Skipped on fresh installs (no locks, and
;     the append-mode probe would create a stray file).
;
;  3. CACHE-LANDMINE PURGE. Delete the differential-era artifacts
;     (installer.exe, current.blockmap) from the updater cache so the
;     class of bug in (1) is removed machine-by-machine as the fleet
;     updates. pending\ is left alone — the running update executes from
;     there. Runs only when an install is actually proceeding.
;
;  $INSTDIR is not reliably resolved this early in oneClick .onInit, so
;  paths are derived from $LOCALAPPDATA + the package name — pinned by
;  build config (oneClick, per-user, no dir choice) since the first
;  release.
; ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
!include "WordFunc.nsh"

!macro customInit
  ; ── 1. downgrade guard ──
  ReadRegStr $R6 SHCTX "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  StrCmp $R6 "" icGuardDone
  ${VersionCompare} "$R6" "${VERSION}" $R5
  StrCmp $R5 "1" 0 icGuardDone
  IfSilent 0 +2
    Quit
  ; Interactive: never offer a downgrade. Say the app is already current
  ; (no version numbers — they are noise to a customer), open the installed
  ; copy so the double-click still "does something", and exit.
  MessageBox MB_OK|MB_ICONINFORMATION "Interview Copilot is already installed and up to date.$\r$\nOpening the installed app now." /SD IDOK
  IfFileExists "$LOCALAPPDATA\Programs\interview-copilot-ai\Interview Copilot.exe" 0 +2
    Exec '"$LOCALAPPDATA\Programs\interview-copilot-ai\Interview Copilot.exe"'
  Quit
  icGuardDone:

  ; ── 2. kill + wait for file locks (updates only) ──
  IfFileExists "$LOCALAPPDATA\Programs\interview-copilot-ai\Interview Copilot.exe" 0 icInitDone
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

  ; ── 3. purge differential-era cache landmines ──
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  !else
    Delete "$LOCALAPPDATA\interview-copilot-ai-updater\installer.exe"
  !endif
  Delete "$LOCALAPPDATA\interview-copilot-ai-updater\current.blockmap"
!macroend

; The stock install section RE-PLANTS the landmine the macro above just
; removed: include/installer.nsh copies the running installer to
; $LOCALAPPDATA\${APP_INSTALLER_STORE_FILE} ("<name>-updater\installer.exe")
; as the baseline for differential downloads. We publish no blockmaps
; (nsis.differentialPackage=false) and the app disables differential +
; web-installer paths, so the 150 MB self-copy is pure waste that ages
; into exactly the stale-installer hazard the downgrade guard exists for.
; customInstall runs at the END of the install section — after the stock
; copy — so deleting here keeps the cache permanently clean.
!macro customInstall
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  !else
    Delete "$LOCALAPPDATA\interview-copilot-ai-updater\installer.exe"
  !endif

  ; ── TELL THE SHELL THE ICON CHANGED ──
  ;
  ; Reported after every update: "showing the older icons ... only when the
  ; update is released". Windows does not re-read an executable's icon just
  ; because the file was replaced. Explorer, the Start menu and the taskbar
  ; all render from the shell icon cache, and the cache is keyed in a way
  ; that happily survives an in-place binary swap — so a release that
  ; changes the app icon (v4.0.15 and v4.0.16 both did) keeps showing the
  ; PREVIOUS one until something else invalidates the cache, which can be
  ; days, or a reboot.
  ;
  ; SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, NULL, NULL) is the
  ; documented way to say "icons and associations changed, re-read them".
  ; It is a notification, not a mutation: nothing is written, no file is
  ; touched, and it cannot fail in a way that affects the install. This is
  ; the same call the Windows shell makes to itself when a file type is
  ; registered.
  ;
  ; 0x08000000 = SHCNE_ASSOCCHANGED, 0 = SHCNF_IDLIST.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
