import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { ModernFormsPlatform } from './platform';
import { RequestPayload, ResponsePayload } from './types';
import axios from 'axios';

const NUMBER_OF_FAN_SPEEDS = 6;

export class ModernFormsPlatformAccessory {

  private updateTimer!: NodeJS.Timeout;
  private fanService: Service;
  private lightService?: Service;
  private states: ResponsePayload = {
    fanOn: false,
    fanSpeed: 0,
    fanDirection: 'forward',
    lightOn: false,
    lightBrightness: 0,
    clientId: this.device().clientId,
  }

  constructor(
    private readonly platform: ModernFormsPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
      this.accessory.getService(this.platform.Service.AccessoryInformation)!
        .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Modern Forms')
        .setCharacteristic(this.platform.Characteristic.Model, 'Unknown')
        .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device().clientId);

      // FAN SERVICE

      this.fanService =
        this.accessory.getService(this.platform.Service.Fan) ??
        this.accessory.addService(this.platform.Service.Fan);

      this.fanService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.ip);
      this.fanService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getFanOn.bind(this))
        .onSet(this.setFanOn.bind(this));
      this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .onSet(this.setRotationSpeed.bind(this))
        .setProps({ minStep: this.getStepWithoutGoingOver(6) });
      this.fanService.getCharacteristic(this.platform.Characteristic.RotationDirection)
        .onSet(this.setRotationDirection.bind(this));

      // LIGHT SERVICE
      if (this.device().light) {
        this.lightService =
          this.accessory.getService(this.platform.Service.Lightbulb) ??
          this.accessory.addService(this.platform.Service.Lightbulb);

        this.lightService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.ip);
        this.lightService.getCharacteristic(this.platform.Characteristic.On).onSet( this.setLightOn.bind(this));
        this.lightService.getCharacteristic(this.platform.Characteristic.Brightness).onSet( this.setBrightness.bind(this));
      } else {
        const oldLightService = this.accessory.getService(this.platform.Service.Lightbulb);
        if (oldLightService ) {
          this.accessory.removeService(oldLightService);
        }
      }

      if (this.device().switch) {
        const mqttTopic = `stat/${this.device().switch}/RESULT`;
        this.log(`Subscribing to messages on topic ${mqttTopic}...`);
        this.platform.mqtt.subscribe(mqttTopic);
        this.platform.mqtt.on('message', (topic, message) => {
          this.log(`Got message from topic ${topic}`);
          if (topic === mqttTopic) {
            const data = JSON.parse(message.toString());
            this.log(`Message: ${JSON.stringify(data)}`);
            if (data.Button1?.Action === 'SINGLE') {
              this.log('Toggle fan on from MQTT');
              this.states.fanOn = !this.states.fanOn;
              this.sendUpdate();
            }
          }
        });
      }

      setImmediate(this.poll.bind(this));
      setInterval(this.poll.bind(this), (this.platform.config.pollingInterval || 15) * 1000);
  }

  device() {
    return this.accessory.context.device;
  }

  async request(payload: RequestPayload & { queryDynamicShadowData?: 1 }) {
    return axios
      .post<ResponsePayload>(`http://${this.device().ip}/mf`, payload)
      .then(res => res.data);
  }

  // HELPERS
  poll() {
    this.platform.log.info(`Requesting updates from ${this.device().clientId} at IP ${this.device().ip}...`);
    this.request({ queryDynamicShadowData: 1 })
      .then(this.updateStates.bind(this))
      .catch(error => {
        this.platform.log.info(`Failed to get status of ${this.device().clientId} at IP ${this.device().ip}: ${error.message}`);
      });
  }

  updateStates(data : ResponsePayload) {
    this.platform.log.info(`Updating states for ${this.device().clientId}: ${JSON.stringify(data)}`);
    this.states = data;
    this.fanService.getCharacteristic(this.platform.Characteristic.On).updateValue(data.fanOn);
    this.updateLed();
    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed).updateValue(data.fanSpeed * 100 / NUMBER_OF_FAN_SPEEDS);
    this.fanService.getCharacteristic(this.platform.Characteristic.RotationDirection).updateValue(data.fanDirection === 'forward' ? 0 : 1);

    if (this.lightService) {
      this.lightService.getCharacteristic(this.platform.Characteristic.On).updateValue(data.lightOn);
      this.lightService.getCharacteristic(this.platform.Characteristic.Brightness).updateValue(data.lightBrightness);
    }
  }

  updateLed() {
    if (this.device().switch) {
      const mqttTopic = `cmnd/${this.device().switch}/LedPower`;
      this.platform.mqtt.publish(mqttTopic, this.states.fanOn ? 'ON' : 'OFF');
    }
  }

  sendUpdate() {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }

    this.platform.log.info(`Staging update to ${this.device().clientId}...`);
    this.updateTimer = setTimeout(() => {
      this.platform.log.info(`Sending update to ${this.device().clientId}...`);
      this.request(this.states)
        .then(this.updateStates.bind(this))
        .catch((error) => this.platform.log.info(`Failed to update fan states: ${error.message}`));
    }, 500);
  }

  getStepWithoutGoingOver = (steps: number) => {
    return Math.floor(100 / steps * 1000) / 1000;
  }

  log = (...args: unknown[]) => {
    this.platform.log.info(`[${this.device().ip}]`, ...args);
  }

  // FAN GETTERS / SETTERS

  async getFanOn() {
    this.log('Get Fan Characteristic On');
    return this.states.fanOn;
  }

  async setFanOn(value: CharacteristicValue) {
    this.log('Set Fan Characteristic On ->', value);
    this.states.fanOn = Boolean(value);
    this.sendUpdate();
  }

  async setRotationDirection(value: CharacteristicValue) {
    this.log('Set Fan Characteristic On ->', value);
    this.states.fanDirection = value === 0 ? 'forward' : 'reverse';
    this.sendUpdate();
  }

  async setRotationSpeed(value: CharacteristicValue) {
    this.log('Set Fan Characteristic On ->', value);
    this.states.fanOn = value > 0;
    this.states.fanSpeed = Math.round(value as number / 100 * NUMBER_OF_FAN_SPEEDS);
    this.sendUpdate();
  }

  // LIGHT GETTERS / SETTERS

  async setLightOn(value: CharacteristicValue) {
    this.log('Set Light Characteristic On ->', value);
    this.states.lightOn = Boolean(value);
    this.sendUpdate();
  }

  async setBrightness(value: CharacteristicValue) {
    this.log('Set Characteristic Brightness -> ', value);
    this.states.lightOn = value > 0;
    this.states.lightBrightness = value as number;
    this.sendUpdate();
  }
}
