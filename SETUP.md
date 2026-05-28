# LogicalInvestor Development Setup

## Quick Start (Recommended)

Run the automated setup script:

```bash
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

## 8. Android Setup (Optional)

This section covers Android development setup. Skip if you only plan to test on iOS.

### What you need

- **Android Studio** (Google's Android IDE)
- **Java Development Kit (JDK)** version 17 or later
- **Android SDK** (installed automatically with Android Studio)

### 8a. Install Android Studio

1. Download [Android Studio](https://developer.android.com/studio) from Google
2. Run the installer
3. Follow the setup wizard (accept defaults)

**Verify:**
```bash
# Check if Android Studio is installed
ls /Applications/Android\ Studio.app
```

### 8b. Install Java (JDK 17)

Gradle (Android's build tool) requires Java to compile Android code.

```bash
brew install openjdk@17
```

### 8c. Configure Java (required)

Homebrew will output instructions. Follow these steps:

**Step 1: Create symlink** (so system Java wrappers can find JDK 17)
```bash
sudo ln -sfn /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-17.jdk
```

**Step 2: Add Java and Android SDK to PATH** — Add these lines to your `~/.zshrc` file (at the end, after fnm setup):
```bash
export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

**Step 3: Reload shell**
```bash
source ~/.zshrc
```

**Verify:**
```bash
java -version
# Should output: openjdk version "17.0.x" ...

echo $ANDROID_HOME
# Should output: /Users/jimmelton/Library/Android/sdk
```

### 8d. Android Emulator Setup

1. Open Android Studio
2. Click **Device Manager** (right sidebar)
3. Click **Create Device**
4. Select a phone (e.g., Pixel 6, Pixel 8)
5. Select an API level (33 or higher recommended)
6. Click **Finish**

**Verify:**
```bash
# List available emulators
ls ~/Library/Android/sdk/avd/
```

### 8e. Start the Emulator

In Android Studio:
1. Go to **Device Manager**
2. Click the **Play button** next to your device
3. Wait for emulator to fully boot (~30 seconds)

Or from command line:
```bash
# List available emulators
~/Library/Android/sdk/emulator/emulator -list-avds

# Start one (replace with your device name)
~/Library/Android/sdk/emulator/emulator -avd Pixel_8_API_33
```

---

## 9. First Build: Use `npm run ios` or `npm run android`

### What it is
This project uses native modules (`expo-secure-store`, `@nauverse/expo-cloud-settings`, `react-native-webview`) that must be compiled. `npm run ios` and `npm run android` are the Expo-blessed ways to handle this — they manage compilation, native module linking, and app installation in one command.

### Build and run on iOS

```bash
npm run ios
```

This:
1. Compiles the iOS project (including native modules)
2. Installs the app on the running simulator
3. Launches the app
4. First build takes 2-3 minutes; subsequent builds are faster

### Build and run on Android

First, start an Android emulator (see section 8d above), then:

```bash
npm run android
```

This:
1. Builds the Android project
2. Installs the app on the running emulator
3. Launches the app
4. First build takes 3-5 minutes; subsequent builds are faster

**Verify:**
- Simulator/emulator shows the LogicalInvestor app loading
- You see the login screen
- No native module errors in the output

**Important:** Use `npm run ios` or `npm run android` for the first build, not trying to manually open Xcode/Android Studio or start Metro first. This ensures native modules are properly compiled and linked.

---

## 11. Metro Bundler (JavaScript Bundler)

### What it is
Metro is the JavaScript bundler that converts your React Native code into a format the app can understand. After the initial build, you can use Metro for faster development iteration.

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

After the first build:

**Option 1:** Press `i` or `a` in the Metro terminal to rebuild and relaunch on iOS or Android

**Option 2:** In another terminal, run:
```bash
npm run ios
# or
npm run android
```

Both options rebuild JavaScript and relaunch the app (much faster than the initial build).

---

## 12. Troubleshooting

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

### Android: "Unable to locate a Java Runtime"

**Problem:** `npm run android` fails with "Unable to locate a Java Runtime"

**Cause:** Gradle can't find Java (JDK 17)

**Fix:**
```bash
# Install Java if not already installed
brew install openjdk@17

# Add to ~/.zshrc (at the end, after fnm setup)
export JAVA_HOME=$(/usr/libexec/java_home -v 17)

# Reload shell
source ~/.zshrc

# Verify
java -version

# Try again
npm run android
```

### Android: Emulator won't launch

**Problem:** Android emulator won't start or crashes

**Fix:**
```bash
# Kill any running emulator processes
killall qemu-system-aarch64

# Clear Android tooling cache
rm -rf ~/Library/Android/Sdk/emulator/qemu

# Try again from Android Studio Device Manager or CLI
```

---

## 13. Full End-to-End Test

### iOS Test

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

### Android Test

```bash
# Start emulator first (via Android Studio Device Manager or CLI)
# Then in a terminal:

# Terminal 1: Start Metro
cd LogicalInvestor
npm start

# Terminal 2: Build and run
cd LogicalInvestor
npm run android
# Wait for app to build and launch in emulator

# Emulator should show the login screen
# Try to log in
```

**Expected result:**
- App loads in simulator/emulator
- Login screen appears
- You can enter credentials and proceed

---

## 14. Next Steps

Once setup is verified:
1. Read `CLAUDE.md` for architecture and codebase overview
2. Check current features and pending work in CLAUDE.md
3. Start working on features or debugging as needed

---

## 15. Machine-Specific Notes

**Mac Mini:**
- Xcode: 26.5
- Shell: zsh

**iMac:**
- Xcode: 16.2

---

## 16. Reference: Key Commands

```bash
# Start development
npm start

# Run on iOS simulator
npm run ios

# Run on Android emulator
npm run android

# Run web
npm run web

# Lint code
npm run lint

# Clean rebuild (if things are weird)
rm -rf node_modules ios android .expo
npm install
npx expo prebuild --platform ios
npx expo prebuild --platform android
```

---

## 17. Getting Help

If setup fails:
1. Check the Troubleshooting section above
2. Run the Prerequisites Check from the top of this file
3. Verify each step in order — don't skip ahead
4. Note down the exact error message and which step failed
