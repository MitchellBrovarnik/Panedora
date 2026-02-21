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
                        // The onLoginStatus handler will take care of rendering home
                    } else {
                        errorEl.textContent = 'Incorrect email or password.';
                        errorEl.style.display = 'block';
                        submitBtn.textContent = 'Sign In';
                        submitBtn.disabled = false;
                        // Only clear password, keep email
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
                <h3 class="tune-title">TUNE YOUR STATION</h3>
                <div class="tune-options">
                    ${tuneOptionsHtml}
                </div>

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

    initEventListeners();
    initAPIListeners();

    // Request initial data
    await window.api.init();

    // Render initial page
    renderPage('home');
}

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', init);
