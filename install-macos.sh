#!/usr/bin/env bash
# Warden (warden) — macOS installer. Run from the unzipped repo root:
#   cd warden && bash install-macos.sh
# Installs system deps (Homebrew), builds, provisions Radicale, and loads
# both services as launchd LaunchAgents (auto-start on login, keep-alive).
set -euo pipefail

BOLD='\033[1m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
die()  { echo -e "  ${RED}✗${NC} $1"; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS. Use install.sh on Linux."
[ -f package.json ] || die "Run from the repo root (package.json not found)."
REPO="$(pwd)"

echo -e "\n${BOLD}Warden macOS install${NC}\n"

# ── 1. Xcode Command Line Tools (node-pty compiles native code) ─────────
if ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools missing — triggering install (GUI prompt)."
  xcode-select --install || true
  die "Re-run this script after the Command Line Tools finish installing."
fi
ok "Xcode Command Line Tools"

# ── 2. Homebrew ─────────────────────────────────────────────────────────
if ! command -v brew >/dev/null 2>&1; then
  warn "Homebrew missing — installing (you may be prompted for your password)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Apple Silicon default prefix
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
fi
BREW_PREFIX="$(brew --prefix)"
ok "Homebrew at $BREW_PREFIX"

# ── 3. System packages ──────────────────────────────────────────────────
# node: runtime. tmux: shared terminal sessions. sqlite: DB debugging.
# poppler: PDF text extraction. cliclick: mouse/keyboard control (replaces
# ydotool/xdotool). terminal-notifier: notifications (osascript fallback
# always works). pipx→radicale: local CalDAV/CardDAV PIM hub.
brew install node tmux sqlite poppler cliclick terminal-notifier pipx uv >/dev/null
pipx ensurepath >/dev/null 2>&1 || true
pipx install radicale >/dev/null 2>&1 || pipx upgrade radicale >/dev/null 2>&1 || true
RADICALE_BIN="$HOME/.local/bin/radicale"
[ -x "$RADICALE_BIN" ] || RADICALE_BIN="$(command -v radicale || true)"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node >= 20 required (found $(node -v))."
ok "node $(node -v), tmux, sqlite, poppler, cliclick, terminal-notifier"
[ -n "$RADICALE_BIN" ] && ok "radicale at $RADICALE_BIN" || warn "radicale not installed — PIM hub disabled"

# ── 4. npm deps + build ─────────────────────────────────────────────────
echo "  → npm ci (this takes a while)..."
npm ci --loglevel=error >/dev/null 2>&1 || npm install --loglevel=error >/dev/null
npm run build >/dev/null
ok "Dependencies installed, TypeScript built"

# ── 5. Env file ─────────────────────────────────────────────────────────
mkdir -p data/env
if [ ! -f data/env/env ]; then
  cat > data/env/env <<EOF
# Warden config — fill in and re-run: launchctl kickstart -k gui/$(id -u)/com.warden.warden
CLAUDE_CODE_OAUTH_TOKEN=
TELEGRAM_BOT_TOKEN=
ASSISTANT_NAME=Warden
TZ=$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')
WORKSPACE_ROOT=$HOME/Documents/Warden
AGENT_TIMEOUT=1800000
IDLE_TIMEOUT=1800000
OLLAMA_URL=http://127.0.0.1:11434
STATUS_PORT=3200
BIND_HOST=0.0.0.0
DESKTOP_CONTROL_ENABLED=true
EOF
  warn "Created data/env/env — add your API token (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY) before first use."
else
  ok "data/env/env already present (brought over from the old box?)"
fi
mkdir -p "$HOME/Documents/Warden"

# ── 6. Radicale (PIM hub) ───────────────────────────────────────────────
if [ -n "$RADICALE_BIN" ]; then
  mkdir -p "$HOME/.config/radicale" "$HOME/.local/share/radicale/collections"
  if [ ! -f "$HOME/.config/radicale/config" ]; then
    cat > "$HOME/.config/radicale/config" <<EOF
[server]
hosts = 127.0.0.1:5232

[auth]
type = none

[rights]
type = authenticated

[storage]
filesystem_folder = ~/.local/share/radicale/collections
EOF
  fi
  cat > "$HOME/Library/LaunchAgents/com.warden.radicale.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.warden.radicale</string>
  <key>ProgramArguments</key><array><string>${RADICALE_BIN}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/com.warden.radicale" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.warden.radicale.plist" 2>/dev/null \
    || launchctl load -w "$HOME/Library/LaunchAgents/com.warden.radicale.plist"
  sleep 2
  # Collections (idempotent — 201 created / 405 exists are both fine)
  curl -su dominic:warden -X MKCOL http://127.0.0.1:5232/dominic/cal/ -H "Content-Type: application/xml" \
    -d '<?xml version="1.0"?><create xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><set><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>Warden Calendar</displayname></prop></set></create>' \
    -o /dev/null || true
  curl -su dominic:warden -X MKCOL http://127.0.0.1:5232/dominic/card/ -H "Content-Type: application/xml" \
    -d '<?xml version="1.0"?><create xmlns="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav"><set><prop><resourcetype><collection/><CR:addressbook/></resourcetype><displayname>Warden Contacts</displayname></prop></set></create>' \
    -o /dev/null || true
  # Env wiring (append only if missing)
  grep -q RADICALE_URL data/env/env || cat >> data/env/env <<EOF
RADICALE_URL=http://127.0.0.1:5232
RADICALE_USER=dominic
RADICALE_PASS=warden
RADICALE_CAL_COLLECTION=/dominic/cal/
RADICALE_CARD_COLLECTION=/dominic/card/
RADICALE_STORAGE_DIR=$HOME/.local/share/radicale/collections
EOF
  ok "Radicale running on 127.0.0.1:5232 (calendar + contacts collections ready)"
  echo -e "    ${YELLOW}Apple Calendar:${NC} Settings → Internet Accounts → Add Other → CalDAV →"
  echo -e "    server 127.0.0.1:5232, user dominic, any password → subscribes to Warden's calendar."
fi

# ── 6b. MCP server config: fix Linux paths for this machine ─────────────
# The npx/uvx servers self-install on first spawn (need node + uv, both
# installed above). The config carries Linux home paths and a KDE-only
# server — rewrite for macOS.
if [ -f data/mcp-servers.json ]; then
  python3 - <<PYEOF
import json, os
p = 'data/mcp-servers.json'
servers = json.load(open(p))
home, repo = os.path.expanduser('~'), os.getcwd()
for s in servers:
    s['args'] = [a.replace('/home/dominic/warden', repo).replace('/home/dominic', home) for a in s.get('args', [])]
    if s.get('name') == 'plasma':
        s['enabled'] = False   # KDE Plasma notifications — no-op on macOS
        s.setdefault('notes', '')
        s['notes'] = (s['notes'] + ' Disabled on macOS (KDE-only).').strip()
json.dump(servers, open(p, 'w'), indent=2)
print('  mcp-servers.json paths rewritten for this machine; plasma disabled')
PYEOF
  ok "MCP servers configured (npx/uvx entries self-install on first use)"
fi

# ── 7. Warden LaunchAgent ───────────────────────────────────────────────
NODE_BIN="$(command -v node)"
cat > "$HOME/Library/LaunchAgents/com.warden.warden.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.warden.warden</string>
  <key>ProgramArguments</key><array>
    <string>${NODE_BIN}</string>
    <string>dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict>
    <!-- launchd does NOT inherit shell PATH; without this, tmux/radicale/
         ollama are invisible to spawned children. -->
    <key>PATH</key><string>${BREW_PREFIX}/bin:${BREW_PREFIX}/sbin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>${REPO}/logs/warden.log</string>
  <key>StandardErrorPath</key><string>${REPO}/logs/warden.error.log</string>
</dict></plist>
EOF
mkdir -p logs
launchctl bootout "gui/$(id -u)/com.warden.warden" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.warden.warden.plist" 2>/dev/null \
  || launchctl load -w "$HOME/Library/LaunchAgents/com.warden.warden.plist"
sleep 4

# ── 8. Health check ─────────────────────────────────────────────────────
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3200/api/health | grep -q 200; then
  ok "Warden is up — dashboard: http://localhost:3200"
else
  warn "Service loaded but health check failed — check logs/warden.error.log"
  warn "Most common cause: missing API token in data/env/env. After fixing:"
  warn "  launchctl kickstart -k gui/$(id -u)/com.warden.warden"
fi

echo -e "
${BOLD}Done. Notes:${NC}
  • Restart:  launchctl kickstart -k gui/$(id -u)/com.warden.warden
  • Stop:     launchctl bootout gui/$(id -u)/com.warden.warden
  • Grant ${BOLD}Accessibility${NC} + ${BOLD}Screen Recording${NC} to '${NODE_BIN}' in
    System Settings → Privacy & Security (needed for desktop control/screenshots).
  • Desktop-control + native notifications need the code changes in
    MACOS_PORT_PLAN.md (Tasks 2 & 4) — hand that file to Warden to apply.
  • Ollama (local models): install from ollama.com if you use local models.
"
