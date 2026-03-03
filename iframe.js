/**
 * VitalSource PDF Downloader - Iframe Script
 * Injected into all iframes to capture page images and EPUB content.
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

    function isEpubContent() {
        if (currentUrl.includes('/epub/')) return true;
        if (document.querySelector('[epub\\:type]')) return true;
        if (document.querySelector('.epub-content, .chapter-content')) return true;
        return document.body?.children.length > 0
            && !findPageImage()
            && document.body.innerText.trim().length > 100;
    }

    function hasContent() {
        return hasPageImage() || isEpubContent();
    }

    function getContentType() {
        if (hasPageImage()) return 'image';
        if (isEpubContent()) return 'epub';
        return null;
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

    function findContentBottom() {
        // Find the actual bottom of visible content, ignoring CSS padding/min-height
        let maxBottom = 0;
        const blocks = document.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, section, blockquote, ul, ol, table, figure, img, hr, pre, span');
        for (const el of blocks) {
            const rect = el.getBoundingClientRect();
            if (rect.height === 0 || rect.width === 0) continue;
            // Check if the element has actual content (text or images)
            if (!el.innerText?.trim() && !el.querySelector('img')) continue;
            const bottom = rect.bottom + window.scrollY;
            if (bottom > maxBottom) maxBottom = bottom;
        }
        return maxBottom || document.documentElement.scrollHeight;
    }

    function getLines(el) {
        // Get line boxes inside an element: [{top, bottom}, ...].
        // Uses getClientRects which returns one rect per line fragment — fast.
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects());

        const lines = [];
        let lastTop = -Infinity;
        for (const r of rects) {
            const top = Math.round(r.top + window.scrollY);
            const bottom = Math.round(r.bottom + window.scrollY);
            if (top - lastTop > 2) { // new line if >2px apart
                lines.push({ top, bottom });
                lastTop = top;
            } else if (lines.length > 0) {
                // Same line — extend bottom if needed
                lines[lines.length - 1].bottom = Math.max(lines[lines.length - 1].bottom, bottom);
            }
        }
        return lines;
    }

    function findPageBreaks(captureHeight, contentBottom) {
        // Walk block-level elements and find Y positions where we can break
        // between elements. When a single element is taller than a page,
        // break between text lines inside it.
        const breaks = [0];
        let currentPageStart = 0;

        const blocks = document.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, section, blockquote, ul, ol, table, figure, img, hr, pre');
        const seen = new Set();

        for (const el of blocks) {
            if (seen.has(el)) continue;
            let parent = el.parentElement;
            let isNested = false;
            while (parent && parent !== document.body) {
                if (seen.has(parent)) { isNested = true; break; }
                parent = parent.parentElement;
            }
            if (isNested) continue;
            seen.add(el);

            const rect = el.getBoundingClientRect();
            const elTop = rect.top + window.scrollY;
            const elBottom = rect.bottom + window.scrollY;

            if (elTop >= contentBottom) break;

            // Does this element overflow the current page?
            if (elBottom - currentPageStart > captureHeight && elTop > currentPageStart) {
                if (elBottom - elTop <= captureHeight) {
                    // Element fits on one page — break before it
                    currentPageStart = elTop;
                    breaks.push(currentPageStart);
                } else {
                    // Element taller than a page — find line-level breaks
                    const lines = getLines(el);

                    if (elTop > currentPageStart) {
                        currentPageStart = elTop;
                        breaks.push(currentPageStart);
                    }

                    // Find lines where bottom exceeds the page
                    let prevLine = null;
                    for (const line of lines) {
                        if (line.bottom - currentPageStart > captureHeight) {
                            // Break just below the previous line's bottom so its
                            // descenders are fully included on the current page
                            const breakY = prevLine
                                ? prevLine.bottom + 2
                                : line.top;
                            currentPageStart = breakY;
                            breaks.push(currentPageStart);
                        }
                        prevLine = line;
                    }
                }
            }
        }

        return breaks;
    }

    function isBlankCanvas(canvas) {
        // Scan horizontal stripes across the canvas to detect blank pages.
        // Check every 50th row, sampling 20 pixels per row.
        const ctx = canvas.getContext('2d');
        const step = Math.max(1, Math.floor(canvas.height / 20));
        for (let row = 0; row < canvas.height; row += step) {
            const colStep = Math.max(1, Math.floor(canvas.width / 20));
            for (let col = 0; col < canvas.width; col += colStep) {
                const pixel = ctx.getImageData(col, row, 1, 1).data;
                if (pixel[0] < 240 || pixel[1] < 240 || pixel[2] < 240) {
                    return false;
                }
            }
        }
        return true;
    }

    async function captureEpubContent() {
        // EPUB chapters can be very long scrollable documents. Capture the full
        // content as multiple viewport-sized chunks (one per PDF page).
        // Break between block elements to avoid cutting through sentences.
        const captureWidth = 800;
        const captureHeight = Math.round(captureWidth * (792 / 612)); // letter aspect ratio
        const contentBottom = findContentBottom();

        const breakPoints = findPageBreaks(captureHeight, contentBottom);
        const pages = [];

        for (let i = 0; i < breakPoints.length; i++) {
            const y = breakPoints[i];
            if (y >= contentBottom) break;

            const nextY = i + 1 < breakPoints.length ? breakPoints[i + 1] : contentBottom;
            // Extend 4px past the break to capture descenders of the last line
            const sliceHeight = Math.min(nextY - y, captureHeight);

            if (sliceHeight <= 10) continue;

            const canvas = await html2canvas(document.body, {
                useCORS: true,
                scale: 2,
                width: captureWidth,
                height: sliceHeight,
                windowWidth: captureWidth,
                windowHeight: captureHeight,
                x: 0,
                y: y,
                logging: false,
            });

            // Skip blank pages
            if (isBlankCanvas(canvas)) {
                canvas.width = 0;
                canvas.height = 0;
                continue;
            }

            pages.push({
                data: canvas.toDataURL('image/jpeg', 0.92),
                width: canvas.width,
                height: canvas.height,
            });

            // Release canvas memory
            canvas.width = 0;
            canvas.height = 0;
        }

        return pages;
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
            } else if (isEpubContent() && typeof html2canvas !== 'undefined') {
                try {
                    const pages = await captureEpubContent();
                    sendToParent({ type: 'VS_PAGE_CAPTURED', requestId, success: true, data: pages, isMultiPage: true });
                } catch (error) {
                    sendToParent({ type: 'VS_PAGE_CAPTURED', requestId, success: false, error: error.message });
                }
            }
            forwardToChildren(event.data);
        }

        if (type === 'VS_PING') {
            const contentType = getContentType();
            sendToParent({
                type: 'VS_PONG',
                requestId,
                hasImage: hasPageImage(),
                hasContent: hasContent(),
                contentType,
                url: currentUrl,
            });
            forwardToChildren(event.data);
        }
    });

    // Announce readiness multiple times for late-loading content
    const announceReady = () => {
        if (hasContent()) {
            const contentType = getContentType();
            sendToParent({
                type: 'VS_IFRAME_READY',
                hasImage: hasPageImage(),
                hasContent: true,
                contentType,
                url: currentUrl,
            });
        }
    };
    [100, 500, 1000, 2000].forEach((delay) => setTimeout(announceReady, delay));
})();
