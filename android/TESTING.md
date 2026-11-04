# Test Panedora on your Android phone

Requires Android 8 or newer and Pandora Plus or Premium.

1. Download the **Panedora-Android-Prototype** artifact from the PR's **Android
   prototype** Actions run. Unzip it and open `Panedora-Android-Prototype.apk`.
2. If Android asks, allow your browser or file manager to install this APK.
   It installs as **Panedora Prototype**, separately from the official Pandora app.
3. Sign in to your Pandora account. If a verification prompt appears, tap
   **Verify with Pandora** and complete Pandora's check.
4. Choose a station. Check that the song, artwork, seeking, thumbs, and Next work.
   A thumbs-down on the current song should save to Pandora and skip that song.
5. Lock the phone for at least three full songs. Confirm that music continues and
   track changes update the lock-screen controls. Then try using another app.
6. Pause/resume with the lock-screen controls, and try headphones/Bluetooth.
   Disconnecting headphones should pause playback.
7. Try playing Pandora on another device. Panedora should ask before taking over.
8. Close and reopen Panedora; check that saved sign-in restores your stations.
   Sign out and reopen to check that the saved login was removed.

If something fails, report the visible error, your Android version, whether you
were on Wi-Fi or cellular, and whether the screen was locked. Do not share your
password, cookies, authentication tokens, or raw Pandora network responses.

This prototype has emulator tests with simulated Pandora responses. It has not
been verified against your live Pandora account. It does not include themes,
effects, lyrics, tuning, or the desktop mini-players yet.
