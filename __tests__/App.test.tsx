/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

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
