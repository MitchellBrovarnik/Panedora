/**
 * Pandora Glass - Frontend Controller (Renderer)
 * Handles UI state, routing, and user interactions
 */

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
    authLoading: false,
    authError: ''
};

const AudioState = {
    element: null,
    currentURL: null
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
    shuffleBtn: document.getElementById('shuffle-btn'),
    repeatBtn: document.getElementById('repeat-btn'),
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

    // Show/hide search bar
    DOM.searchContainer.style.display = page === 'search' ? 'block' : 'none';

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
        default:
            renderHomePage();
    }
}

function renderHomePage() {
    if (AppState.isLoading) {
        DOM.pageContent.innerHTML = `
      <div class="welcome-container">
        <h1 class="welcome-title">Welcome to Pandora Glass</h1>
        <p class="welcome-subtitle">Connecting to Pandora...</p>
        <div class="loading-spinner"></div>
      </div>`;
        return;
    }

    if (!AppState.isLoggedIn) {
        DOM.pageContent.innerHTML = `
      <div class="welcome-container">
        <h1 class="welcome-title">Sign in to Pandora</h1>
        <p class="welcome-subtitle">Sign in with your Pandora account to load and sync your stations.</p>
        <form class="login-form" id="login-form">
          <input class="login-input" id="login-username" type="text" placeholder="Email" autocomplete="username" required>
          <input class="login-input" id="login-password" type="password" placeholder="Password" autocomplete="current-password" required>
          <button class="login-button" type="submit" ${AppState.authLoading ? 'disabled' : ''}>
            ${AppState.authLoading ? 'Signing in…' : 'Sign In'}
          </button>
          ${AppState.authError ? `<p class="login-error">${AppState.authError}</p>` : ''}
        </form>
      </div>`;

        const loginForm = document.getElementById('login-form');
        loginForm?.addEventListener('submit', handleLoginSubmit);
        return;
    }

    let cardsHtml = '';
    AppState.stations.forEach(station => {
        cardsHtml += createCard(
            station.image || null,
            station.name,
            station.type === 'playlist' ? 'Playlist' : 'Station',
            () => playStation(station)
        );
    });

    DOM.pageContent.innerHTML = `
    <section class="fade-in">
      <h2 class="section-title">Your Stations</h2>
      <div class="card-grid" id="home-cards">
        ${cardsHtml || createEmptyState('No stations found', 'Your Pandora stations will appear here')}
      </div>
    </section>`;

    // Attach click handlers to cards
    document.querySelectorAll('.card').forEach((card, index) => {
        card.addEventListener('click', () => {
            if (AppState.stations[index]) {
                playStation(AppState.stations[index]);
            }
        });
    });
}

