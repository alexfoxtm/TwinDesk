package com.twindesk.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ReleaseShrinkRulesTest {
    @Test fun releaseShrinksAndKeepsTheNamedBridges() {
        val app = appDir()
        val gradle = File(app, "build.gradle.kts").readText()
        assertTrue(gradle.contains("isMinifyEnabled = true"))
        assertTrue(gradle.contains("isShrinkResources = true"))
        assertFalse(gradle.contains("isMinifyEnabled = false"))
        assertTrue(gradle.contains("getDefaultProguardFile(\"proguard-android-optimize.txt\")"))
        assertTrue(gradle.contains("\"proguard-rules.pro\""))

        val rules = File(app, "proguard-rules.pro").readText()
        assertTrue(rules.contains("-keepclassmembers class * {"))
        assertTrue(rules.contains("@android.webkit.JavascriptInterface <methods>;"))
        assertTrue(rules.contains("JavascriptInterface,Signature,InnerClasses,EnclosingMethod,Exceptions,RuntimeVisibleAnnotations,AnnotationDefault"))
        assertTrue(rules.contains("-keep class com.twindesk.android.WebHost\$Bridge { public *; }"))
        assertTrue(rules.contains("-keep class com.twindesk.android.LockPage\$Bridge { public *; }"))
        assertTrue(rules.contains("-keep class rikka.shizuku.** { *; }"))
        assertTrue(rules.contains("-keep class moe.shizuku.api.BinderContainer { *; }"))

        val web = methods(File(app, "src/main/java/com/twindesk/android/Web.kt"))
        val lock = methods(File(app, "src/main/java/com/twindesk/android/LockPage.kt"))
        assertTrue(web.containsAll(listOf(
            "tr", "send", "move", "ready", "videoState", "canDecodeVideo", "detail", "videoMetrics",
            "playing", "haptic", "tick", "event", "setPad", "setLayout", "pad", "motion",
        )))
        assertTrue(lock.containsAll(listOf(
            "tr", "pageId", "phase", "geometry", "credentials", "ready", "send", "ack", "close", "keyboard",
        )))
        val elevate = File(app, "src/shizuku/java/com/twindesk/android/Elevate.kt").readText()
        assertTrue(elevate.contains("getDeclaredMethod(\"newProcess\""))
    }

    private fun methods(file: File): Set<String> {
        val names = Regex("@JavascriptInterface\\s+fun\\s+([A-Za-z0-9_]+)").findAll(file.readText()).map { it.groupValues[1] }.toSet()
        assertTrue("${file.name} has no JavascriptInterface methods", names.isNotEmpty())
        return names
    }

    private fun appDir(): File {
        var dir: File? = File(System.getProperty("user.dir") ?: "")
        repeat(8) {
            val current = dir ?: return@repeat
            if (File(current, "proguard-rules.pro").isFile && File(current, "build.gradle.kts").isFile) return current
            dir = current.parentFile
        }
        error("app module not found from ${System.getProperty("user.dir") ?: ""}")
    }
}
