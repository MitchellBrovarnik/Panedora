# Discord Rich Presence

Panedora's shared Discord application is already configured in `discord-config.json`. Listeners can go straight to **Testing** below and enable the switch; they do not need a developer application or an environment variable. The maintainer setup is only needed when creating or replacing the shared application.

## One-time setup for the Panedora maintainer

1. Sign in at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Choose **New Application**, name it **Panedora**, and create it. The registered name is what Discord displays in **Listening to Panedora**.
3. Under **General Information**, copy the **Application ID**. It is public and safe to commit. Do not copy a client secret, bot token, or Discord account token.
4. In the repository root, set `discord-config.json` to:

   ```json
   {
       "applicationId": "YOUR_APPLICATION_ID"
   }
   ```

5. Restart Panedora. The build script includes this configuration in Windows, macOS, and Linux releases. Commit the real ID before publishing a release with Discord support. A blank/invalid ID leaves the switch disabled; no Discord connection is attempted.

There is no bot to invite, OAuth redirect to configure, or account-linking flow for this basic presence feature. One application ID is shared by all Panedora installations. You can optionally upload Panedora's icon as the application's icon. Album covers use the public image URLs supplied by Pandora, so there is no need to upload individual covers as Discord assets.

For a temporary local override, set `PANEDORA_DISCORD_CLIENT_ID` before starting the app. For example, in PowerShell:

```powershell
$env:PANEDORA_DISCORD_CLIENT_ID = "YOUR_APPLICATION_ID"
npm start
```

The environment override only affects that launch environment; use `discord-config.json` for released builds.

## Testing

1. Run the Discord **desktop** app on the same computer and sign in. The browser version alone is insufficient.
2. In Discord's **User Settings → Activity Privacy**, enable sharing your activity. Discord's own profile/server privacy settings still apply.
3. In Panedora, turn on **Settings → Discord → Share what I'm listening to** and play a station.
4. View your Discord profile (or have a friend check it): expect **Listening to Panedora**, the current title and artist, the album cover, and playback progress. The album name is included as artwork hover text; exact presentation varies with Discord's UI.
5. Try Skip, replay/seek, pause/resume, changing stations/modes, mini mode, and signing out. Pausing, buffering, stopping, disabling sharing, signing out, or closing the player clears the activity. Returning to playback publishes the current song and position. Mini mode keeps sharing while music plays.
6. Close Discord while music plays, then reopen it. Panedora retries quietly, starting at 30 seconds and backing off to at most five minutes. Toggling sharing off and on retries immediately. Music must continue unaffected.

Updates are coalesced to at most one song/timestamp write every five seconds. Rapid skips can therefore take a few seconds to settle on the latest song. The progress display uses timestamps, not a network request every second. Local audio reports refresh those timestamps only after a seek, replay, resume, or timing drift. A 45-second watchdog clears stale presence if playback reporting stops.

## Implementation and verification

`discord-rpc.js` implements the documented Discord IPC handshake, framing, ping/pong, and `SET_ACTIVITY` command with Node built-ins compatible with Panedora's Electron 28 runtime. It uses named pipes on Windows and Unix sockets on macOS/Linux (including the standard Flatpak Discord runtime path). Sandboxed packaging can still require access to Discord's socket.

`discord-presence.js` validates the current playback generation and track identity, takes publishable metadata from the main process, and handles reconnects, bounded updates, and clearing. It sends no Pandora credentials, session tokens, track tokens, or audio URLs to Discord. It never controls or waits on the audio player.

Automated tests cover a simulated Discord IPC server, current/stale playback reports, delayed acknowledgements, malformed/disconnected servers, settings, and real Electron audio events. They do not authenticate with Discord or Pandora. A live Discord profile/artwork test with the maintainer's Application ID is still required before declaring the integration verified end to end.

References: [Discord IPC/RPC](https://docs.discord.com/developers/topics/rpc), [Rich Presence without authentication](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence#rich-presence-without-authentication), and [external artwork URLs](https://docs.discord.com/developers/events/gateway-events#activity-object-activity-asset-image).
