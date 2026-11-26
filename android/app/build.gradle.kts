import org.gradle.process.ExecOperations
import javax.inject.Inject

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.twindesk.android"
    compileSdk = 37
    ndkVersion = "29.0.14206865"
    defaultConfig {
        applicationId = "io.github.alexfoxtm.twindesk.android"
        minSdk = 29 // Android 10: wireless debugging needs 11, everything else works from 10
        targetSdk = 36
        versionCode = 30201
        versionName = "3.2.1"
        buildConfigField("String", "NETEM_PEER", "\"\"")
        buildConfigField("String", "NETEM_ADDRESS", "\"\"")
    }
    // Two builds of the same app (same id and signature, so one installs over the other):
    //   standard — what people download: no notification access, SMS or Accessibility service, which
    //              Play Protect blocks on apps installed from a browser, a messaging app or a file manager;
    //   full     — with them (notifications, Messages, the mouse and keyboard without ADB): the computer
    //              installs it over the standard one through wireless debugging, which Play Protect doesn't check.
    //   fdroid   — what F-Droid builds and signs: the full one without Google's code scanner (Scan QR
    //              code opens the Camera app) or the updater (F-Droid updates it).
    flavorDimensions += "dist"
    productFlavors {
        create("standard") {
            dimension = "dist"
            buildConfigField("boolean", "NOTIF_LISTENER", "false")
            buildConfigField("boolean", "ACCESSIBILITY", "false")
            buildConfigField("boolean", "UPDATER", "true")
        }
        create("full") {
            dimension = "dist"
            buildConfigField("boolean", "NOTIF_LISTENER", "true")
            buildConfigField("boolean", "ACCESSIBILITY", "true")
            buildConfigField("boolean", "UPDATER", "true")
        }
        create("fdroid") {
            dimension = "dist"
            buildConfigField("boolean", "NOTIF_LISTENER", "true")
            buildConfigField("boolean", "ACCESSIBILITY", "true")
            buildConfigField("boolean", "UPDATER", "false")
        }
    }
    sourceSets {
        // Google's code scanner (src/gms) in the GitHub builds; without it in F-Droid's (src/fdroid).
        getByName("standard").kotlin.srcDir("src/gms/java")
        getByName("full").kotlin.srcDir("src/gms/java")
        // Shizuku (Permissions › Without a computer, Elevate.kt) in the full build only.
        getByName("full").kotlin.srcDir("src/shizuku/java")
        getByName("standard").kotlin.srcDir("src/noshizuku/java")
        getByName("fdroid").kotlin.srcDir("src/noshizuku/java")
    }
    buildTypes {
        debug {
            val peer = providers.gradleProperty("twNetemPeer").getOrElse("")
            val address = providers.gradleProperty("twNetemAddress").getOrElse("")
            require(peer.matches(Regex("[A-Za-z0-9._-]{0,64}")) && address.matches(Regex("[0-9.]{0,15}")))
            buildConfigField("String", "NETEM_PEER", "\"$peer\"")
            buildConfigField("String", "NETEM_ADDRESS", "\"$address\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Sideloaded from GitHub releases: signed with this machine's debug key until a release key exists.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    lint {
        checkReleaseBuilds = false
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

abstract class BuildEmbeddedNetwork : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val source: DirectoryProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val appShareLicense: RegularFileProperty

    @get:Internal
    abstract val ndk: DirectoryProperty

    @get:OutputDirectory
    abstract val libraries: DirectoryProperty

    @get:OutputDirectory
    abstract val notices: DirectoryProperty

    @get:Inject
    abstract val exec: ExecOperations

    @TaskAction
    fun buildNetwork() {
        val script = source.file("build.sh").get().asFile
        val output = libraries.get().asFile.parentFile
        exec.exec {
            environment("ANDROID_NDK_HOME", ndk.get().asFile.absolutePath)
            workingDir(script.parentFile)
            commandLine("bash", script.absolutePath, "android", output.absolutePath)
        }
        appShareLicense.get().asFile.copyTo(notices.file("AppShare-Apache-2.0.txt").get().asFile, overwrite = true)
    }
}

val embeddedNetworkOutput = layout.buildDirectory.dir("generated/embeddedNetwork")
val buildEmbeddedNetwork = tasks.register<BuildEmbeddedNetwork>("buildEmbeddedNetwork") {
    source.set(rootProject.layout.projectDirectory.dir("../network"))
    appShareLicense.set(rootProject.layout.projectDirectory.file("../licenses/Apache-2.0.txt"))
    ndk.set(androidComponents.sdkComponents.ndkDirectory)
    libraries.set(embeddedNetworkOutput.map { it.dir("jniLibs") })
    notices.set(embeddedNetworkOutput.map { it.dir("assets") })
}

androidComponents.onVariants { variant ->
    variant.sources.jniLibs?.addGeneratedSourceDirectory(buildEmbeddedNetwork, BuildEmbeddedNetwork::libraries)
    variant.sources.assets?.addGeneratedSourceDirectory(buildEmbeddedNetwork, BuildEmbeddedNetwork::notices)
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    // Shizuku (General › Permissions › Without a computer), full build only: its small client API; the app itself is the person's own install.
    "fullImplementation"("dev.rikka.shizuku:api:13.1.5")
    "fullImplementation"("dev.rikka.shizuku:provider:13.1.5")
    // Scan QR code (pairing): Google's scanner, no camera permission. Not in the F-Droid build (proprietary).
    "standardImplementation"("com.google.android.gms:play-services-code-scanner:16.1.0")
    "fullImplementation"("com.google.android.gms:play-services-code-scanner:16.1.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")
    testImplementation("org.robolectric:robolectric:4.16.1")
}
