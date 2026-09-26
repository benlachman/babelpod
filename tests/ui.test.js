/**
 * @jest-environment jsdom
 *
 * Web UI tests for per-output volume. Renders the real index.html body in the
 * jsdom environment with a stubbed socket.io client, then drives socket events
 * to verify the per-output slider renders (capability by presence), emits
 * setOutputVolume, reflects incoming outputVolume, and degrades gracefully.
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const bodyInner = html.match(/<body>([\s\S]*)<\/body>/)[1];
// The app script is the last inline <script> (after the socket.io <script src>)
const scripts = [...bodyInner.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const appScript = scripts[scripts.length - 1][1];

let handlers;
let emitted;

function loadUi() {
  handlers = {};
  emitted = [];
  document.body.innerHTML = bodyInner;
  window.localStorage.clear(); // volume-mode preference must not leak between tests
  if (!window.CSS) window.CSS = { escape: (s) => s };
  // Stub socket.io: record handlers and emitted events
  window.io = () => ({
    id: 'test-owner',
    on: (e, cb) => { (handlers[e] = handlers[e] || []).push(cb); },
    once: (e, cb) => { (handlers[e] = handlers[e] || []).push(cb); },
    emit: (e, d) => { emitted.push({ event: e, data: d }); },
  });
  // eslint-disable-next-line no-eval
  (0, eval)(appScript);
}

function fire(event, data) {
  (handlers[event] || []).forEach((cb) => cb(data));
}

const baseState = {
  version: 1,
  sessionOwner: 'test-owner',
  inputs: [{ id: 'void', name: 'None' }],
  selectedInput: 'void',
  selectedOutputs: [],
  volume: 50,
  config: {},
  autoconnectState: 'paused',
};

describe('Web UI — per-output volume', () => {
  test('renders a volume slider only for outputs that report a volume', () => {
    loadUi();
    fire('state', {
      ...baseState,
      outputs: [
        { id: 'air:Kitchen', name: 'Kitchen - AirPlay', volume: 40 },
        { id: 'plughw:0,0', name: 'Headphones - Output' }, // no volume → no slider
      ],
    });

    const sliders = document.querySelectorAll('#outputsList input.output-volume');
    expect(sliders.length).toBe(1);
    expect(sliders[0].dataset.outputId).toBe('air:Kitchen');
    expect(sliders[0].value).toBe('40');
  });

  test('dragging a per-output slider emits setOutputVolume with id and value', async () => {
    loadUi();
    fire('state', {
      ...baseState,
      outputs: [{ id: 'air:Kitchen', name: 'Kitchen - AirPlay', volume: 40 }],
    });

    const slider = document.querySelector('#outputsList input.output-volume');
    slider.value = '72';
    slider.dispatchEvent(new window.Event('input', { bubbles: true }));

    await new Promise((r) => setTimeout(r, 150)); // debounce ~100ms

    const setOutputVolumes = emitted.filter((e) => e.event === 'setOutputVolume');
    expect(setOutputVolumes).toHaveLength(1);
    expect(setOutputVolumes[0].data).toEqual({ id: 'air:Kitchen', value: 72 });
  });

  test('incoming outputVolume updates the matching slider', () => {
    loadUi();
    fire('state', {
      ...baseState,
      outputs: [{ id: 'air:Kitchen', name: 'Kitchen - AirPlay', volume: 40 }],
    });

    fire('outputVolume', { id: 'air:Kitchen', value: 88 });

    expect(document.querySelector('#outputsList input.output-volume').value).toBe('88');
  });

  test('no per-output sliders when the server omits volume (graceful degrade)', () => {
    loadUi();
    fire('state', {
      ...baseState,
      outputs: [{ id: 'air:Kitchen', name: 'Kitchen - AirPlay' }],
    });

    expect(document.querySelectorAll('#outputsList input.output-volume').length).toBe(0);
  });
});

describe('Web UI — turntable plug setup (settings)', () => {
  test('shows the setup form (not the configured status) when no plug is present', () => {
    loadUi();
    fire('state', { ...baseState, outputs: [] }); // no turntablePower in state
    expect(document.getElementById('plugSetup').style.display).toBe('block');
    expect(document.getElementById('plugConfigured').style.display).toBe('none');
  });

  test('shows configured status (not the form) when a plug is present', () => {
    loadUi();
    fire('state', { ...baseState, outputs: [], turntablePower: { on: true, reachable: true } });
    expect(document.getElementById('plugConfigured').style.display).toBe('block');
    expect(document.getElementById('plugSetup').style.display).toBe('none');
    expect(document.getElementById('plugConfiguredDetail').textContent).toContain('on');
  });

  test('Set Up emits setupTurntablePlug with the entered code', () => {
    loadUi();
    fire('state', { ...baseState, outputs: [] });
    document.getElementById('plugPairingCode').value = '1406-013-3112';
    window.setupPlug();
    const sent = emitted.filter((e) => e.event === 'setupTurntablePlug');
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toEqual({ pairingCode: '1406-013-3112' });
  });

  test('Set Up with an empty code does not emit', () => {
    loadUi();
    fire('state', { ...baseState, outputs: [] });
    document.getElementById('plugPairingCode').value = '   ';
    window.setupPlug();
    expect(emitted.filter((e) => e.event === 'setupTurntablePlug')).toHaveLength(0);
  });

  test('a turntablePower broadcast after setup flips the section to configured', () => {
    loadUi();
    fire('state', { ...baseState, outputs: [] });
    document.getElementById('plugPairingCode').value = '14060133112';
    window.setupPlug();
    fire('turntablePower', { on: false, reachable: true }); // commissioning succeeded
    expect(document.getElementById('plugConfigured').style.display).toBe('block');
    expect(document.getElementById('plugSetup').style.display).toBe('none');
  });
});

describe('Web UI — per-speaker default volumes (settings)', () => {
  test('settings shows a default-volume slider per capable output, seeded from config', () => {
    loadUi();
    fire('state', {
      ...baseState,
      config: { defaultVolume: 55, defaultOutputVolumes: { 'air:Kitchen': 30 } },
      outputs: [
        { id: 'air:Kitchen', name: 'Kitchen - AirPlay', volume: 50 },
        { id: 'air:Office', name: 'Office - AirPlay', volume: 50 }, // no explicit default → fallback
        { id: 'plughw:0,0', name: 'Headphones - Output' },          // no volume → no slider
      ],
    });

    const sliders = document.querySelectorAll('#settingsDefaultOutputs input.settings-default-volume');
    expect(sliders.length).toBe(2);
    const byId = {};
    sliders.forEach((s) => { byId[s.dataset.outputId] = s.value; });
    expect(byId['air:Kitchen']).toBe('30');  // from config.defaultOutputVolumes
    expect(byId['air:Office']).toBe('55');    // falls back to defaultVolume
  });
});

describe('Web UI — restart server (settings)', () => {
  const outputs = [{ id: 'air:Kitchen', name: 'Kitchen - AirPlay', volume: 40 }];

  test('hides the restart section when the server does not advertise canRebootHost', () => {
    loadUi();
    fire('state', { ...baseState, outputs });
    expect(document.getElementById('hostRebootSection').style.display).toBe('none');
  });

  test('shows the restart section, named after the server, when canRebootHost is present', () => {
    loadUi();
    fire('state', { ...baseState, outputs, config: { displayName: 'PattyPi' }, canRebootHost: true });
    expect(document.getElementById('hostRebootSection').style.display).toBe('');
    expect(document.getElementById('rebootHostButton').textContent).toBe('Restart PattyPi');
  });

  test('confirming emits rebootHost and disables the button', () => {
    loadUi();
    fire('state', { ...baseState, outputs, config: { displayName: 'PattyPi' }, canRebootHost: true });
    window.confirm = jest.fn(() => true);
    document.getElementById('rebootHostButton').click();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Restart PattyPi?'));
    expect(emitted.filter((e) => e.event === 'rebootHost')).toHaveLength(1);
    const button = document.getElementById('rebootHostButton');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Restarting…');
  });

  test('cancelling the confirmation does not emit', () => {
    loadUi();
    fire('state', { ...baseState, outputs, canRebootHost: true });
    window.confirm = jest.fn(() => false);
    document.getElementById('rebootHostButton').click();
    expect(emitted.filter((e) => e.event === 'rebootHost')).toHaveLength(0);
  });

  test('the state after reconnecting re-enables the button', () => {
    loadUi();
    fire('state', { ...baseState, outputs, config: { displayName: 'PattyPi' }, canRebootHost: true });
    window.confirm = jest.fn(() => true);
    document.getElementById('rebootHostButton').click();
    fire('state', { ...baseState, outputs, config: { displayName: 'PattyPi' }, canRebootHost: true });
    expect(document.getElementById('rebootHostButton').disabled).toBe(false);
  });
});

describe('Web UI — silence auto-off (settings)', () => {
  const outputs = [{ id: 'air:Kitchen', name: 'Kitchen - AirPlay', volume: 40 }];
  const plugged = { turntablePower: { on: true, reachable: true } };
  const autoOffConfig = {
    displayName: 'PattyPi',
    autoOffEnabled: true,
    autoOffSilenceMinutes: 20,
    autoOffSilenceThresholdDb: -43,
    autoOffNoiseFloorDb: -62,
  };

  test('is hidden until a plug is configured', () => {
    loadUi();
    fire('state', { ...baseState, outputs, config: autoOffConfig });
    expect(document.getElementById('autoOffSettings').style.display).toBe('none');
  });

  test('is shown and filled from config when a plug is configured', () => {
    loadUi();
    fire('state', { ...baseState, outputs, config: autoOffConfig, ...plugged });
    expect(document.getElementById('autoOffSettings').style.display).toBe('');
    expect(document.getElementById('settingsAutoOffEnabled').checked).toBe(true);
    expect(document.getElementById('settingsAutoOffMinutes').value).toBe('20');
    expect(document.getElementById('settingsAutoOffThresholdDb').value).toBe('-43');
    expect(document.getElementById('settingsAutoOffNoiseFloorDb').value).toBe('-62');
  });

  test('turning it off hides the timing fields', () => {
    loadUi();
    fire('state', { ...baseState, outputs, config: autoOffConfig, ...plugged });
    const checkbox = document.getElementById('settingsAutoOffEnabled');
    checkbox.checked = false;
    checkbox.dispatchEvent(new window.Event('change'));
    expect(document.getElementById('autoOffDetails').style.display).toBe('none');
    expect(document.getElementById('autoOffDisabledHint').style.display).toBe('');
  });

  test('Save Settings sends the auto-off fields, clamped to the AirSpin ranges', () => {
    loadUi();
    fire('state', { ...baseState, outputs, config: autoOffConfig, ...plugged });
    document.getElementById('settingsAutoOffMinutes').value = '500';
    document.getElementById('settingsAutoOffThresholdDb').value = '-40.4';
    document.getElementById('settingsAutoOffNoiseFloorDb').value = '';
    document.getElementById('saveSettingsButton').click();
    const setConfig = emitted.filter((e) => e.event === 'setConfig');
    expect(setConfig).toHaveLength(1);
    expect(setConfig[0].data).toMatchObject({
      autoOffEnabled: true,
      autoOffSilenceMinutes: 240,
      autoOffSilenceThresholdDb: -40,
      autoOffNoiseFloorDb: -62, // empty field keeps the current value
    });
  });

  test('Save Settings leaves auto-off out when no plug is configured', () => {
    loadUi();
    fire('state', { ...baseState, outputs, config: autoOffConfig });
    document.getElementById('saveSettingsButton').click();
    const setConfig = emitted.filter((e) => e.event === 'setConfig');
    expect(setConfig[0].data).not.toHaveProperty('autoOffEnabled');
  });
});

describe('Web UI — Shared vs Per Speaker volume', () => {
  const outputs = [
    { id: 'air:Kitchen', name: 'Kitchen - AirPlay', volume: 40 },
    { id: 'plughw:0,0', name: 'Headphones - Output' },
  ];

  test('the mode control appears only when outputs support per-output volume', () => {
    loadUi();
    fire('state', { ...baseState, outputs: [{ id: 'plughw:0,0', name: 'Headphones - Output' }] });
    expect(document.getElementById('volumeMode').style.display).toBe('none');
    fire('state', { ...baseState, outputs });
    expect(document.getElementById('volumeMode').style.display).toBe('flex');
  });

  test('Shared hides per-speaker sliders, Per Speaker brings them back with current volumes', () => {
    loadUi();
    fire('state', { ...baseState, outputs });
    document.querySelector('#volumeMode button[data-mode="shared"]').click();
    expect(document.querySelectorAll('#outputsList input.output-volume')).toHaveLength(0);
    fire('outputVolume', { id: 'air:Kitchen', value: 65 });
    document.querySelector('#volumeMode button[data-mode="perSpeaker"]').click();
    const sliders = document.querySelectorAll('#outputsList input.output-volume');
    expect(sliders).toHaveLength(1);
    expect(sliders[0].value).toBe('65');
  });

  test('the choice is remembered in this browser', () => {
    loadUi();
    fire('state', { ...baseState, outputs });
    document.querySelector('#volumeMode button[data-mode="shared"]').click();
    expect(window.localStorage.getItem('perSpeakerVolumeEnabled')).toBe('false');
  });
});

describe('Web UI — warnings', () => {
  const outputs = [{ id: 'air:Kitchen', name: 'Kitchen - AirPlay', volume: 40 }];
  const shown = (id) => document.getElementById(id).style.display !== 'none';

  test('warns about no input and no speakers when nothing is selected and autoconnect is paused', () => {
    loadUi();
    fire('state', { ...baseState, outputs });
    expect(shown('inputWarning')).toBe(true);
    expect(shown('outputWarning')).toBe(true);
  });

  test('no speaker warning while autoconnect is listening with default speakers', () => {
    loadUi();
    fire('state', {
      ...baseState,
      outputs,
      autoconnectState: 'idle',
      config: { defaultOutputIds: ['air:Kitchen'] },
    });
    expect(shown('outputWarning')).toBe(false);
  });

  test('warnings clear as the user selects an input and a speaker', () => {
    loadUi();
    fire('state', {
      ...baseState,
      inputs: [{ id: 'void', name: 'None' }, { id: 'plughw:0,0', name: 'USB Audio' }],
      outputs,
    });
    fire('input', { id: 'plughw:0,0' });
    fire('output', { ids: ['air:Kitchen'] });
    expect(shown('inputWarning')).toBe(false);
    expect(shown('outputWarning')).toBe(false);
  });

  test('warns when the turntable plug is off, and clears when it turns on', () => {
    loadUi();
    fire('state', { ...baseState, outputs, turntablePower: { on: false, reachable: true } });
    expect(shown('turntableWarning')).toBe(true);
    fire('turntablePower', { on: true, reachable: true });
    expect(shown('turntableWarning')).toBe(false);
  });

  test('warnings are suppressed while disconnected', () => {
    loadUi();
    fire('state', { ...baseState, outputs });
    fire('disconnect');
    expect(shown('inputWarning')).toBe(false);
    expect(shown('outputWarning')).toBe(false);
  });
});
