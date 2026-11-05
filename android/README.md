# Panedora Android prototype

A separate native Android prototype. The desktop app and website are unchanged.

This build focuses on Pandora sign-in, stations/shuffle, history, rating/undo, seeking, and
continuous playback through Android Media3. The Stations / Playing / History / Settings
layout is made for touch and uses Panedora's dark purple palette. Stations is the
home screen, with History and Settings in the top toolbar. A compact player stays
available while browsing; tapping it opens a dedicated Now Playing screen with
larger artwork and a single row of playback icons. There is no persistent bottom
navigation bar. Back/collapse returns to the previous screen and retains station
search and scroll position. Tap the song title for album details.

Settings includes the desktop app's nine themes, including **Adaptive (Dynamic)**,
plus preset accents and a custom six-digit hex accent for the fixed themes.
Adaptive samples the current album artwork using the desktop's dominant-color
algorithm and colors the background, surfaces, and controls while keeping readable
contrast. Colors are prepared from the existing queued-cover loads, without extra
image requests, and cached as small color values. Missing artwork uses a purple
fallback; late downloads cannot recolor a newer song or a fixed theme. Preferences
persist on the phone and apply without interrupting playback.
Notification taps open Now Playing for the
current active station, including when Android needs to create the screen again.
With no active station, the app opens Stations without starting music.

The **Tune your station** button below the station name loads Pandora's available
modes. Shuffle is excluded; Premium-only choices are hidden unless the login and
station both allow them. Mode changes revalidate eligibility, discard the queued
old mix, request a continuation fragment, and confirm the selected mode before
starting a fresh song. A later Pause or station selection takes precedence over a
pending change. Taking playback from another device still requires a user choice.

The player, playlist refill, audio focus, and media notification live in a
`MediaSessionService`, so switching apps or locking the phone does not stop the
queue. Removing Panedora's card from Recents stops playback and the media service,
including pending playlist/resume requests, without signing out. The phone
talks directly to Pandora using the desktop client's REST payloads. Credentials
are encrypted with Android Keystore; backup and cleartext networking are disabled.
Pandora verification is displayed for the user to complete, using the same cookie
store as the API. It starts with Pandora's supplied direct provider script and
remembers the route that renders the check, with the other route retained as a
fallback. Taking playback from another device requires a user choice.

Shuffle uses Pandora's `/v1/station/shuffle` endpoint, as the desktop app does.
The player preloads decoded artwork for the current song and next two queued
songs, at both main-player and compact-player sizes. These requests share the
image cache and release their targets when the queue changes or playback ends.

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

Not included yet: desktop mini-players, Discord, visual effects,
lyrics, station creation/removal, downloaded music, or free accounts. History keeps
the last 100 songs from this app session. History ratings do not skip the current
song. Ratings created here retain Pandora's feedback ID for undo; existing ratings
without an ID are looked up by recording ID and original station before removal.
No automatic playback restoration after Android kills the process or the phone
reboots; reopen and choose a station.
