# Test Panedora on your Android phone

Requires Android 8 or newer and Pandora Plus or Premium.

1. Download the **Panedora-Android-Prototype** artifact from the PR's **Android
   prototype** Actions run. Unzip it and open `Panedora-Android-Prototype.apk`.
2. If Android asks, allow your browser or file manager to install this APK.
   It installs as **Panedora Prototype**, separately from the official Pandora app.
3. Sign in to your Pandora account. If a verification prompt appears, tap
   **Verify with Pandora** and complete Pandora's check.
4. Choose a station. Check that the song, artwork, seeking, thumbs, and Next work.
   Now Playing should show one row of playback icons and no bottom navigation or
   duplicate player. Collapse it with the top-left chevron to browse stations.
   The compact player should pause, resume, skip, and reopen Now Playing. History
   and Settings are in the top toolbar. Back should return to the previous screen,
   including after rotating or reopening the screen. Tap the song title for album
   details. Try a long song/station name and landscape orientation; controls should
   stay readable and reachable by scrolling in short windows.
   Tap **Tune your station** under the station name. Choose an offered mode and
   check that a fresh song starts from that mix. Plus accounts should not show
   Artist Only; Shuffle should not show tuning. Try pausing or selecting another
   station while a change is loading; the later action should win.
   Open Settings and try Theme and Accent color, including Custom hex. The chosen
   colors should apply immediately, persist after reopening, and keep music playing.
   While browsing Stations or Settings, tap the media notification. It should open
   Now Playing for the current station without restarting the song. Repeat after
   switching stations and after Android recreates the screen.
   A thumbs-down on the current song should save to Pandora and skip that song.
   Tap an active thumb again to remove the rating. Check the change in Pandora.
   Play/pause should keep the cover, controls, and scroll position still.
   After another song starts, open **History** and rate the previous song. The
   current song should keep playing. History currently covers this app session.
   Try **Shuffle Stations**, then refresh the station list; the shuffle control
   should remain available. Switching back to a regular station while shuffle
   is loading should keep the newer station choice.
   Give upcoming artwork a moment to preload, then skip. Prepared artwork should
   appear immediately in Playing and in the compact player, without a logo flash.
5. Lock the phone for at least three full songs. Confirm that music continues and
   track changes update the lock-screen controls. Then try using another app.
6. Pause/resume with the lock-screen controls, and try headphones/Bluetooth.
   Disconnecting headphones should pause playback.
7. Try playing Pandora on another device. Panedora should ask before taking over.
8. While music is playing, remove Panedora's card from Recents. Music and its
   notification should stop. Also try closing it while a song is buffering or
   Play is waiting on a connection; a late response must not restart playback.
   Reopen Panedora; saved sign-in should restore your stations without starting
   music. Sign out and reopen to check that the saved login was removed.

If something fails, report the visible error, your Android version, whether you
were on Wi-Fi or cellular, and whether the screen was locked. Do not share your
password, cookies, authentication tokens, or raw Pandora network responses.

This prototype has emulator tests with simulated Pandora responses. It has not
been verified against your live Pandora account. It does not include themes,
effects, adaptive colors, lyrics, or the desktop mini-players yet.

If verification appears, its widget should load below the title. If loading fails,
the page should show an error and offer **Reload check**. Complete the real check
yourself; emulator fixtures cannot verify Pandora's live acceptance. Check whether
the direct-script-first order reduces the wait on your phone; server/network
delays can still affect the result.
