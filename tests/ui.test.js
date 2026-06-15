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
