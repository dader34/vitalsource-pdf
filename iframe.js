/**
 * VitalSource PDF Downloader - Iframe Script
 * Injected into all iframes to capture page images.
 */

(function () {
    'use strict';

    const currentUrl = window.location.href;

    function findPageImage() {
        // Primary selector used by VitalSource
        const primary = document.querySelector('img#pbk-page');
        if (primary) return primary;

        // Fallback: look for large images that are likely book page renders
        const images = document.querySelectorAll('img');
        for (const img of images) {
            if (img.naturalWidth > 400 && img.naturalHeight > 400) {
                return img;
            }
        }

        return null;
    }

    function hasPageImage() {
        return !!findPageImage();
    }

    function sendToParent(message) {
        try {
            window.top.postMessage(message, '*');
        } catch {
            window.parent.postMessage(message, '*');
        }
    }

    function forwardToChildren(message) {
        document.querySelectorAll('iframe').forEach((iframe) => {
            try { iframe.contentWindow.postMessage(message, '*'); } catch {}
        });

        const mosaicBook = document.querySelector('mosaic-book');
        if (mosaicBook?.shadowRoot) {
            mosaicBook.shadowRoot.querySelectorAll('iframe').forEach((iframe) => {
                try { iframe.contentWindow.postMessage(message, '*'); } catch {}
            });
        }
    }

    async function captureImage(img) {
        if (!img.complete || img.naturalWidth === 0) {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Image load timeout')), 10000);
                img.onload = () => { clearTimeout(timeout); resolve(); };
                img.onerror = () => { clearTimeout(timeout); reject(new Error('Image failed to load')); };
            });
        }

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const result = {
            data: canvas.toDataURL('image/jpeg', 0.92),
            width: img.naturalWidth,
            height: img.naturalHeight,
        };

        // Explicitly release canvas memory
        canvas.width = 0;
        canvas.height = 0;

        return result;
    }

    // Accept messages from any origin since parent page and iframes
    // may be on different domains (school subdomains, CDNs, etc.)
    window.addEventListener('message', async (event) => {
        const { type, requestId } = event.data || {};
        if (!type || !type.startsWith('VS_') || !requestId) return;

        if (type === 'VS_CAPTURE_PAGE') {
            const pageImg = findPageImage();
            if (pageImg) {
                try {
                    const imageData = await captureImage(pageImg);
                    sendToParent({ type: 'VS_PAGE_CAPTURED', requestId, success: true, data: imageData });
                } catch (error) {
                    sendToParent({ type: 'VS_PAGE_CAPTURED', requestId, success: false, error: error.message });
                }
            }
            forwardToChildren(event.data);
        }

        if (type === 'VS_PING') {
            sendToParent({ type: 'VS_PONG', requestId, hasImage: hasPageImage(), url: currentUrl });
            forwardToChildren(event.data);
        }
    });

    // Announce readiness multiple times for late-loading content, but only if we have an image
    const announceReady = () => {
        if (hasPageImage()) {
            sendToParent({ type: 'VS_IFRAME_READY', hasImage: true, url: currentUrl });
        }
    };
    [100, 500, 1000, 2000].forEach((delay) => setTimeout(announceReady, delay));
})();
