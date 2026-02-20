// Pandora Glass Injection Script

console.log('[Glass] Injection script loaded');

// Enhanced Ad Blocker & Utility
const observer = new MutationObserver((mutations) => {
    // 1. Remove Ads
    const adElements = document.querySelectorAll('.UpgradeButton, .UpgradeLink, .DisplayAd, #ad-container, [data-qa="upgrade_button"]');
    adElements.forEach(el => {
        if (el.style.display !== 'none') {
            console.log('[Glass] Removing ad element:', el.className);
            el.style.display = 'none';
            el.remove();
        }
    });

    // 2. Auto-Click "Still Listening?"
    const stillListeningBtn = document.querySelector('.StillListeningBody__button');
    if (stillListeningBtn) {
        console.log('[Glass] Auto-clicking "Still Listening?" button');
        stillListeningBtn.click();
    }

    // 3. Auto-Click "Skip Ad" (if video ad appears?)
    // Note: Video ads are harder, but we'll try to find skip buttons
    const skipBtn = document.querySelector('.VideoAd__skipButton');
    if (skipBtn) {
        console.log('[Glass] Auto-clicking "Skip Ad" button');
        skipBtn.click();
    }
});

// Start observing DOM changes
observer.observe(document.body, {
    childList: true,
    subtree: true
});

// Initial cleanup
setTimeout(() => {
    console.log('[Glass] Initial cleanup run');
    // Force specific tweaks if needed
}, 2000);
