/**
 * Panedora - Frontend Controller (Renderer)
 * Handles UI state, routing, and user interactions
 */

// ============================================================================
// Rate Limiting — prevents spamming Pandora's API with rapid button clicks
// ============================================================================

const COOLDOWN_MS = 1500;
const _cooldowns = {};

/**
 * Returns true if the action is allowed (not on cooldown).
 * Starts the cooldown timer on first allowed call.
 */
function rateLimitOk(action) {
    const now = Date.now();
    if (_cooldowns[action] && now - _cooldowns[action] < COOLDOWN_MS) {
        return false;
    }
    _cooldowns[action] = now;
    return true;
}

// ============================================================================
// Application State
// ============================================================================

const AppState = {
    currentPage: 'home',
    playerState: {
        track: null,
        artist: null,
        album: null,
        time: 0,
        duration: 0,
        isPlaying: false,
        volume: 100,
        coverArt: null,
        shuffle: false,
        repeat: false
    },
    stations: [],
    searchResults: null,
    searchQuery: '',
    isLoading: true,
    isLoggedIn: false,
    effectSpeed: 1
};

// ============================================================================
// DOM References
// ============================================================================

const DOM = {
    pageContent: document.getElementById('page-content'),
    stationsList: document.getElementById('stations-list'),
    searchContainer: document.getElementById('search-container'),
    searchInput: document.getElementById('search-input'),
    nowPlayingArt: document.getElementById('now-playing-art'),
    nowPlayingTitle: document.getElementById('now-playing-title'),
    nowPlayingArtist: document.getElementById('now-playing-artist'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    playIcon: document.getElementById('play-icon'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    heartBtn: document.getElementById('heart-btn'),
    progressBar: document.getElementById('progress-bar'),
    progressFill: document.getElementById('progress-fill'),
    currentTime: document.getElementById('current-time'),
    totalTime: document.getElementById('total-time'),
    volumeSlider: document.getElementById('volume-slider'),
    volumeBtn: document.getElementById('volume-btn'),
    navItems: document.querySelectorAll('.nav-item')
};

// ============================================================================
// View Router
// ============================================================================

function renderPage(page) {
    AppState.currentPage = page;

    // Update nav highlighting
    DOM.navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });

    // Reset scroll position to top when navigating to a new view
    const mainScroll = document.getElementById('main-scroll');
    if (mainScroll) mainScroll.scrollTop = 0;

    // Show/hide search bar
    DOM.searchContainer.style.display = page === 'search' ? 'block' : 'none';

    // Hide lyrics when leaving Now Playing page
    if (page !== 'nowplaying') {
        isLyricsMode = false;
        const lyricsBtn = document.getElementById('lyrics-btn');
        const lyricsOverlay = document.getElementById('lyrics-overlay');
        if (lyricsBtn) lyricsBtn.classList.remove('active');
        if (lyricsOverlay) lyricsOverlay.classList.remove('visible');
    }

    // Hide footer thumbs when on Now Playing (they appear there instead)
    const miniThumbs = document.getElementById('mini-thumbs');
    if (miniThumbs) {
        miniThumbs.style.display = page === 'nowplaying' ? 'none' : '';
    }

    switch (page) {
        case 'home':
            renderHomePage();
            break;
        case 'search':
            renderSearchPage();
            break;
        case 'library':
            renderLibraryPage();
            break;
        case 'nowplaying':
            renderNowPlayingPage();
            break;
        case 'settings':
            renderSettingsPage();
            break;
        default:
            renderHomePage();
    }
}

function renderHomePage() {
    if (AppState.isLoading) {
        DOM.pageContent.innerHTML = `
      <div class="welcome-container">
        <h1 class="welcome-title">Welcome to Panedora</h1>
        <p class="welcome-subtitle">Connecting to Pandora...</p>
        <div class="loading-spinner"></div>
      </div>`;
        return;
    }

    if (!AppState.isLoggedIn) {
        DOM.pageContent.innerHTML = `
      <div class="welcome-container">
        <h1 class="welcome-title">Sign in to Pandora</h1>
        <p class="welcome-subtitle">Enter your Pandora credentials to continue.</p>
        <form id="login-form" style="display: flex; flex-direction: column; gap: 12px; max-width: 320px; margin: 24px auto 0;">
            <label for="login-email" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);">Email</label>
            <input type="email" id="login-email" placeholder="Email" required
                style="padding: 10px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.06); color: #fff; font-size: 14px; outline: none;">
            <label for="login-password" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);">Password</label>
            <input type="password" id="login-password" placeholder="Password" required
                style="padding: 10px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.06); color: #fff; font-size: 14px; outline: none;">
            <button type="submit" id="login-submit-btn"
                style="padding: 10px 14px; border-radius: 8px; border: none; background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.2s;">
                Sign In
            </button>
            <p id="login-error" style="color: #ef4444; font-size: 13px; text-align: center; display: none;"></p>
        </form>
      </div>`;

        // Attach login form handler
        const loginForm = document.getElementById('login-form');
        if (loginForm) {
            loginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = document.getElementById('login-email').value;
                const password = document.getElementById('login-password').value;
                const submitBtn = document.getElementById('login-submit-btn');
                const errorEl = document.getElementById('login-error');

                submitBtn.textContent = 'Signing in...';
                submitBtn.disabled = true;
                errorEl.style.display = 'none';

                try {
                    const result = await window.api.auth.login(email, password);
                    if (result && result.success) {
                        console.log('[UI] Login successful!');
                    } else {
                        errorEl.textContent = (result && result.error) || 'Incorrect email or password.';
                        errorEl.style.display = 'block';
                        submitBtn.textContent = 'Sign In';
                        submitBtn.disabled = false;
                        document.getElementById('login-password').value = '';
                    }
                } catch (err) {
                    console.error('[UI] Login error:', err);
                    errorEl.textContent = 'Connection error. Please try again.';
                    errorEl.style.display = 'block';
                    submitBtn.textContent = 'Sign In';
                    submitBtn.disabled = false;
                    document.getElementById('login-password').value = '';
                }
            });
        }
        return;
    }

    // Dynamic greeting based on time of day
    const hour = new Date().getHours();
    let greeting = 'Good Evening';
    if (hour < 12) greeting = 'Good Morning';
    else if (hour < 18) greeting = 'Good Afternoon';

    DOM.pageContent.innerHTML = `
    <div class="fade-in">
      <h1 class="home-greeting">${greeting}</h1>

      <section>
        <h2 class="section-title">Jump Back In</h2>
        <div class="card-grid" id="home-recent">
        </div>
      </section>

      <section id="home-more-section" style="margin-top: 32px; display: none;">
        <h2 class="section-title">More from Your Collection</h2>
        <div class="card-grid" id="home-more">
        </div>
      </section>
    </div>`;

    updateHomeGrids();
}

function updateHomeGrids() {
    const recentContainer = document.getElementById('home-recent');
    const moreContainer = document.getElementById('home-more');
    const moreSection = document.getElementById('home-more-section');
    if (!recentContainer) return;

    // Sort stations by lastUpdated for "Jump Back In"
    const recentStations = [...AppState.stations]
        .sort((a, b) => new Date(b.lastUpdated || 0) - new Date(a.lastUpdated || 0))
        .slice(0, 6);

    // A second batch for "More from Your Collection"
    const moreStations = [...AppState.stations]
        .sort((a, b) => new Date(b.lastUpdated || 0) - new Date(a.lastUpdated || 0))
        .slice(6, 12);

    // Helper to update a container's children without destroying elements that just moved
    function updateGridNodes(container, stationsArray) {
        if (!container) return;

        // Convert to map for easy lookup
        const existingCards = Array.from(container.querySelectorAll('.card'));
        const cardMap = {};
        existingCards.forEach(card => cardMap[card.dataset.id] = card);

        // Build new arrangement
        const newFragment = document.createDocumentFragment();
        let hasChanges = existingCards.length !== stationsArray.length;

        stationsArray.forEach((station, index) => {
            const dataId = station.id || station.stationId;
            let card = cardMap[dataId];

            if (card) {
                // Card exists, check if it moved
                if (existingCards[index] !== card) {
                    hasChanges = true;
                }
                newFragment.appendChild(card);
            } else {
                // Completely new card
                const temp = document.createElement('div');
                temp.innerHTML = createCard(station.image || null, station.name, station.type === 'playlist' ? 'Playlist' : 'Station', dataId);
                const newCard = temp.firstElementChild;
                newCard.addEventListener('click', () => playStation(station));
                newFragment.appendChild(newCard);
                hasChanges = true;
            }
        });

        // Only touch the DOM if something actually changed order or items
        if (hasChanges) {
            container.innerHTML = '';
            container.appendChild(newFragment);
        }
    }

    // Fallback if empty
    if (recentStations.length === 0) {
        recentContainer.innerHTML = createEmptyState('No stations found', 'Your Pandora stations will appear here');
    } else {
        updateGridNodes(recentContainer, recentStations);
    }

    if (moreContainer && moreSection) {
        if (moreStations.length > 0) {
            updateGridNodes(moreContainer, moreStations);
            moreSection.style.display = 'block';
        } else {
            moreContainer.innerHTML = '';
            moreSection.style.display = 'none';
        }
    }
}

