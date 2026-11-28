; Synapse pour Windows : ce que l'installateur fait en plus (inclus par electron-builder, voir package.json → nsis.include).
;
; Une seule icône Synapse : une fois Synapse installé (icône sur le bureau et dans le menu Démarrer), l'installateur
; (Synapse-Setup.exe) n'a plus aucune utilité ; il s'efface tout seul, quelques secondes après s'être fermé, pour ne pas
; laisser deux icônes « Synapse » côte à côte. (Pour réinstaller : le retélécharger sur GitHub.)
!macro customInstall
  ExecShell "" "$SYSDIR\cmd.exe" '/c ping 127.0.0.1 -n 6 >nul & del /f /q "$EXEPATH"' SW_HIDE
!macroend
