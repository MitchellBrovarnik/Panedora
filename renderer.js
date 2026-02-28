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
    isLoggedIn: false
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
        case 'settings':
            renderSettingsPage();
            break;
        default:
            renderHomePage();
    }
}

function renderHomePage() {
    console.log('[UI] Rendering Home Page');
    console.trace('renderHomePage called from:');
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
        <p class="welcome-subtitle">Enter your Pandora credentials to continue.</p>
        <form id="login-form" style="display: flex; flex-direction: column; gap: 12px; max-width: 320px; margin: 24px auto 0;">
            <input type="email" id="login-email" placeholder="Email" required
                style="padding: 10px 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.06); color: #fff; font-size: 14px; outline: none;">
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
                        errorEl.textContent = 'Incorrect email or password.';
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
                console.log('[UI] Station search click:', JSON.stringify(s));
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
            '--accent-soft': 'rgba(124, 91, 245, 0.12)'
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
            '--accent-soft': 'rgba(59, 130, 246, 0.12)'
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
            '--accent-soft': 'rgba(16, 185, 129, 0.12)'
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
            '--accent-soft': 'rgba(249, 115, 22, 0.12)'
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
            '--accent-soft': 'rgba(236, 72, 153, 0.12)'
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
            '--accent-soft': 'rgba(103, 232, 249, 0.12)'
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
            '--accent-soft': 'rgba(34, 211, 238, 0.12)'
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
            '--accent-soft': 'rgba(29, 185, 84, 0.12)'
        }
    }
};

function applyTheme(themeId) {
    const theme = THEMES[themeId];
    if (!theme) return;

    const root = document.documentElement;
    Object.entries(theme.vars).forEach(([prop, value]) => {
        root.style.setProperty(prop, value);
    });

    localStorage.setItem('pandora-glass-theme', themeId);
    AppState.currentTheme = themeId;
    console.log(`[UI] Theme applied: ${theme.name}`);
}

function loadSavedTheme() {
    const saved = localStorage.getItem('pandora-glass-theme');
    if (saved && THEMES[saved]) {
        applyTheme(saved);
    }
}

function renderSettingsPage() {
    const currentTheme = AppState.currentTheme || localStorage.getItem('pandora-glass-theme') || 'midnight';

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

    DOM.pageContent.innerHTML = `
    <div class="fade-in">
      <section class="settings-section">
        <h2 class="section-title">Appearance</h2>
        <p class="settings-description">Choose a theme to personalize your experience.</p>
        <div class="theme-grid">${themeSwatches}</div>
      </section>
    </div>`;

    // Attach click handlers
    document.querySelectorAll('.theme-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
            const themeId = btn.dataset.theme;
            applyTheme(themeId);
            renderSettingsPage();
        });
    });
}

function renderNowPlayingPage() {
    const { track, artist, album, coverArt, time, duration, isPlaying } = AppState.playerState;


    // Build history section
    let pastSongs = [...(AppState.playerState.history || [])];
    if (pastSongs.length > 0 && pastSongs[pastSongs.length - 1].trackToken === AppState.playerState.trackToken) {
        pastSongs.pop(); // Remove currently playing song
    }
    pastSongs.reverse(); // Show newest first
    let historyHtml = '';
    if (pastSongs.length > 0) {
        historyHtml = `
            <div class="np-history">
                <h3 class="tune-title">RECENTLY PLAYED</h3>
                <div class="history-list">
                    ${pastSongs.map(h => `
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
                    `).join('')}
                </div>
            </div>
        `;
    }

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

    // Thumb up — toggle liked state & call API or Undo
    document.getElementById('np-thumbup')?.addEventListener('click', function () {
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

    // Update progress (only if we don't have a live audio element overriding it)
    const audioEl = document.querySelector('audio');
    if (state.duration > 0 && !audioEl) {
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

            if (pastSongs.length > 0) {
                const histDiv = document.createElement('div');
                histDiv.className = 'np-history';
                histDiv.innerHTML = `
                    <h3 class="tune-title">RECENTLY PLAYED</h3>
                    <div class="history-list">
                        ${pastSongs.map(h => `
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
                        `).join('')}
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
    DOM.nextBtn.addEventListener('click', () => window.api.player.next());
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

    // Previous track button logic (Reset audio to 0, or skip to previous track)
    DOM.prevBtn.addEventListener('click', () => {
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
        // Also set volume directly on the audio element
        const audioEl = document.querySelector('audio');
        if (audioEl) audioEl.volume = vol;
    });

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

    // Player state updates
    window.api.onState((state) => {
        updatePlayerUI(state);

        // Audio Playback override
        if (state.audioURL) {
            if (!currentAudio) {
                console.log('[UI] Creating new Audio instance');
                currentAudio = document.createElement('audio');
                document.body.appendChild(currentAudio);

                // Sync time with UI
                currentAudio.addEventListener('timeupdate', () => {
                    if (!AppState.playerState.isPlaying) return;
                    const progress = (currentAudio.currentTime / currentAudio.duration) * 100;
                    DOM.progressFill.style.width = `${progress}%`;
                    DOM.currentTime.textContent = formatTime(currentAudio.currentTime);
                    DOM.totalTime.textContent = formatTime(currentAudio.duration || 0);
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

                    // Only auto-skip if we are actually logged in and trying to play
                    if (AppState.isLoggedIn) {
                        setTimeout(() => window.api.player.next(), 2000);
                    }
                });
            }

            // Only update source and play if the URL actually changed
            if (currentAudio.src !== state.audioURL) {
                console.log('[UI] Loading new audioURL into existing Audio instance');
                console.log('[UI] audioURL:', state.audioURL.substring(0, 80) + '...');
                console.log('[UI] isPlaying:', AppState.playerState.isPlaying);
                currentAudio.src = state.audioURL;
                currentAudio.play().then(() => {
                    console.log('[UI] Audio play() succeeded!');
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

        // Update large text if on Now Playing page
        const largeTitle = document.getElementById('np-large-title');
        if (largeTitle && state.track) largeTitle.textContent = state.track;

        const largeArtist = document.getElementById('np-large-artist');
        if (largeArtist && state.artist) largeArtist.textContent = state.artist;

        const largeAlbum = document.getElementById('np-large-album');
        if (largeAlbum && state.album) largeAlbum.textContent = state.album;
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
        console.log('[UI] Received search results:', data);
        AppState.searchResults = data;
        if (AppState.currentPage === 'search') {
            renderSearchPage();
        }
    });

    // Login status updates
    window.api.onLoginStatus((status) => {
        console.log('[UI] Login status received:', status.isLoggedIn, '(was:', AppState.isLoggedIn, ')');
        AppState.isLoggedIn = status.isLoggedIn;

        if (status.isLoggedIn) {
            // Successfully logged in — backend will soon send UI:COLLECTION
            console.log('[UI] User logged in, waiting for collection...');
            AppState.isLoading = false;
            renderPage('home');
        } else {
            // Logged out — clear data, pause audio, and show login form
            console.log('[UI] User logged out, showing login form...');
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
}

// ============================================================================
// Initialize Application
// ============================================================================

async function init() {
    console.log('[UI] Initializing Pandora Glass...');

    // Restore saved theme before rendering
    loadSavedTheme();

    initEventListeners();
    initAPIListeners();

    // Request initial data
    await window.api.init();

    // Render initial page
    renderPage('home');
}

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', init);
