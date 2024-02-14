import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import network from 'network';
import { bindNodeCallback, of, partition, from, concat, EMPTY } from 'rxjs';
import { tap, mergeMap, filter, mapTo, share, map, distinct } from 'rxjs/operators';
import ping from 'ping';
import calculateNetwork from 'network-calculator';
import getIpRange from 'get-ip-range';
import arp from 'node-arp';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { ModernFormsPlatformAccessory } from './platformAccessory';
import {ResponsePayload} from './types';
import axios from 'axios';
import mqtt, {MqttClient} from 'mqtt';

interface FanConfig {

  ip: string
  light?: boolean
  switch?: string

}

interface Config extends PlatformConfig {
  autoDiscover?: boolean
  fans?: Array<FanConfig>
}

export class ModernFormsPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  public readonly mqtt!: MqttClient;

  constructor(
    public readonly log: Logger,
    public readonly config: Config,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    if (this.config.mqttUrl) {
      this.mqtt = mqtt.connect(this.config.mqttUrl);
    }

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  async ping(ip: string) {
    return axios
      .post<ResponsePayload>(`http://${ip}/mf`, {queryDynamicShadowData: 1})
      .then(res => res.data);
  }


  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    this.log.info('Looking for Modern Forms devices on network');

    const getActiveInterface = bindNodeCallback(network.get_active_interface);
    const getMAC = bindNodeCallback(arp.getMAC.bind(arp));

    const cachedFansAddresses$ = from(this.accessories ?? []).pipe(
      map(accessory => accessory.context.device),
      tap(fan => this.log.debug('Found potential IP address from cached devices:', fan.ip)),
    );

    const configFansAddresses$ = from(this.config.fans ?? []).pipe(
      tap(fan => this.log.debug('Found potential IP address from config:', fan.ip)),
    );

    const networkFansAddresses$ = of(this.config.autoDiscover).pipe(
      mergeMap(autoDiscover => autoDiscover === false ? EMPTY : getActiveInterface()),
      tap(() => this.log.debug('Searching network for Modern Forms fans')),
      map(int => calculateNetwork(int.ip_address ?? '192.168.0.1', int.netmask ?? '255.255.255.0')),
      map(network => network.network + '/' + network.bitmask),
      mergeMap(subnet => getIpRange(subnet)),
      mergeMap(ip => ping.promise.probe(ip).then(() => ip)),
      mergeMap(ip => getMAC(ip).pipe(
        map(mac => mac?.toUpperCase() ?? ''),
        filter(mac => mac.startsWith('C8:93:46')),
        mapTo({ ip: ip, light: true }),
      )),
      tap(fan => this.log.debug('Found potential IP address from network and filtering by MAC vendor:', fan.ip)),
    );

    const devices$ = concat(cachedFansAddresses$, configFansAddresses$, networkFansAddresses$).pipe(
      distinct(),
      mergeMap(fan => of(fan).pipe(
        mergeMap(fan => this.ping(fan.ip).then(res => res.clientId).catch(() => null)),
        filter((clientId): clientId is string => clientId !== null),
        tap(clientId => this.log.info(`Found device at ${fan.ip} with client ID of ${clientId}`)),
        map(clientId => {
          const uuid = this.api.hap.uuid.generate(clientId);
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
          return { fan, clientId, uuid, existingAccessory };
        }),
      )),
      share(),
    );

    const [newDevices$, existingDevices$] = partition(
      devices$,
      device => !device.existingAccessory,
    );

    newDevices$.subscribe(({ uuid, fan, clientId }) => {
      this.log.info('Adding new accessory:', clientId);
      const accessory = new this.api.platformAccessory(clientId, uuid);
      accessory.context.device = { uuid, ip: fan.ip, light: fan.light, switch: fan.switch, clientId };
      new ModernFormsPlatformAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    });

    existingDevices$.subscribe(({ uuid, fan, clientId, existingAccessory }) => {
      this.log.info('Restoring existing accessory from cache:', clientId);
      existingAccessory!.context.device = { uuid, ip: fan.ip, light: fan.light, switch: fan.switch, clientId };
      new ModernFormsPlatformAccessory(this, existingAccessory!);
    });
  }
}
