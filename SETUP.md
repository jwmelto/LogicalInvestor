# LogicalInvestor Development Setup

## Quick Start (Recommended)

Run the automated setup script:

```bash
chmod +x setup.sh
./setup.sh
```

The script will:
1. Check for Xcode and Homebrew
2. Install fnm (Node version manager)
3. Configure your shell for Node 24 auto-switching
4. Install Node 24 LTS
5. Install CocoaPods
6. Install all project dependencies
7. Build iOS native code

If the script fails, see the Manual Setup section below.

---

## Toolchain Dependencies

The setup script installs and configures these tools:

| Tool | Purpose | Required | Installed By |
|------|---------|----------|--------------|
| **Xcode** | Apple's IDE and compiler toolchain for iOS | Yes | You (App Store) |
| **Homebrew** | macOS package manager | Yes | You (brew.sh) |
| **fnm** | Fast Node Manager — manage Node versions | Yes | `brew install fnm` |
| **Node 24 LTS** | JavaScript runtime (this project requires v24) | Yes | `fnm install 24` |
| **CocoaPods** | iOS dependency manager | Yes | `brew install cocoapods` |
| **Expo** | Cross-platform framework and CLI | Yes | `npm install` |
| **React Native** | Mobile framework | Yes | `npm install` |

All are installed automatically by setup.sh except Xcode and Homebrew, which require manual installation first.

---

## Manual Setup

If you prefer to set up manually or need to troubleshoot, follow the steps below.

## Prerequisites Check

Before starting, verify what you already have. Run each command separately and note the results.

**Check Xcode:**
```bash
xcode-select -p
```
Should output a path. If nothing appears or "not found", you need to install Xcode.