function renderSearchPage() {
    if (!AppState.searchResults) {
        DOM.pageContent.innerHTML = `
      <div class="empty-state fade-in">
        <h3>Search Pandora</h3>
        <p>Find your favorite songs, artists, and stations</p>
      </div>`;
        return;
    }

    const { songs, artists, stations } = AppState.searchResults;
    let html = '<div class="fade-in">';

    // Songs section
    if (songs && songs.length > 0) {
        let tracksHtml = '';
        songs.forEach((song, index) => {
            tracksHtml += createTrackRow(
                index + 1,
                song.title,
                song.artist,
                '--:--',
                song.coverArt
            );
        });
        html += `
      <section class="search-section">
        <h2 class="section-title">Songs</h2>
        <div class="track-list" id="search-songs">${tracksHtml}</div>
      </section>`;
    }

    // Artists section
    if (artists && artists.length > 0) {
        let artistCards = '';
        artists.forEach(artist => {
            artistCards += createCard(artist.image, artist.name, 'Artist');
        });
        html += `
      <section class="search-section">
        <h2 class="section-title">Artists</h2>
        <div class="card-grid" id="search-artists">${artistCards}</div>
      </section>`;
    }

    // Stations section
    if (stations && stations.length > 0) {
        let stationCards = '';
        stations.forEach(station => {
            stationCards += createCard(station.image, station.name, 'Station');
        });
        html += `
      <section class="search-section">
        <h2 class="section-title">Stations</h2>
        <div class="card-grid" id="search-stations">${stationCards}</div>
      </section>`;
    }

    if (!songs?.length && !artists?.length && !stations?.length) {
        html += createEmptyState('No results found', `No results for "${AppState.searchQuery}"`);
    }

    html += '</div>';
    DOM.pageContent.innerHTML = html;

    // Attach click handlers — Songs
    document.querySelectorAll('#search-songs .track-row').forEach((row, index) => {
        row.addEventListener('click', () => {
            if (songs[index]) {
                window.api.content.playItem(songs[index]);
            }
        });
    });

    // Attach click handlers — Artists
    document.querySelectorAll('#search-artists .card').forEach((card, index) => {
        card.addEventListener('click', () => {
            if (artists[index]) {
                window.api.content.playItem(artists[index]);
            }
        });
    });

    // Attach click handlers — Stations
    document.querySelectorAll('#search-stations .card').forEach((card, index) => {
        card.addEventListener('click', () => {
            if (stations[index]) {
                const s = stations[index];

                // Use playItem with the best available ID for station creation
                const stationSeed = s.stationId || s.stationFactoryPandoraId || s.pandoraId || s.id;
                window.api.content.playItem({ ...s, type: 'station', id: stationSeed });
            }
        });
    });
}

function renderLibraryPage() {
    const filterQuery = AppState.libraryFilter || '';

    // Sort alphabetically for the full collection
    const sortedStations = [...AppState.stations]
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Apply filter
    const filtered = filterQuery
        ? sortedStations.filter(s => s.name.toLowerCase().includes(filterQuery.toLowerCase()))
        : sortedStations;

    let cardsHtml = '';
    filtered.forEach(station => {
        cardsHtml += createCard(
            station.image,
            station.name,
            station.type === 'playlist' ? 'Playlist' : 'Station'
        );
    });

    const countLabel = filterQuery
        ? `${filtered.length} of ${AppState.stations.length} stations`
        : `${AppState.stations.length} Stations`;

    DOM.pageContent.innerHTML = `
    <div class="fade-in">
      <div class="library-header">
        <h2 class="section-title">Your Collection</h2>
        <span class="library-count">${countLabel}</span>
      </div>
      <div class="library-filter-container">
        <svg class="library-filter-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
        </svg>
        <input type="text" class="library-filter-input" id="library-filter"
          placeholder="Filter your stations..." value="${escapeHtml(filterQuery)}">
      </div>
      <div class="card-grid" id="library-cards">
        ${cardsHtml || createEmptyState('No matches', `No stations matching "${filterQuery}"`)}
      </div>
    </div>`;

    // Attach filter handler
    const filterInput = document.getElementById('library-filter');
    if (filterInput) {
        filterInput.addEventListener('input', debounce((e) => {
            AppState.libraryFilter = e.target.value;
            renderLibraryPage();
            // Re-focus input and restore cursor position
            const el = document.getElementById('library-filter');
            if (el) {
                el.focus();
                el.selectionStart = el.selectionEnd = el.value.length;
            }
        }, 150));
    }

    // Attach click handlers
    document.querySelectorAll('#library-cards .card').forEach((card, index) => {
        card.addEventListener('click', () => {
            if (filtered[index]) {
                playStation(filtered[index]);
            }
        });
    });
}

// ============================================================================
// Theme System
// ============================================================================

const THEMES = {
    midnight: {
        name: 'Midnight Violet',
        preview: ['#1a0a2e', '#0d1b3e', '#7c5bf5'],
        vars: {
            '--bg-base': '#080810',
            '--grad-1': '#1a0a2e',
            '--grad-2': '#0d1b3e',
            '--grad-3': '#1e0a3a',
            '--accent': '#7c5bf5',
            '--accent-glow': 'rgba(124, 91, 245, 0.3)',
            '--accent-grad': 'linear-gradient(135deg, #6366f1, #a855f7)',
            '--accent-soft': 'rgba(124, 91, 245, 0.12)',
            '--glass': 'rgba(255, 255, 255, 0.045)'
        }
    },
    ocean: {
        name: 'Deep Ocean',
        preview: ['#0a1628', '#0c2340', '#3b82f6'],
        vars: {
            '--bg-base': '#060d1a',
            '--grad-1': '#0a1628',
            '--grad-2': '#0c2340',
            '--grad-3': '#0a1e38',
            '--accent': '#3b82f6',
            '--accent-glow': 'rgba(59, 130, 246, 0.3)',
            '--accent-grad': 'linear-gradient(135deg, #2563eb, #06b6d4)',
            '--accent-soft': 'rgba(59, 130, 246, 0.12)',
            '--glass': 'rgba(255, 255, 255, 0.06)'
        }
    },
    emerald: {
        name: 'Emerald Forest',
        preview: ['#0a1e14', '#0d2818', '#10b981'],
        vars: {
            '--bg-base': '#060f0a',
            '--grad-1': '#0a1e14',
            '--grad-2': '#0d2818',
            '--grad-3': '#0a2416',
            '--accent': '#10b981',
            '--accent-glow': 'rgba(16, 185, 129, 0.3)',
            '--accent-grad': 'linear-gradient(135deg, #059669, #34d399)',
            '--accent-soft': 'rgba(16, 185, 129, 0.12)',
            '--glass': 'rgba(255, 255, 255, 0.05)'
        }
    },
    sunset: {
        name: 'Sunset Blaze',
        preview: ['#2a0a0a', '#3d1a0a', '#f97316'],
        vars: {
            '--bg-base': '#120606',
            '--grad-1': '#2a0a0a',
            '--grad-2': '#3d1a0a',
            '--grad-3': '#2e0e08',
            '--accent': '#f97316',
            '--accent-glow': 'rgba(249, 115, 22, 0.3)',
            '--accent-grad': 'linear-gradient(135deg, #ea580c, #fbbf24)',
            '--accent-soft': 'rgba(249, 115, 22, 0.12)',
            '--glass': 'rgba(255, 255, 255, 0.06)'
        }
    },
    rose: {
        name: 'Rose Quartz',
        preview: ['#2a0a1e', '#3d0a28', '#ec4899'],
        vars: {
            '--bg-base': '#120610',
            '--grad-1': '#2a0a1e',
            '--grad-2': '#3d0a28',
            '--grad-3': '#2e0820',
            '--accent': '#ec4899',
            '--accent-glow': 'rgba(236, 72, 153, 0.3)',
            '--accent-grad': 'linear-gradient(135deg, #db2777, #f472b6)',
            '--accent-soft': 'rgba(236, 72, 153, 0.12)',
            '--glass': 'rgba(255, 255, 255, 0.055)'
        }
    },
    arctic: {
        name: 'Arctic Frost',
        preview: ['#0a1420', '#0e1c2e', '#67e8f9'],
        vars: {
            '--bg-base': '#060c14',
            '--grad-1': '#0a1420',
            '--grad-2': '#0e1c2e',
            '--grad-3': '#0c1826',
            '--accent': '#67e8f9',
            '--accent-glow': 'rgba(103, 232, 249, 0.3)',
            '--accent-grad': 'linear-gradient(135deg, #06b6d4, #a5f3fc)',
            '--accent-soft': 'rgba(103, 232, 249, 0.12)',
            '--glass': 'rgba(255, 255, 255, 0.08)'
        }
    },
    neon: {
        name: 'Neon Cyber',
        preview: ['#0a0a1a', '#1a0a2e', '#22d3ee'],
        vars: {
            '--bg-base': '#050510',
            '--grad-1': '#0a0a1a',
            '--grad-2': '#1a0a2e',
            '--grad-3': '#0a0a20',
            '--accent': '#22d3ee',
            '--accent-glow': 'rgba(34, 211, 238, 0.3)',
            '--accent-grad': 'linear-gradient(135deg, #8b5cf6, #22d3ee)',
            '--accent-soft': 'rgba(34, 211, 238, 0.12)',
            '--glass': 'rgba(255, 255, 255, 0.08)'
        }
    },
    classic: {
        name: 'Classic Dark',
        preview: ['#121212', '#1a1a1a', '#1db954'],
        vars: {
            '--bg-base': '#0a0a0a',
            '--grad-1': '#121212',
            '--grad-2': '#1a1a1a',
            '--grad-3': '#161616',
            '--accent': '#1db954',
            '--accent-glow': 'rgba(29, 185, 84, 0.3)',
            '--accent-grad': 'linear-gradient(135deg, #1db954, #1ed760)',
            '--accent-soft': 'rgba(29, 185, 84, 0.12)',
            '--glass': 'rgba(255, 255, 255, 0.07)'
        }
    },
    adaptive: {
        name: 'Adaptive (Dynamic)',
        preview: ['#1e1e24', 'linear-gradient(to right, #ff0000, #00ff00, #0000ff)', '#ffffff'],
        vars: {
            // These are defaults; they will be overwritten dynamically when a song plays
            '--bg-base': '#0a0a0a',
            '--grad-1': '#121212',
            '--grad-2': '#1a1a1a',
            '--grad-3': '#161616',
            '--accent': '#7c5bf5',
            '--accent-glow': 'rgba(124, 91, 245, 0.4)',
            '--accent-grad': 'linear-gradient(135deg, #7c5bf5, #000000)',
            '--accent-soft': 'rgba(124, 91, 245, 0.12)',
            '--glass': 'rgba(255, 255, 255, 0.07)'
        }
    }
};

