# Rules for the app's release build (R8), carried by this plugin: build.gradle.kts hands
# them to whichever app uses it (consumerProguardFiles), so they apply to the app's own
# shrinking without anything added to the generated Gradle project.
#
# ML Kit (Google's code scanner, behind "Scan the code") and Firebase start themselves from
# names in the manifest's metadata: each of their ComponentRegistrar classes is looked up by
# name and made with its empty constructor. Nothing in the code calls that constructor, so
# R8 took it out, and every registrar failed with NoSuchMethodException at start-up
# ("Invalid component registrar" in the log). ML Kit was left with none of its parts, and
# the first GmsBarcodeScanning.getClient found a null where one should be: the phone showed
# "Attempt to invoke virtual method 'java.lang.Class java.lang.Object.getClass()' on a null
# object reference". The class and its name are kept by the libraries' own rules; this
# keeps the constructor too.
-keep class * implements com.google.firebase.components.ComponentRegistrar {
    <init>();
}
