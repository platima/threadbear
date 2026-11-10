import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.tinkerware.threadbear.push"
    compileSdk = 36

    defaultConfig {
        minSdk = 26

        // What the app's release build (R8) must keep for ML Kit and Firebase to start
        // (consumer-rules.pro says what and why)
        consumerProguardFiles("consumer-rules.pro")

        // For the emulator check in CI (.github/workflows/android.yml) only, which
        // builds a copy of its own: a key it knows, so it can seal a message the
        // app will open, and the token logged, so it knows where to send it. The
        // app people install has neither (the variables are not set there).
        buildConfigField("String", "TEST_PUSH_KEY", "\"${System.getenv("TB_PUSH_TEST_KEY") ?: ""}\"")
        buildConfigField("boolean", "LOG_PUSH_TOKEN", (System.getenv("TB_PUSH_LOG_TOKEN") == "1").toString())
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("com.google.firebase:firebase-messaging:24.1.2")
    // The pairing screen's scanner: Google's, which has its own camera screen
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    implementation(project(":tauri-android"))
}