const BG_EFFECTS = {
    waves: { name: 'Waves', desc: 'Flowing neon lines' },
    orbs: { name: 'Orbs', desc: 'Floating glowing spheres' },
    space: { name: 'Space', desc: 'Parallax starfield' },
    grid: { name: 'Grid', desc: 'Synthwave 3D floor' },
    particles: { name: 'Particles', desc: 'Falling digital snow' },
    rings: { name: 'Rings', desc: 'Pulsing concentric circles' },
    'reactive-bars': { name: 'Reactive (Bars)', desc: 'Frequency visualizer' },
    'reactive-circle': { name: 'Reactive (Circle)', desc: 'Pulsing equalizer ring' },
    'reactive-wave': { name: 'Reactive (Wave)', desc: 'Oscilloscope waveform' },
    static: { name: 'Static', desc: 'Clean gradient only' }
};

function applyTheme(themeId) {
    const theme = THEMES[themeId];
    if (!theme) return;

    const root = document.documentElement;
    Object.entries(theme.vars).forEach(([prop, value]) => {
        root.style.setProperty(prop, value);
    });

    localStorage.setItem('panedora-theme', themeId);
    AppState.currentTheme = themeId;

    // If switching to adaptive while a song is already playing, extract color now
    if (themeId === 'adaptive' && AppState.playerState?.coverArt) {
        window._lastExtractedArt = null; // reset so extraction runs
        let highResArt = AppState.playerState.coverArt;
        if (highResArt.includes('W_500')) {
            highResArt = highResArt.replace('W_500', 'W_1080').replace('H_500', 'H_1080');
        }
        extractDominantColor(highResArt).then(domColor => {
            window._lastExtractedArt = AppState.playerState.coverArt;
            const r = document.documentElement;
            r.style.setProperty('--accent', domColor);
            const rawRgb = domColor.replace('rgb(', '').replace(')', '');
            r.style.setProperty('--accent-glow', `rgba(${rawRgb}, 0.5)`);
            r.style.setProperty('--accent-soft', `rgba(${rawRgb}, 0.15)`);
            r.style.setProperty('--accent-grad', `linear-gradient(135deg, ${domColor}, #000000)`);
        });
    }
}

function loadSavedTheme() {
    const savedTheme = localStorage.getItem('panedora-theme');
    if (savedTheme && THEMES[savedTheme]) {
        applyTheme(savedTheme);
    } else {
        applyTheme('midnight'); // Default fallback
    }
}
function loadSavedEffect() {
    const savedEffect = localStorage.getItem('panedora-effect');
    // Ensure the effect still exists in the registry
    if (savedEffect && BG_EFFECTS[savedEffect]) {
        applyBgEffect(savedEffect);
    } else {
        applyBgEffect('waves'); // Default fallback
    }
    // Apply saved speed
    const savedSpeed = parseFloat(localStorage.getItem('panedora-effect-speed')) || 1;
    applyEffectSpeed(savedSpeed);
}

function applyEffectSpeed(speed) {
    localStorage.setItem('panedora-effect-speed', speed);
    AppState.effectSpeed = speed;

    // Skip reactive effects and static — only scale non-reactive CSS animations
    const currentEffect = AppState.currentEffect || 'waves';
    if (currentEffect.startsWith('reactive-') || currentEffect === 'static') return;

    // Re-render the effect entirely so new durations apply from a fresh start
    applyBgEffect(currentEffect);
}

const LYRICS_STYLES = {
    glow: { name: 'Text Glow', desc: 'Glowing text with no background container' },
    pill: { name: 'Pill Box', desc: 'Highlight is a tightly padded wrapper' },
    bar: { name: 'Full Line', desc: 'Highlight spans the entire width of the screen' }
};

function applyLyricsStyle(styleId) {
    const style = LYRICS_STYLES[styleId];
    if (!style) return;

    localStorage.setItem('panedora-lyrics-style', styleId);
    AppState.currentLyricsStyle = styleId;

    const content = document.getElementById('lyrics-content');
    if (content) {
        content.classList.remove('style-glow', 'style-pill', 'style-bar');
        content.classList.add(`style-${styleId}`);
    }
    console.log(`[UI] Lyrics style applied: ${style.name}`);
}

function loadSavedLyricsStyle() {
    const savedStyle = localStorage.getItem('panedora-lyrics-style');
    if (savedStyle && LYRICS_STYLES[savedStyle]) {
        applyLyricsStyle(savedStyle);
    } else {
        applyLyricsStyle('glow'); // Default
    }
}

// Helper: Extract dominant color from image URL
async function extractDominantColor(imgSrc) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 50; // Scale down for speed
            canvas.height = 50;
            ctx.drawImage(img, 0, 0, 50, 50);

            try {
                const imageData = ctx.getImageData(0, 0, 50, 50).data;
                const colors = {};
                let maxCount = 0;
                let dominant = [124, 91, 245]; // default purple fallback

                // Skip by 4 (RGBA)
                for (let i = 0; i < imageData.length; i += 4) {
                    const r = imageData[i];
                    const g = imageData[i + 1];
                    const b = imageData[i + 2];

                    // Ignore colors that are too dark/black or too bright/white
                    if ((r < 30 && g < 30 && b < 30) || (r > 240 && g > 240 && b > 240)) continue;

                    // Group similar colors by rounding
                    const rgb = `${Math.round(r / 10) * 10},${Math.round(g / 10) * 10},${Math.round(b / 10) * 10}`;
                    colors[rgb] = (colors[rgb] || 0) + 1;

                    if (colors[rgb] > maxCount) {
                        maxCount = colors[rgb];
                        dominant = [r, g, b];
                    }
                }

                // Ensure the color isn't too dark or too light for an accent
                const hsl = rgbToHsl(dominant[0], dominant[1], dominant[2]);
                if (hsl[2] < 0.4) {
                    const rgb = hslToRgb(hsl[0], hsl[1], 0.5);
                    dominant = [rgb[0], rgb[1], rgb[2]];
                } else if (hsl[2] > 0.75) {
                    // Cap lightness so accent is never washed-out white/grey
                    const rgb = hslToRgb(hsl[0], Math.max(hsl[1], 0.5), 0.65);
                    dominant = [rgb[0], rgb[1], rgb[2]];
                }

                resolve(`rgb(${dominant[0]}, ${dominant[1]}, ${dominant[2]})`);
            } catch (e) {
                console.error('[UI] Error extracting color:', e);
                resolve('rgb(124, 91, 245)');
            }
        };
        img.onerror = () => resolve('rgb(124, 91, 245)');
        img.src = imgSrc;
    });
}

function rgbToHsl(r, g, b) {
    r /= 255, g /= 255, b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // achromatic
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h, s, l];
}

