/*
  Smart plug control for the turntable outlet.

  MatterPlugController commissions a Matter smart plug onto BabelPod's own
  fabric (multi-admin — the plug stays paired with Apple Home) and exposes a
  small interface so the mechanism stays swappable:

    await controller.start()         — connect (commission first if needed)
    await controller.setPower(bool)  — send OnOff On/Off command
    controller.isOn                  — last reported hardware state
    controller.isReachable           — node online + subscription healthy
    controller.on('change', {on, reachable} => ...) — fired on every hardware
      state or reachability change, including changes made from Apple Home or
      the plug's physical button (OnOff attribute subscription)
    await controller.stop()

  matter.js is loaded lazily inside start() so servers without a configured
  plug never pay its memory cost (important on the Pi Zero's 512MB).

  Commissioning is a one-time operator step: in Apple Home open the plug,
  "Turn On Pairing Mode" to get a fresh setup code, and put that code in
  babelpod.config.json as turntablePlugPairingCode. Fabric credentials persist
  in the storage directory, so the code is only needed once.
*/

const { EventEmitter } = require('events');

const ONOFF_CLUSTER_ID = 6; // Matter OnOff cluster (0x0006)

class MatterPlugController extends EventEmitter {
  constructor({ pairingCode = null, storagePath, log = console } = {}) {
    super();
    // Apple Home shows pairing codes with dashes (XXXX-XXX-XXXX); the Matter
    // codec wants digits only
    this.pairingCode = pairingCode ? String(pairingCode).replace(/\D/g, '') : null;
    this.storagePath = storagePath;
    this.log = log;
    this.isOn = false;
    this.isReachable = false;
    this.controller = null;
    this.node = null;
    this.onOffClient = null;
    this.OnOffCluster = null;
  }

  updateState({ on, reachable }) {
    let changed = false;
    if (typeof on === 'boolean' && on !== this.isOn) {
      this.isOn = on;
      changed = true;
    }
    if (typeof reachable === 'boolean' && reachable !== this.isReachable) {
      this.isReachable = reachable;
      changed = true;
    }
    if (changed) this.emit('change', { on: this.isOn, reachable: this.isReachable });
  }

  async start() {
    const { Environment } = await import('@matter/main');
    const { GeneralCommissioning, OnOff } = await import('@matter/main/clusters');
    const { ManualPairingCodeCodec } = await import('@matter/main/types');
    const { CommissioningController } = await import('@project-chip/matter.js');
    const { NodeStates } = await import('@project-chip/matter.js/device');
    this.OnOffCluster = OnOff.Complete;

    const environment = Environment.default;
    if (this.storagePath) environment.vars.set('storage.path', this.storagePath);

    this.controller = new CommissioningController({
      environment: { environment, id: 'babelpod-turntable-plug' },
      autoConnect: false,
      adminFabricLabel: 'BabelPod'
    });
    await this.controller.start();

    if (!this.controller.isCommissioned()) {
      if (!this.pairingCode) {
        throw new Error(
          'Plug is not commissioned. In Apple Home, enable pairing mode on the plug ' +
          'and set turntablePlugPairingCode in babelpod.config.json.'
        );
      }
      this.log.info('Commissioning Matter plug...');
      const { shortDiscriminator, passcode } = ManualPairingCodeCodec.decode(this.pairingCode);
      const nodeId = await this.controller.commissionNode({
        commissioning: {
          regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
          regulatoryCountryCode: 'XX'
        },
        discovery: {
          identifierData: { shortDiscriminator },
          discoveryCapabilities: { ble: false }
        },
        passcode
      });
      this.log.info(`Matter plug commissioned with nodeId ${nodeId}`);
    }

    const [nodeId] = this.controller.getCommissionedNodes();
    if (nodeId === undefined) throw new Error('No commissioned Matter node found');
    const node = await this.controller.getNode(nodeId);
    this.node = node;

    // Hardware sync: every OnOff attribute report — including changes made
    // from Apple Home or the physical button — flows through here.
    node.events.attributeChanged.on(({ path: { clusterId, attributeName }, value }) => {
      if (clusterId === ONOFF_CLUSTER_ID && attributeName === 'onOff') {
        this.updateState({ on: !!value });
      }
    });
    node.events.stateChanged.on(state => {
      this.updateState({ reachable: state === NodeStates.Connected });
    });

    if (!node.isConnected) node.connect();
    if (!node.initialized) await node.events.initialized;

    // `initialized` can fire from the local cache before the remote device
    // structure has been read (fresh commissioning, cold cache), leaving the
    // device list empty — wait for the structure if the client isn't there yet.
    this.onOffClient = this.findOnOffClient() || await this.waitForOnOffClient();

    const initialOn = await this.onOffClient.getOnOffAttribute();
    this.updateState({ on: !!initialOn, reachable: node.isConnected });
  }

  waitForOnOffClient(timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const client = this.findOnOffClient();
        if (!client) return;
        cleanup();
        resolve(client);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Commissioned Matter node has no OnOff cluster (timed out waiting for device structure)'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.node.events.structureChanged.off(check);
      };
      this.node.events.structureChanged.on(check);
      check();
    });
  }

  findOnOffClient() {
    for (const device of this.node.getDevices()) {
      try {
        const client = device.getClusterClient(this.OnOffCluster);
        if (client !== undefined) return client;
      } catch (e) {
        // device without OnOff support — keep looking
      }
    }
    return null;
  }

  async setPower(on) {
    if (!this.onOffClient) throw new Error('Plug is not connected');
    if (on) {
      await this.onOffClient.on();
    } else {
      await this.onOffClient.off();
    }
    // Do not update state here — the OnOff attribute subscription reports the
    // real post-command hardware state, which self-corrects failed commands.
  }

  async stop() {
    if (this.controller) await this.controller.close();
    this.controller = null;
    this.node = null;
    this.onOffClient = null;
  }
}

module.exports = { MatterPlugController };
