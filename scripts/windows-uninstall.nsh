!ifdef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var PanedoraDataCheckbox
  Var PanedoraDeleteData
  Var PanedoraDataPath

  !macro customUnWelcomePage
    UninstPage custom un.PanedoraDataPage un.PanedoraReadDataChoice

    Function un.PanedoraDataPage
      ${If} ${isUpdated}
        Abort
      ${EndIf}

      SetShellVarContext current
      StrCpy $0 "$APPDATA"
      ${If} $installMode == "all"
        SetShellVarContext all
      ${EndIf}
      ${If} $0 == ""
        Abort
      ${EndIf}
      StrCpy $PanedoraDataPath "$0\${PRODUCT_FILENAME}"

      !insertmacro MUI_HEADER_TEXT "Uninstall Panedora" "Choose what to do with local data."
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == "error"
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0 0 100% 24u "Panedora can keep your local data so that your preferences and saved sign-in are available if you reinstall."
      Pop $0
      ${NSD_CreateCheckbox} 0 32u 100% 14u "Also remove local Panedora data"
      Pop $PanedoraDataCheckbox
      ${NSD_CreateLabel} 12u 54u 94% 50u "This includes settings, saved sign-in, and diagnostic logs for this Windows profile.$\r$\n$PanedoraDataPath"
      Pop $0
      ${If} $PanedoraDeleteData == ${BST_CHECKED}
        ${NSD_Check} $PanedoraDataCheckbox
      ${EndIf}
      nsDialogs::Show
    FunctionEnd

    Function un.PanedoraReadDataChoice
      ${NSD_GetState} $PanedoraDataCheckbox $PanedoraDeleteData
    FunctionEnd
  !macroend

  !macro customUnInstall
    ${IfNot} ${isUpdated}
    ${AndIf} $PanedoraDeleteData == ${BST_CHECKED}
    ${AndIf} $PanedoraDataPath != ""
      ${If} ${FileExists} "$PanedoraDataPath\."
        ClearErrors
        RMDir /r "$PanedoraDataPath"
        ${If} ${Errors}
          MessageBox MB_OK|MB_ICONEXCLAMATION "Some local Panedora data could not be removed:$\r$\n$PanedoraDataPath"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !macroend
!endif
