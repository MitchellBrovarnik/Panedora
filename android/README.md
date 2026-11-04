# Panedora Android prototype

A separate native Android prototype. The desktop app and website are unchanged.

This build focuses on Pandora sign-in, stations, current-song thumbs, seeking, and
continuous playback through Android Media3. The Stations / Now Playing / Settings
layout is made for touch and uses Panedora's dark purple palette.

The player, playlist refill, audio focus, and media notification live in a
`MediaSessionService`, so closing the screen does not stop the queue. The phone
talks directly to Pandora using the desktop client's REST payloads. Credentials
are encrypted with Android Keystore; backup and cleartext networking are disabled.
Pandora verification is displayed for the user to complete, using the same cookie
store as the API. Taking playback from another device requires a user choice.

## Build

Open this directory in Android Studio, or use JDK 17, Gradle 8.13, and Android SDK 36:

```sh
gradle :app:assembleDebug :app:testDebugUnitTest
gradle :app:connectedDebugAndroidTest
```

The **Android prototype** GitHub Actions workflow builds an installable debug APK,
runs protocol tests, and exercises playback with local silent WAV files in an
Android emulator. Test doubles exist only in `src/androidTest`; they are not
included in the installed app. No Pandora credentials are needed by CI.

The APK installs as **Panedora Prototype** (`app.panedora.mobile.prototype`).
This is an unsigned-for-release development build, signed with the Android debug
key. It is not a Play Store release. CI runners generate fresh debug keys, so a
later prototype may require uninstalling the previous prototype before installing.

Real Pandora authentication, mobile verification, and long screen-off listening
still require testing with a paid account on a physical phone. See [TESTING.md](TESTING.md).

Not included yet: desktop mini-players, Discord, themes/effects, lyrics, history
ratings, station creation/removal/tuning, downloaded music, or free accounts.
No automatic playback restoration after Android kills the process or the phone
reboots; reopen and choose a station.
