#!/bin/bash
# Install Mac secretary as a LaunchAgent (5 min)
set -e

PLIST="$HOME/Library/LaunchAgents/com.tabisurushosai.secretary.plist"
SCRIPT_DEST="$HOME/Documents/mac_secretary.sh"

# Copy the script
cp "$(dirname "$0")/mac_secretary.sh" "$SCRIPT_DEST"
chmod 755 "$SCRIPT_DEST"

# Generate plist
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tabisurushosai.secretary</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT_DEST</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/tabisuru_secretary.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/tabisuru_secretary.err.log</string>
</dict>
</plist>
EOF

# Reload
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo ""
echo "✅ Mac 秘書 LaunchAgent 登録完了"
echo "  plist: $PLIST"
echo "  script: $SCRIPT_DEST"
echo "  ログ: tail -f ~/Library/Logs/tabisuru_secretary.log"
echo ""
echo "次回起動: 即時 + 5分毎"
