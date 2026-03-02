#!/usr/bin/env bash
# Torrent Streamer — Production Start Script (Linux / macOS)
# Usage: ./start.sh [--port 8080] [--skip-build]
# Auto-installs Node.js if not present.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=9090
SKIP_BUILD=false
NODE_VERSION="20"   # LTS major version to install if missing

while [[ $# -gt 0 ]]; do
    case $1 in
        --port)       PORT="$2"; shift 2 ;;
        --skip-build) SKIP_BUILD=true; shift ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

cyan='\033[0;36m'; green='\033[0;32m'; red='\033[0;31m'; yellow='\033[0;33m'; bold='\033[1m'; reset='\033[0m'
step() { echo -e "\n${cyan}${bold}>> $*${reset}"; }
ok()   { echo -e "   ${green}✓${reset}  $*"; }
fail() { echo -e "   ${red}✗${reset}  $*"; exit 1; }
warn() { echo -e "   ${yellow}!${reset}  $*"; }
info() { echo -e "      $*"; }

echo ""
echo -e "${bold}  Torrent Streamer${reset}"
echo "  ─────────────────────────────"
echo "  Root : $ROOT"
echo "  Port : $PORT"
echo ""

# ── Detect OS ─────────────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

install_node_linux() {
    step "Installing Node.js $NODE_VERSION (Linux)"

    # Try package managers in order of preference
    if command -v apt-get &>/dev/null; then
        info "Using apt (Debian/Ubuntu)"
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
        info "Using dnf (Fedora/RHEL)"
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_VERSION}.x" | sudo bash -
        sudo dnf install -y nodejs
    elif command -v yum &>/dev/null; then
        info "Using yum (CentOS/RHEL)"
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_VERSION}.x" | sudo bash -
        sudo yum install -y nodejs
    elif command -v pacman &>/dev/null; then
        info "Using pacman (Arch)"
        sudo pacman -Sy --noconfirm nodejs npm
    elif command -v zypper &>/dev/null; then
        info "Using zypper (openSUSE)"
        sudo zypper install -y nodejs npm
    else
        # Fallback: download binary directly
        warn "No known package manager found — installing Node.js binary directly"
        local ARCH_STR="x64"
        [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]] && ARCH_STR="arm64"
        local URL="https://nodejs.org/dist/latest-v${NODE_VERSION}.x/node-v${NODE_VERSION}.*-linux-${ARCH_STR}.tar.xz"
        # Resolve latest patch version
        local LATEST
        LATEST=$(curl -sL "https://nodejs.org/dist/latest-v${NODE_VERSION}.x/" \
            | grep -oP "node-v\K[0-9]+\.[0-9]+\.[0-9]+" | head -1)
        local TARBALL="node-v${LATEST}-linux-${ARCH_STR}.tar.xz"
        local DLURL="https://nodejs.org/dist/v${LATEST}/${TARBALL}"
        info "Downloading $DLURL"
        curl -fsSL "$DLURL" -o "/tmp/$TARBALL"
        sudo tar -xJf "/tmp/$TARBALL" -C /usr/local --strip-components=1
        rm "/tmp/$TARBALL"
    fi
}

install_node_mac() {
    step "Installing Node.js $NODE_VERSION (macOS)"

    if command -v brew &>/dev/null; then
        info "Using Homebrew"
        brew install node@${NODE_VERSION}
        # Homebrew may not link it automatically
        brew link --overwrite --force node@${NODE_VERSION} 2>/dev/null || true
    else
        # Install Homebrew first, then Node
        warn "Homebrew not found — installing Homebrew then Node.js"
        info "This will prompt for your password"
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Add brew to PATH for this session
        if [[ "$ARCH" == "arm64" ]]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        else
            eval "$(/usr/local/bin/brew shellenv)"
        fi
        brew install node@${NODE_VERSION}
        brew link --overwrite --force node@${NODE_VERSION} 2>/dev/null || true
    fi
}

# ── 1. Ensure Node.js is installed ────────────────────────────────────────────
step "Checking Node.js"
if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    ok "Node $NODE_VER already installed"
else
    warn "Node.js not found — installing automatically"
    case "$OS" in
        Linux*)  install_node_linux ;;
        Darwin*) install_node_mac ;;
        *)       fail "Unsupported OS: $OS — install Node.js manually from https://nodejs.org" ;;
    esac

    # Refresh PATH
    export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"
    hash -r 2>/dev/null || true

    if command -v node &>/dev/null; then
        ok "Node $(node --version) installed successfully"
    else
        fail "Node.js installation failed. Please install manually: https://nodejs.org"
    fi
fi

# Ensure npm is available (it ships with Node, but just in case)
if ! command -v npm &>/dev/null; then
    fail "npm not found even after installing Node. Try: sudo npm install -g npm"
fi


# ── 3. Server deps ────────────────────────────────────────────────────────────
STREAMER_DIR="$ROOT/streamer"
[[ -d "$STREAMER_DIR" ]] || fail "streamer/ directory not found"

step "Installing server dependencies"
npm install --prefix "$STREAMER_DIR" --omit=dev --silent
ok "server deps installed"

# ── 4. Launch ─────────────────────────────────────────────────────────────────
step "Starting server"
echo ""
echo -e "  ${bold}http://localhost:$PORT${reset}"
echo ""

export PORT="$PORT"
cd "$STREAMER_DIR"
exec node server.js
