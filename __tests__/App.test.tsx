/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App, {
  NearbyDevice,
  rssiToPercent,
  smoothRssi,
  upsertDiscoveredDevice,
} from '../App';

jest.mock('react-native-ble-plx', () => {
  const State = {
    PoweredOff: 'PoweredOff',
    PoweredOn: 'PoweredOn',
    Resetting: 'Resetting',
    Unauthorized: 'Unauthorized',
    Unknown: 'Unknown',
    Unsupported: 'Unsupported',
  };

  return {
    BleManager: jest.fn().mockImplementation(() => ({
      destroy: jest.fn().mockResolvedValue(undefined),
      onStateChange: jest.fn(
        (listener: (state: string) => void, emitCurrentState: boolean) => {
          if (emitCurrentState) {
            listener(State.PoweredOn);
          }
          return { remove: jest.fn() };
        },
      ),
      startDeviceScan: jest.fn().mockResolvedValue(undefined),
      state: jest.fn().mockResolvedValue(State.PoweredOn),
      stopDeviceScan: jest.fn().mockResolvedValue(undefined),
    })),
    ScanMode: { LowLatency: 2 },
    State,
  };
});

test('renders the nearby device scanner', async () => {
  let screen: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(() => {
    screen = ReactTestRenderer.create(<App />);
  });

  expect(screen!.toJSON()).not.toBeNull();

  await ReactTestRenderer.act(() => {
    screen!.unmount();
  });
});

test('updates a discovered device without changing list order', () => {
  const firstDevice: NearbyDevice = {
    canTrack: true,
    id: 'first',
    isBonded: false,
    isConnected: false,
    isConnectable: true,
    lastSeen: 1,
    name: 'First device',
    rssi: -80,
    serviceCount: 0,
  };
  const secondDevice: NearbyDevice = {
    canTrack: true,
    id: 'second',
    isBonded: false,
    isConnected: false,
    isConnectable: true,
    lastSeen: 2,
    name: 'Second device',
    rssi: -50,
    serviceCount: 0,
  };

  const discovered = upsertDiscoveredDevice(
    upsertDiscoveredDevice([], firstDevice),
    secondDevice,
  );
  const updated = upsertDiscoveredDevice(discovered, {
    ...firstDevice,
    lastSeen: 3,
    rssi: -40,
  });

  expect(updated.map(device => device.id)).toEqual(['first', 'second']);
  expect(updated[0].rssi).toBe(-40);
});

test('merges a BLE sighting into a connected system audio device', () => {
  const connectedHeadphones: NearbyDevice = {
    canTrack: false,
    id: 'AA:BB:CC:DD:EE:FF',
    isBonded: true,
    isConnected: true,
    isConnectable: null,
    lastSeen: 1,
    name: 'Headphones',
    rssi: null,
    serviceCount: 0,
  };

  const updated = upsertDiscoveredDevice([connectedHeadphones], {
    canTrack: true,
    id: connectedHeadphones.id,
    isBonded: false,
    isConnected: false,
    isConnectable: true,
    lastSeen: 2,
    name: 'Unnamed device',
    rssi: -61,
    serviceCount: 2,
  });

  expect(updated).toHaveLength(1);
  expect(updated[0]).toMatchObject({
    canTrack: true,
    isBonded: true,
    isConnected: true,
    name: 'Headphones',
    rssi: -61,
  });
});

test('smooths RSSI readings and maps them onto the strength meter', () => {
  expect(smoothRssi(null, -70)).toBe(-70);
  expect(smoothRssi(-70, -50)).toBe(-64);
  expect(rssiToPercent(-100)).toBe(0);
  expect(rssiToPercent(-70)).toBe(50);
  expect(rssiToPercent(-40)).toBe(100);
});
