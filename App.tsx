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
  BackHandler,
  DeviceEventEmitter,
  FlatList,
  NativeModules,
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

export type NearbyDevice = {
  canTrack: boolean;
  id: string;
  isBonded: boolean;
  isConnected: boolean;
  isConnectable: boolean | null;
  lastSeen: number;
  name: string;
  rssi: number | null;
  serviceCount: number;
};

type SystemAudioDevice = {
  id: string;
  isBonded: boolean;
  isConnected: boolean;
  name: string;
  profiles: string[];
};

type BluetoothSystemModule = {
  getKnownAudioDevices: () => Promise<SystemAudioDevice[]>;
  setFinderBackHandlerEnabled?: (enabled: boolean) => void;
};

type ScreenMode = 'devices' | 'finder';

const DISCOVERY_DURATION_MS = 8_000;
const SIGNAL_STALE_AFTER_MS = 5_000;
const METER_SEGMENTS = 12;
const RSSI_MIN = -100;
const RSSI_MAX = -40;
const RSSI_SMOOTHING_FACTOR = 0.3;

const bluetoothSystem = NativeModules.BluetoothSystem as
  | BluetoothSystemModule
  | undefined;

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
    canTrack: true,
    id: device.id,
    isBonded: false,
    isConnected: false,
    isConnectable: device.isConnectable,
    lastSeen: Date.now(),
    name: device.localName || device.name || 'Unnamed device',
    rssi: device.rssi,
    serviceCount: device.serviceUUIDs?.length ?? 0,
  };
}

function normalizeSystemAudioDevice(
  device: SystemAudioDevice,
): NearbyDevice {
  return {
    canTrack: false,
    id: device.id,
    isBonded: device.isBonded,
    isConnected: device.isConnected,
    isConnectable: null,
    lastSeen: Date.now(),
    name: device.name || 'Audio device',
    rssi: null,
    serviceCount: 0,
  };
}

async function getKnownAudioDevices(): Promise<NearbyDevice[]> {
  if (Platform.OS !== 'android' || !bluetoothSystem) {
    return [];
  }

  try {
    const devices = await bluetoothSystem.getKnownAudioDevices();
    return devices.map(normalizeSystemAudioDevice);
  } catch {
    // BLE discovery should still work if a phone cannot expose audio profiles.
    return [];
  }
}

export function upsertDiscoveredDevice(
  devices: NearbyDevice[],
  incomingDevice: NearbyDevice,
): NearbyDevice[] {
  const existingIndex = devices.findIndex(
    device => device.id === incomingDevice.id,
  );

  if (existingIndex === -1) {
    return [...devices, incomingDevice];
  }

  const existingDevice = devices[existingIndex];
  const updatedDevices = [...devices];
  updatedDevices[existingIndex] = {
    ...existingDevice,
    ...incomingDevice,
    canTrack: existingDevice.canTrack || incomingDevice.canTrack,
    isBonded: existingDevice.isBonded || incomingDevice.isBonded,
    isConnected: existingDevice.isConnected || incomingDevice.isConnected,
    name:
      incomingDevice.name === 'Unnamed device'
        ? existingDevice.name
        : incomingDevice.name,
  };
  return updatedDevices;
}

export function smoothRssi(
  previousRssi: number | null,
  incomingRssi: number,
): number {
  if (previousRssi === null) {
    return incomingRssi;
  }

  return Math.round(
    previousRssi * (1 - RSSI_SMOOTHING_FACTOR) +
      incomingRssi * RSSI_SMOOTHING_FACTOR,
  );
}

export function rssiToPercent(rssi: number | null): number {
  if (rssi === null) {
    return 0;
  }

  const clampedRssi = Math.min(RSSI_MAX, Math.max(RSSI_MIN, rssi));
  return Math.round(((clampedRssi - RSSI_MIN) / (RSSI_MAX - RSSI_MIN)) * 100);
}

function signalDescription(rssi: number | null): string {
  if (rssi === null) {
    return 'No signal';
  }
  if (rssi >= -55) {
    return 'Very strong';
  }
  if (rssi >= -67) {
    return 'Strong';
  }
  if (rssi >= -80) {
    return 'Moderate';
  }
  return 'Weak';
}

