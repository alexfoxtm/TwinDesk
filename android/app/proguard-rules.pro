# Release shrinking. The default Android optimize file already keeps manifest components
# (activities, services, receivers, providers, the accessibility service, the notification
# listener, the VPN, the tiles), Parcelable creators, Serializable members, enums, and native
# methods. What follows is what this app reaches by name and the default file does not keep.
# No extra libraries: the offline build must keep resolving what it already has.

# WebView looks methods up by the name written in the page. The annotation has to stay on the
# method or the lookup finds nothing. WebHost.Bridge (Web.kt, name "TD") and LockPage.Bridge
# (LockPage.kt, name "LockBridge").
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.twindesk.android.WebHost$Bridge { public *; }
-keep class com.twindesk.android.LockPage$Bridge { public *; }
-keepattributes JavascriptInterface,Signature,InnerClasses,EnclosingMethod,Exceptions,RuntimeVisibleAnnotations,AnnotationDefault

# The default file only names the old WebViewClient(String) overloads. These pages override the
# WebResourceRequest ones, and WebChromeClient supplies the video poster.
-keepclassmembers class * extends android.webkit.WebViewClient { public *; }
-keepclassmembers class * extends android.webkit.WebChromeClient { public *; }

# Elevate.kt calls Shizuku.newProcess by reflection (it is private). The provider in the full
# manifest is rikka.shizuku.ShizukuProvider. BinderContainer is the Parcelable the provider
# library moves across processes; its own rule only keepnames the class.
-keep class rikka.shizuku.** { *; }
-keep interface rikka.shizuku.** { *; }
-keep class moe.shizuku.api.BinderContainer { *; }
-dontwarn rikka.shizuku.**
-dontwarn moe.shizuku.**

# OkHttp, Compose, coroutines, and the Play code scanner ship their own consumer rules inside
# the artifacts already on the offline classpath. Framework lookups (SystemProperties,
# WifiManager.isWifiApEnabled, BluetoothDevice.removeBond, BluetoothGatt.refresh) are android.*
# and are not renamed.

# These JNI symbols use fixed Java class and method names.
-keep class com.twindesk.android.embedded.NativeNode { native <methods>; }
-keep class com.twindesk.android.embedded.NativeInterfaces { native <methods>; }
