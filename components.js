/**
 * Panedora - UI Components
 * Helper functions for generating Spotify-style UI elements
 */

function createCard(image, title, subtitle, dataId) {
  const placeholder = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Crect fill='%23282828' width='180' height='180'/%3E%3C/svg%3E`;
  const id = `card_${Math.random().toString(36).substr(2, 9)}`;

  return `
    <div class="card" id="${id}" data-id="${dataId || ''}" tabindex="0">
      <div class="card-image-container">
        <img class="card-image" src="${image || placeholder}" alt="${title}">
        <button class="card-play-button" aria-label="Play ${title}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
      <div class="card-content">
        <h3 class="card-title">${escapeHtml(title)}</h3>
        <p class="card-subtitle">${escapeHtml(subtitle)}</p>
      </div>
    </div>`;
}

function createTrackRow(index, title, artist, duration, coverArt, dataId) {
  const placeholder = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect fill='%23282828' width='40' height='40'/%3E%3C/svg%3E`;
  const id = `track_${Math.random().toString(36).substr(2, 9)}`;

  return `
    <div class="track-row" id="${id}" data-id="${dataId || ''}" tabindex="0">
      <div class="track-number"><span>${index}</span></div>
      <div class="track-info">
        <img class="track-art" src="${coverArt || placeholder}" alt="">
        <div class="track-details">
          <span class="track-title">${escapeHtml(title)}</span>
          <span class="track-artist">${escapeHtml(artist)}</span>
        </div>
      </div>
      <div class="track-duration">${duration || '--:--'}</div>
    </div>`;
}

function createStationListItem(name, id, type, isActive = false) {
  return `
    <div class="station-item ${isActive ? 'active' : ''}" data-id="${id}" data-type="${type}" tabindex="0">
      <span class="station-name">${escapeHtml(name)}</span>
      <button class="delete-btn" title="Delete Station">×</button>
    </div>`;
}

function createLoadingSpinner(message = 'Loading...') {
  return `<div class="loading-container"><div class="loading-spinner"></div><p>${escapeHtml(message)}</p></div>`;
}

function createEmptyState(title, message) {
  return `<div class="empty-state"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}
