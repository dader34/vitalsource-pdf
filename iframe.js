/**
 * VitalSource PDF Downloader - Iframe Script
 * Injected into all iframes to capture page images.
 */

(function () {
    'use strict';

    const currentUrl = window.location.href;

    function hasPageImage() {
        return !!document.querySelector('img#pbk-page');
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
        canvas.getContext('2d').drawImage(img, 0, 0);

        return {
            data: canvas.toDataURL('image/jpeg', 0.92),
            width: img.naturalWidth,
            height: img.naturalHeight,
        };
    }

    window.addEventListener('message', async (event) => {
        if (!(event.origin || '').includes('vitalsource.com')) return;

        const { type, requestId } = event.data || {};
        if (!type || !requestId) return;

        if (type === 'VS_CAPTURE_PAGE') {
            const pageImg = document.querySelector('img#pbk-page');
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

    // Announce readiness multiple times for late-loading content
    const announceReady = () => {
        sendToParent({ type: 'VS_IFRAME_READY', hasImage: hasPageImage(), url: currentUrl });
    };
    [100, 500, 1000, 2000].forEach((delay) => setTimeout(announceReady, delay));

    console.log('[VS-PDF] Iframe script loaded:', { url: currentUrl, hasImage: hasPageImage() });
})();