**Check Homebrew:**
```bash
command -v brew
```
Should output a path. If nothing appears, install from [brew.sh](https://brew.sh).

**Check fnm:**
```bash
command -v fnm
```
Should output a path if installed, nothing if not.

**Check Node:**
```bash
command -v node
```
Should output a path if any Node is installed, nothing if not.

**Check CocoaPods:**
```bash
command -v pod
```
Should output a path if installed, nothing if not.

**Check your shell:**
```bash
echo $SHELL
```
Should output `/bin/zsh` (or `/bin/bash` on older Macs). This matters for the fnm setup step.

## 1. Xcode & Command Line Tools

### What it is
Xcode is Apple's IDE for iOS development. The **command line tools** are the essential compilers and utilities needed to build iOS apps — these are separate from the Xcode app itself.

### Installation

**Option A: Install from App Store (Recommended)**
1. Open App Store
2. Search for "Xcode"
3. Click "Get" / "Install"
4. Wait for installation to complete (15-30 minutes)

**Option B: Install via Command Line** (if App Store is unavailable)
```bash
xcode-select --install
```

### Accept the Xcode license

After installation, accept the Xcode license (required):
```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
```

---

## 2. fnm (Fast Node Manager)

### What it is
fnm manages multiple Node versions on your machine. This project requires **Node 24 LTS**. fnm makes it easy to switch between projects with different Node requirements.

### Installation

```bash
brew install fnm
```

### Verify installation
```bash
fnm --version
# Should output a version number like 1.35.0
```

### Add to shell configuration

This is **critical** — fnm's initialization must be the **LAST line** in your `~/.zshrc` file, after any other PATH modifications (like Homebrew).

Edit your shell config file and add this line at the **END** (after all other PATH/Homebrew setup):
```bash
eval "$(fnm env --use-on-cd --shell zsh)"
```

**Check if it's already configured:**
```bash
grep "fnm env" ~/.zshrc
```

If nothing appears, you need to add it.

### Verify configuration

Close your terminal completely and open a new one. Then:
```bash
fnm --version
```

Should output a version number like `1.39.0`. If you get "command not found", the initialization line wasn't added or the terminal wasn't fully restarted.

**Common issue:** If another tool's initialization (like Homebrew or NVM) comes AFTER fnm in `.zshrc`, it can override fnm. Ensure fnm is the last thing in the file.

---

## 3. Node 24 LTS

### Installation

```bash
# Install Node 24 LTS
fnm install 24

# Verify installation
node --version
# Should output: v24.x.x (where x represents patch version)

# Verify npm is available
npm --version
```

### Auto-switching (automatic)

Once fnm is configured, create a `.node-version` file in the project directory (this already exists in LogicalInvestor):

```bash
cd LogicalInvestor
cat .node-version
# Should show: 24
```

When you `cd` into this directory, fnm will automatically switch to Node 24.

**Test it:**
```bash
cd LogicalInvestor
node --version
# Should show v24.x.x

cd ~
node --version
# Should show whatever Node version you have globally (or nothing if fnm 24 is default)

cd LogicalInvestor
node --version
# Should show v24.x.x again
```

---

## 4. CocoaPods

### What it is
CocoaPods is a dependency manager for iOS (Objective-C/Swift). Expo uses it to manage native dependencies for the iOS build.

### Installation

```bash
brew install cocoapods
```

---

## 5. Project Dependencies

```bash
cd LogicalInvestor
npm install
```

This installs all JavaScript dependencies listed in `package.json`, including:
- Expo and React Native
- Navigation libraries
- Storage libraries
- XML parser for RSS feeds
- etc.

**Verify:**
```bash
# Check that node_modules exists
ls -la | grep node_modules
# Should show a directory

# Spot-check a few key packages
ls node_modules/expo
ls node_modules/react-native
```

---

## 6. iOS Build Prerequisites

### Generate iOS native code

```bash
cd LogicalInvestor
npx expo prebuild --platform ios
```

This command:
1. Generates the `/ios` directory (ignored in git)
2. Installs CocoaPods dependencies via `pod install`
3. Creates `LogicalInvestor.xcworkspace`

**Verify:**
```bash
# Check that /ios directory exists
ls -la | grep ios
# Should show an "ios" directory

# Check that Xcode workspace exists
ls ios/LogicalInvestor.xcworkspace
```

**Troubleshooting:** If this fails with CocoaPods errors, try:
```bash
cd ios
pod repo update
pod install
cd ..
```

---

## 7. iOS Simulator Setup

### Verify Xcode includes simulator tools

```bash
# List available simulators
xcrun simctl list devices

# You should see output like:
# == Devices ==
# -- iOS 18.0 --
#     iPhone 15 Pro (XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX) (Shutdown)
```

If you see simulators listed, skip ahead to "Start a Simulator" below.

### If no simulators appear

Open Xcode and install a simulator:

```bash
open /Applications/Xcode.app

# In Xcode: Settings → Platforms → iOS
# Click the + button next to your iOS version
# Select a simulator to download (e.g., iPhone 15 Pro)
```

Or via command line:
```bash
xcode-select --install-additional-components
```

### Start a simulator

```bash
# List available simulators
xcrun simctl list devices available

# Start one (example: iPhone 15 Pro, iOS 18.0)
xcrun simctl boot "iPhone 15 Pro"

# Open Simulator app
open /Applications/Simulator.app
```

**Verify:**
```bash
# Simulator should be running and visible on your screen
# You should see a blank iPhone screen
```

---

## 8. First Build: Use `npm run ios`

### What it is
This project uses native modules (`expo-secure-store`, `@nauverse/expo-cloud-settings`, `react-native-webview`) that must be compiled by Xcode. `npm run ios` is the Expo-blessed way to handle this — it manages Xcode compilation, native module linking, simulator setup, and app installation in one command.

### Build and run

```bash
npm run ios
```

This:
1. Compiles the iOS project (including native modules)
2. Installs the app on the running simulator
3. Launches the app
4. First build takes 2-3 minutes; subsequent builds are faster

**Verify:**
- Simulator shows the LogicalInvestor app loading
- You see the login screen
- No native module errors in the output

**Important:** Use `npm run ios` for the first build, not trying to manually open Xcode or start Metro first. This ensures native modules are properly compiled and linked.

---

## 9. Metro Bundler (JavaScript Bundler)

### What it is
Metro is the JavaScript bundler that converts your React Native code into a format the app can understand. After the initial Xcode build, you can use Metro for faster development iteration.

### Start the bundler

Open a **new terminal** at the project root:

```bash
cd LogicalInvestor
npm start
```

You should see output like:
```
Starting Metro Bundler
...
Press 'i' to open iOS simulator, 'a' for Android, 'w' for web
```

**Keep this terminal open** while developing — it watches for file changes and rebuilds automatically.

### Using Metro for subsequent builds

After the first Xcode build:

**Option 1:** Press `i` in the Metro terminal to rebuild and relaunch on simulator

**Option 2:** In another terminal, run:
```bash
npm run ios
```

Both options rebuild JavaScript and relaunch the app (much faster than the initial Xcode build).

---

## 10. Troubleshooting

### "fnm: command not found"
- You added `eval "$(fnm env...)"` to the wrong file (check you edited `~/.zshrc`, not `~/.bashrc`)
- Or fnm initialization is not the LAST line in `.zshrc` (another tool is overwriting PATH)
- **Fix:** Edit `~/.zshrc`, move the fnm line to the very end, save, and restart terminal

### "node-version file not found"
- Make sure you're in the `LogicalInvestor` directory
- Verify `.node-version` exists: `cat .node-version` should show `24`

### "CocoaPods not found"
- Make sure you installed via `brew install cocoapods`, not `sudo gem install cocoapods`
- Check: `which pod` should show something like `/usr/local/bin/pod`

### iOS simulator won't start
```bash
# Kill all simulators
killall "Simulator"

# Reset simulator (optional, more drastic)
xcrun simctl erase all

# Restart from step 8
```

### "Xcode build failed" or "clang errors"
```bash
# Accept Xcode license
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept

# Reset command line tools
sudo xcode-select --reset
```

### Metro bundler crashes or behaves weirdly
```bash
# Stop Metro (Ctrl+C)
# Clear Metro cache
watchman watch-del-all

# Restart
npm start
```

### "Pod install failed"
```bash
cd ios
rm Podfile.lock
pod repo update
pod install
cd ..
npm run ios
```

### Native module errors after switching architectures (Intel ↔ Apple Silicon)

If you get errors like "Cannot find native module 'ExpoCloudSettings'" after switching machines or architectures:

The issue: `package-lock.json` is architecture-specific. It was generated on Intel with Intel binaries, but Apple Silicon (arm64) needs different binaries.

**Fix:**
```bash
rm -rf node_modules package-lock.json
npm install
npm run ios
```

This regenerates the lock file with the correct architecture-specific binaries. If you switched machines, commit the updated `package-lock.json`:
```bash
git add package-lock.json
git commit -m "Regenerate package-lock.json for [architecture]"
```

This is a known limitation of the npm ecosystem when working across Intel and Apple Silicon machines.

---

## 11. Full End-to-End Test

Once setup is complete, verify everything works:

```bash
# Terminal 1: Start Metro
cd LogicalInvestor
npm start
# Wait for "Watching for file changes..."

# Terminal 2: Build and run
cd LogicalInvestor
npm run ios
# Wait for app to build and launch in simulator

# Simulator should show the login screen
# Try to log in (you'll need valid logicalinvestor.net credentials)
```

**Expected result:**
- App loads in simulator
- Login screen appears
- You can enter credentials and proceed

---

## 12. Next Steps

Once setup is verified:
1. Read `CLAUDE.md` for architecture and codebase overview
2. Check current features and pending work in CLAUDE.md
3. Start working on features or debugging as needed

---

## Machine-Specific Notes

**Mac Mini:**
- Xcode: 26.5
- Shell: zsh

**iMac:**
- Xcode: 16.2

---

## Reference: Key Commands

```bash
# Start development
npm start

# Run on iOS
npm run ios

# Run on Android
npm run android

# Run web
npm run web

# Lint code
npm run lint

# Clean rebuild (if things are weird)
rm -rf node_modules ios .expo
npm install
npx expo prebuild --platform ios
```

---

## Getting Help

If setup fails:
1. Check the Troubleshooting section above
2. Run the Prerequisites Check from the top of this file
3. Verify each step in order — don't skip ahead
4. Note down the exact error message and which step failed
