/**
 * Pandora Glass - Audio Player
 * HTML5 Audio wrapper for playback management
 */

const { EventEmitter } = require('events');

class AudioPlayer extends EventEmitter {
    constructor() {
        super();
        this.audio = null;
        this.playlist = [];
        this.currentTrackIndex = 0;
        this.currentTrack = null;
        this.cachedCoverArt = null;
        this.cachedArtistArt = null;
        this.stationId = null;
        this.isPlaying = false;
        this.volume = 1.0;

        // State update interval
        this.stateInterval = null;
    }

    /**
     * Initialize audio element (call from renderer context)
     */
    initAudio() {
        if (typeof Audio === 'undefined') {
            console.log('[AudioPlayer] Running in main process - no Audio API');
            return;
        }

        this.audio = new Audio();

        this.audio.addEventListener('ended', () => this.next());
        this.audio.addEventListener('error', (e) => {
            console.error('[AudioPlayer] Audio error:', e);
            this.emit('error', e);
            // Try next track on error
            setTimeout(() => this.next(), 1000);
        });
        this.audio.addEventListener('playing', () => {
            this.isPlaying = true;
            this.emit('stateChange', this.getState());
        });
        this.audio.addEventListener('pause', () => {
            this.isPlaying = false;
            this.emit('stateChange', this.getState());
        });
        this.audio.addEventListener('loadedmetadata', () => {
            this.emit('stateChange', this.getState());
        });

        // Emit state updates periodically while playing
        this.stateInterval = setInterval(() => {
            if (this.isPlaying) {
                this.emit('stateChange', this.getState());
            }
        }, 500);
    }

    /**
     * Load a playlist of tracks from API response
     */
    loadPlaylist(tracks, stationId) {
        this.playlist = tracks.filter(t => t.audioURL); // Only tracks with audio
        this.stationId = stationId;
        this.currentTrackIndex = 0;

        if (this.playlist.length > 0) {
            this.loadTrack(0);
        }

        console.log(`[AudioPlayer] Loaded ${this.playlist.length} tracks`);
    }

    /**
     * Load a specific track by index
     */
    loadTrack(index) {
        if (index < 0 || index >= this.playlist.length) {
            console.log('[AudioPlayer] No more tracks, need to fetch more');
            this.emit('needMoreTracks');
            return false;
        }

        this.currentTrackIndex = index;
        this.currentTrack = this.playlist[index];

        // Cache high-res art URLs to avoid repeated sorting in getState loop
        this.cachedCoverArt = this.getHighResArt(this.currentTrack?.albumArt);
        this.cachedArtistArt = this.getHighResArt(this.currentTrack?.artistArt);

        if (this.audio) {
            this.audio.src = this.currentTrack.audioURL;
            this.audio.volume = this.volume;
        }

        console.log(`[AudioPlayer] Loaded: ${this.currentTrack.songTitle} - ${this.currentTrack.artistName}`);
        this.emit('trackChange', this.currentTrack);
        this.emit('stateChange', this.getState());

        return true;
    }

    /**
     * Play current track
     */
    async play() {
        if (!this.audio || !this.currentTrack) return;

        try {
            await this.audio.play();
            this.isPlaying = true;
        } catch (e) {
            console.error('[AudioPlayer] Play failed:', e);
        }
    }

    /**
     * Pause playback
     */
    pause() {
        if (!this.audio) return;
        this.audio.pause();
        this.isPlaying = false;
    }

    /**
     * Toggle play/pause
     */
    toggle() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    /**
     * Skip to next track
     */
    next() {
        const loaded = this.loadTrack(this.currentTrackIndex + 1);
        if (loaded && this.isPlaying) {
            this.play();
        }
    }

    /**
     * Go to previous track (replay current)
     */
    prev() {
        // On Pandora, "previous" means replay current track
        if (this.audio) {
            this.audio.currentTime = 0;
            this.play();
        }
    }

    /**
     * Seek to position in seconds
     */
    seek(seconds) {
        if (this.audio && !isNaN(seconds)) {
            this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration || 0));
        }
    }

    /**
     * Set volume (0-100)
     */
    setVolume(value) {
        this.volume = Math.max(0, Math.min(1, value / 100));
        if (this.audio) {
            this.audio.volume = this.volume;
        }
    }

    /**
     * Get current player state
     */
    getState() {
        const track = this.currentTrack;

        return {
            track: track?.songTitle || null,
            artist: track?.artistName || null,
            album: track?.albumTitle || null,
            stationName: null, // Will be set by main process
            stationId: this.stationId,
            coverArt: this.cachedCoverArt,
            artistArt: this.cachedArtistArt,
            time: this.audio?.currentTime || 0,
            duration: track?.trackLength || this.audio?.duration || 0,
            isPlaying: this.isPlaying,
            volume: Math.round(this.volume * 100),
            trackToken: track?.trackToken || null,
            trackIndex: this.currentTrackIndex,
            playlistLength: this.playlist.length
        };
    }

    /**
     * Get current track for API calls
     */
    getCurrentTrack() {
        return this.currentTrack;
    }

    /**
     * Get highest res art from array
     */
    getHighResArt(artArray) {
        if (!artArray || !Array.isArray(artArray) || artArray.length === 0) {
            return null;
        }

        // Find largest artwork in O(N) instead of O(N log N) sorting
        let best = artArray[0];
        for (let i = 1; i < artArray.length; i++) {
            if ((artArray[i].size || 0) > (best.size || 0)) {
                best = artArray[i];
            }
        }
        return best?.url || null;
    }

    /**
     * Add more tracks to playlist (from API fetch)
     */
    appendTracks(tracks) {
        const newTracks = tracks.filter(t => t.audioURL);
        this.playlist.push(...newTracks);
        console.log(`[AudioPlayer] Appended ${newTracks.length} tracks, total: ${this.playlist.length}`);
    }

    /**
     * Cleanup
     */
    destroy() {
        if (this.stateInterval) {
            clearInterval(this.stateInterval);
        }
        if (this.audio) {
            this.audio.pause();
            this.audio.src = '';
        }
    }
}

module.exports = AudioPlayer;
