package com.nearbybluetooth

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class BluetoothSystemModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun getKnownAudioDevices(promise: Promise) {
    if (!hasBluetoothConnectPermission()) {
      promise.reject(
        "BLUETOOTH_PERMISSION_DENIED",
        "Bluetooth connect permission is required to read connected devices.",
      )
      return
    }

    val bluetoothManager =
      reactApplicationContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val adapter = bluetoothManager?.adapter

    if (adapter == null) {
      promise.reject("BLUETOOTH_UNSUPPORTED", "Bluetooth is unavailable on this device.")
      return
    }

    if (!adapter.isEnabled) {
      promise.resolve(Arguments.createArray())
      return
    }

    reactApplicationContext.runOnUiQueueThread {
      AudioDeviceRequest(adapter, promise).start()
    }
  }

  @ReactMethod
  fun setFinderBackHandlerEnabled(enabled: Boolean) {
    reactApplicationContext.runOnUiQueueThread {
      (reactApplicationContext.currentActivity as? MainActivity)
        ?.setFinderBackHandlerEnabled(enabled)
    }
  }

  private fun hasBluetoothConnectPermission(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
      ContextCompat.checkSelfPermission(
        reactApplicationContext,
        Manifest.permission.BLUETOOTH_CONNECT,
      ) == PackageManager.PERMISSION_GRANTED

  private inner class AudioDeviceRequest(
    private val adapter: BluetoothAdapter,
    private val promise: Promise,
  ) {
    private val handler = Handler(Looper.getMainLooper())
    private val devices = linkedMapOf<String, AudioDeviceInfo>()
    private val pendingProfiles =
      mutableSetOf(BluetoothProfile.A2DP, BluetoothProfile.HEADSET)
    private var isResolved = false

    private val timeout = Runnable { finish() }

    @SuppressLint("MissingPermission")
    fun start() {
      adapter.bondedDevices
        .filter(::isAudioDevice)
        .forEach { addDevice(it, isConnected = false, profileName = null) }

      requestProfile(BluetoothProfile.A2DP, "Media audio")
      requestProfile(BluetoothProfile.HEADSET, "Headset")
      handler.postDelayed(timeout, PROFILE_LOOKUP_TIMEOUT_MS)
    }

    @SuppressLint("MissingPermission")
    private fun requestProfile(profileId: Int, profileName: String) {
      val listener =
        object : BluetoothProfile.ServiceListener {
          override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
            try {
              if (!isResolved) {
                proxy.connectedDevices.forEach {
                  addDevice(it, isConnected = true, profileName = profileName)
                }
              }
            } finally {
              adapter.closeProfileProxy(profile, proxy)
              completeProfile(profileId)
            }
          }

          override fun onServiceDisconnected(profile: Int) {
            completeProfile(profileId)
          }
        }

      if (!adapter.getProfileProxy(reactApplicationContext, listener, profileId)) {
        completeProfile(profileId)
      }
    }

    @SuppressLint("MissingPermission")
    private fun addDevice(
      device: BluetoothDevice,
      isConnected: Boolean,
      profileName: String?,
    ) {
      val existing = devices[device.address]
      val info =
        existing
          ?: AudioDeviceInfo(
            id = device.address,
            name = device.name ?: "Audio device",
            isBonded = device.bondState == BluetoothDevice.BOND_BONDED,
          )

      info.isConnected = info.isConnected || isConnected
      info.isBonded = info.isBonded || device.bondState == BluetoothDevice.BOND_BONDED
      if (profileName != null) {
        info.profiles.add(profileName)
      }
      devices[device.address] = info
    }

    private fun completeProfile(profileId: Int) {
      if (isResolved) {
        return
      }

      pendingProfiles.remove(profileId)
      if (pendingProfiles.isEmpty()) {
        finish()
      }
    }

    private fun finish() {
      if (isResolved) {
        return
      }

      isResolved = true
      handler.removeCallbacks(timeout)
      val result = Arguments.createArray()

      devices.values
        .sortedWith(
          compareByDescending<AudioDeviceInfo> { it.isConnected }
            .thenBy { it.name.lowercase() },
        )
        .forEach { device ->
          val map = Arguments.createMap()
          val profiles = Arguments.createArray()
          device.profiles.forEach(profiles::pushString)
          map.putString("id", device.id)
          map.putString("name", device.name)
          map.putBoolean("isConnected", device.isConnected)
          map.putBoolean("isBonded", device.isBonded)
          map.putArray("profiles", profiles)
          result.pushMap(map)
        }

      promise.resolve(result)
    }

    private fun isAudioDevice(device: BluetoothDevice): Boolean =
      device.bluetoothClass?.majorDeviceClass == BluetoothClass.Device.Major.AUDIO_VIDEO
  }

  private data class AudioDeviceInfo(
    val id: String,
    val name: String,
    var isConnected: Boolean = false,
    var isBonded: Boolean = false,
    val profiles: MutableSet<String> = linkedSetOf(),
  )

  companion object {
    private const val NAME = "BluetoothSystem"
    private const val PROFILE_LOOKUP_TIMEOUT_MS = 2_000L
  }
}
