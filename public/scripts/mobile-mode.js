const MOBILE_MODE_CLASS = 'st-mobile-mode';
const MOBILE_MODE_QUERY = '(max-width: 768px)';

let initialized = false;
let mediaQuery = null;

function applyMobileMode() {
    document.body.classList.toggle(MOBILE_MODE_CLASS, mediaQuery.matches);
}

function handleViewportChange() {
    applyMobileMode();
}

export function initMobileMode() {
    if (initialized) {
        return;
    }

    initialized = true;
    mediaQuery = window.matchMedia(MOBILE_MODE_QUERY);

    applyMobileMode();

    if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleViewportChange);
    } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(handleViewportChange);
    }

    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.addEventListener('orientationchange', handleViewportChange, { passive: true });
}
