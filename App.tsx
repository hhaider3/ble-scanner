/**
 * Nearby Bluetooth Low Energy scanner.
 *
 * @format
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  PermissionsAndroid,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BleManager, Device, ScanMode, State } from 'react-native-ble-plx';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

type NearbyDevice = {
  id: string;
  isConnectable: boolean | null;
  lastSeen: number;
  name: string;
  rssi: number | null;
  serviceCount: number;
};

const STATE_LABELS: Partial<Record<State, string>> = {
  [State.PoweredOn]: 'Bluetooth ready',
  [State.PoweredOff]: 'Bluetooth is off',
  [State.Unauthorized]: 'Permission needed',
  [State.Unsupported]: 'BLE is unsupported',
  [State.Resetting]: 'Bluetooth is resetting',
  [State.Unknown]: 'Checking Bluetooth',
};

async function requestBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  if (Number(Platform.Version) < 31) {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title: 'Nearby device permission',
        message:
          'Location permission is required by Android to discover nearby Bluetooth devices.',
        buttonPositive: 'Continue',
      },
    );

    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  const results = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  ]);

  return (
    results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] ===
      PermissionsAndroid.RESULTS.GRANTED &&
    results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] ===
      PermissionsAndroid.RESULTS.GRANTED
  );
}

function normalizeDevice(device: Device): NearbyDevice {
  return {
    id: device.id,
    isConnectable: device.isConnectable,
    lastSeen: Date.now(),
    name: device.localName || device.name || 'Unnamed device',
    rssi: device.rssi,
    serviceCount: device.serviceUUIDs?.length ?? 0,
  };
}

function signalDescription(rssi: number | null): string {
  if (rssi === null) {
    return 'Signal unknown';
  }
  if (rssi >= -60) {
    return 'Strong signal';
  }
  if (rssi >= -80) {
    return 'Medium signal';
  }
  return 'Weak signal';
}

function bluetoothHelp(state: State): string {
  switch (state) {
    case State.PoweredOff:
      return 'Turn on Bluetooth, then try scanning again.';
    case State.Unauthorized:
      return 'Allow Bluetooth access in your phone settings.';
    case State.Unsupported:
      return 'This phone does not support Bluetooth Low Energy.';
    case State.Resetting:
    case State.Unknown:
      return 'Wait for Bluetooth to become ready, then try again.';
    default:
      return 'Tap the button to discover nearby BLE devices.';
  }
}

function DeviceCard({ device }: { device: NearbyDevice }) {
  return (
    <View style={styles.deviceCard}>
      <View style={styles.deviceTopRow}>
        <View style={styles.deviceTitleContainer}>
          <Text numberOfLines={1} style={styles.deviceName}>
            {device.name}
          </Text>
          <Text numberOfLines={1} style={styles.deviceId}>
            {device.id}
          </Text>
        </View>
        <View style={styles.rssiPill}>
          <Text style={styles.rssiText}>
            {device.rssi === null ? '—' : `${device.rssi} dBm`}
          </Text>
        </View>
      </View>

      <View style={styles.deviceMetaRow}>
        <Text style={styles.deviceMeta}>{signalDescription(device.rssi)}</Text>
        <Text style={styles.metaDivider}>•</Text>
        <Text style={styles.deviceMeta}>
          {device.isConnectable === false ? 'Advertising' : 'Connectable'}
        </Text>
        {device.serviceCount > 0 ? (
          <>
            <Text style={styles.metaDivider}>•</Text>
            <Text style={styles.deviceMeta}>
              {device.serviceCount}{' '}
              {device.serviceCount === 1 ? 'service' : 'services'}
            </Text>
          </>
        ) : null}
      </View>
    </View>
  );
}

function ScannerScreen() {
  const manager = useMemo(() => new BleManager(), []);
  const scanSession = useRef(0);
  const [adapterState, setAdapterState] = useState<State>(State.Unknown);
  const [devices, setDevices] = useState<Record<string, NearbyDevice>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  const sortedDevices = useMemo(
    () =>
      Object.values(devices).sort(
        (left, right) => (right.rssi ?? -200) - (left.rssi ?? -200),
      ),
    [devices],
  );

  const stopScan = useCallback(async () => {
    scanSession.current += 1;
    setIsScanning(false);

    try {
      await manager.stopDeviceScan();
    } catch {
      // The native scan may already be stopped when Bluetooth changes state.
    }
  }, [manager]);

  const startScan = useCallback(async () => {
    const currentSession = scanSession.current + 1;
    scanSession.current = currentSession;
    setErrorMessage(null);
    setIsStarting(true);

    try {
      const hasPermission = await requestBluetoothPermissions();
      if (currentSession !== scanSession.current) {
        return;
      }

      if (!hasPermission) {
        setErrorMessage(
          'Bluetooth permission was denied. Allow it in Settings to scan.',
        );
        return;
      }

      const currentState = await manager.state();
      if (currentSession !== scanSession.current) {
        return;
      }

      setAdapterState(currentState);
      if (currentState !== State.PoweredOn) {
        setErrorMessage(bluetoothHelp(currentState));
        return;
      }

      setDevices({});
      setIsScanning(true);

      await manager.startDeviceScan(
        null,
        {
          allowDuplicates: true,
          scanMode: ScanMode.LowLatency,
        },
        (scanError, device) => {
          if (currentSession !== scanSession.current) {
            return;
          }

          if (scanError) {
            scanSession.current += 1;
            setIsScanning(false);
            setErrorMessage(scanError.message || 'The BLE scan failed.');
            return;
          }

          if (device) {
            const normalized = normalizeDevice(device);
            setDevices(currentDevices => ({
              ...currentDevices,
              [normalized.id]: normalized,
            }));
          }
        },
      );
    } catch (error) {
      if (currentSession === scanSession.current) {
        setIsScanning(false);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Could not start the BLE scan.',
        );
      }
    } finally {
      if (currentSession === scanSession.current) {
        setIsStarting(false);
      }
    }
  }, [manager]);

  useEffect(() => {
    let isMounted = true;
    const subscription = manager.onStateChange(nextState => {
      if (!isMounted) {
        return;
      }

      setAdapterState(nextState);
      if (nextState !== State.PoweredOn) {
        scanSession.current += 1;
        setIsScanning(false);
      }
    }, true);

    return () => {
      isMounted = false;
      scanSession.current += 1;
      subscription.remove();
      manager
        .stopDeviceScan()
        .finally(() => manager.destroy())
        .catch(() => {
          // The manager can already be torn down during development reloads.
        });
    };
  }, [manager]);

  const statusLabel = isScanning
    ? 'Scanning nearby'
    : STATE_LABELS[adapterState] ?? 'Bluetooth unavailable';
  const statusColor =
    adapterState === State.PoweredOn ? styles.statusReady : styles.statusMuted;

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#071b27" />

      <View style={styles.header}>
        <Text style={styles.eyebrow}>BLUETOOTH LOW ENERGY</Text>
        <Text style={styles.title}>Nearby devices</Text>
        <Text style={styles.subtitle}>
          Find BLE accessories advertising around this phone.
        </Text>
      </View>

      <View style={styles.controlCard}>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, statusColor]} />
          <Text style={styles.statusText}>{statusLabel}</Text>
          {isScanning ? (
            <ActivityIndicator color="#47d7ac" size="small" />
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            isScanning ? 'Stop scanning' : 'Scan for nearby devices'
          }
          disabled={isStarting}
          onPress={isScanning ? stopScan : startScan}
          style={({ pressed }) => [
            styles.scanButton,
            isScanning && styles.stopButton,
            pressed && styles.buttonPressed,
            isStarting && styles.buttonDisabled,
          ]}
        >
          {isStarting ? (
            <ActivityIndicator color="#071b27" />
          ) : (
            <Text
              style={[
                styles.scanButtonText,
                isScanning && styles.stopButtonText,
              ]}
            >
              {isScanning ? 'Stop scan' : 'Scan for devices'}
            </Text>
          )}
        </Pressable>

        {errorMessage ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {errorMessage}
          </Text>
        ) : null}
      </View>

      <View style={styles.listHeader}>
        <Text style={styles.listTitle}>Discovered</Text>
        <Text style={styles.deviceCount}>
          {sortedDevices.length}{' '}
          {sortedDevices.length === 1 ? 'device' : 'devices'}
        </Text>
      </View>

      <FlatList
        contentContainerStyle={[
          styles.listContent,
          sortedDevices.length === 0 && styles.emptyListContent,
        ]}
        data={sortedDevices}
        keyExtractor={device => device.id}
        renderItem={({ item }) => <DeviceCard device={item} />}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <View style={styles.bluetoothMark}>
              <Text style={styles.bluetoothMarkText}>B</Text>
            </View>
            <Text style={styles.emptyTitle}>
              {isScanning ? 'Listening for advertisements…' : 'Ready to scan'}
            </Text>
            <Text style={styles.emptyText}>
              {isScanning
                ? 'Keep nearby accessories powered on and in pairing mode.'
                : bluetoothHelp(adapterState)}
            </Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
      />

      <Text style={styles.footerNote}>
        Results include BLE advertisers only, not Bluetooth Classic devices.
      </Text>
    </SafeAreaView>
  );
}

function App() {
  return (
    <SafeAreaProvider>
      <ScannerScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#071b27',
    flex: 1,
  },
  header: {
    paddingHorizontal: 22,
    paddingBottom: 20,
    paddingTop: 18,
  },
  eyebrow: {
    color: '#47d7ac',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.8,
    marginBottom: 8,
  },
  title: {
    color: '#f5fbff',
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  subtitle: {
    color: '#9fb2bd',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8,
    maxWidth: 330,
  },
  controlCard: {
    backgroundColor: '#102c39',
    borderColor: '#1c4250',
    borderRadius: 18,
    borderWidth: 1,
    marginHorizontal: 18,
    padding: 16,
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: 14,
    minHeight: 20,
  },
  statusDot: {
    borderRadius: 5,
    height: 10,
    marginRight: 9,
    width: 10,
  },
  statusReady: {
    backgroundColor: '#47d7ac',
  },
  statusMuted: {
    backgroundColor: '#f2b862',
  },
  statusText: {
    color: '#dceaf0',
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
  },
  scanButton: {
    alignItems: 'center',
    backgroundColor: '#47d7ac',
    borderRadius: 12,
    height: 48,
    justifyContent: 'center',
  },
  stopButton: {
    backgroundColor: 'transparent',
    borderColor: '#47d7ac',
    borderWidth: 1,
  },
  buttonPressed: {
    opacity: 0.76,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  scanButtonText: {
    color: '#071b27',
    fontSize: 15,
    fontWeight: '800',
  },
  stopButtonText: {
    color: '#66e4bd',
  },
  errorText: {
    color: '#ffb5ad',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 12,
  },
  listHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 10,
    paddingHorizontal: 22,
    paddingTop: 22,
  },
  listTitle: {
    color: '#f5fbff',
    fontSize: 19,
    fontWeight: '800',
  },
  deviceCount: {
    color: '#829aa6',
    fontSize: 13,
    fontWeight: '600',
  },
  listContent: {
    paddingBottom: 16,
    paddingHorizontal: 18,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  deviceCard: {
    backgroundColor: '#0d2632',
    borderColor: '#173b49',
    borderRadius: 15,
    borderWidth: 1,
    marginBottom: 10,
    padding: 15,
  },
  deviceTopRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  deviceTitleContainer: {
    flex: 1,
    marginRight: 12,
  },
  deviceName: {
    color: '#eff8fb',
    fontSize: 16,
    fontWeight: '700',
  },
  deviceId: {
    color: '#718d9a',
    fontSize: 11,
    marginTop: 5,
  },
  rssiPill: {
    backgroundColor: '#173b49',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  rssiText: {
    color: '#83e8c7',
    fontSize: 11,
    fontWeight: '800',
  },
  deviceMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 13,
  },
  deviceMeta: {
    color: '#a8bac3',
    fontSize: 12,
  },
  metaDivider: {
    color: '#3c5c68',
    marginHorizontal: 7,
  },
  emptyState: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingBottom: 24,
    paddingHorizontal: 32,
  },
  bluetoothMark: {
    alignItems: 'center',
    backgroundColor: '#102f3c',
    borderColor: '#1b4a59',
    borderRadius: 30,
    borderWidth: 1,
    height: 60,
    justifyContent: 'center',
    marginBottom: 16,
    width: 60,
  },
  bluetoothMarkText: {
    color: '#47d7ac',
    fontSize: 22,
    fontWeight: '900',
  },
  emptyTitle: {
    color: '#dceaf0',
    fontSize: 17,
    fontWeight: '800',
  },
  emptyText: {
    color: '#78919c',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 7,
    textAlign: 'center',
  },
  footerNote: {
    color: '#607985',
    fontSize: 11,
    lineHeight: 16,
    paddingBottom: 5,
    paddingHorizontal: 22,
    textAlign: 'center',
  },
});

export default App;