function hslToRgb(h, s, l) {
    let r, g, b;

    if (s === 0) {
        r = g = b = l; // achromatic
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };

        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function applyBgEffect(effectId) {
    if (!BG_EFFECTS[effectId]) effectId = 'waves'; // fallback

    document.body.setAttribute('data-bg-effect', effectId);
    localStorage.setItem('panedora-effect', effectId);
    AppState.currentEffect = effectId;

    // Stop any physical rendering from the visualizer if we switch away from it
    if (window.visualizer) {
        window.visualizer.stop();
    }

    const container = document.getElementById('bg-effects');
    if (container) {
        container.innerHTML = ''; // Keep it clean

        if (effectId === 'waves') {
            container.innerHTML = `
                <div class="waves-container">
                    <svg class="waves" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 24 150 28" preserveAspectRatio="none" shape-rendering="auto">
                    <defs><path id="gentle-wave" d="M-160 44c30 0 58-18 88-18s 58 18 88 18 58-18 88-18 58 18 88 18 v44h-352z" /></defs>
                    <g class="parallax-waves">
                    <use xlink:href="#gentle-wave" x="48" y="0" fill="var(--accent-glow)" />
                    <use xlink:href="#gentle-wave" x="48" y="3" fill="var(--accent-soft)" />
                    <use xlink:href="#gentle-wave" x="48" y="5" fill="var(--glass)" />
                    <use xlink:href="#gentle-wave" x="48" y="7" fill="var(--accent)" opacity="0.4" />
                    </g></svg>
                </div>
            `;
        } else if (effectId === 'orbs') {
            container.innerHTML = `
                <div class="orb orb-1"></div>
                <div class="orb orb-2"></div>
                <div class="orb orb-3"></div>
            `;
        } else if (effectId === 'space') {
            container.innerHTML = `
                <div class="star-layer"></div>
                <div class="star-layer"></div>
                <div class="star-layer"></div>
            `;
        } else if (effectId === 'grid') {
            container.innerHTML = `<div class="synth-grid"></div>`;
        } else if (effectId === 'particles') {
            let parts = '';
            for (let i = 0; i < 30; i++) {
                parts += `<div class="particle" style="left: ${Math.random() * 100}%; animation-delay: ${Math.random() * 5}s; animation-duration: ${4 + Math.random() * 4}s;"></div>`;
            }
            container.innerHTML = parts;
        } else if (effectId === 'rings') {
            container.innerHTML = `
                <div class="ring-container">
                    <div class="ring ring-1"></div>
                    <div class="ring ring-2"></div>
                    <div class="ring ring-3"></div>
                    <div class="ring ring-4"></div>
                </div>
            `;
        } else if (effectId.startsWith('reactive-')) {
            container.innerHTML = `<canvas id="reactive-canvas" style="width: 100%; height: 100%; position: absolute; top:0; left:0; pointer-events: none; opacity: 0.6; mix-blend-mode: screen;"></canvas>`;
            const canvas = document.getElementById('reactive-canvas');
            const styleName = effectId.replace('reactive-', '');

            // Note: window.visualizer.init(audioElement) must be called first 
            // after user interaction (like clicking play).
            const activeAudioEl = document.querySelector('audio');
            if (window.visualizer && activeAudioEl) {
                window.visualizer.init(activeAudioEl);
                window.visualizer.start(canvas, styleName);
            }
        }
    }

    // Apply speed scaling to newly created effect elements
    const speedMult = 1 / (AppState.effectSpeed || parseFloat(localStorage.getItem('panedora-effect-speed')) || 1);
    if (speedMult !== 1 && container && !effectId.startsWith('reactive-') && effectId !== 'static') {
        requestAnimationFrame(() => {
            container.querySelectorAll('*').forEach(el => {
                const dur = getComputedStyle(el).animationDuration;
                if (dur && dur !== '0s') {
                    el.style.animationDuration = (parseFloat(dur) * speedMult) + 's';
                }
            });
        });
    }
}

function renderSettingsPage() {
    const currentTheme = AppState.currentTheme || localStorage.getItem('panedora-theme') || 'midnight';
    const currentEffect = AppState.currentEffect || localStorage.getItem('panedora-effect') || 'aurora';

    let themeSwatches = '';
    Object.entries(THEMES).forEach(([id, theme]) => {
        const isActive = id === currentTheme;
        themeSwatches += `
            <button class="theme-swatch ${isActive ? 'active' : ''}" data-theme="${id}" title="${theme.name}">
                <div class="swatch-preview">
                    <div class="swatch-color" style="background: ${theme.preview[0]}"></div>
                    <div class="swatch-color" style="background: ${theme.preview[1]}"></div>
                    <div class="swatch-accent" style="background: ${theme.preview[2]}"></div>
                </div>
                <span class="swatch-label">${theme.name}</span>
                ${isActive ? '<span class="swatch-check">\u2713</span>' : ''}
            </button>`;
    });

    let effectButtons = '';
    Object.entries(BG_EFFECTS).forEach(([id, effect]) => {
        const isActive = id === currentEffect;
        effectButtons += `
            <button class="theme-swatch ${isActive ? 'active' : ''}" data-effect="${id}" title="${effect.desc}" style="height: auto; padding: 16px;">
                <span class="swatch-label" style="font-size: 14px; font-weight: 600; text-transform: capitalize; margin-bottom: 4px;">${effect.name}</span>
                <span style="font-size: 12px; color: var(--text-2); display: block; text-align: center;">${effect.desc}</span>
                ${isActive ? '<span class="swatch-check">\u2713</span>' : ''}
            </button>`;
    });

    const currentLyricsStyle = AppState.currentLyricsStyle || localStorage.getItem('panedora-lyrics-style') || 'glow';
    let lyricsStyleButtons = '';
    Object.entries(LYRICS_STYLES).forEach(([id, style]) => {
        const isActive = id === currentLyricsStyle;
        lyricsStyleButtons += `
            <button class="theme-swatch ${isActive ? 'active' : ''}" data-lyrics-style="${id}" title="${style.desc}">
                <div class="swatch-preview" style="background: var(--glass-hover); justify-content: center; align-items: center; border-bottom: 1px solid var(--glass-border);">
                    <div class="lyrics-content style-${id}" style="width: 100%; height: 100%; padding: 0; display: flex; align-items: center; justify-content: center; overflow: hidden;">
                        <div class="lyrics-line active" style="margin: 0; width: 100%; font-size: 15px; transform: scale(1); opacity: 1; display: flex; justify-content: center;">
                            <span class="lyric-text" style="display: inline-block;">Sample</span>
                        </div>
                    </div>
                </div>
                <span class="swatch-label">${style.name}</span>
                <span style="font-size: 12px; color: var(--text-2); display: block; text-align: left; padding: 0 14px 14px 14px; line-height: 1.4; white-space: normal;">${style.desc}</span>
                ${isActive ? '<span class="swatch-check">\u2713</span>' : ''}
            </button>`;
    });

    DOM.pageContent.innerHTML = `
    <div class="fade-in" style="display: flex; flex-direction: column; gap: 32px;">
      <section class="settings-section">
        <h2 class="section-title">Color Theme</h2>
        <p class="settings-description">Choose a color palette to personalize your experience.</p>
        <div class="theme-grid">${themeSwatches}</div>
      </section>

      <section class="settings-section">
        <h2 class="section-title">Background Effects</h2>
        <p class="settings-description">Make the background feel alive with animated effects.</p>
        <div class="theme-grid" style="grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));">${effectButtons}</div>
        ${!currentEffect.startsWith('reactive-') && currentEffect !== 'static' ? `
        <div class="effect-speed-control" style="margin-top: 20px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <label style="font-size: 13px; font-weight: 600; color: var(--text-1);">Animation Speed</label>
            <span id="speed-label" style="font-size: 12px; color: var(--text-2);">${(parseFloat(localStorage.getItem('panedora-effect-speed')) || 1).toFixed(1)}x</span>
          </div>
          <input type="range" id="effect-speed-slider" min="0.2" max="3" step="0.1" value="${parseFloat(localStorage.getItem('panedora-effect-speed')) || 1}"
            style="width: 100%; height: 4px; -webkit-appearance: none; appearance: none; background: rgba(255,255,255,0.1); border-radius: 2px; cursor: pointer; accent-color: var(--accent);">
          <div style="display: flex; justify-content: space-between; margin-top: 4px;">
            <span style="font-size: 10px; color: var(--text-3);">Slow</span>
            <span style="font-size: 10px; color: var(--text-3);">Fast</span>
          </div>
        </div>
        ` : ''}
      </section>

      <section class="settings-section">
        <h2 class="section-title">Lyrics Highlight Style</h2>
        <p class="settings-description">Choose how the currently playing line is highlighted.</p>
        <div class="theme-grid" style="grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));">${lyricsStyleButtons}</div>
      </section>
    </div>`;

    // Attach click handlers for themes
    document.querySelectorAll('.theme-swatch[data-theme]').forEach(btn => {
        btn.addEventListener('click', () => {
            const themeId = btn.dataset.theme;
            applyTheme(themeId);
            renderSettingsPage();
        });
    });

    // Attach click handlers for effects
    document.querySelectorAll('.theme-swatch[data-effect]').forEach(btn => {
        btn.addEventListener('click', () => {
            const effectId = btn.dataset.effect;
            applyBgEffect(effectId);
            renderSettingsPage();
        });
    });

    // Attach click handlers for lyrics styles
    document.querySelectorAll('.theme-swatch[data-lyrics-style]').forEach(btn => {
        btn.addEventListener('click', () => {
            const styleId = btn.dataset.lyricsStyle;
            applyLyricsStyle(styleId);
            renderSettingsPage();
        });
    });

    // Effect speed slider
    const speedSlider = document.getElementById('effect-speed-slider');
    const speedLabel = document.getElementById('speed-label');
    if (speedSlider) {
        speedSlider.addEventListener('input', () => {
            const speed = parseFloat(speedSlider.value);
            if (speedLabel) speedLabel.textContent = speed.toFixed(1) + 'x';
            applyEffectSpeed(speed);
        });
    }
}

function renderNowPlayingPage() {
    const { track, artist, album, coverArt, time, duration, isPlaying } = AppState.playerState;

    // Build history section
    let pastSongs = [...(AppState.playerState.history || [])];
    if (pastSongs.length > 0 && pastSongs[pastSongs.length - 1].trackToken === AppState.playerState.trackToken) {
        pastSongs.pop(); // Remove currently playing song
    }
    pastSongs.reverse(); // Show newest first
    let historyHtml = `
        <div class="np-history">
            <h3 class="tune-title">RECENTLY PLAYED</h3>
            <div class="history-list">
    `;

    if (pastSongs.length > 0) {
        historyHtml += pastSongs.map(h => `
            <div class="history-item ${h.feedback ? 'history-' + h.feedback : ''}" data-token="${h.trackToken}">
                <img class="history-art" src="${h.coverArt || ''}" alt="">
                <div class="history-info">
                    <span class="history-title">${escapeHtml(h.songTitle)}</span>
                    <span class="history-artist">${escapeHtml(h.artistName)}</span>
                </div>
                <div class="history-feedback">
                    ${h.feedback === 'liked' ? '<span class="history-badge history-badge-liked" title="Liked">👍</span>' : ''}
                    ${h.feedback === 'disliked' ? '<button class="history-undo-btn" title="Undo dislike" data-token="' + h.trackToken + '">Undo 👎</button>' : ''}
                    ${!h.feedback ? '<span class="history-badge">—</span>' : ''}
                </div>
            </div>
        `).join('');
    } else {
        historyHtml += `
            <div class="empty-state" style="padding: 24px 0; min-height: auto;">
                <p style="text-align: left; color: rgba(255,255,255,0.7); margin-bottom: 8px;">Songs you've played will appear here.</p>
                <p style="text-align: left; color: rgba(255,255,255,0.4); font-size: 13px;">Stores your last 20 tracks.</p>
            </div>
        `;
    }

    historyHtml += `
            </div>
        </div>
    `;

    DOM.pageContent.innerHTML = `
    <div class="now-playing-page fade-in">
        <button class="back-btn" id="np-back-btn">← Back</button>

        <div class="np-content">
            <div class="np-left">
                <div class="np-artwork">
                    <img id="np-large-art" src="${coverArt || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"%3E%3Crect fill="%23333" width="300" height="300"/%3E%3Ctext x="150" y="160" text-anchor="middle" fill="%23666" font-size="48"%3E♪%3C/text%3E%3C/svg%3E'}" alt="Album Art" />
                </div>
                <div class="np-track-info">
                    <h2 class="np-track" id="np-large-title">${track || 'Not Playing'}</h2>
                    <p class="np-artist" id="np-large-artist">${artist || 'Select a station'}</p>
                    <p class="np-album" id="np-large-album">${album || ''}</p>
                </div>

                <div class="np-feedback-row">
                    <button class="np-feedback-btn" id="np-thumbdown" aria-label="Thumbs Down" title="Thumbs Down">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M17 2H7.28a2 2 0 0 0-2 1.7L3.9 12.7a2 2 0 0 0 2 2.3H10l-1 4a3 3 0 0 0 3 3l5-9"/>
                            <path d="M17 2v11h3a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-3z"/>
                        </svg>
                    </button>
                    <button class="np-feedback-btn" id="np-thumbup" aria-label="Thumbs Up" title="Thumbs Up">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                        </svg>
                    </button>
                </div>
            </div>
            
            <div class="np-right">

                ${historyHtml}
            </div>
        </div>
    </div>`;

    // Attach event handlers
    document.getElementById('np-back-btn')?.addEventListener('click', () => renderPage('home'));

    // Sync thumb button states with current track feedback
    if (AppState.playerState.feedback === 'thumbUp') {
        document.getElementById('np-thumbup')?.classList.add('liked');
    } else if (AppState.playerState.feedback === 'thumbDown') {
        document.getElementById('np-thumbdown')?.classList.add('disliked');
    }

    // Thumb up — toggle liked state & call API or Undo
    document.getElementById('np-thumbup')?.addEventListener('click', function () {
        if (!rateLimitOk('thumb')) return;
        const isCurrentlyLiked = this.classList.contains('liked');
        const token = AppState.playerState.trackToken;

        if (isCurrentlyLiked) {
            // Undo the like
            this.classList.remove('liked');
            DOM.heartBtn?.classList.remove('liked');
            if (token) window.api.player.undoFeedback(token);
        } else {
            // Add the like
            this.classList.add('liked');
            document.getElementById('np-thumbdown')?.classList.remove('disliked');
            window.api.player.thumbUp();
            DOM.heartBtn?.classList.add('liked');
        }
    });

    // Thumb down — toggle disliked state & call API or Undo
    document.getElementById('np-thumbdown')?.addEventListener('click', function () {
        if (!rateLimitOk('thumb')) return;
        const isCurrentlyDisliked = this.classList.contains('disliked');
        const token = AppState.playerState.trackToken;

        if (isCurrentlyDisliked) {
            // Undo the dislike (if they somehow manage to click it before it skips)
            this.classList.remove('disliked');
            if (token) window.api.player.undoFeedback(token);
        } else {
            // Add the dislike
            this.classList.add('disliked');
            document.getElementById('np-thumbup')?.classList.remove('liked');
            DOM.heartBtn?.classList.remove('liked');
            window.api.player.thumbDown();
        }
    });

    // History undo-dislike handlers
    document.querySelectorAll('.history-undo-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const token = btn.dataset.token;
            const result = await window.api.player.undoFeedback(token);
            if (result && result.success) {
                // Update the UI: remove disliked state from this history item
                const item = btn.closest('.history-item');
                if (item) {
                    item.classList.remove('history-disliked');
                    btn.replaceWith(Object.assign(document.createElement('span'), {
                        className: 'history-badge',
                        textContent: '✓ Removed'
                    }));
                }
            }
        });
    });
}

