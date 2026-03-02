# Pandora Glass

## Project Purpose
Pandora Glass is a personal, educational, and experimental project created purely for fun. It was built as a creative exercise to explore modern UI design (Glassmorphism) and Electron-based desktop application development. This project is intended for personal use only and was developed with zero intent to cause harm, bypass security, or interfere with Pandora's business operations. It is shared as a demonstration of UI/UX design and technical integration.

![App Interface](screenshot.png)
*A preview of the Pandora Glass immersive station library.*

A premium, immersive Pandora desktop client built with Electron. Pandora Glass features a modern Glassmorphism design system, persistent session management, and an enhanced playback experience that gives you deep control over your music library and station curation.

## Recent Updates

*   **Mini Player Transparency & Contrast:** Rewrote the Mini Player window logic to achieve true OS-level transparency. Introduced localized frosted glass "pill" containers and soft radial gradients behind text and controls to guarantee high contrast against bright desktop backgrounds without losing overall window translucency.
*   **Always-on-Top Mini Player:** Built a compact, floating Mini Player mode that stays on top of other Windows (even borderless fullscreen games), providing instant access to playback controls, thumbs up/down, and high-res album art without interrupting your workflow.
*   **Live Lyrics:** Added a comprehensive lyrics fetching system that seamlessly presents synchronized, time-coded lyrics overlaid on the Now Playing screen, complete with scrolling and highlighted active lines.
*   **Visualizer Overhaul:** Completely reprogrammed the CSS and Canvas audio visualizers (specifically the Reactive Wave and Reactive Circle). Applied heavy math smoothing (25-point rolling averages) and frequency dampening to transform chaotic oscilloscope noise into fluid, breathing visualizers.
*   **State & Feedback Fixes:** Fixed complex UI bugs where the "Thumb Up" button would randomly clear its state during volume changes, and where the Adaptive Theme color extractor would aggressively flash the screen by re-downloading album art on every partial state update.
*   **Persistent Preferences:** The application now actively saves and restores your preferred Color Theme and Background Visualizer Effect across launches.
*   **Startup Stability:** Resolved deep Electron "Access is denied" GPU cache disk errors by configuring specific Chromium command-line switches on boot.

## Overview

Pandora Glass is designed to provide the absolute best desktop listening experience for Pandora users. By requesting high-quality audio streams (HE-AAC / aacplus) and providing real-time feedback synchronization with your Pandora account, it operates as a fully native, lightweight alternative to browser-based listening.

## Key Features

### Immersive Glassmorphism Design
*   **Frosted Aesthetic:** The application is built on a deep violet-to-black gradient background with high-gloss translucent panels using backdrop blur effects.
*   **Detached Navigation & Player:** The side navigation and footer player bar render as floating islands with gap transitions, providing a premium, native feel.
*   **Collapsible Sidebar:** The sidebar collapses into a sleek icon-only view and expands smoothly on hover to maximize space for your station library.
*   **Immersive Now Playing:** A full-bleed dedicated page for focused listening, featuring large artwork and high-res track metadata.
*   **Theme Customization:** Personalize your experience with 8 premium theme presets (Midnight, Emerald, Sunset, etc.) that instantly transform the app's color palette and gradients.

### Enhanced Player Experience
*   **High-Resolution UI:** Every aspect of the playback interface is optimized for visual clarity and smooth transitions.
*   **High-Quality Audio:** The client utilizes the `aacplus` (HE-AAC) streaming format during API requests, ensuring you receive a clear and consistent listening experience.
*   **Seamless Playback Controls:** Standard controls (Play, Pause, Skip, Previous) integrated cleanly into a floating player footer. The previous button intelligently restarts the track if you are more than a few seconds in, or skips to the previous track otherwise.

### Intelligent Feedback & History System
*   **Reactive Feedback:** Large, interactive Like (Thumbs Up) and Dislike (Thumbs Down) buttons on the Now Playing page feature dynamic visual states and synchronize directly with the Pandora API.
*   **Smart Toggling:** Clicking an active feedback button (for example, clicking a green thumb to un-like a track) automatically calls the Pandora API to delete the feedback preference, rather than just changing the local UI state.
*   **Persistent Song History:** A dedicated "Recently Played" section tracks and displays the last 20 songs you have listened to, complete with album art and your feedback status.
*   **Undo Dislike:** If you dislike a song (which automatically skips it and removes it from rotation), you can find it in your history list and click the "Undo" button. This instantly communicates with the API to delete the negative feedback and restore the song to your station's rotation.
*   **Live Synchronization:** The history list updates in real-time as songs change or feedback is toggled, requiring no manual page refreshes.