function signalColor(rssi: number | null): string {
  if (rssi === null) {
    return '#41606c';
  }
  if (rssi >= -67) {
    return '#47d7ac';
  }
  if (rssi >= -80) {
    return '#f2b862';
  }
  return '#ef7e72';
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

function DeviceCard({
  device,
  disabled,
  onPress,
}: {
  device: NearbyDevice;
  disabled: boolean;
  onPress: () => void;
}) {
  const canTrackNow = device.canTrack && !disabled;

  return (
    <Pressable
      accessibilityLabel={
        device.canTrack
          ? `Track ${device.name}`
          : `${device.name}, live BLE tracking unavailable`
      }
      accessibilityRole="button"
      disabled={!canTrackNow}
      onPress={onPress}
      style={({ pressed }) => [
        styles.deviceCard,
        pressed && styles.deviceCardPressed,
        disabled && styles.deviceCardDisabled,
        !device.canTrack && styles.systemDeviceCard,
      ]}
    >
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
        {device.isConnected || device.isBonded ? (
          <>
            <Text
              style={[
                styles.deviceStatus,
                device.isConnected
                  ? styles.deviceStatusConnected
                  : styles.deviceStatusPaired,
              ]}
            >
              {device.isConnected ? 'Connected' : 'Paired'}
            </Text>
            <Text style={styles.metaDivider}>•</Text>
          </>
        ) : null}
        <Text style={styles.deviceMeta}>
          {device.canTrack ? signalDescription(device.rssi) : 'System audio'}
        </Text>
        {device.canTrack ? (
          <>
            <Text style={styles.metaDivider}>•</Text>
            <Text style={styles.deviceMeta}>
              {device.isConnectable === false ? 'Advertising' : 'Connectable'}
            </Text>
          </>
        ) : null}
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

      <View style={styles.trackRow}>
        <Text style={styles.trackHint}>
          {disabled
            ? 'Available when scan finishes'
            : device.canTrack
            ? 'Track BLE signal'
            : 'Live BLE signal unavailable'}
        </Text>
        {canTrackNow ? <Text style={styles.trackArrow}>→</Text> : null}
      </View>
    </Pressable>
  );
}

function SignalMeter({ rssi }: { rssi: number | null }) {
  const activeSegments = Math.round(
    (rssiToPercent(rssi) / 100) * METER_SEGMENTS,
  );
  const activeColor = signalColor(rssi);

  return (
    <View
      accessibilityLabel={`Signal strength ${rssiToPercent(rssi)} percent`}
      accessibilityRole="progressbar"
      style={styles.meter}
    >
      {Array.from({ length: METER_SEGMENTS }, (_, index) => (
        <View
          key={index}
          style={[
            styles.meterSegment,
            index < activeSegments && { backgroundColor: activeColor },
          ]}
        />
      ))}
    </View>
  );
}

function ScannerScreen() {
  const manager = useMemo(() => new BleManager(), []);
  const scanSession = useRef(0);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialScanStarted = useRef(false);
  const [adapterState, setAdapterState] = useState<State>(State.Unknown);
  const [devices, setDevices] = useState<NearbyDevice[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasScanned, setHasScanned] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [lastSignalAt, setLastSignalAt] = useState<number | null>(null);
  const [liveRssi, setLiveRssi] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [screenMode, setScreenMode] = useState<ScreenMode>('devices');
  const [selectedDevice, setSelectedDevice] = useState<NearbyDevice | null>(
    null,
  );

  const clearScanTimer = useCallback(() => {
    if (scanTimer.current !== null) {
      clearTimeout(scanTimer.current);
      scanTimer.current = null;
    }
  }, []);

  const stopNativeScan = useCallback(async () => {
    scanSession.current += 1;
    clearScanTimer();
    setIsDiscovering(false);
    setIsTracking(false);

    try {
      await manager.stopDeviceScan();
    } catch {
      // The native scan can already be stopped after an adapter state change.
    }
  }, [clearScanTimer, manager]);

  const startDiscoveryScan = useCallback(async () => {
    const currentSession = scanSession.current + 1;
    scanSession.current = currentSession;
    clearScanTimer();
    setErrorMessage(null);
    setIsDiscovering(false);
    setIsTracking(false);
    setIsStarting(true);
    setScreenMode('devices');
    setSelectedDevice(null);

    try {
      await manager.stopDeviceScan().catch(() => undefined);

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

      const knownAudioDevices = await getKnownAudioDevices();
      if (currentSession !== scanSession.current) {
        return;
      }

      setDevices(knownAudioDevices);
      setHasScanned(true);
      setIsDiscovering(true);

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
            clearScanTimer();
            setIsDiscovering(false);
            setErrorMessage(scanError.message || 'The BLE scan failed.');
            return;
          }

          if (device) {
            const normalizedDevice = normalizeDevice(device);
            setDevices(currentDevices =>
              upsertDiscoveredDevice(currentDevices, normalizedDevice),
            );
          }
        },
      );

      if (currentSession === scanSession.current) {
        scanTimer.current = setTimeout(() => {
          if (currentSession !== scanSession.current) {
            return;
          }

          scanSession.current += 1;
          scanTimer.current = null;
          setIsDiscovering(false);
          manager.stopDeviceScan().catch(() => undefined);
        }, DISCOVERY_DURATION_MS);
      }
    } catch (error) {
      if (currentSession === scanSession.current) {
        setIsDiscovering(false);
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
  }, [clearScanTimer, manager]);

  const startTrackingDevice = useCallback(
    async (target: NearbyDevice) => {
      if (!target.canTrack) {
        return;
      }

      const currentSession = scanSession.current + 1;
      scanSession.current = currentSession;
      clearScanTimer();
      setErrorMessage(null);
      setIsDiscovering(false);
      setIsTracking(false);
      setIsStarting(true);
      setLastSignalAt(null);
      setLiveRssi(null);
      setNow(Date.now());
      setSelectedDevice(target);
      setScreenMode('finder');

      try {
        await manager.stopDeviceScan().catch(() => undefined);

        const hasPermission = await requestBluetoothPermissions();
        if (currentSession !== scanSession.current) {
          return;
        }

        if (!hasPermission) {
          setErrorMessage(
            'Bluetooth permission was denied. Allow it in Settings to track this device.',
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

        setIsTracking(true);

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
              setIsTracking(false);
              setErrorMessage(
                scanError.message || 'The device tracking scan failed.',
              );
              return;
            }

            if (device?.id !== target.id || device.rssi === null) {
              return;
            }

            const observedAt = Date.now();
            setNow(observedAt);
            setLastSignalAt(observedAt);
            setLiveRssi(currentRssi => smoothRssi(currentRssi, device.rssi!));
          },
        );
      } catch (error) {
        if (currentSession === scanSession.current) {
          setIsTracking(false);
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'Could not start tracking this device.',
          );
        }
      } finally {
        if (currentSession === scanSession.current) {
          setIsStarting(false);
        }
      }
    },
    [clearScanTimer, manager],
  );

  const returnToDevices = useCallback(async () => {
    await stopNativeScan();
    setErrorMessage(null);
    setLastSignalAt(null);
    setLiveRssi(null);
    setSelectedDevice(null);
    setScreenMode('devices');
  }, [stopNativeScan]);

  useEffect(() => {
    if (screenMode !== 'finder') {
      return undefined;
    }

    const handleBack = () => {
      returnToDevices().catch(() => undefined);
    };

    if (
      Platform.OS === 'android' &&
      bluetoothSystem?.setFinderBackHandlerEnabled
    ) {
      const subscription = DeviceEventEmitter.addListener(
        'finderBackRequested',
        handleBack,
      );
      bluetoothSystem.setFinderBackHandlerEnabled(true);

      return () => {
        bluetoothSystem.setFinderBackHandlerEnabled?.(false);
        subscription.remove();
      };
    }

    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        handleBack();
        return true;
      },
    );

    return () => subscription.remove();
  }, [returnToDevices, screenMode]);

  useEffect(() => {
    if (screenMode !== 'finder' || !isTracking) {
      return undefined;
    }

    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [isTracking, screenMode]);

  useEffect(() => {
    let isMounted = true;
    const subscription = manager.onStateChange(nextState => {
      if (!isMounted) {
        return;
      }

      setAdapterState(nextState);

      if (nextState === State.PoweredOn && !initialScanStarted.current) {
        initialScanStarted.current = true;
        startDiscoveryScan().catch(() => undefined);
        return;
      }

      if (nextState !== State.PoweredOn) {
        scanSession.current += 1;
        clearScanTimer();
        setIsDiscovering(false);
        setIsTracking(false);
        setErrorMessage(bluetoothHelp(nextState));
        manager.stopDeviceScan().catch(() => undefined);
      }
    }, true);

    return () => {
      isMounted = false;
      scanSession.current += 1;
      clearScanTimer();
      subscription.remove();
      manager
        .stopDeviceScan()
        .finally(() => manager.destroy())
        .catch(() => {
          // The manager can already be torn down during development reloads.
        });
    };
  }, [clearScanTimer, manager, startDiscoveryScan]);

  const signalAge = lastSignalAt === null ? null : now - lastSignalAt;
  const isSignalStale = signalAge !== null && signalAge > SIGNAL_STALE_AFTER_MS;
  const displayedRssi = isSignalStale ? null : liveRssi;

  if (screenMode === 'finder' && selectedDevice) {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
        <StatusBar barStyle="light-content" backgroundColor="#071b27" />

        <View style={styles.finderHeader}>
          <Pressable
            accessibilityLabel="Back to discovered devices"
            accessibilityRole="button"
            onPress={returnToDevices}
            style={({ pressed }) => [
              styles.backButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.backButtonText}>← Devices</Text>
          </Pressable>
          <Text style={styles.eyebrow}>LIVE SIGNAL</Text>
          <Text numberOfLines={1} style={styles.finderTitle}>
            {selectedDevice.name}
          </Text>
          <Text numberOfLines={1} style={styles.finderDeviceId}>
            {selectedDevice.id}
          </Text>
        </View>

        <View style={styles.finderBody}>
          <View style={styles.signalCard}>
            <View style={styles.liveStatusRow}>
              <View
                style={[
                  styles.statusDot,
                  displayedRssi === null
                    ? styles.statusMuted
                    : styles.statusReady,
                ]}
              />
              <Text style={styles.liveStatusText}>
                {isStarting
                  ? 'Starting tracker'
                  : isSignalStale
                  ? 'Signal lost — keep moving'
                  : displayedRssi === null
                  ? 'Waiting for this device'
                  : 'Receiving live signal'}
              </Text>
              {isTracking ? (
                <ActivityIndicator color="#47d7ac" size="small" />
              ) : null}
            </View>

            <View style={styles.readingRow}>
              <Text
                accessibilityLabel={
                  displayedRssi === null
                    ? 'No current RSSI reading'
                    : `Current RSSI ${displayedRssi} decibels`
                }
                style={[
                  styles.readingNumber,
                  { color: signalColor(displayedRssi) },
                ]}
              >
                {displayedRssi === null ? '—' : displayedRssi}
              </Text>
              <View style={styles.readingLabels}>
                <Text style={styles.readingUnit}>dBm</Text>
                <Text style={styles.readingDescription}>
                  {signalDescription(displayedRssi)}
                </Text>
              </View>
            </View>

            <SignalMeter rssi={displayedRssi} />
            <View style={styles.meterLabels}>
              <Text style={styles.meterLabel}>Weak</Text>
              <Text style={styles.meterLabel}>Moderate</Text>
              <Text style={styles.meterLabel}>Strong</Text>
            </View>

            {isSignalStale && liveRssi !== null && signalAge !== null ? (
              <Text style={styles.lastReadingText}>
                Last reading: {liveRssi} dBm, {Math.floor(signalAge / 1_000)}s
                ago
              </Text>
            ) : null}

            {errorMessage ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {errorMessage}
              </Text>
            ) : null}
          </View>

          <View style={styles.finderTipCard}>
            <Text style={styles.tipTitle}>Find it faster</Text>
            <Text style={styles.tipText}>
              Walk slowly and watch the meter. A less negative number means the
              signal is getting stronger and you are likely moving closer.
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={returnToDevices}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Stop tracking</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const statusLabel = isDiscovering
    ? 'Scanning nearby for 8 seconds'
    : hasScanned
    ? 'Scan complete — list is frozen'
    : STATE_LABELS[adapterState] ?? 'Bluetooth unavailable';
  const statusColor =
    adapterState === State.PoweredOn ? styles.statusReady : styles.statusMuted;

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#071b27" />

      <View style={styles.header}>
        <Text style={styles.eyebrow}>BLUETOOTH DEVICE FINDER</Text>
        <Text style={styles.title}>Nearby devices</Text>
        <Text style={styles.subtitle}>
          See connected audio devices and nearby BLE advertisers, then track an
          available BLE signal.
        </Text>
      </View>

      <View style={styles.controlCard}>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, statusColor]} />
          <Text style={styles.statusText}>{statusLabel}</Text>
          {isDiscovering || isStarting ? (
            <ActivityIndicator color="#47d7ac" size="small" />
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hasScanned ? 'Scan again' : 'Scan for devices'}
          disabled={isDiscovering || isStarting}
          onPress={startDiscoveryScan}
          style={({ pressed }) => [
            styles.scanButton,
            pressed && styles.buttonPressed,
            (isDiscovering || isStarting) && styles.buttonDisabled,
          ]}
        >
          <Text style={styles.scanButtonText}>
            {isDiscovering || isStarting
              ? 'Scanning…'
              : hasScanned
              ? 'Scan again'
              : 'Scan for devices'}
          </Text>
        </Pressable>

        {errorMessage ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {errorMessage}
          </Text>
        ) : null}
      </View>

      <View style={styles.listHeader}>
        <Text style={styles.listTitle}>Known devices</Text>
        <Text style={styles.deviceCount}>
          {devices.length} {devices.length === 1 ? 'device' : 'devices'}
        </Text>
      </View>

      <FlatList
        contentContainerStyle={[
          styles.listContent,
          devices.length === 0 && styles.emptyListContent,
        ]}
        data={devices}
        keyExtractor={device => device.id}
        renderItem={({ item }) => (
          <DeviceCard
            device={item}
            disabled={isDiscovering || isStarting}
            onPress={() => startTrackingDevice(item)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <View style={styles.bluetoothMark}>
              <Text style={styles.bluetoothMarkText}>B</Text>
            </View>
            <Text style={styles.emptyTitle}>
              {isDiscovering
                ? 'Listening for advertisements…'
                : 'Ready to scan'}
            </Text>
            <Text style={styles.emptyText}>
              {isDiscovering
                ? 'Results will become selectable when this scan finishes.'
                : bluetoothHelp(adapterState)}
            </Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
      />

      <Text style={styles.footerNote}>
        Connected audio devices can be listed, but live tracking requires a BLE
        advertisement from that device.
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
    paddingBottom: 20,
    paddingHorizontal: 22,
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
    maxWidth: 350,
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
  deviceCardPressed: {
    borderColor: '#47d7ac',
    transform: [{ scale: 0.99 }],
  },
  deviceCardDisabled: {
    opacity: 0.72,
  },
  systemDeviceCard: {
    borderColor: '#35505b',
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
  deviceStatus: {
    borderRadius: 10,
    fontSize: 10,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 3,
    textTransform: 'uppercase',
  },
  deviceStatusConnected: {
    backgroundColor: '#17483c',
    color: '#83e8c7',
  },
  deviceStatusPaired: {
    backgroundColor: '#30414a',
    color: '#bccbd2',
  },
  metaDivider: {
    color: '#3c5c68',
    marginHorizontal: 7,
  },
  trackRow: {
    alignItems: 'center',
    borderTopColor: '#173b49',
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 13,
    paddingTop: 11,
  },
  trackHint: {
    color: '#70d8b8',
    fontSize: 12,
    fontWeight: '700',
  },
  trackArrow: {
    color: '#70d8b8',
    fontSize: 17,
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
  finderHeader: {
    paddingBottom: 22,
    paddingHorizontal: 22,
    paddingTop: 10,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 22,
    paddingVertical: 6,
  },
  backButtonText: {
    color: '#83e8c7',
    fontSize: 14,
    fontWeight: '800',
  },
  finderTitle: {
    color: '#f5fbff',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  finderDeviceId: {
    color: '#718d9a',
    fontSize: 12,
    marginTop: 7,
  },
  finderBody: {
    flex: 1,
    paddingHorizontal: 18,
  },
  signalCard: {
    backgroundColor: '#102c39',
    borderColor: '#1c4250',
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
  },
  liveStatusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 22,
  },
  liveStatusText: {
    color: '#dceaf0',
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
  },
  readingRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    marginBottom: 24,
    marginTop: 26,
  },
  readingNumber: {
    fontSize: 70,
    fontVariant: ['tabular-nums'],
    fontWeight: '800',
    letterSpacing: -3,
    lineHeight: 76,
  },
  readingLabels: {
    marginBottom: 9,
    marginLeft: 12,
  },
  readingUnit: {
    color: '#91a8b3',
    fontSize: 15,
    fontWeight: '700',
  },
  readingDescription: {
    color: '#dceaf0',
    fontSize: 14,
    fontWeight: '800',
    marginTop: 4,
  },
  meter: {
    flexDirection: 'row',
    height: 30,
  },
  meterSegment: {
    backgroundColor: '#264653',
    borderRadius: 4,
    flex: 1,
    marginRight: 4,
  },
  meterLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 9,
  },
  meterLabel: {
    color: '#708a95',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  lastReadingText: {
    color: '#f2b862',
    fontSize: 12,
    marginTop: 18,
  },
  finderTipCard: {
    backgroundColor: '#0d2632',
    borderColor: '#173b49',
    borderRadius: 15,
    borderWidth: 1,
    marginTop: 14,
    padding: 16,
  },
  tipTitle: {
    color: '#dceaf0',
    fontSize: 14,
    fontWeight: '800',
  },
  tipText: {
    color: '#829aa6',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 6,
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: '#47d7ac',
    borderRadius: 12,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    marginTop: 18,
  },
  secondaryButtonText: {
    color: '#66e4bd',
    fontSize: 14,
    fontWeight: '800',
  },
});

export default App;