// Variables for lyrics state
let isLyricsMode = false;

async function fetchLyrics(artist, title) {
    if (!artist || !title) return 'Lyrics not available.';

    // Clean up title (remove "Remastered", "feat.", etc.) to improve API hit rate
    let cleanTitle = title.split(' (')[0].split(' - ')[0].split(' feat.')[0];

    try {

        const result = await window.api.content.fetchLyrics(artist, cleanTitle);

        if (result && result.success) {
            return result.lyrics;
        } else {
            console.warn('[UI] Lyrics fetch returned error:', result?.error);
            return result?.error || 'Lyrics not found for this track.';
        }
    } catch (e) {
        console.error('[UI] Lyrics IPC fetch error:', e);
        return 'Internal error while requesting lyrics. Please try again.';
    }
}

async function toggleLyrics() {
    isLyricsMode = !isLyricsMode;
    const btn = document.getElementById('lyrics-btn');
    const overlay = document.getElementById('lyrics-overlay');
    const content = document.getElementById('lyrics-content');

    if (btn) btn.classList.toggle('active', isLyricsMode);

    // If not on Now Playing page, navigate there first
    if (AppState.currentPage !== 'nowplaying' && isLyricsMode) {
        renderPage('nowplaying');
        // Let the DOM update
        setTimeout(() => toggleLyricsLogic(), 100);
    } else {
        toggleLyricsLogic();
    }
}

async function toggleLyricsLogic() {
    const overlay = document.getElementById('lyrics-overlay');
    const content = document.getElementById('lyrics-content');

    if (!overlay || !content) return;

    if (isLyricsMode) {
        overlay.classList.add('visible');
        content.innerHTML = '<div class="lyrics-loading">Loading lyrics...</div>';

        const lyricsText = await fetchLyrics(AppState.playerState.artist, AppState.playerState.track);

        if (lyricsText && !lyricsText.startsWith('Lyrics not')) {
            renderLyricsHTML(content, lyricsText);
        } else {
            content.innerHTML = `<div class="lyrics-error">${escapeHtml(lyricsText)}</div>`;
        }

        // Apply chosen style
        applyLyricsStyle(AppState.currentLyricsStyle || 'glow');
    } else {
        overlay.classList.remove('visible');
    }
}

