# Backlog

## iOS App: First-Interaction Gesture Delay

The first tap on interactive controls (Toggle switches, Menu items) after the app connects to the server has a ~2-4 second delay before the action fires. Subsequent taps respond instantly. The console logs `Gesture: System gesture gate timed out.` when the delayed action finally resolves.

**What we know:**
- Timing logs confirm the tap is received by SwiftUI immediately (a `simultaneousGesture(TapGesture())` fires at the correct time), but the control's own action (Toggle binding setter, Button action) is delayed ~4 seconds
- The delay is consistent on first interaction after connection, then disappears for subsequent interactions
- The issue affects standard Apple controls: `Toggle(.switch)`, `Button`, and `Menu` items
- The `System gesture gate timed out` message comes from `_UISystemGestureGateGestureRecognizer`, an internal UIKit recognizer
- The app uses a `ScrollView` inside a `NavigationStack`, which is a common layout
- `UIScrollView.appearance().delaysContentTouches = false` was tried without effect
- Removing `NavigationStack` entirely did not resolve it
- Removing the `PulseAnimationModifier` (`.repeatForever` animation) did not resolve it
- Replacing controls with raw `onTapGesture` bypasses the delay but is not a real fix

**Reproduce:** Launch app → connect to server → immediately tap any Toggle or Menu item → observe ~4s delay and console warning

## Software Pre-amp / Input Gain Control

The Burr-Brown/TI USB Audio CODEC has no ALSA capture volume control — gain is fixed at the hardware level. Line-level input (e.g., laptop headphone out) measures ~-55dB RMS and needs ~42dB of boost to be usable. Currently the workaround is using the phono preamp stage on the external switch, which adds analog gain but also applies RIAA EQ coloring.

**Goal:** Add a configurable software gain stage so line-level sources work without external amplification.

**Approach:**
- Insert a `sox` process (or ALSA softvol plugin) in the `arecord` → `duplicator` pipeline to apply gain
- Add an input gain slider to the UI (web + SwiftUI)
- Consider adding a signal level meter to the UI so users can visually confirm input levels

## Remaining items from the AirSpin server spec (v1.1)

`airspin/docs/babelpod-server-spec.md` (branch `claude/turntable-homekit-volume-LXDRd`) specifies four features. Turntable power (§0/§3: Matter plug + silence auto-off + `turntablePower` events) is implemented. Still open:

- **Per-output volume (§1):** `setOutputVolume {id, value}` / `outputVolume` broadcasts, per-output `volume` field on every output in `state`/`outputs` (capability by presence — must be on *every* output once implemented), `setVolume` becomes "set all", persistence across restarts. `node_airtunes2` already supports per-device volume. AirSpin client side is already implemented.
- **HTTP command endpoint (§4):** `POST /api/setVolume|setOutputVolume|setTurntablePower` + `GET /api/state` with a shared-secret token, for AirSpin App Intents / Siri Shortcuts. Privileged (bypasses session owner), routes through the same control core, LAN only.
- **HomeKit volume accessory (§5):** HAP-NodeJS Lightbulb whose `Brightness` maps to volume (the only Siri-controllable numeric), two-way sync, per-output Lightbulbs once §1 lands.

## iOS App: Push Notification to Turn Off Record Player

When autoconnect transitions from silence to idle (speakers released after 5 minutes of silence), send a push notification from the iOS app reminding the user to turn off the record player. The record is still spinning in the runout groove — the user may have walked away.

*Partially superseded:* the server can now power the turntable off itself after sustained silence via the Matter smart plug (`autoOffEnabled`). A notification remains useful for setups without a smart plug, or as a heads-up that auto-off happened.

Should be gated by a toggle in settings (off by default). Requires the server to emit the silence→idle transition event.

- **iOS:** Register for push notifications, display alert when backgrounded
- **Web:** Use the Web Notifications API (`Notification.requestPermission()` + `new Notification(...)`) — works even when the tab is in the background, no server-side push infrastructure needed

## iOS App: Unused ServicePickerView

`BabelUI/ServicePickerView.swift` defines a service picker component that is not integrated into the app. Either integrate it into the connection flow or remove it to reduce dead code.

## iOS App: Error History

Server errors and status messages are shown as transient toasts. There is no persistent error log in the app — once dismissed, messages are gone. Consider adding an error history view for debugging.
