# BabelPod Testing Guide

## Manual Testing Checklist

### UI Tests

#### Volume Slider
- [ ] Volume slider initializes at 50%
- [ ] Dragging the slider updates the volume smoothly
- [ ] Slider background color updates correctly (red gradient shows progress)
- [ ] Volume changes from the server update both the slider position and background color
- [ ] Rapid slider movements don't flood the server (debounced to 100ms)

#### Input Selection
- [ ] Input devices populate in the dropdown
- [ ] Selecting an input device switches the audio source
- [ ] Current input is displayed correctly in the status area
- [ ] Error messages appear if input device fails

#### Output Selection
- [ ] Output devices appear as checkboxes
- [ ] Local devices are labeled "(Output)"
- [ ] AirPlay devices are labeled "(AirPlay)"
- [ ] Checking/unchecking outputs updates the active outputs list
- [ ] Multiple outputs can be selected simultaneously
- [ ] Rapid checkbox clicking doesn't cause issues (debounced to 150ms)

#### Session Management
- [ ] Only one user can control at a time
- [ ] Overlay appears when another user has control
- [ ] "Take Over Control" button works correctly
- [ ] Session owner can make changes

#### Error and Status Display
- [ ] Connection status shows when connected
- [ ] Disconnection errors are displayed
- [ ] Server errors are shown in red
- [ ] Status messages are shown in green
- [ ] Messages auto-dismiss after appropriate timeout

### Server Tests

#### Error Handling
- [ ] Server doesn't crash when arecord fails
- [ ] Server doesn't crash when aplay fails
- [ ] Server doesn't crash when AirPlay device disconnects
- [ ] Server doesn't crash on mDNS errors
- [ ] Server logs all errors to console

#### Process Management
- [ ] arecord process starts correctly
- [ ] aplay processes start correctly
- [ ] Processes are cleaned up when switching inputs/outputs
- [ ] Graceful shutdown on Ctrl+C (SIGINT)
- [ ] Graceful shutdown on SIGTERM

#### Audio Streaming
- [ ] Audio streams from input to output without glitches
- [ ] Multiple outputs work simultaneously
- [ ] Volume changes affect all outputs
- [ ] Stream continues even if one output fails

#### Device Discovery
- [ ] PCM devices are detected from /proc/asound/pcm
- [ ] AirPlay devices are discovered via mDNS
- [ ] Duplicate AirPlay devices are unified
- [ ] Device list updates when devices appear/disappear

## Automated Testing

Currently, automated tests are not implemented due to the hardware-dependent nature of the application (requires ALSA devices and AirPlay receivers).

Future automated tests could include:
1. Unit tests for device parsing functions
2. Unit tests for unified output building
3. Mock-based tests for socket.io event handlers
4. Integration tests with mock audio devices

## Performance Testing

### Volume Slider
- Verify debouncing works: Move slider rapidly and check server logs
- Should only see volume updates every 100ms, not on every pixel movement

### Output Selection
- Rapidly toggle multiple checkboxes
- Should only see output updates every 150ms
- No race conditions should occur

### Memory Leaks
- Run server for extended period
- Check memory usage doesn't continuously grow
- Verify all processes are cleaned up when stopping

## Error Scenarios to Test

1. **Device Removed During Use**
   - Start audio playback to a USB device
   - Unplug the device
   - Verify error message appears, server doesn't crash

2. **Network Issues**
   - Start streaming to AirPlay device
   - Disconnect network
   - Verify error message appears, server doesn't crash

3. **Invalid Input Device**
   - Select an input device that doesn't exist
   - Verify error message appears

4. **Permission Issues**
   - Run without proper audio permissions
   - Verify appropriate error messages

5. **Multiple Rapid Changes**
   - Rapidly switch inputs
   - Rapidly toggle outputs
   - Rapidly change volume
   - Verify no crashes, clean state transitions

## Browser Compatibility

Test in:
- [ ] Chrome/Chromium
- [ ] Firefox
- [ ] Safari
- [ ] Mobile Safari (iOS)
- [ ] Chrome Mobile (Android)

## Expected Behavior

### Normal Operation
1. Server starts, binds to port 3000
2. mDNS advertises BabelPod service
3. mDNS discovers AirPlay devices
4. PCM devices are scanned every 10 seconds
5. Web UI connects via Socket.IO
6. First user gets control
7. User selects input and outputs
8. Audio streams in real-time
9. Volume changes propagate to all outputs

### Error Recovery
1. If a process fails, error is logged and emitted to UI
2. Other processes continue operating
3. User can try selecting the device again
4. Server remains running and responsive
