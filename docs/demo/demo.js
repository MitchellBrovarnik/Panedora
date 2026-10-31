/* The desktop UI runs here with fictional stations and an in-memory player.
   There is no Pandora connection, audio element, AudioContext or microphone. */
(() => {
    'use strict';
    const preferences = new Map();
    Object.defineProperty(window, 'localStorage', { value: {
        getItem: key => preferences.get(String(key)) ?? null,
        setItem: (key, value) => preferences.set(String(key), String(value)),
        removeItem: key => preferences.delete(String(key)), clear: () => preferences.clear()
    } });
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let motion = !reducedMotion.matches;
    let visible = true;
    let clock = null;
    let previousTick = 0;
    let stationIndex = 0;
    let songIndex = 0;
    let volume = 65;
    let history = [];
    let playing = true;
    let generation = 0;
    let menuPinned = false;
    let modeId = 0;
    let shuffling = false;
    const ratings = new Map();
    const definitions = [
        ['night-drive', 'Night Drive Radio', 'Electronic · after dark', '#7b55d9', '#16234f', ['After Hours', 'City Lights', 'Last Train'], 'Northbound'],
        ['evening-mix', 'Evening Mix Radio', 'Indie · wind down', '#f49364', '#613b62', ['Last Light', 'Slow Motion', 'Window Seat'], 'Paper Skies'],
        ['focus', 'Focus Radio', 'Instrumental · settle in', '#58bca5', '#143e52', ['Quiet Current', 'Soft Focus', 'Small Hours'], 'Stillwater'],
        ['coastline', 'Coastline Radio', 'Alternative · open roads', '#4aafda', '#234785', ['Blue Horizon', 'Salt Air', 'Daybreak'], 'Coastline Club'],
        ['golden-hour', 'Golden Hour Radio', 'Soul · a little warmth', '#e4b45d', '#784249', ['Sunday Morning', 'Warm Front', 'Stay Awhile'], 'June Avenue'],
        ['deep-space', 'Deep Space Radio', 'Ambient · drift away', '#ad84ea', '#20243f', ['Orbit', 'Weightless', 'Far From Here'], 'Signal Garden']
    ];
    function cover(first, second, variant) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${first}"/><stop offset="1" stop-color="${second}"/></linearGradient><pattern id="p" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M0 24 24 0" stroke="white" stroke-opacity=".07"/></pattern></defs><rect width="480" height="480" rx="12" fill="url(#g)"/><rect width="480" height="480" fill="url(#p)"/><circle cx="${220 + variant * 8}" cy="220" r="145" fill="${second}" fill-opacity=".78"/><circle cx="${220 + variant * 8}" cy="220" r="106" fill="none" stroke="${first}" stroke-width="2"/><circle cx="${220 + variant * 8}" cy="220" r="60" fill="none" stroke="white" stroke-opacity=".35"/><circle cx="${220 + variant * 8}" cy="220" r="16" fill="${first}"/><path d="M0 385 Q120 ${300 + variant * 10} 240 385 T480 385 V480 H0Z" fill="white" fill-opacity=".1"/></svg>`;
        return 'data:image/svg+xml,' + encodeURIComponent(svg);
    }
    const stations = definitions.map((d, i) => ({ id: d[0], stationId: d[0], name: d[1], description: d[2], type: 'station',
        image: cover(d[3], d[4], i), lastUpdated: new Date(2026, 0, 7 - i).toISOString() }));
    const songs = definitions.flatMap((d, i) => d[5].map((title, n) => ({
        title, artist: d[6], album: d[1].replace(' Radio', ''), stationIndex: i, songIndex: n,
        id: d[0] + '-' + n, trackToken: d[0] + '-' + n, image: cover(d[3], d[4], i + n), duration: 192 + i * 7 + n * 16
    })));
    const modes = () => ({ status: 'ready', available: true, currentModeId: modeId, modes: [
        { id: 0, name: 'My Station', available: true }, { id: 2, name: 'Discovery', available: true }, { id: 3, name: 'Deep Cuts', available: true }
    ] });
    const currentSong = () => songs.find(song => song.stationIndex === stationIndex && song.songIndex === songIndex);
    function syncSampleProgress() {
        const { time, duration } = AppState.playerState;
        DOM.progressBar.setAttribute('aria-valuenow', String(Math.round(time / duration * 100)));
        DOM.progressBar.setAttribute('aria-valuetext', `${formatTime(time)} of ${formatTime(duration)} (sample)`);
    }
    function rememberSong() {
        const song = currentSong();
        history.unshift({ trackToken: song.id, songTitle: song.title, artistName: song.artist,
            coverArt: song.image, feedback: ratings.get(song.id) === 'thumbUp' ? 'liked' : ratings.get(song.id) === 'thumbDown' ? 'disliked' : null });
        history = history.slice(0, 8);
    }
    function publishSong(time = 0) {
        const song = currentSong(), station = stations[stationIndex];
        updatePlayerUI({ track: song.title, artist: song.artist, album: song.album, coverArt: song.image, coverArtSources: [],
            trackToken: song.id, playbackGeneration: ++generation, stationId: shuffling ? 'demo-shuffle' : station.id, stationName: shuffling ? 'Shuffle Stations' : station.name,
            stationModes: modes(), isShuffle: shuffling, stationLoading: false, streamBlocked: false,
            isPlaying: playing, feedback: ratings.get(song.id) || null, history: [...history],
            time, duration: song.duration, volume, upcomingArtwork: [], audioURL: null });
        if (AppState.currentTheme === 'adaptive') applyTheme('adaptive');
        if (AppState.currentPage === 'nowplaying') renderPage('nowplaying');
        if (isLyricsMode) void toggleLyricsLogic();
        syncSampleProgress();
        updateMotion();
    }
    function selectSong(song) {
        rememberSong(); shuffling = false; stationIndex = song.stationIndex; songIndex = song.songIndex; playing = true;
        publishSong();
    }
    function next(direction = 1) {
        rememberSong(); songIndex = (songIndex + direction + 3) % 3;
        if (shuffling && AppState.stations.length) {
            const remaining = AppState.stations.map(station => stations.findIndex(s => s.id === station.id));
            const index = remaining.indexOf(stationIndex);
            stationIndex = remaining[(index + direction + remaining.length) % remaining.length];
        }
        publishSong();
        return Promise.resolve({ success: true });
    }
    function rate(positive, token = currentSong().id) {
        ratings.set(token, positive ? 'thumbUp' : 'thumbDown');
        for (const item of history) if (item.trackToken === token) item.feedback = positive ? 'liked' : 'disliked';
        updatePlayerUI({ feedback: ratings.get(currentSong().id) || null, history: [...history] });
        return Promise.resolve({ success: true });
    }
    function search(query) {
        const q = String(query).trim().toLowerCase();
        AppState.searchResults = {
            songs: songs.filter(s => !q || [s.title, s.artist, s.album].some(t => t.toLowerCase().includes(q))),
            artists: [], stations: AppState.stations.filter(s => !q || s.name.toLowerCase().includes(q))
        };
        if (AppState.currentPage !== 'search') return Promise.resolve();
        renderSearchPage();
        const rows = document.querySelectorAll('#search-songs .track-row');
        rows.forEach((row, i) => {
            row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', 'Preview ' + AppState.searchResults.songs[i].title);
            // The renderer already binds each row to playItem with that song.
            row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } });
        });
        if (!AppState.searchResults.songs.length && !AppState.searchResults.stations.length) {
            DOM.pageContent.innerHTML = createEmptyState('No sample matches', 'Try “Night”, “Focus”, or “After Hours”.');
        }
        return Promise.resolve();
    }
    window.api = {
        platform: 'demo',
        content: {
            playItem: item => {
                const song = songs.find(s => s.id === item.trackToken || s.id === item.id);
                if (song) { selectSong(song); return Promise.resolve({ success: true }); }
                const index = stations.findIndex(s => s.id === item.id || s.id === item.stationId);
                if (index < 0) return Promise.resolve({ error: 'Sample station not found' });
                selectSong(songs.find(s => s.stationIndex === index && s.songIndex === 0));
                return Promise.resolve({ success: true });
            }, search,
            playShuffle: async () => {
                if (!AppState.stations.length) return { error: 'Reset the demo to restore the sample stations.' };
                shuffling = true; playing = true; return next();
            },
            removeStation: async id => {
                AppState.stations = AppState.stations.filter(s => s.id !== id);
                const scroll = document.getElementById('main-scroll');
                const position = scroll.scrollTop;
                renderStationsList();
                if (AppState.currentPage === 'home') updateHomeGrids();
                else if (AppState.currentPage === 'library') renderLibraryPage();
                else if (AppState.currentPage === 'search') search(DOM.searchInput.value);
                scroll.scrollTop = position;
                return true;
            },
            fetchLyrics: async () => ({ success: true, lyrics: '[00:00.00]A quiet moment, a different view\n[00:12.00]The evening finds a little room\n[00:24.00]A city painted in the light\n[00:36.00]We take the long way home tonight\n[00:48.00]These are sample lyrics for the demo\n[01:00.00]Let the colors move around you' })
        },
        player: {
            setVolume: async value => { volume = clampVolumePercent(value); return { success: true }; },
            play: async () => { playing = !playing; updatePlayerUI({ isPlaying: playing }); updateMotion(); },
            toggle: async () => { playing = !playing; updatePlayerUI({ isPlaying: playing }); updateMotion(); },
            pause: async () => { playing = false; updatePlayerUI({ isPlaying: false }); updateMotion(); },
            next: () => next(), prev: () => next(-1), thumbUp: token => rate(true, token), thumbDown: token => rate(false, token),
            undoFeedback: async token => {
                ratings.delete(token); for (const item of history) if (item.trackToken === token) item.feedback = null;
                updatePlayerUI({ feedback: ratings.get(currentSong().id) || null, history: [...history] }); return { success: true };
            },
            getStationModes: async () => modes(),
            setStationMode: async (_id, id) => { modeId = id; playing = true; await next(); return { success: true }; }
        },
        settings: { getVolume: async () => ({ volume }), saveVolume: async value => { volume = clampVolumePercent(value); return true; },
            getLegacyMiniplayer: async () => false, setLegacyMiniplayer: async () => false },
        auth: { logout: () => reset() }, window: { toggleMini: () => {}, minimize: () => {}, maximize: () => {}, close: () => {} }
    };

    // Feed the real visualizer synthetic frequency/time-domain data. Its drawing
    // routines are unchanged, and no sound device or browser audio API is opened.
    const visualizer = window.visualizer;
    visualizer.audioContext = { state: 'running', sampleRate: 44100 };
    const phase = () => performance.now() / 1000;
    const gaussian = (hz, center, width) => Math.exp(-0.5 * ((hz - center) / width) ** 2);
    function groove(t) {
        const beat = t * 112 / 60;
        const hit = (period, offset, decay) => Math.exp(-(((beat - offset) % period + period) % period) * (60 / 112) / decay);
        return { beat, kick: hit(1, 0, .1), bass: .45 + .55 * hit(.5, .25, .18), snare: hit(2, 1, .12), hat: hit(.5, .25, .045) };
    }
    function noise(bin, frame) {
        let value = Math.imul(bin + 1, 374761393) ^ Math.imul(frame, 668265263);
        value = Math.imul(value ^ (value >>> 13), 1274126177);
        return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
    }
    let spectrum = null, spectrumTime = null;
    function sampleSpectrum(length) {
        const t = phase();
        if (!spectrum || spectrum.length !== length) { spectrum = new Float32Array(length); spectrumTime = null; }
        if (t === spectrumTime) return spectrum;
        const dt = spectrumTime === null ? 0 : Math.min(.05, Math.max(0, t - spectrumTime));
        const { beat, kick, bass, snare, hat } = groove(t);
        const chord = [1, .89, 1.12, .94][Math.floor(beat / 8) % 4];
        const frame = Math.floor(t * 9), fraction = t * 9 - frame;
        const blend = fraction * fraction * (3 - 2 * fraction);
        for (let i = 0; i < length; i++) {
            const hz = i * visualizer.audioContext.sampleRate / visualizer.analyser.fftSize;
            // Stationary frequency bands with independent fluctuations, rather
            // than a phase that travels sideways through every bar.
            const texture = .7 + .6 * (noise(i, frame) * (1 - blend) + noise(i, frame + 1) * blend);
            const voices = gaussian(hz, 430 * chord, 140) + .8 * gaussian(hz, 1160 * chord, 260) + .65 * gaussian(hz, 2600 * chord, 500);
            const body = (.12 + .12 * Math.exp(-hz / 8000) + .17 * voices) * texture;
            const activity = body + .58 * kick * gaussian(hz, 95, 190) + .22 * bass * gaussian(hz, 220, 220)
                + .4 * snare * gaussian(hz, 1800, 1500) * texture + .28 * hat * gaussian(hz, 6500, 2400) * texture;
            const target = Math.max(.03, Math.min(.95, activity));
            // Quick attacks and slower releases keep the percussion punchy
            // without making the bars jitter or move in lockstep.
            const follow = 1 - Math.exp(-dt / (target > spectrum[i] ? .025 : .16));
            spectrum[i] = spectrumTime === null ? target : spectrum[i] + (target - spectrum[i]) * follow;
        }
        spectrumTime = t;
        return spectrum;
    }
    visualizer.analyser = {
        fftSize: 256, minDecibels: -100, maxDecibels: -20,
        get frequencyBinCount() { return this.fftSize / 2; },
        getFloatFrequencyData(array) {
            const levels = sampleSpectrum(array.length);
            for (let i = 0; i < array.length; i++) array[i] = this.minDecibels + levels[i] * (this.maxDecibels - this.minDecibels);
        },
        getByteFrequencyData(array) {
            const levels = sampleSpectrum(array.length);
            for (let i = 0; i < array.length; i++) array[i] = Math.round(levels[i] * 255);
        },
        getByteTimeDomainData(array) {
            const t = phase(), { kick, bass, snare, hat } = groove(t);
            for (let i = 0; i < array.length; i++) {
                const sample = t + i / visualizer.audioContext.sampleRate;
                const low = (12 + 32 * kick + 10 * bass) * Math.sin(2 * Math.PI * 82 * sample);
                const voice = 14 * Math.sin(2 * Math.PI * 330 * sample) + 9 * Math.sin(2 * Math.PI * 495 * sample);
                const percussion = (18 * snare + 9 * hat) * (2 * noise(i, Math.floor(t * 60)) - 1);
                array[i] = Math.max(0, Math.min(255, Math.round(128 + low + voice + percussion)));
            }
        }
    };
    visualizer.init = () => {};
    const applyEffect = applyBgEffect;
    applyBgEffect = id => { applyEffect(id); updateMotion(); };
    const nativePage = renderPage;
    const nativeLibrary = renderLibraryPage;
    renderLibraryPage = () => { nativeLibrary(); enhanceCards(); };
    const nativeSettings = renderSettingsPage;
    renderSettingsPage = () => {
        const scroll = document.getElementById('main-scroll').scrollTop;
        const focused = document.activeElement?.dataset;
        const restore = focused?.theme ? ['theme', focused.theme] : focused?.effect ? ['effect', focused.effect] : null;
        nativeSettings();
        document.querySelectorAll('.settings-section').forEach(section => {
            if (section.querySelector('#legacy-miniplayer-toggle, #discord-sharing-toggle')) section.hidden = true;
        });
        document.querySelectorAll('[data-theme], [data-effect]').forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('active'))));
        const effects = document.querySelector('[data-effect]')?.closest('section');
        if (effects) effects.querySelector('.settings-description').textContent = 'Try animated backgrounds. Reactive previews use a simulated signal; the demo has no audio.';
        document.getElementById('main-scroll').scrollTop = scroll;
        if (restore) document.querySelector(`[data-${restore[0]}="${restore[1]}"]`)?.focus({ preventScroll: true });
    };
    renderPage = page => {
        if (page === 'search' && !AppState.searchResults) AppState.searchResults = { songs, artists: [], stations: AppState.stations };
        nativePage(page);
        if (page === 'search') search(DOM.searchInput.value);
        enhanceCards();
        const sidebar = document.querySelector('.sidebar');
        menuPinned = false; sidebar.classList.remove('demo-nav-open');
        if (sidebar.matches(':hover') && !document.activeElement?.matches(':focus-visible')) sidebar.classList.add('demo-nav-dismissed');
        updateMenuLabel();
    };
    seekToFraction = fraction => { updatePlayerUI({ time: Math.max(0, Math.min(1, fraction)) * currentSong().duration }); syncSampleProgress(); return true; };
    function enhanceCards() {
        document.querySelectorAll('.card').forEach(card => {
            card.tabIndex = 0; card.setAttribute('role', 'button');
            card.setAttribute('aria-label', 'Preview ' + (card.querySelector('.card-title')?.textContent || 'station'));
        });
        document.querySelectorAll('.nav-item').forEach(link => link.setAttribute('aria-label', link.textContent.trim()));
        if (AppState.currentPage === 'search') DOM.searchInput.placeholder = 'Search sample songs and stations';
    }
    function updateMotion() {
        const run = motion && visible && !document.hidden;
        document.body.classList.toggle('demo-motion-paused', !run);
        const button = document.getElementById('demo-motion');
        button.textContent = motion ? 'Pause motion' : 'Play motion'; button.setAttribute('aria-pressed', String(!motion));
        const canvas = document.getElementById('reactive-canvas');
        if (canvas && run && playing) {
            if (!visualizer.isVisualizing || visualizer.canvas !== canvas) visualizer.start(canvas, AppState.currentEffect.replace('reactive-', ''));
        } else visualizer.stop();
        if (clock) { clearInterval(clock); clock = null; }
        previousTick = performance.now();
        if (run && playing) clock = setInterval(() => {
            const now = performance.now(), elapsed = Math.min((now - previousTick) / 1000, 1); previousTick = now;
            const time = AppState.playerState.time + elapsed;
            if (time >= currentSong().duration) void next();
            else { updatePlayerUI({ time, duration: currentSong().duration }); syncSampleProgress(); if (isLyricsMode) syncLyrics(time); }
        }, 250);
    }
    function updateMenuLabel() {
        const button = document.getElementById('demo-menu');
        button.setAttribute('aria-expanded', String(menuPinned));
        button.setAttribute('aria-label', menuPinned ? 'Collapse navigation' : 'Expand navigation');
    }
    function reset() {
        preferences.clear(); ratings.clear(); history = []; stationIndex = 0; songIndex = 0; modeId = 0; shuffling = false; playing = true; volume = 65;
        motion = !reducedMotion.matches; AppState.stations = stations.map(s => ({ ...s })); AppState.libraryFilter = ''; AppState.searchResults = null; DOM.searchInput.value = '';
        applyTheme('midnight'); applyBgEffect('waves'); applyLyricsStyle('glow'); applyEffectSpeed(1); applyVolume(volume);
        renderStationsList(); renderPage('home'); publishSong(44);
    }
    AppState.isLoggedIn = true; AppState.isLoading = false;
    initEventListeners();
    document.getElementById('demo-motion').addEventListener('click', () => { motion = !motion; updateMotion(); });
    document.getElementById('demo-reset').addEventListener('click', reset);
    document.getElementById('demo-menu').addEventListener('click', () => {
        menuPinned = !menuPinned; document.querySelector('.sidebar').classList.remove('demo-nav-dismissed');
        document.querySelector('.sidebar').classList.toggle('demo-nav-open', menuPinned); updateMenuLabel();
    });
    document.querySelector('.sidebar').addEventListener('mouseleave', () => document.querySelector('.sidebar').classList.remove('demo-nav-dismissed'));
    document.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card')) { e.preventDefault(); e.target.click(); }
        if (e.key === 'Escape') { menuPinned = false; document.querySelector('.sidebar').classList.remove('demo-nav-open'); updateMenuLabel(); }
    });
    document.addEventListener('visibilitychange', updateMotion);
    window.addEventListener('message', e => {
        const originMatches = e.origin === location.origin || (location.protocol === 'file:' && ['null', 'file://'].includes(e.origin));
        if (e.source !== parent || !originMatches || e.data?.type !== 'panedora-demo-visibility' || typeof e.data.visible !== 'boolean') return;
        visible = e.data.visible; updateMotion();
    });
    reducedMotion.addEventListener('change', e => { motion = !e.matches; updateMotion(); });
    window.addEventListener('pagehide', () => { visible = false; updateMotion(); });
    reset();
    parent.postMessage({ type: 'panedora-demo-ready' }, location.protocol === 'file:' ? '*' : location.origin);
})();
