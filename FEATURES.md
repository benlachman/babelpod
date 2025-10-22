# 🎵 BabelPod Features & Divergence from Upstream

This document lists all features and major changes in **benlachman/babelpod** that diverge from the original [afaden/babelpod](https://github.com/afaden/babelpod) repository since forking/merging.

---

## 🎯 Overview

This fork includes significant enhancements focused on **reliability**, **error handling**, **Bluetooth support**, and **user experience improvements**. Many improvements were cherry-picked and adapted from [DerDaku/babelpod](https://github.com/DerDaku/babelpod/tree/master).

---

## ✨ Major Features Added

### 1. 🎧 Bluetooth Input Support (Cherry-picked from DerDaku)

**What it does:**
- Stream audio from paired Bluetooth devices (phones, tablets, laptops, speakers)
- Automatically connects to Bluetooth devices when selected as input
- Shows connection status for each Bluetooth device
- Uses bluealsa for ALSA-compatible Bluetooth audio streaming

**Why it matters:**
- Enables wireless audio streaming from any Bluetooth source
- No need for physical line-in connections
- Perfect for streaming music from phones or tablets

**Changes made:**
- Added `bluetoothctl` dependency from DerDaku's fork
- Implemented Bluetooth device discovery and listing
- Added auto-connection logic when Bluetooth input is selected
- Device appears as "Bluetooth: [device name]" in input dropdown

**Requirements:**
- `bluez` package installed
- Devices must be paired using `bluetoothctl` first

---

### 2. 🔄 Automatic Input Recovery

**What it does:**
- Automatically restarts audio capture when input device disconnects
- Attempts up to 3 reconnection attempts with 2-second delays
- Provides clear user feedback during reconnection
- Prevents silent failures that required manual restart

**Why it matters:**
- **Solves a critical reliability issue**: Service would stop broadcasting audio after a few hours when USB audio devices disconnected
- No more manual Raspberry Pi restarts needed
- Perfect for permanent/always-on installations

**Changes made:**
```javascript
// Detects unexpected exits and attempts automatic recovery
- Distinguishes between manual input switches and crashes
- Retry logic with configurable attempts and delays
- User notifications: "Input device disconnected - attempting to reconnect..."
- Success/failure messages in UI
```

**Technical details:**
- Monitors arecord process exit codes
- Resets retry counter on successful manual input selection
- Prevents restart loops during intentional input changes

---

### 3. 🌐 Enhanced mDNS Service Discovery (Cherry-picked from DerDaku)

**What it does:**
- Upgraded from `mdns-js` to `dnssd2` library for better service discovery
- Handles dynamic IP address changes for AirPlay devices
- Improved event handling: `serviceUp`, `serviceChanged`, `serviceDown`
- Better detection of stereo paired HomePods even after network changes

**Why it matters:**
- More reliable AirPlay device discovery
- Handles network topology changes gracefully
- Better support for complex setups like stereo paired HomePods

**Changes made:**
- Replaced mdns-js dependency with dnssd2 v1.0.0
- Implemented new event handlers for service lifecycle
- Added IP address change tracking
- Improved service update logic

---

### 4. ⚙️ Optional PCM Device Scanning (Cherry-picked from DerDaku)

**What it does:**
- PCM scanning enabled by default for backward compatibility
- Can be disabled via `DISABLE_PCM=1` environment variable
- Improves performance on systems that only use Bluetooth or don't have ALSA hardware

**Why it matters:**
- Better performance on systems without PCM devices
- More flexible deployment options
- Reduced CPU usage when PCM scanning is unnecessary

**Changes made:**
- Added environment variable check: `process.env.DISABLE_PCM`
- Default behavior: Scans `/proc/asound/pcm` every 10 seconds
- With `DISABLE_PCM=1`: Skips PCM scanning entirely
- Added `BABEL_PORT` environment variable for custom port configuration

**Usage:**
```bash
# Disable PCM scanning for better performance
DISABLE_PCM=1 node index.js

# Custom port
BABEL_PORT=8080 node index.js
```

---

### 5. 🛡️ Comprehensive Error Handling & Reliability

**What it does:**
- Prevents crashes from device failures
- UI displays error and status messages
- Graceful handling of process, stream, and network errors
- Clean shutdown on SIGINT/SIGTERM

**Why it matters:**
- **Service won't crash** when devices fail
- Users see what's happening without checking server logs
- Better debugging and troubleshooting experience

**Changes made:**
```javascript
// Process errors (arecord, aplay)
- spawn error handlers
- stderr monitoring
- exit code checking
- automatic cleanup

// Stream errors
- pipe error handlers
- duplicator error handlers
- input stream error handlers

// Network errors
- AirTunes connection failure handling
- mDNS browser error handling
- Socket.io connection issue handling

// Global handlers
- uncaughtException handler
- unhandledRejection handler
- SIGINT/SIGTERM graceful shutdown
```

**User experience:**
- Green status messages (auto-dismiss after 5s)
- Red error messages (auto-dismiss after 10s)
- Connection status indicators
- Server errors forwarded to UI in real-time

---

### 6. 🎚️ UI Improvements & Bug Fixes

**What it does:**
- Fixed volume slider background not updating
- Fixed unreliable output selection checkboxes
- Smooth slider operation with proper visual feedback
- Debounced controls to prevent server flooding

**Why it matters:**
- Better user experience with responsive controls
- No more "hit or miss" checkbox selection
- Reduced server load from rapid UI changes

**Changes made:**

#### Volume Slider Fixes:
- Added `updateSliderProgress()` call when server sends volume updates
- 100ms debouncing to prevent flooding server with updates
- Immediate UI update, batched server updates

#### Output Selection Fixes:
- 150ms debouncing on checkbox changes
- Prevents race conditions from rapid state changes
- Checkboxes reliably reflect server state

#### Code cleanup:
- Removed duplicate CSS rule for webkit-slider-runnable-track
- Removed redundant hover style that broke progress bar
- Cleaner, more maintainable CSS

---

### 7. 🔊 Improved AirPlay Streaming Stability (Cherry-picked from DerDaku)

**What it does:**
- Added `{end: false}` option to airtunes pipe
- Prevents premature stream closing during input changes
- More reliable multi-device streaming

**Why it matters:**
- Streams stay open during input device switches
- Better stability when streaming to multiple AirPlay devices simultaneously
- Fewer audio interruptions

**Changes made:**
```javascript
// Before:
pipedest.pipe(airTunesDevice);

// After:
pipedest.pipe(airTunesDevice, {end: false});
```

---

### 8. 📦 Updated Dependencies (Cherry-picked from DerDaku)

**What changed:**
- **airtunes2**: Pinned to v2.4.9 (ciderapp/node_airtunes2#v2.4.9)
  - Better stability
  - Node 20 compatibility
  - Improved multi-device support

- **dnssd2**: v1.0.0 (new dependency)
  - Better mDNS handling
  - Replaces mdns-js for improved service discovery

- **bluetoothctl**: Added from DerDaku's fork
  - Enables Bluetooth input support
  - ALSA-compatible Bluetooth audio streaming

- **socket.io**: Updated to v4.8.1
  - Better WebSocket handling
  - Improved real-time communication

**Why it matters:**
- Better Node.js version compatibility (tested with Node 18 and 20)
- More stable dependencies with active maintenance
- Reduced dependency on unmaintained packages

---

### 9. 🎮 Systemd Service Support

**What it does:**
- Included `babelpod.service` file for systemd
- Run BabelPod automatically on boot
- Proper environment setup for system service

**Why it matters:**
- Perfect for permanent Raspberry Pi installations
- Starts automatically after reboot
- Proper logging via journalctl

**Usage:**
```bash
# Install service
sudo cp babelpod.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable babelpod
sudo systemctl start babelpod

# View logs
sudo journalctl -u babelpod -f
```

**Configuration options in service file:**
- User and Group configuration
- Working directory setup
- Environment variables (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS)
- Automatic restart on failure

---

### 10. 🧪 Testing Infrastructure

**What it does:**
- Added Jest testing framework
- Created test directory structure
- Comprehensive manual testing documentation (TESTING.md)
- Test scripts in package.json

**Why it matters:**
- Better code quality and reliability
- Easier to validate changes
- Prevents regressions

**Added files:**
- `tests/unit.test.js` - Unit test structure
- `TESTING.md` - Comprehensive manual testing guide
- Jest configuration in package.json

**Tests cover:**
- PCM environment variable behavior
- Bluetooth device ID formatting
- mDNS service event handling
- AirPlay device regex patterns
- Stereo pairing detection
- Pipe stability options

**Run tests:**
```bash
npm test
npm run test:watch  # Watch mode
```

---

### 11. 📚 Enhanced Documentation

**What it does:**
- Updated README.md with all new features
- Added TESTING.md for manual testing procedures
- Created CHANGES.md with detailed changelog
- Improved installation and setup instructions

**New documentation includes:**
- Bluetooth pairing instructions
- Environment variable documentation
- Systemd service setup guide
- Raspberry Pi Zero/Zero 2 W specific instructions
- Debugging and troubleshooting section
- Error handling overview

**Why it matters:**
- Easier onboarding for new users
- Better troubleshooting resources
- Clear feature documentation

---

## 🎯 Important Design Choices

### 1. **PCM Scanning Default Behavior**
- **Decision**: Enable by default, allow disabling via environment variable
- **Reason**: Backward compatibility - existing users expect PCM devices to work without configuration
- **Trade-off**: Slightly higher CPU usage on systems that don't need it, but can be disabled

### 2. **Debouncing Timeouts**
- **Decision**: 100ms for volume slider, 150ms for output checkboxes
- **Reason**: Balance between responsiveness and server load
- **Testing**: Values chosen after testing with multiple rapid UI interactions

### 3. **Automatic Retry Logic**
- **Decision**: 3 attempts with 2-second delays
- **Reason**: Enough attempts to handle temporary disconnects, not too many to cause long delays
- **User control**: Users can manually reselect input immediately if needed

### 4. **Error Message Auto-Dismiss**
- **Decision**: 5s for status (green), 10s for errors (red)
- **Reason**: Status messages are informational, errors need more time to read
- **User experience**: Keeps UI clean while ensuring important messages are seen

### 5. **Dependency Pinning**
- **Decision**: Pin airtunes2 to specific version, use semver for others
- **Reason**: airtunes2 stability is critical; other deps can auto-update minor versions
- **Maintenance**: Easier security updates while maintaining audio stability

---

## 📋 Requirement Updates

### New System Requirements:
1. **Optional: Bluetooth support**
   - `bluez` package for Bluetooth pairing
   - `bluetoothctl` for device management

2. **Node.js compatibility**
   - Tested with Node 18 and 20 LTS
   - Build environment for native modules (build-essential)

3. **Environment variables**
   - `DISABLE_PCM=1` - Disable PCM device scanning
   - `BABEL_PORT=3000` - Custom HTTP server port

### Installation Changes:
- Added Raspberry Pi Zero/Zero 2 W specific npm install instructions
- Memory-efficient installation options for low-memory devices
- Swap space recommendations

---

## 🔄 Changes Cherry-Picked from DerDaku/babelpod

These improvements were adapted from [DerDaku/babelpod PR #31](https://github.com/afaden/babelpod/pull/31):

1. ✅ **Enhanced mDNS library (dnssd2)** - Fully integrated
2. ✅ **Bluetooth input support** - Fully integrated with documentation
3. ✅ **Optional PCM device scanning** - Implemented with default-enabled behavior
4. ✅ **Improved AirPlay streaming stability** - `{end: false}` pipe option added
5. ✅ **Updated dependencies** - airtunes2 v2.4.9, dnssd2 v1.0.0

### What Was NOT Merged:
- ❌ **Stereo HomePod support** - Already implemented in this codebase
- ❌ **UI dropdown height increase** - Not applicable (current code uses checkboxes)

---

## 🚀 Breaking Changes

**None** - All changes are backward compatible:
- PCM works by default (can be disabled if not needed)
- Existing AirPlay devices continue to work
- No changes to required configuration
- Bluetooth is optional (gracefully handles missing bluetoothctl)

---

## 🔮 Future Work & TODOs

Based on code comments and documentation:

1. **Bluetooth input auto-discovery** - Currently requires manual pairing
2. **More comprehensive unit tests** - Expand test coverage
3. **Integration tests with mock devices** - Better automated testing
4. **Performance monitoring** - Add metrics and monitoring
5. **Web UI improvements** - Additional user-requested features

---

## 📊 Summary

This fork represents a **production-ready, reliable version** of BabelPod with:
- 🛡️ **Robust error handling** - Won't crash on device failures
- 🎧 **Bluetooth support** - Wireless audio input
- 🔄 **Auto-recovery** - Handles USB device disconnects
- 🌐 **Better discovery** - Enhanced mDNS with dnssd2
- 🎚️ **Polished UI** - Fixed bugs, better UX
- 🧪 **Test coverage** - Infrastructure for quality assurance
- 📚 **Comprehensive docs** - Better user guidance
- ⚙️ **Flexible config** - Environment variables for customization
- 🎮 **Service support** - Run as systemd service

All changes maintain **backward compatibility** while significantly improving **reliability** and **user experience**.

---

**Last Updated**: October 2025  
**Maintained by**: benlachman  
**Original Source**: [afaden/babelpod](https://github.com/afaden/babelpod)  
**Credits**: Features cherry-picked from [DerDaku/babelpod](https://github.com/DerDaku/babelpod)
