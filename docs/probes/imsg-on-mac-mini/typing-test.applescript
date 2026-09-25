on run argv
  set chatURL to item 1 of argv
  tell application "Messages"
    activate
    open location chatURL
  end tell
  delay 1.5
  tell application "System Events" to tell process "Messages"
    set focusedItem to value of attribute "AXFocusedUIElement"
    set focusID to ""
    if exists attribute "AXIdentifier" of focusedItem then set focusID to value of attribute "AXIdentifier" of focusedItem
    if focusID is not "messageBodyField" then error "composer not focused: " & focusID
    log "typing start " & (current date)
    repeat with c in characters of "typing test"
      keystroke (contents of c)
      delay 0.5
    end repeat
    log "typing done, holding " & (current date)
    delay 8
    keystroke "a" using command down
    key code 51
    log "cleared " & (current date)
  end tell
end run
