# Panedora

[![License: CC BY-NC-ND 4.0](https://img.shields.io/badge/License-CC%20BY--NC--ND%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-nd/4.0/)

## New: Tune Your Station

**Station modes now work directly in Panedora.** Click the artwork in the play bar to open Now Playing, then choose a mode from **Tune your station** above Recently Played.

The themed menu shows the modes Pandora makes available for your station and account, such as Discovery, Deep Cuts, or Artist Only. Artist Only requires verified Pandora Premium access and an eligible station. Tuning is hidden for Shuffle and stations without available modes.

## Project Purpose
Panedora is a personal, educational, and experimental project created purely for fun. It was built as a creative exercise to explore modern UI design (Glassmorphism) and Electron-based desktop application development. This project is intended for personal use only and was developed with zero intent to cause harm, bypass security, or interfere with Pandora's business operations. It is shared as a demonstration of UI/UX design and technical integration.

![App Interface](screenshot.png?v=2)
*A preview of the Panedora immersive station library.*

A premium, immersive Pandora desktop client built with Electron. Panedora features a fully theme-driven Glassmorphism design system, persistent session management, and an enhanced playback experience that goes far beyond the standard Pandora web player.

> [!IMPORTANT]
> **Pandora Plus or Premium subscription required.** This application only works with an active Pandora Plus or Premium account. Free Pandora accounts cannot log in yet — free account support may be added in a future release. A paid subscription is required to access the API endpoints that Panedora currently relies on.

> ### A Note to Developers
> This project is source-available and intended for educational purposes. You are free to explore and learn from the code. However, under the CC BY-NC-ND 4.0 license, you may not distribute modified versions of this software. Additionally, to prevent abuse of the legacy Pandora API, please do not modify or tamper with any of the application's backend logic.

## Recent Updates

*   **Tune Your Station:** Choose and apply Pandora's available station modes directly in the expanded Now Playing view, with immediate playback of the new mix.
*   **Device Takeover:** If Pandora is playing on another device, choose **Let me listen** in Panedora's themed prompt to switch playback here, or **Let them listen** to keep Panedora paused.
*   **Themed Station Removal & Station Highlighting:** Station removal uses a confirmation that matches the app's theme. The sidebar follows the actual playing station or Shuffle.
*   **Mini Player Transparency & Contrast:** Rewrote the Mini Player window logic to achieve true OS-level transparency. Introduced localized frosted glass "pill" containers and soft radial gradients to ensure readability at any size.
*   **Always-on-Top Mini Player:** Built a compact, floating Mini Player mode that stays on top of other windows (even borderless fullscreen games), providing instant access to playback controls, thumbnail art, and feedback buttons without leaving your current application.
*   **Live Lyrics:** Added a comprehensive lyrics fetching system that seamlessly presents synchronized, time-coded lyrics overlaid on the Now Playing screen, complete with auto-scrolling and a highlighted active line.
*   **Visualizer Overhaul:** Completely reprogrammed the CSS and Canvas audio visualizers (specifically the Reactive Wave and Reactive Circle). Applied heavy math smoothing (25-point rolling averages) and lerp interpolation for fluid, non-jittery motion.
*   **State & Feedback Fixes:** Fixed complex UI bugs where the "Thumb Up" button would randomly clear its state during volume changes, and where the Adaptive Theme color extractor would aggressively re-run on every track update.
*   **Persistent Preferences:** The application now actively saves and restores your preferred Color Theme, Background Effect, and Lyrics Highlight Style across launches.
*   **Startup Stability:** Resolved deep Electron "Access is denied" GPU cache disk errors by configuring specific Chromium command-line switches on boot.
*   **UI Polish:** Hardened CSS layout dimensions for Lyrics Settings previews, rebuilt DOM inheritance to fix width overflowing, tightened highlight box borders, and resolved a global scrolling bug by locking overflow on the body.

## Overview

Panedora is designed to provide the absolute best desktop listening experience for Pandora users. By providing real-time feedback synchronization with your Pandora account, it operates as a fully functional client — not just a web wrapper. Every visual element is driven by a live CSS custom property system, so the entire look of the app updates instantly whenever you switch themes or effects.

## Key Features

### Immersive Glassmorphism Design
*   **Theme-Driven Aesthetic:** The entire app background, accent colors, glows, and gradients are controlled by CSS custom properties that update at runtime. The look of the app is completely determined by whichever theme you have selected — there is no single fixed color scheme.
*   **9 Built-In Themes:** Choose from Midnight Violet, Deep Ocean, Emerald Forest, Sunset Blaze, Rose Quartz, Arctic Frost, Neon Cyber, Classic Dark, and Adaptive (Dynamic). Each theme instantly transforms every color, gradient, and glow in the UI.
*   **Adaptive (Dynamic) Theme:** When selected, the app samples the current track's album artwork using an HTML5 Canvas pixel-extraction algorithm and automatically derives a dominant accent color, updating the entire UI palette in real time as songs change.
*   **Frosted Glass Panels:** The side navigation and footer player bar render as floating, translucent islands using `backdrop-filter: blur()` on a fully transparent Electron window.
*   **Detached Navigation & Player:** The sidebar and footer player render as separate floating panels with gap spacing between them, giving the interface a premium, native-app feel.
*   **Collapsible Sidebar:** The sidebar collapses into a sleek icon-only view (62px wide) and expands smoothly on hover (250px) to reveal labels, station names, and the sign-out button — maximizing content space at all times.
*   **Immersive Now Playing:** A full-bleed dedicated page for focused listening, featuring large album artwork, high-res track metadata, feedback controls, and your recently played history.
*   **Custom Frameless Window:** The application runs as a fully frameless, transparent Electron window with a custom drag-region title bar and standard minimize/maximize/close controls.

### Background Effects
The Settings page lets you choose from 10 animated background effects, all of which inherit the active theme's accent color:
*   **Waves**
*   **Orbs**
*   **Space**
*   **Grid**
*   **Particles**
*   **Rings**
*   **Reactive (Bars)**
*   **Reactive (Circle)**
*   **Reactive (Wave)**
*   **Static**

Your selected effect is saved and restored automatically on next launch.

### Enhanced Player Experience
*   **High-Quality Audio:** The client requests the `aacplus` (HE-AAC) streaming format, ensuring a clear and consistent listening experience.
*   **Seamless Playback Controls:** Standard controls (Play, Pause, Skip, Previous) integrated cleanly into a floating player footer. The previous button intelligently restarts the current track if you are more than a few seconds in, mirroring natural playback behavior.
*   **Mini Player Mode:** Collapse the app into a compact 540×100 bar that floats above all other windows using the `screen-saver` always-on-top level — including borderless fullscreen games. The mini player includes playback controls and quick-access feedback buttons.
*   **Lyrics Button:** A dedicated lyrics toggle in the player footer fetches and displays time-coded, auto-scrolling lyrics overlaid on the Now Playing page.
*   **Lyrics Highlight Styles:** Choose how the active lyric line is highlighted — Text Glow (scaled, glowing text), Pill Box (a tightly padded container border), or Full Line (a full-width background block).

### Intelligent Feedback & History System
*   **Reactive Feedback:** Large, interactive Like (Thumbs Up) and Dislike (Thumbs Down) buttons on the Now Playing page feature dynamic visual states and synchronize directly with the Pandora API.
*   **Smart Toggling:** Clicking an already-active feedback button calls the Pandora API to delete the feedback preference, rather than just toggling a local UI state.
*   **Persistent Song History:** A dedicated "Recently Played" panel on the Now Playing page tracks and displays the last 20 songs you have listened to, complete with album art and your feedback status for each track.
*   **Undo Dislike:** If you dislike a song (which automatically skips it), you can find it in your history panel and click the "Undo" button to instantly remove the negative feedback via the Pandora API, returning the track to your rotation.
*   **Live Synchronization:** The history list updates in real time as songs change or feedback is toggled, with no manual page refresh required.

### Station Library
*   **Home Screen:** Displays a time-aware greeting ("Good Morning", "Good Afternoon", "Good Evening") and organizes your stations into two grids: "Jump Back In" (your 6 most recently played) and "More from Your Collection" (the next 6 by recency).
*   **Full Library View:** The Library page shows all your stations sorted alphabetically with a live filter input — type to narrow down results instantly as you type, with a debounced update and preserved cursor position.
*   **Search:** Search for songs, artists, and stations. Results are organized into separate sections. Selecting a song currently starts a station based on that song; it does not guarantee playback of that exact track, including on Premium accounts.

### Robust Session Management
*   **Secure Authentication:** Signs in directly with Pandora, generating and managing the required auth tokens and CSRF tokens for all subsequent requests.
*   **Pandora Verification (Experimental):** Human-check support is implemented for sign-in, with a separate CAPTCHA window and automatic retry after completion. It has been tested with simulated challenges; verification against a live Pandora CAPTCHA still needs confirmation.
*   **Clean Sign Out:** A dedicated sign-out process permanently wipes session tokens, pauses active streams, and safely tears down the player state to prevent ghost playback or infinite reload loops.

### Update Notices
Release builds containing the update checker look for a newer stable GitHub release once per launch. A small pill centered above the page content offers **Download update** or **Later**, while navigation and playback controls remain usable. Download opens the project's GitHub release page; Later postpones that version's reminder for 24 hours. Checks run in the background and quietly stop if the network is unavailable. The pill stays hidden in mini mode and while another app dialog is open, and does not move keyboard focus.

Older versions without this checker need one manual update before they can display notices for later releases. Development checkouts do not check automatically.

## Technical Architecture

Panedora is built using a modern Electron stack, emphasizing security and separation of concerns:

*   **Main Process (`main.js`):** Acts as the orchestrator. It manages the application lifecycle, handles all API requests to Pandora from the secure Node.js context, builds playlist queues, manages the `songHistory` array, controls the Mini Player window state, and exposes functionality to the renderer via IPC handlers.
*   **Pandora API Controller (`pandora-api.js`):** A dedicated class that handles all communication with Pandora's backend REST endpoints. It routes requests through Electron's `net.fetch` (Chromium's native network stack) and manages auth token and CSRF token lifecycle.
*   **Renderer Process (`renderer.js`):** The frontend layer. Built with vanilla JavaScript, HTML5, and CSS3. Handles all DOM rendering, routing between pages (Home, Search, Library, Now Playing, Settings), audio playback via the HTML5 `<audio>` element, the full theme and background effect system, lyrics fetching and rendering, and the Adaptive theme color extraction algorithm.
*   **Audio Visualizer (`visualizer.js`):** A standalone class powered by the Web Audio API. Initializes an `AudioContext`, taps into the HTML5 audio element via a `MediaElementSource`, and drives three Canvas-based reactive visualizer styles (Bars, Circle, Wave) with configurable FFT sizes and smoothing.
*   **Preload Script (`preload-ui.js`):** Establishes a secure IPC bridge using Electron's `contextBridge`. Context isolation is enabled, meaning the renderer has zero direct access to Node.js or Electron APIs — all privileged calls go through the explicitly exposed `window.api` surface.
*   **Styling (`styles.css`):** Built entirely on CSS custom properties (variables) for the theme system. Employs CSS Grid, Flexbox, `backdrop-filter`, CSS animations, and a transparent/frameless window setup to achieve the Glassmorphism aesthetic.

## Automated Builds & Releases
This project utilizes a GitHub Actions Continuous Integration (CI/CD) pipeline. Whenever a new version tag is published, the workflow automatically provisions Windows, macOS, and Linux runners to build the application and attaches the ready-to-use `.exe`, `.dmg`, and `.AppImage` installers to the [Releases](https://github.com/MitchellBrovarnik/Panedora/releases) page.

You do **not** need to compile the application locally. Simply navigate to the Releases tab to download the platform-specific installer for your system.

### Windows SmartScreen Notice
> **Note:** Windows may show a SmartScreen warning saying **"Windows protected your PC"** when you run the installer. This is normal for apps from independent developers that haven't purchased a code signing certificate. To install:
> 1. Click **"More info"**
> 2. Click **"Run anyway"**
>
> This project is source-available — you can review the full source code right here to verify it's safe.

### macOS Gatekeeper Notice
> **Note:** macOS may block the app with a message saying **"Panedora is damaged and can't be opened"**, **"Panedora can't be opened because it is from an unidentified developer"**, or **"Apple could not verify"**. This is normal for apps that aren't distributed through the Mac App Store or signed with an Apple Developer certificate.
>
> **If you see the "damaged" message**, open **Terminal** and run:
> ```
> xattr -cr ~/Downloads/<the downloaded .dmg file>
> ```
> Replace `<the downloaded .dmg file>` with the actual filename you downloaded (e.g. `Panedora-1.0.0-arm64.dmg`). Then open the `.dmg` again and drag Panedora to Applications as usual.
>
> **If you see the "unidentified developer" message**, try:
> 1. Right-click (or Control-click) the app and select **"Open"**
> 2. Click **"Open"** in the dialog that appears
>
> Or go to **System Settings → Privacy & Security** and click **"Open Anyway"** next to the blocked app message.

## Usage

1. **Sign In:** Launch the application and sign in using your Pandora credentials. A Pandora Plus or Premium subscription is required — free accounts are not yet supported. An active internet connection is required.
2. **Library Navigation:** Your stations populate the Home screen in two grids. Click any station card to begin playback. Use the Library page to browse and filter your full collection alphabetically.
3. **Now Playing:** Click the album artwork in the footer player bar to open the full Now Playing view, which includes large artwork, track metadata, feedback buttons, and your Recently Played history.
4. **Curating & History:**
   *   Use the **Thumbs Up** / **Thumbs Down** buttons to inform Pandora's algorithm of your preferences.
   *   Review your recently played tracks in the panel on the right side of the Now Playing page. Click **Undo** on any disliked track to remove the negative feedback from your Pandora account.
   *   Click the artwork in the play bar to open the expanded song/history view. Use **Tune your station** above Recently Played to choose from Pandora's available modes. Once the new mode and its songs are confirmed, playback switches to the first new song and resumes even if it was paused. Failed changes keep the current song and its playback state. Pause works normally once the new song starts.
5. **Lyrics:** Click the **Lyrics** button in the player footer to display synchronized, scrolling lyrics over the Now Playing page.
6. **Mini Player:** Click the **Mini Player** button to collapse the app into a compact floating bar that stays on top of all other windows, including fullscreen games.
7. **Themes, Effects & Settings:** Click the **Settings** gear in the sidebar to choose a Color Theme, Background Effect, and Lyrics Highlight Style.
8. **Sign Out:** Hover over the left sidebar to expand it, then click the **Sign Out** button at the bottom to safely end your session.

## Current Limitations

*   **On-Demand Song Playback:** Pandora Premium supports playing available songs on demand; Plus primarily provides station listening and replay ([Pandora's subscription/API comparison](https://developer.pandora.com/docs/getting-started/pandora-subscriptions-and-apis/)). Panedora currently uses station playback for song search results and has not implemented verified Premium on-demand playback. A Premium subscription alone therefore does not make exact-song selection work in this client. Use Pandora's official app or website for direct song playback.

## Privacy and Security

Panedora is designed with user privacy as a priority:
*   **Direct Authentication:** Your credentials are used to sign in to Pandora. Saved passwords are encrypted locally using the operating system's secure storage when available, with an app encryption fallback.
*   **Local Storage Only:** Authentication tokens and encrypted credentials are stored locally on your machine in your user data directory. All auth data is cleared on sign-out.
*   **No Analytics or Ad Trackers:** Panedora includes no analytics or advertising trackers. Pandora handles authentication and playback; lyrics requests send the artist and song title to LRCLIB when you use Lyrics. Release builds with the update checker request GitHub's latest public release. These services receive normal network information such as your IP address, but lyrics and update requests do not include your Pandora credentials. Fonts are bundled with the app instead of fetched from Google Fonts.

## License

This project is **source-available** under the [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/) License. You are free to view and study the source code, but commercial use and derivative distribution are not permitted. See the LICENSE file for details.

Bundled third-party assets retain their own licenses: [Inter](assets/Inter-OFL.txt) uses SIL OFL 1.1; the website's [Boxicons font](docs/assets/Boxicons-OFL.txt) uses SIL OFL 1.1 and its [CSS](docs/assets/Boxicons-MIT.txt) uses MIT. Inter is sourced from [the official project](https://github.com/rsms/inter/tree/353b61b9f4430d5f420d56605a6e7993e0941470); Boxicons is the upstream 2.1.4 package, with its font paths changed to local files.

## Disclaimer

This application is an unofficial, third-party client created for personal, non-commercial use and educational purposes. It is not affiliated with, endorsed by, or sponsored by Pandora Media, LLC, or its parent company, Sirius XM Holdings Inc. 'Pandora' is a registered trademark of Pandora Media, LLC. No proprietary Pandora assets or code are included in this repository.

> [!TIP]
> This application currently requires an active Pandora Plus or Premium subscription. A paid account does not guarantee support for every feature in Pandora's official apps; see the current limitations above.
