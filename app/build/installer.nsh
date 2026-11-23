; Extra uninstall step for OpenStems.
;
; The Python environment that the app created on first run lives in
; %LOCALAPPDATA%\OpenStems\engine-env. It belongs to the app, so the uninstaller
; removes it. Nothing else is touched: the models folder, the outputs, the settings
; and the logs all stay where they are.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\OpenStems\engine-env"
  ${endIf}
!macroend