### Robust Session Management
*   **Secure Authentication:** Securely authenticates your active user session and generates required CSRF tokens for API communication.
*   **Clean Sign Out:** A dedicated sign-out process permanently wipes session tokens, pauses active streams, and safely tears down the player state to prevent ghost playback or infinite reload loops.

## Technical Architecture

Pandora Glass is built using a modern Electron stack, emphasizing security and separation of concerns:

*   **Main Process (`main.js`):** Acts as the orchestrator. It manages the application lifecycle, handles secure API requests to Pandora, builds the playlist queues, manages the `songHistory` array, and maintains the global player state.
*   **Pandora API Controller (`pandora-api.js`):** A robust class that handles all communication with Pandora's backend endpoints. It manages authentication tokens, fetches stations, retrieves high-quality AAC+ playlists, and handles all feedback (add/delete) operations.
*   **Renderer Process (`renderer.js`):** The frontend layer. Built with vanilla JavaScript, HTML5, and CSS3, it is responsible for DOM manipulation, audio playback via the HTML5 `<audio>` element, and rendering the Glassmorphism UI.
*   **Preload Script (`preload-ui.js`):** Establishes a secure IPC (Inter-Process Communication) bridge. Context isolation is enabled, meaning the renderer process has zero access to Node.js capabilities. It can only communicate with the main process through strictly defined channels (e.g., `window.api.player.thumbUp()`).
*   **Styling (`styles.css`):** Employs modern CSS features including CSS Grid, Flexbox, CSS Variables (Custom Properties), and advanced backdrop filters to achieve the Glassmorphism aesthetic.

## Installation

### Prerequisites
*   [Node.js](https://nodejs.org/) (v16 or higher)
*   A valid Pandora account

### Setup Steps
1. Clone the repository to your local machine:
   ```bash
   git clone https://github.com/MitchellBrovarnik/Pandora-Glass.git
   cd Pandora-Glass
   ```
2. Install the necessary dependencies:
   ```bash
   npm install
   ```
3. Start the application in development mode:
   ```bash
   npm start
   ```

## Creating a Production Build
To package Pandora Glass for your specific operating system into a standalone executable, you can use Electron Forge or electron-builder (ensure they are installed in your project). For a standard package using electron-packager, you can add a script to your `package.json` or run:
```bash
npx electron-packager . PandoraGlass --platform=win32 --arch=x64 --out=dist
```
*(Replace `win32` and `x64` with your target platform and architecture).*

## Usage

1. **Sign In:** Launch the application and sign in using your standard Pandora credentials. The application requires an active internet connection to communicate with Pandora's servers.
2. **Library Navigation:** Upon logging in, your full list of saved stations will populate the home screen. Click any station card to begin playback.
3. **Now Playing:** Click the album artwork in the footer player bar to expand the full-screen Now Playing view.
4. **Curating & History:**
   * Use the **Thumbs Up** / **Thumbs Down** buttons to inform the algorithm of your preferences.
   * Review your recently played list on the right side of the Now Playing page. If you made a mistake, use the **Undo** button on any disliked track to remove the negative feedback.
5. **Themes & Settings:** Click the **Settings** gear in the sidebar to browse and apply different visual themes.
6. **Sign Out:** Hover over the left sidebar to expand it, and click the **Sign Out** button at the bottom to safely terminate your session.

## Known Issues

*   **Station Tuning Limitations:** The "Tune Your Station" feature is currently a work in progress. You may find that manual mode switching (e.g., Discovery, Artist Only) does not work. Some stations may default to "Artist Only" or "My Station" modes automatically.
*   **Search Functionality:** The search tab is currently a work in progress. Searching for a specific song may not actually play that specific track.

## Privacy and Security

Pandora Glass is designed with user privacy as a priority:
*   **Direct Authentication:** Your login credentials (email and password) are used solely to authenticate directly with Pandora's official API servers.
*   **No Data Storage:** This application does not store your password or personal account data on disk. Authentication tokens are maintained in-memory for the duration of your session and are wiped entirely when you sign out or close the application.
*   **No Third-Party Tracking:** No personal data is collected, transmitted, or shared with any third-party services. The application communicates only with Pandora's infrastructure to facilitate music playback and station management.

## License

This project is licensed under the MIT License. See the LICENSE file for details.

## Disclaimer

This application is an unofficial, third-party client created for personal, non-commercial use and educational purposes. It is not affiliated with, endorsed by, or sponsored by Pandora Media, LLC. No trademark infringement is intended. This project is provided for educational and research purposes only; users are advised that using third-party clients may violate the service's Terms of Service, and use of this software is entirely at the user's own risk.

> [!TIP]
> **Recommendation:** This application is best experienced with an active Pandora Plus or Premium subscription. Using a paid account ensures full compatibility with all playback features, provides the highest audio quality, and directly supports the artists on the platform.
