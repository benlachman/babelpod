# Backlog

## Software Pre-amp / Input Gain Control

The Burr-Brown/TI USB Audio CODEC has no ALSA capture volume control — gain is fixed at the hardware level. Line-level input (e.g., laptop headphone out) measures ~-55dB RMS and needs ~42dB of boost to be usable. Currently the workaround is using the phono preamp stage on the external switch, which adds analog gain but also applies RIAA EQ coloring.

**Goal:** Add a configurable software gain stage so line-level sources work without external amplification.

**Approach:**
- Insert a `sox` process (or ALSA softvol plugin) in the `arecord` → `duplicator` pipeline to apply gain
- Add an input gain slider to the UI (web + SwiftUI)
- Consider adding a signal level meter to the UI so users can visually confirm input levels
