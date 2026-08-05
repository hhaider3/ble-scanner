package com.nearbybluetooth

import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  private val finderBackCallback =
    object : OnBackPressedCallback(false) {
      override fun handleOnBackPressed() {
        val reactContext = reactActivityDelegate.currentReactContext
        if (reactContext == null) {
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
          isEnabled = true
          return
        }

        reactContext.emitDeviceEvent(FINDER_BACK_EVENT)
      }
    }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, finderBackCallback)
  }

  fun setFinderBackHandlerEnabled(enabled: Boolean) {
    finderBackCallback.isEnabled = enabled
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "NearbyBluetooth"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  companion object {
    const val FINDER_BACK_EVENT = "finderBackRequested"
  }
}