function renderLyricsHTML(contentElement, lyricsText) {
    const isLrc = /\[\d{2}:\d{2}\.\d{2,3}\]/.test(lyricsText);
    const linesHtml = lyricsText.split('\n').map(line => {
        const text = line.trim();
        if (!text) return '<br>';

        if (isLrc) {
            const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
            const match = text.match(timeRegex);
            if (match) {
                const mins = parseInt(match[1], 10);
                const secs = parseInt(match[2], 10);
                const ms = parseInt(match[3], 10);
                const timeInSeconds = (mins * 60) + secs + (ms / (match[3].length === 3 ? 1000 : 100));
                const cleanLyricText = text.replace(timeRegex, '').replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
                // Even empty lines should be synced blocks so the timing flows natively
                const display = cleanLyricText || '♪';
                return `<div class="lyrics-line" data-time="${timeInSeconds.toFixed(3)}"><span class="lyric-text">${escapeHtml(display)}</span></div>`;
            }
        }

        // Fallback for plain text
        const plainText = text.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
        return plainText ? `<div class="lyrics-line"><span class="lyric-text">${escapeHtml(plainText)}</span></div>` : '<br>';
    }).join('');
    contentElement.innerHTML = linesHtml || '<div class="lyrics-error">Lyrics format unsupported.</div>';

    console.log(`[UI] Lyrics parsed. LRC Mode: ${isLrc}`);
    if (isLrc) {
        console.log(`[UI] Found ${contentElement.querySelectorAll('.lyrics-line[data-time]').length} synced lines.`);
    }

    // Re-sync immediately just in case audio is already playing
    const audioEl = document.querySelector('audio');
    if (audioEl) syncLyrics(audioEl.currentTime);
}

function syncLyrics(currentTime) {
    if (!isLyricsMode) return;
    const overlay = document.getElementById('lyrics-overlay');
    const content = document.getElementById('lyrics-content');
    if (!overlay || !content || !overlay.classList.contains('visible')) return;

    const lines = Array.from(content.querySelectorAll('.lyrics-line[data-time]'));
    if (lines.length === 0) return;

    const offset = 0.5; // Slight positive offset to preemptively highlight
    let activeIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        // If current time plus offset is past this line's start time, it MIGHT be the active one.
        // We keep looping to find the LATEST line we've passed.
        if (parseFloat(lines[i].dataset.time) <= currentTime + offset) {
            activeIndex = i;
        } else {
            break; // Since lines are sequential, once we hit a future line, we stop.
        }
    }

    if (activeIndex !== -1) {
        let changed = false;
        lines.forEach((line, index) => {
            const isActive = index === activeIndex;
            if (line.classList.contains('active') !== isActive) {
                line.classList.toggle('active', isActive);
                changed = true;
            }
        });

        if (changed) {
            const activeLine = lines[activeIndex];
            // Use native scrollIntoView bounded to the center of the scroll container
            // This is much more reliable than calculating offsetTop manually
            activeLine.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }
    }
}

// ============================================================================
// Sidebar Station List
// ============================================================================

function renderStationsList() {
    if (AppState.stations.length === 0) {
        DOM.stationsList.innerHTML = `
      <div class="empty-state" style="padding: 20px; text-align: center;">
        <p style="color: var(--text-subdued); font-size: 12px;">No stations</p>
      </div>`;
        return;
    }

    let html = '';
    AppState.stations.forEach(station => {
        const isActive = AppState.playerState.track &&
            station.name.toLowerCase().includes(AppState.playerState.artist?.toLowerCase() || '');
        html += createStationListItem(station.name, station.id, station.type, isActive);
    });

    DOM.stationsList.innerHTML = html;

    // Attach click handlers
    document.querySelectorAll('.station-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.dataset.id;
            const station = AppState.stations.find(s => s.id === id);
            if (station) {
                playStation(station);
            }
        });

        // Attach delete handlers
        const deleteBtn = item.querySelector('.delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation(); // Don't play the station
                const id = item.dataset.id;
                const station = AppState.stations.find(s => s.id === id);
                if (!station) return;

                const confirmed = confirm(`Are you sure you want to delete the station "${station.name}"?`);
                if (confirmed) {
                    item.style.opacity = '0.5';
                    item.style.pointerEvents = 'none';
                    const success = await window.api.content.removeStation(id);
                    if (!success) {
                        alert('Failed to delete station. Please try again.');
                        item.style.opacity = '1';
                        item.style.pointerEvents = 'all';
                    }
                }
            });
        }
    });
}

// ============================================================================
// Player State Updates
// ============================================================================

// Checks if text overflows its parent and applies marquee scrolling animation
function checkMarquee(el) {
    if (!el || !el.parentElement) return;
    // Reset to measure true width
    el.classList.remove('marquee');
    el.style.removeProperty('--marquee-offset');
    el.style.removeProperty('--marquee-duration');

    const parentWidth = el.parentElement.clientWidth;
    const textWidth = el.scrollWidth;

    if (textWidth > parentWidth) {
        const overflow = textWidth - parentWidth;
        const duration = Math.max(5, overflow / 15); // ~15px/s scroll speed
        el.style.setProperty('--marquee-offset', `-${overflow + 16}px`);
        el.style.setProperty('--marquee-duration', `${duration}s`);
        el.classList.add('marquee');
    }
}
function updatePlayerUI(state) {
    AppState.playerState = { ...AppState.playerState, ...state };

    // Update now playing info
    if (state.track) {
        DOM.nowPlayingTitle.textContent = state.track;
    }
    if (state.artist) {
        DOM.nowPlayingArtist.textContent = state.artist;
    }
    if (state.coverArt) {
        DOM.nowPlayingArt.src = state.coverArt;
    }

    // Marquee scroll for overflowing text in mini mode
    if (state.track || state.artist) {
        requestAnimationFrame(() => {
            checkMarquee(DOM.nowPlayingTitle);
            checkMarquee(DOM.nowPlayingArtist);
        });
    }

    // Sync mini thumb button visuals with track feedback state
    if (state.track !== undefined || AppState.playerState.trackToken) {
        const miniThumbUp = document.getElementById('mini-thumb-up');
        const miniThumbDown = document.getElementById('mini-thumb-down');
        // Check the merged AppState.playerState.feedback so partial updates don't clear the thumbs!
        if (miniThumbUp) miniThumbUp.classList.toggle('liked', AppState.playerState.feedback === 'thumbUp');
        if (miniThumbDown) miniThumbDown.classList.toggle('disliked', AppState.playerState.feedback === 'thumbDown');

        // Also sync Now Playing page thumb buttons
        const npThumbUp = document.getElementById('np-thumbup');
        const npThumbDown = document.getElementById('np-thumbdown');
        if (npThumbUp) npThumbUp.classList.toggle('liked', AppState.playerState.feedback === 'thumbUp');
        if (npThumbDown) npThumbDown.classList.toggle('disliked', AppState.playerState.feedback === 'thumbDown');

        // Also sync the main player heart
        const heartBtn = document.getElementById('heart-btn');
        if (heartBtn) heartBtn.classList.toggle('liked', AppState.playerState.feedback === 'thumbUp');
    }

    // Update play/pause button
    if (state.isPlaying !== undefined) {
        DOM.playIcon.innerHTML = state.isPlaying
            ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
            : '<path d="M8 5v14l11-7z"/>';
        DOM.playPauseBtn.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
    }

    // Update progress (only if we don't have a live audio element overriding it)
    const audioEl = document.querySelector('audio');
    if (state.duration > 0 && !audioEl) {
        const progress = (state.time / state.duration) * 100;
        DOM.progressFill.style.width = `${progress}%`;
        DOM.currentTime.textContent = formatTime(state.time);
        DOM.totalTime.textContent = formatTime(state.duration);
    }

    // Live-update the history section if the Now Playing page is visible
    if (state.history && document.querySelector('.np-history') || (state.history && document.querySelector('.np-right'))) {
        const histContainer = document.querySelector('.np-right');
        if (histContainer) {
            // Remove old history section
            const oldHistory = histContainer.querySelector('.np-history');
            if (oldHistory) oldHistory.remove();

            // Build fresh history
            let pastSongs = [...(state.history || [])];
            if (pastSongs.length > 0 && pastSongs[pastSongs.length - 1].trackToken === state.trackToken) {
                pastSongs.pop(); // Remove currently playing song
            }
            pastSongs.reverse(); // Show newest first

            const histDiv = document.createElement('div');
            histDiv.className = 'np-history';

            let listContent = '';
            if (pastSongs.length > 0) {
                listContent = pastSongs.map(h => `
                    <div class="history-item ${h.feedback ? 'history-' + h.feedback : ''}" data-token="${h.trackToken}">
                        <img class="history-art" src="${h.coverArt || ''}" alt="">
                        <div class="history-info">
                            <span class="history-title">${escapeHtml(h.songTitle)}</span>
                            <span class="history-artist">${escapeHtml(h.artistName)}</span>
                        </div>
                        <div class="history-feedback">
                            ${h.feedback === 'liked' ? '<span class="history-badge history-badge-liked" title="Liked">\ud83d\udc4d</span>' : ''}
                            ${h.feedback === 'disliked' ? '<button class="history-undo-btn" title="Undo dislike" data-token="' + h.trackToken + '">Undo \ud83d\udc4e</button>' : ''}
                            ${!h.feedback ? '<span class="history-badge">\u2014</span>' : ''}
                        </div>
                    </div>
                `).join('');
            } else {
                listContent = `
                    <div class="empty-state" style="padding: 24px 0; min-height: auto;">
                        <p style="text-align: left; color: rgba(255,255,255,0.7); margin-bottom: 8px;">Songs you've played will appear here.</p>
                        <p style="text-align: left; color: rgba(255,255,255,0.4); font-size: 13px;">Stores your last 20 tracks.</p>
                    </div>
                `;
            }

            histDiv.innerHTML = `
                <h3 class="tune-title">RECENTLY PLAYED</h3>
                <div class="history-list">
                    ${listContent}
                </div>
            `;
            histContainer.appendChild(histDiv);

            // Re-attach undo handlers
            histDiv.querySelectorAll('.history-undo-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const token = btn.dataset.token;
                    const result = await window.api.player.undoFeedback(token);
                    if (result && result.success) {
                        const item = btn.closest('.history-item');
                        if (item) {
                            item.classList.remove('history-disliked');
                            btn.replaceWith(Object.assign(document.createElement('span'), {
                                className: 'history-badge',
                                textContent: '\u2713 Removed'
                            }));
                        }
                    }
                });
            });
        }
    }
}