async function handleLoginSubmit(event) {
    event.preventDefault();

    if (AppState.authLoading) return;

    const username = document.getElementById('login-username')?.value?.trim();
    const password = document.getElementById('login-password')?.value;

    if (!username || !password) {
        AppState.authError = 'Please enter both email and password.';
        renderPage(AppState.currentPage);
        return;
    }

    AppState.authLoading = true;
    AppState.authError = '';
    renderPage(AppState.currentPage);

    try {
        const result = await window.api.auth.login(username, password);
        if (!result?.success) {
            AppState.authError = result?.error || 'Login failed. Please verify your credentials.';
        } else {
            AppState.isLoading = true;
        }
    } catch (error) {
        AppState.authError = 'Login failed. Please try again.';
    } finally {
        AppState.authLoading = false;
        renderPage(AppState.currentPage);
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
        <div class="card-grid">${artistCards}</div>
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
        <div class="card-grid">${stationCards}</div>
      </section>`;
    }

    if (!songs?.length && !artists?.length && !stations?.length) {
        html += createEmptyState('No results found', `No results for "${AppState.searchQuery}"`);
    }

    html += '</div>';
    DOM.pageContent.innerHTML = html;

    // Attach click handlers
    document.querySelectorAll('#search-songs .track-row').forEach((row, index) => {
        row.addEventListener('click', () => {
            if (songs[index]) {
                window.api.content.playItem(songs[index]);
            }
        });
    });
}

function renderLibraryPage() {
    let cardsHtml = '';
    AppState.stations.forEach(station => {
        cardsHtml += createCard(
            station.image,
            station.name,
            station.type === 'playlist' ? 'Playlist' : 'Station'
        );
    });

    DOM.pageContent.innerHTML = `
    <section class="fade-in">
      <h2 class="section-title">Your Library</h2>
      <div class="card-grid">
        ${cardsHtml || createEmptyState('Library Empty', 'Your saved content will appear here')}
      </div>
    </section>`;

    // Attach click handlers
    document.querySelectorAll('.card').forEach((card, index) => {
        card.addEventListener('click', () => {
            if (AppState.stations[index]) {
                playStation(AppState.stations[index]);
            }
        });
    });
}

function renderNowPlayingPage() {
    const { track, artist, album, coverArt, time, duration, isPlaying } = AppState.playerState;

    const tuneOptions = [
        { id: 'mystation', label: 'My Station' },
        { id: 'crowdfaves', label: 'Crowd Faves' },
        { id: 'discovery', label: 'Discovery' },
        { id: 'deepcuts', label: 'Deep Cuts' },
        { id: 'newlyreleased', label: 'Newly Released' },
        { id: 'artistonly', label: 'Artist Only' },
        { id: 'energyboost', label: 'Energy Boost' },
        { id: 'relax', label: 'Relax' }
    ];

    const tuneOptionsHtml = tuneOptions.map(opt => `
        <button class="tune-option" data-tune="${opt.id}">
            ${opt.label}
        </button>
    `).join('');

    DOM.pageContent.innerHTML = `
    <div class="now-playing-page fade-in">
        <button class="back-btn" id="np-back-btn">← Back</button>
        
        <div class="np-content">
            <div class="np-left">
                <div class="np-artwork">
                    <img src="${coverArt || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"%3E%3Crect fill="%23333" width="300" height="300"/%3E%3Ctext x="150" y="160" text-anchor="middle" fill="%23666" font-size="48"%3E♪%3C/text%3E%3C/svg%3E'}" alt="Album Art" />
                </div>
                <div class="np-track-info">
                    <h2 class="np-track">${track || 'Not Playing'}</h2>
                    <p class="np-artist">${artist || 'Select a station'}</p>
                    <p class="np-album">${album || ''}</p>
                </div>
                
                <div class="np-controls">
                    <button class="np-ctrl-btn" id="np-thumbdown" title="Thumbs Down">-</button>
                    <button class="np-ctrl-btn" id="np-prev" title="Previous">|◀</button>
                    <button class="np-ctrl-btn np-play-btn" id="np-play">${isPlaying ? '| |' : '▶'}</button>
                    <button class="np-ctrl-btn" id="np-next" title="Next">▶|</button>
                    <button class="np-ctrl-btn" id="np-thumbup" title="Thumbs Up">+</button>
                </div>
                
                <div class="np-progress">
                    <span class="np-time">${formatTime(time)}</span>
                    <div class="np-progress-bar">
                        <div class="np-progress-fill" style="width: ${duration > 0 ? (time / duration) * 100 : 0}%"></div>
                    </div>
                    <span class="np-time">${formatTime(duration)}</span>
                </div>
            </div>
            
            <div class="np-right">
                <h3 class="tune-title">TUNE YOUR STATION</h3>
                <div class="tune-options">
                    ${tuneOptionsHtml}
                </div>
            </div>
        </div>
    </div>`;

    // Attach event handlers
    document.getElementById('np-back-btn')?.addEventListener('click', () => renderPage('home'));
    document.getElementById('np-play')?.addEventListener('click', () => window.api.player.toggle());
    document.getElementById('np-next')?.addEventListener('click', () => window.api.player.next());
    document.getElementById('np-prev')?.addEventListener('click', () => window.api.player.prev());
    document.getElementById('np-thumbup')?.addEventListener('click', () => window.api.player.thumbUp());
    document.getElementById('np-thumbdown')?.addEventListener('click', () => window.api.player.thumbDown());

    // Tune option handlers
    document.querySelectorAll('.tune-option').forEach(btn => {
        btn.addEventListener('click', () => {
            const tuneMode = btn.dataset.tune;
            window.api.player.tuneStation(tuneMode);
            // Update active state
            document.querySelectorAll('.tune-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
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
    });
}

// ============================================================================
// Player State Updates
// ============================================================================

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

    // Update play/pause button
    if (state.isPlaying !== undefined) {
        DOM.playIcon.innerHTML = state.isPlaying
            ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
            : '<path d="M8 5v14l11-7z"/>';
        DOM.playPauseBtn.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
    }

    // Update progress
    if (state.duration > 0) {
        const progress = (state.time / state.duration) * 100;
        DOM.progressFill.style.width = `${progress}%`;
        DOM.currentTime.textContent = formatTime(state.time);
        DOM.totalTime.textContent = formatTime(state.duration);
    }

    // Update shuffle/repeat
    if (state.shuffle !== undefined) {
        DOM.shuffleBtn.classList.toggle('active', state.shuffle);
    }
    if (state.repeat !== undefined) {
        DOM.repeatBtn.classList.toggle('active', state.repeat);
    }
}

function initAudioPlayer() {
    if (AudioState.element) return;

    AudioState.element = new Audio();
    AudioState.element.preload = 'auto';
    AudioState.element.volume = AppState.playerState.volume / 100;

    AudioState.element.addEventListener('play', () => {
        updatePlayerUI({ isPlaying: true });
    });

    AudioState.element.addEventListener('pause', () => {
        updatePlayerUI({ isPlaying: false });
    });

    AudioState.element.addEventListener('timeupdate', () => {
        updatePlayerUI({
            time: AudioState.element.currentTime || 0,
            duration: AudioState.element.duration || AppState.playerState.duration || 0
        });
    });

    AudioState.element.addEventListener('ended', async () => {
        await window.api.player.next();
    });

    AudioState.element.addEventListener('error', (event) => {
        console.error('[UI] Audio playback error:', event);
    });
}

async function syncAudioPlaybackFromState(state) {
    if (!AudioState.element) return;

    if (state.audioURL && state.audioURL !== AudioState.currentURL) {
        AudioState.currentURL = state.audioURL;
        AudioState.element.src = state.audioURL;
        AudioState.element.currentTime = 0;

        try {
            await AudioState.element.play();
        } catch (error) {
            console.error('[UI] Autoplay blocked/failed:', error);
        }
    }
}

// ============================================================================
// Player Controls
// ============================================================================

function playStation(station) {
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

    // Search input
    DOM.searchInput.addEventListener('input', (e) => {
        debouncedSearch(e.target.value);
    });

    // Player controls
    DOM.playPauseBtn.addEventListener('click', async () => {
        if (!AudioState.element) return;

        if (AudioState.element.paused) {
            try {
                await AudioState.element.play();
            } catch (error) {
                console.error('[UI] Play failed:', error);
            }
            return;
        }

        AudioState.element.pause();
    });
    DOM.prevBtn.addEventListener('click', () => window.api.player.prev());
    DOM.nextBtn.addEventListener('click', () => window.api.player.next());
    DOM.shuffleBtn.addEventListener('click', () => window.api.player.shuffle());
    DOM.repeatBtn.addEventListener('click', () => window.api.player.repeat());
    DOM.heartBtn.addEventListener('click', () => {
        DOM.heartBtn.classList.toggle('liked');
        window.api.player.thumbUp();
    });

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

    // Volume
    DOM.volumeSlider.addEventListener('input', (e) => {
        const volume = parseInt(e.target.value);
        AppState.playerState.volume = volume;
        if (AudioState.element) {
            AudioState.element.volume = volume / 100;
        }
        window.api.player.setVolume(volume);
    });

    // Progress bar seeking
    DOM.progressBar.addEventListener('click', (e) => {
        const rect = DOM.progressBar.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        const seekTime = percent * AppState.playerState.duration;
        if (AudioState.element && !isNaN(seekTime)) {
            AudioState.element.currentTime = seekTime;
        }
        window.api.player.seek(seekTime);
    });
}

// ============================================================================
// API Event Handlers
// ============================================================================

function initAPIListeners() {
    // Player state updates
    window.api.onState(async (state) => {
        await syncAudioPlaybackFromState(state);

        const normalizedState = { ...state };
        delete normalizedState.isPlaying;
        updatePlayerUI(normalizedState);
    });

    // Collection/stations data
    window.api.onCollection((data) => {
        console.log('[UI] Received collection data:', data);
        AppState.stations = data || [];
        AppState.isLoading = false;
        renderStationsList();
        if (AppState.currentPage === 'home' || AppState.currentPage === 'library') {
            renderPage(AppState.currentPage);
        }
    });

    // Search results
    window.api.onSearchResults((data) => {
        console.log('[UI] Received search results:', data);
        AppState.searchResults = data;
        if (AppState.currentPage === 'search') {
            renderSearchPage();
        }
    });

    // Login status - only update when status actually changes
    window.api.onLoginStatus((status) => {
        const wasLoggedIn = AppState.isLoggedIn;
        const statusChanged = wasLoggedIn !== status.isLoggedIn;

        AppState.isLoggedIn = status.isLoggedIn;
        AppState.authLoading = false;

        // If we just detected login for the first time, fetch collection
        if (status.isLoggedIn && !wasLoggedIn) {
            console.log('[UI] User logged in, waiting for station collection...');
            AppState.isLoading = true;
            AppState.authError = '';
            renderPage(AppState.currentPage);
            return;
        }

        // Show login screen whenever we're logged out
        if (!status.isLoggedIn) {
            AppState.isLoading = false;
            if (statusChanged) {
                AppState.authError = '';
            }
            renderPage(AppState.currentPage);
        }
    });
}

// ============================================================================
// Initialize Application
// ============================================================================

async function init() {
    console.log('[UI] Initializing Pandora Glass...');

    initAudioPlayer();
    initEventListeners();
    initAPIListeners();

    // Request initial data
    const initResult = await window.api.init();
    if (initResult?.status === 'needsLogin') {
        AppState.isLoading = false;
    }

    // Render initial page
    renderPage('home');
}

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', init);
