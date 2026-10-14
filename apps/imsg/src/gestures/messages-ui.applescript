-- Run only on the dedicated, unlocked Mac desktop. Arguments come from the adapter, not shell interpolation.
on run argv
  set action to item 1 of argv
  if action is "ensure" then
    tell application "Messages" to activate
    tell application "System Events" to tell process "Messages"
      if (count of windows) is 0 then keystroke "n" using command down
      if (count of windows) is 0 then error "Messages window could not be reopened"
    end tell
  else if action is "open" or action is "read" then
    if action is "read" then
      -- Fresh HID input before bringing the transcript into view is necessary for a receipt.
      tell application "System Events" to tell process "Messages"
        if frontmost is false then error "Messages is not in front"
        key code 56
      end tell
    end if
    tell application "Messages" to open location (item 2 of argv)
    delay 0.5
    tell application "System Events" to tell process "Messages"
      if frontmost is false then error "Messages is not in front"
      set focusedItem to value of attribute "AXFocusedUIElement"
      if not (exists attribute "AXIdentifier" of focusedItem) then error "composer is not focused"
      if (value of attribute "AXIdentifier" of focusedItem) is not "messageBodyField" then error "composer is not focused"
    end tell
  else if action is "key" or action is "clear" then
    if action is "clear" then
      -- A lost foreground stops typing, but cleanup must still reach the original draft.
      tell application "Messages"
        activate
        open location (item 2 of argv)
      end tell
      delay 0.5
    end if
    tell application "System Events" to tell process "Messages"
      -- Check immediately before every keystroke, including draft cleanup.
      if frontmost is false then error "Messages is not in front"
      set focusedItem to value of attribute "AXFocusedUIElement"
      if not (exists attribute "AXIdentifier" of focusedItem) then error "composer is not focused"
      if (value of attribute "AXIdentifier" of focusedItem) is not "messageBodyField" then error "composer is not focused"
      if action is "key" then
        if (item 2 of argv) is (ASCII character 10) or (item 2 of argv) is (ASCII character 13) then
          -- Plain Return would SEND the draft. Option-Return inserts a line break.
          key code 36 using option down
        else
          keystroke (item 2 of argv)
        end if
      else
        keystroke "a" using command down
        key code 51
      end if
    end tell
  else if action is "park" then
    tell application "System Events" to tell process "Messages"
      if frontmost is false then error "Messages is not in front; cannot park"
      keystroke "n" using command down
    end tell
  else
    error "Unknown UI action"
  end if
end run