// ============================================================================
// Player Controls
// ============================================================================

function playStation(station) {
    // Update lastUpdated locally so Home page "Jump Back In" reflects this on next visit
    const match = AppState.stations.find(s => s.id === station.id || s.name === station.name);
    if (match) {
        match.lastUpdated = new Date().toISOString();
    }

    window.api.content.playItem(station);
}

// Search with debounce
const debouncedSearch = debounce(async (query) => {
    if (query.length < 2) return;
    AppState.searchQuery = query;
    await window.api.content.search(query);
}, 300);

// ============================================================================
// Event Listeners
// ============================================================================

function initEventListeners() {
    // Navigation
    DOM.navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            renderPage(item.dataset.page);
        });
    });

    // Logout
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            window.api.auth.logout();
        });
    }

    // Search input
    DOM.searchInput.addEventListener('input', (e) => {
        debouncedSearch(e.target.value);
    });

    // Player controls
    DOM.playPauseBtn.addEventListener('click', () => {
        window.api.player.toggle();
        // Also toggle actual audio
        const audioEl = document.querySelector('audio');
        if (audioEl) {
            if (audioEl.paused) {
                audioEl.play().catch(e => console.error(e));
                AppState.playerState.isPlaying = true;
            } else {
                audioEl.pause();
                AppState.playerState.isPlaying = false;
            }
            updatePlayerUI(AppState.playerState);
        }
    });
    // DOM.prevBtn event listener moved down
    DOM.nextBtn.addEventListener('click', () => { if (rateLimitOk('skip')) window.api.player.next(); });
    DOM.heartBtn.addEventListener('click', () => {
        if (!rateLimitOk('thumb')) return;
        DOM.heartBtn.classList.toggle('liked');
        window.api.player.thumbUp();
    });

    // Handle window resizes (like toggling mini player mode) to recalculate scrolling text limits
    window.addEventListener('resize', debounce(() => {
        if (AppState.playerState.track || AppState.playerState.artist) {
            checkMarquee(DOM.nowPlayingTitle);
            checkMarquee(DOM.nowPlayingArtist);
        }
    }, 100));

    // Click on now playing section to open Now Playing page
    if (DOM.nowPlayingArt) {
        DOM.nowPlayingArt.addEventListener('click', () => renderPage('nowplaying'));
        DOM.nowPlayingArt.style.cursor = 'pointer';
    }
    if (DOM.nowPlayingTitle) {
        DOM.nowPlayingTitle.addEventListener('click', () => renderPage('nowplaying'));
        DOM.nowPlayingTitle.style.cursor = 'pointer';
    }
    if (DOM.nowPlayingArtist) {
        DOM.nowPlayingArtist.addEventListener('click', () => renderPage('nowplaying'));
        DOM.nowPlayingArtist.style.cursor = 'pointer';
    }

    // Previous track button logic (Reset audio to 0, or skip to previous track)
    DOM.prevBtn.addEventListener('click', () => {
        if (!rateLimitOk('prev')) return;
        const audioEl = document.querySelector('audio');
        if (audioEl && audioEl.currentTime > 3) {
            // If more than 3 sec in, restart current track
            audioEl.currentTime = 0;
            if (audioEl.paused) {
                audioEl.play().catch(e => console.error(e));
                AppState.playerState.isPlaying = true;
                updatePlayerUI(AppState.playerState);
            }
        } else {
            // Otherwise go to previous track
            window.api.player.prev();
        }
    });

    // Volume
    DOM.volumeSlider.addEventListener('input', (e) => {
        const vol = parseInt(e.target.value) / 100;
        window.api.player.setVolume(parseInt(e.target.value));

        // Let the WebAudio visualizer handle volume so bars stay full height, otherwise fallback to audio element
        const audioEl = document.querySelector('audio');
        if (window.visualizer && window.visualizer.audioContext) {
            window.visualizer.setVolume(vol);
            if (audioEl) audioEl.volume = 1.0; // Ensure node signal isn't attenuated
        } else {
            if (audioEl) audioEl.volume = vol;
        }
    });

    const lyricsBtn = document.getElementById('lyrics-btn');
    if (lyricsBtn) {
        lyricsBtn.addEventListener('click', toggleLyrics);
    }

    const miniPlayerBtn = document.getElementById('mini-player-btn');
    if (miniPlayerBtn) {
        miniPlayerBtn.addEventListener('click', () => {
            window.api.window.toggleMini();
        });
    }

    // Expand/collapse volume slider on hover in mini mode
    const volumeControls = document.querySelector('.volume-controls');
    if (volumeControls) {
        let volumeCollapseTimer = null;

        volumeControls.addEventListener('mouseenter', () => {
            if (document.body.classList.contains('mini-mode')) {
                if (volumeCollapseTimer) {
                    clearTimeout(volumeCollapseTimer);
                    volumeCollapseTimer = null;
                }
                DOM.volumeSlider.classList.remove('collapsed');
            }
        });

        volumeControls.addEventListener('mouseleave', () => {
            if (document.body.classList.contains('mini-mode')) {
                volumeCollapseTimer = setTimeout(() => {
                    DOM.volumeSlider.classList.add('collapsed');
                    volumeCollapseTimer = null;
                }, 500);
            }
        });
    }

    // Custom title bar controls
    const titleMinBtn = document.getElementById('titlebar-minimize');
    const titleMaxBtn = document.getElementById('titlebar-maximize');
    const titleCloseBtn = document.getElementById('titlebar-close');
    if (titleMinBtn) titleMinBtn.addEventListener('click', () => window.api.window.minimize());
    if (titleMaxBtn) titleMaxBtn.addEventListener('click', () => window.api.window.maximize());
    if (titleCloseBtn) titleCloseBtn.addEventListener('click', () => window.api.window.close());

    // Mini player thumb up/down buttons
    const miniThumbUp = document.getElementById('mini-thumb-up');
    const miniThumbDown = document.getElementById('mini-thumb-down');
    if (miniThumbUp) {
        miniThumbUp.addEventListener('click', async () => {
            if (!rateLimitOk('thumb')) return;
            const state = AppState.playerState;
            if (state.feedback === 'thumbUp' && state.trackToken) {
                // Already liked — undo it
                const result = await window.api.player.undoFeedback(state.trackToken);
                if (result && result.success) {
                    miniThumbUp.classList.remove('liked');
                    state.feedback = null;
                }
            } else {
                // Not liked — send thumb up
                await window.api.player.thumbUp();
                miniThumbUp.classList.add('liked');
                miniThumbDown?.classList.remove('disliked');
                state.feedback = 'thumbUp';
            }
        });
    }
    if (miniThumbDown) {
        miniThumbDown.addEventListener('click', async () => {
            if (!rateLimitOk('thumb')) return;
            const state = AppState.playerState;
            if (state.feedback === 'thumbDown' && state.trackToken) {
                // Already disliked — undo it
                const result = await window.api.player.undoFeedback(state.trackToken);
                if (result && result.success) {
                    miniThumbDown.classList.remove('disliked');
                    state.feedback = null;
                }
            } else {
                // Not disliked — send thumb down
                await window.api.player.thumbDown();
                miniThumbDown.classList.add('disliked');
                miniThumbUp?.classList.remove('liked');
                state.feedback = 'thumbDown';
            }
        });
    }

    // Progress bar seeking
    DOM.progressBar.addEventListener('click', (e) => {
        const rect = DOM.progressBar.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        const audioEl = document.querySelector('audio');
        if (audioEl && audioEl.duration) {
            audioEl.currentTime = percent * audioEl.duration;
            // Update UI immediately
            DOM.progressFill.style.width = `${percent * 100}%`;
            DOM.currentTime.textContent = formatTime(audioEl.currentTime);
        } else {
            // Fallback if no audio element
            const seekTime = percent * AppState.playerState.duration;
            window.api.player.seek(seekTime);
        }
    });
}

// ============================================================================
// API Event Handlers
// ============================================================================

