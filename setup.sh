#!/bin/bash

# LogicalInvestor Development Setup Script
# Automates toolchain installation and project configuration

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_step() {
  echo -e "${GREEN}→${NC} $1"
}

log_error() {
  echo -e "${RED}✗${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}⚠${NC} $1"
}

log_success() {
  echo -e "${GREEN}✓${NC} $1"
}

# Check for required tools
log_step "Checking prerequisites..."

# Xcode
if ! command -v xcode-select &> /dev/null; then
  log_error "Xcode not found. Install from App Store, then run this script again."
  exit 1
fi
log_success "Xcode found"

# Homebrew
if ! command -v brew &> /dev/null; then
  log_error "Homebrew not found. Install from https://brew.sh, then run this script again."
  exit 1
fi
log_success "Homebrew found"

# Accept Xcode license (only if not already accepted)
log_step "Checking Xcode license..."
if xcodebuild -version &>/dev/null; then
  log_success "Xcode license already accepted"
else
  log_step "Accepting Xcode license (requires sudo)..."
  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
  sudo xcodebuild -license accept
  log_success "Xcode license accepted"
fi

# Install/verify fnm
log_step "Setting up fnm (Node version manager)..."
if ! command -v fnm &> /dev/null; then
  log_step "Installing fnm..."
  brew install fnm
else
  log_success "fnm already installed"
fi

# Configure fnm in shell
SHELL_RC="$HOME/.zshrc"
if [ -f "$SHELL_RC" ]; then
  if ! grep -q "fnm env" "$SHELL_RC"; then
    log_step "Adding fnm initialization to $SHELL_RC..."
    echo '' >> "$SHELL_RC"
    echo 'eval "$(fnm env --use-on-cd --shell zsh)"' >> "$SHELL_RC"
    log_success "fnm initialization added"
    log_warn "Shell configuration changed. You may need to restart your terminal."
  else
    log_success "fnm already configured in $SHELL_RC"
  fi
else
  log_error "Could not find $SHELL_RC"
  exit 1
fi

# Reload shell configuration for current session
eval "$(fnm env --use-on-cd --shell zsh)" || true

# Install Node 24
log_step "Setting up Node 24 LTS..."
if fnm list | grep -q "v24"; then
  log_success "Node 24 already installed"
else
  log_step "Installing Node 24..."
  fnm install 24
  log_success "Node 24 installed"
fi

# Switch to Node 24 for this session
fnm use 24 || true

# Verify Node
NODE_VERSION=$(node --version)
log_success "Node version: $NODE_VERSION"

# Install CocoaPods
log_step "Setting up CocoaPods..."
if ! command -v pod &> /dev/null; then
  log_step "Installing CocoaPods..."
  brew install cocoapods
  log_success "CocoaPods installed"
else
  log_success "CocoaPods already installed"
fi

# Install project dependencies
log_step "Installing project dependencies..."
npm install
log_success "Project dependencies installed"

# iOS prebuild
log_step "Building iOS native code (this may take a few minutes)..."
npx expo prebuild --platform ios --clean
log_success "iOS build complete"

# Success
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Setup complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "  1. npm start          # Start the Metro bundler"
echo "  2. npm run ios        # Build and run on iOS simulator"
echo ""
echo "For more information, see SETUP.md and CLAUDE.md"
