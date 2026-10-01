// Wait for DOM to load
document.addEventListener('DOMContentLoaded', () => {
    // Navbar scroll effect
    const navbar = document.querySelector('.navbar');

    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    });

    // Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();

            const targetId = this.getAttribute('href');
            if (targetId === '#') return;

            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                // Adjust for fixed navbar height
                const navbarHeight = document.querySelector('.navbar').offsetHeight;
                const targetPosition = targetElement.getBoundingClientRect().top + window.scrollY - navbarHeight;

                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });

    // Intersection Observer for scroll animations
    const revealElements = document.querySelectorAll('.reveal');

    const revealOptions = {
        threshold: 0.15,
        rootMargin: "0px 0px -50px 0px"
    };

    const revealOnScroll = new IntersectionObserver(function(entries, observer) {
        entries.forEach(entry => {
            if (!entry.isIntersecting) {
                return;
            } else {
                entry.target.classList.add('active');
                observer.unobserve(entry.target);
            }
        });
    }, revealOptions);

    revealElements.forEach(el => {
        revealOnScroll.observe(el);
    });

    // Add subtle parallax effect to orbs based on mouse movement
    let mouseX = 0;
    let mouseY = 0;
    let isMouseMoving = false;
    const orbs = document.querySelectorAll('.orb');

    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;

        if (!isMouseMoving) {
            isMouseMoving = true;
            requestAnimationFrame(updateOrbs);
        }
    });

    function updateOrbs() {
        orbs.forEach((orb, index) => {
            const speed = (index + 1) * 20;
            const xOffset = (window.innerWidth / 2 - mouseX) / speed;
            const yOffset = (window.innerHeight / 2 - mouseY) / speed;

            orb.style.transform = `translate(${xOffset}px, ${yOffset}px)`;
        });
        isMouseMoving = false;
    }

    // Reset orb transform on mouse leave to let CSS animation take over smoothly
    document.addEventListener('mouseleave', () => {
        orbs.forEach(orb => {
            orb.style.transform = '';
        });
    });

    // Fetch latest release and update download links
    const releasePage = 'https://github.com/MitchellBrovarnik/Panedora/releases/latest';
    const isDownload = asset => typeof asset?.browser_download_url === 'string' &&
        asset.browser_download_url.startsWith('https://github.com/MitchellBrovarnik/Panedora/releases/download/');
    fetch('https://api.github.com/repos/MitchellBrovarnik/Panedora/releases/latest', { credentials: 'omit', referrerPolicy: 'no-referrer' })
        .then(res => {
            if (!res.ok) throw new Error('Release check unavailable');
            return res.json();
        })
        .then(release => {
            if (release.draft !== false || release.prerelease !== false) return;
            const assets = Array.isArray(release.assets) ? release.assets.filter(a => typeof a?.name === 'string' && isDownload(a)) : [];
            const winAsset = assets.find(a => a.name.endsWith('.exe'));
            const macAssets = assets.filter(a => a.name.endsWith('.dmg'));
            const linuxAsset = assets.find(a => a.name.endsWith('.AppImage'));

            if (winAsset) document.getElementById('download-win').href = winAsset.browser_download_url;
            const mac = document.getElementById('download-mac');
            if (macAssets.length === 1) {
                mac.href = macAssets[0].browser_download_url;
                const architecture = /arm64/i.test(macAssets[0].name) ? 'Apple Silicon'
                    : /(?:x64|amd64)/i.test(macAssets[0].name) ? 'Intel' : '';
                mac.querySelector('.download-btn').textContent = 'Download .dmg' + (architecture ? ' · ' + architecture : '');
                if (architecture) mac.setAttribute('aria-label', 'Download Panedora for macOS (' + architecture + ')');
            } else if (macAssets.length > 1) {
                mac.href = releasePage;
                mac.querySelector('.download-btn').textContent = 'Choose a macOS build';
            }
            if (linuxAsset) document.getElementById('download-linux').href = linuxAsset.browser_download_url;
            if (typeof release.tag_name === 'string' && /^v?\d+\.\d+\.\d+$/i.test(release.tag_name)) {
                document.getElementById('latest-release-label').textContent = 'Latest release: ' + release.tag_name;
            }
        })
        .catch(() => {});
});