function initAPIListeners() {
    // Manage a single Audio instance to prevent overlapping event listeners and track skipping
    let currentAudio = null;
    let consecutiveErrors = 0; // Prevent chain-skipping on stale/expired URLs

    // Player state updates
    window.api.onState((state) => {
        updatePlayerUI(state);

        // Audio Playback override
        if (state.audioURL) {
            if (!currentAudio) {

                currentAudio = document.createElement('audio');
                document.body.appendChild(currentAudio);

                // Sync time with UI
                currentAudio.addEventListener('timeupdate', () => {
                    if (!AppState.playerState.isPlaying) return;
                    const progress = (currentAudio.currentTime / currentAudio.duration) * 100;
                    DOM.progressFill.style.width = `${progress}%`;
                    DOM.currentTime.textContent = formatTime(currentAudio.currentTime);
                    DOM.totalTime.textContent = formatTime(currentAudio.duration || 0);

                    // Sync lyrics
                    syncLyrics(currentAudio.currentTime);
                });

                // Prevent rapid skipping by notifying main process only once per natural end
                currentAudio.addEventListener('ended', () => {
                    console.log('[UI] Track ended naturally, requesting next');
                    window.api.player.next();
                });

                currentAudio.addEventListener('error', (e) => {
                    console.error('[UI] Audio element error:', currentAudio.error);

                    // Don't auto-skip if the source was intentionally cleared
                    if (!currentAudio.getAttribute('src') || currentAudio.getAttribute('src') === '') {
                        console.log('[UI] Ignoring audio error: source is intentionally empty.');
                        return;
                    }

                    consecutiveErrors++;

                    // Stop chain-skipping after 3 consecutive errors (likely expired URLs)
                    if (consecutiveErrors >= 3) {
                        console.warn('[UI] Too many consecutive audio errors — stopping auto-skip. URLs may be expired.');
                        consecutiveErrors = 0;
                        return;
                    }

                    // Only auto-skip if we are actually logged in and trying to play
                    if (AppState.isLoggedIn) {
                        setTimeout(() => window.api.player.next(), 2000);
                    }
                });
            }

            // Only update source and play if the URL actually changed
            if (currentAudio.src !== state.audioURL) {
                console.log('[UI] Loading new audio source');
                currentAudio.src = state.audioURL;
                currentAudio.play().then(() => {
                    consecutiveErrors = 0; // Reset on successful play

                    // Web Audio API requires a user gesture. This is a safe place to init.
                    if (window.visualizer) {
                        window.visualizer.init(currentAudio);
                        // If they have the reactive theme already selected, start it up!
                        if (AppState.currentEffect && AppState.currentEffect.startsWith('reactive-')) {
                            const cvs = document.getElementById('reactive-canvas');
                            const styleName = AppState.currentEffect.replace('reactive-', '');
                            if (cvs) window.visualizer.start(cvs, styleName);
                        }
                    }
                }).catch(e => console.error('[UI] Play error:', e));

                // Reset feedback buttons on the Now Playing page
                document.getElementById('np-thumbup')?.classList.remove('liked');
                document.getElementById('np-thumbdown')?.classList.remove('disliked');
                DOM.heartBtn?.classList.remove('liked');
            }
        } else if (state.audioURL === null && currentAudio) {
            // Clear audio if specifically set to null
            currentAudio.pause();
            currentAudio.src = '';
        }

        if (state.isPlaying && currentAudio && currentAudio.paused) {
            currentAudio.play().catch(e => console.error('[UI] Play error:', e));
        } else if (!state.isPlaying && currentAudio && !currentAudio.paused) {
            currentAudio.pause();
        }

        // Update large artwork if on Now Playing page
        const largeArt = document.getElementById('np-large-art');
        if (largeArt && state.coverArt) {
            largeArt.src = state.coverArt;
        }

        // Handle Adaptive Theme Color Extraction (only trigger once per new cover art)
        if (AppState.currentTheme === 'adaptive' && state.coverArt && window._lastExtractedArt !== state.coverArt) {
            window._lastExtractedArt = state.coverArt;

            // we want to use the highest res art for color extraction
            let highResArt = state.coverArt;
            if (highResArt.includes('W_500')) {
                highResArt = highResArt.replace('W_500', 'W_1080').replace('H_500', 'H_1080');
            }

            extractDominantColor(highResArt).then(domColor => {
                const root = document.documentElement;
                root.style.setProperty('--accent', domColor);

                // create a raw RGB version from the domColor rgb(r, g, b) string for rgba injection
                const rawRgb = domColor.replace('rgb(', '').replace(')', '');
                root.style.setProperty('--accent-glow', `rgba(${rawRgb}, 0.5)`);
                root.style.setProperty('--accent-soft', `rgba(${rawRgb}, 0.15)`);
                root.style.setProperty('--accent-grad', `linear-gradient(135deg, ${domColor}, #000000)`);

            });
        }

        // Update large text if on Now Playing page
        const largeTitle = document.getElementById('np-large-title');
        if (largeTitle && state.track) largeTitle.textContent = state.track;

        const largeArtist = document.getElementById('np-large-artist');
        if (largeArtist && state.artist) largeArtist.textContent = state.artist;

        const largeAlbum = document.getElementById('np-large-album');
        if (largeAlbum && state.album) largeAlbum.textContent = state.album;

        // Auto-refresh lyrics if overlay is open and track changes
        if (isLyricsMode && state.track && state.artist) {
            // we debounce this slightly to avoid double-firing during rapid track skips
            clearTimeout(window._lyricsFetchTimer);
            window._lyricsFetchTimer = setTimeout(async () => {
                const overlay = document.getElementById('lyrics-overlay');
                const content = document.getElementById('lyrics-content');
                if (overlay && content && overlay.classList.contains('visible')) {
                    content.innerHTML = '<div class="lyrics-loading">Loading new lyrics...</div>';
                    const text = await fetchLyrics(state.artist, state.track);
                    if (text && !text.startsWith('Lyrics not')) {
                        renderLyricsHTML(content, text);
                    } else {
                        content.innerHTML = `<div class="lyrics-error">${escapeHtml(text)}</div>`;
                    }
                }
            }, 800);
        }
    });

    // Collection/stations data
    window.api.onCollection((data) => {
        console.log('[UI] Received collection data:', data);
        AppState.stations = data || [];
        AppState.isLoading = false;
        renderStationsList();

        if (AppState.currentPage === 'home') {
            // Only update the home page automatically if it has no station cards (e.g. fresh login)
            const recentContainer = document.getElementById('home-recent');
            if (recentContainer && recentContainer.querySelectorAll('.card').length === 0 && AppState.stations.length > 0) {
                updateHomeGrids();
            }
        } else if (AppState.currentPage === 'library') {
            renderPage('library');
        }
    });

    // Search results
    window.api.onSearchResults((data) => {

        AppState.searchResults = data;
        if (AppState.currentPage === 'search') {
            renderSearchPage();
        }
    });

    // Login status updates
    window.api.onLoginStatus((status) => {

        AppState.isLoggedIn = status.isLoggedIn;

        if (status.isLoggedIn) {
            // Successfully logged in — backend will soon send UI:COLLECTION

            AppState.isLoading = false;
            renderPage('home');
        } else {
            // Logged out — clear data, pause audio, and show login form

            AppState.isLoading = false;
            AppState.stations = [];
            AppState.playerState = { volume: 50 };

            // Clear physical UI text and artwork
            if (DOM.nowPlayingTitle) DOM.nowPlayingTitle.textContent = 'Not Playing';
            if (DOM.nowPlayingArtist) DOM.nowPlayingArtist.textContent = '--';
            if (DOM.nowPlayingArt) DOM.nowPlayingArt.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'%3E%3Crect fill='%23282828' width='56' height='56'/%3E%3C/svg%3E";
            if (DOM.progressFill) DOM.progressFill.style.width = '0%';
            if (DOM.currentTime) DOM.currentTime.textContent = '0:00';
            if (DOM.totalTime) DOM.totalTime.textContent = '0:00';

            const audioEl = document.querySelector('audio');
            if (audioEl) {
                audioEl.pause();
                audioEl.src = '';
            }

            const stationsList = document.getElementById('stations-list');
            if (stationsList) stationsList.innerHTML = '';

            updatePlayerUI(AppState.playerState);
            renderPage('home');
        }
    });

    // Mini player mode toggle
    window.api.onMiniMode((data) => {
        document.body.classList.toggle('mini-mode', data.isMini);
        // Collapse volume slider by default in mini mode, reset when leaving
        if (data.isMini) {
            DOM.volumeSlider.classList.add('collapsed');
        } else {
            DOM.volumeSlider.classList.remove('collapsed');
        }
    });

    window.api.onError((data) => {
        console.error('[UI] Error from main:', data.message);
        showErrorToast(data.message);
    });
}

function showErrorToast(message) {
    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(239,68,68,0.9);color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:10000;pointer-events:none;opacity:0;transition:opacity 0.3s;';
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ============================================================================
// Initialize Application
// ============================================================================

async function init() {
    console.log('[UI] Initializing Panedora...');

    // Replace broken images with a dark placeholder
    document.addEventListener('error', (e) => {
        if (e.target.tagName === 'IMG' && !e.target.dataset.fallbackApplied) {
            e.target.dataset.fallbackApplied = 'true';
            e.target.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 180 180'%3E%3Crect fill='%23282828' width='180' height='180'/%3E%3Ctext x='90' y='100' text-anchor='middle' fill='%23555' font-size='36'%3E%E2%99%AA%3C/text%3E%3C/svg%3E";
        }
    }, true);

    // Restore saved theme and effect before rendering
    loadSavedTheme();
    loadSavedEffect();

    initEventListeners();
    initAPIListeners();

    // Request initial data
    await window.api.init();

    // Render initial page
    renderPage('home');
}

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', init);
