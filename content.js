/**
 * VitalSource PDF Downloader - Main Content Script
 * Runs on bookshelf.vitalsource.com
 */

(function () {
    'use strict';

    if (!window.location.href.includes('/reader/books/')) return;

    console.log('[VS-PDF] Content script loaded');

    const state = {
        capturedPages: [],
        isRunning: false,
        readyFrames: [],
        pendingCaptures: {},
        modal: null,
    };

    // Message handling — accept messages from any origin since iframes
    // may be hosted on CDN domains outside vitalsource.com
    window.addEventListener('message', (event) => {
        const { type, requestId, success, data, error, hasImage, url } = event.data || {};
        if (!type || !type.startsWith('VS_')) return;

        if (type === 'VS_PAGE_CAPTURED' && requestId && state.pendingCaptures[requestId]) {
            const { resolve, reject } = state.pendingCaptures[requestId];
            delete state.pendingCaptures[requestId];
            success ? resolve(data) : reject(new Error(error || 'Capture failed'));
        }

        if (type === 'VS_PONG' && requestId && state.pendingCaptures[requestId] && hasImage) {
            const { resolve } = state.pendingCaptures[requestId];
            delete state.pendingCaptures[requestId];
            resolve({ hasImage, url });
        }

        if (type === 'VS_IFRAME_READY') {
            console.log('[VS-PDF] Frame ready:', { hasImage, url });
            state.readyFrames.push({ hasImage, url });
        }
    });

    // Helpers
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function sanitizeFilename(name) {
        return name.replace(/[^a-z0-9\s\-_]/gi, '').replace(/\s+/g, '_').substring(0, 50);
    }

    function getCurrentPageLabel() {
        const pageInput = document.querySelector('input[id^="text-field-"]');
        return pageInput?.value?.trim() || '';
    }

    function getBookTitle() {
        const titleEl = document.querySelector('h1, [data-testid="book-title"]');
        if (titleEl) return titleEl.textContent.trim();

        const pageTitle = document.title;
        if (pageTitle && pageTitle !== 'Bookshelf') return pageTitle.split('|')[0].trim();

        return null;
    }

    // Iframe communication
    function broadcastToIframes(message) {
        for (let i = 0; i < window.frames.length; i++) {
            try { window.frames[i].postMessage(message, '*'); } catch {}
        }
        document.querySelectorAll('iframe').forEach((iframe) => {
            try { iframe.contentWindow.postMessage(message, '*'); } catch {}
        });

        // Also check Shadow DOM (VitalSource uses <mosaic-book> with shadow root)
        const mosaicBook = document.querySelector('mosaic-book');
        if (mosaicBook?.shadowRoot) {
            mosaicBook.shadowRoot.querySelectorAll('iframe').forEach((iframe) => {
                try { iframe.contentWindow.postMessage(message, '*'); } catch {}
            });
        }

        // Generically search all elements with shadow roots for nested iframes
        document.querySelectorAll('*').forEach((el) => {
            if (el.shadowRoot) {
                el.shadowRoot.querySelectorAll('iframe').forEach((iframe) => {
                    try { iframe.contentWindow.postMessage(message, '*'); } catch {}
                });
            }
        });
    }

    async function pingIframe() {
        const readyWithImage = state.readyFrames.find((f) => f?.hasImage);
        if (readyWithImage) return readyWithImage;

        const requestId = 'ping_' + Date.now();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                delete state.pendingCaptures[requestId];
                const ready = state.readyFrames.find((f) => f?.hasImage);
                ready ? resolve(ready) : reject(new Error('No iframe with page image found. Try reloading.'));
            }, 5000);

            state.pendingCaptures[requestId] = {
                resolve: (info) => { clearTimeout(timeout); resolve(info); },
                reject,
            };

            broadcastToIframes({ type: 'VS_PING', requestId });
        });
    }

    async function captureCurrentPage() {
        const requestId = 'capture_' + Date.now();
        let resolved = false;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (resolved) return;
                delete state.pendingCaptures[requestId];
                reject(new Error('Capture timeout'));
            }, 15000);

            state.pendingCaptures[requestId] = {
                resolve: (data) => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeout);
                    delete state.pendingCaptures[requestId];
                    data.timestamp = Date.now();
                    data.pageLabel = getCurrentPageLabel();
                    resolve(data);
                },
                reject: (err) => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeout);
                    delete state.pendingCaptures[requestId];
                    reject(err);
                },
            };

            broadcastToIframes({ type: 'VS_CAPTURE_PAGE', requestId });
        });
    }

    async function goToNextPage() {
        const input = document.querySelector('input[id^="text-field-"]');
        if (!input) throw new Error('No page input found');

        const current = parseInt(input.value, 10);
        if (isNaN(current)) throw new Error('Cannot read current page');

        const next = current + 1;

        // Use the native setter to bypass React's controlled input
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, String(next));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.closest('form').dispatchEvent(new Event('submit', { bubbles: true }));

        await sleep(1500);

        // Check if we actually moved — if not, we're at the last page
        if (parseInt(input.value, 10) === current) {
            throw new Error('Last page');
        }
    }

    // PDF generation
    function calculateImageDimensions(imgWidth, imgHeight) {
        const pageWidth = 612, pageHeight = 792; // Letter size at 72 DPI
        const imgAspect = imgWidth / imgHeight;
        const pageAspect = pageWidth / pageHeight;

        if (imgAspect > pageAspect) {
            const drawWidth = pageWidth;
            const drawHeight = pageWidth / imgAspect;
            return { drawWidth, drawHeight, offsetX: 0, offsetY: (pageHeight - drawHeight) / 2 };
        } else {
            const drawHeight = pageHeight;
            const drawWidth = pageHeight * imgAspect;
            return { drawWidth, drawHeight, offsetX: (pageWidth - drawWidth) / 2, offsetY: 0 };
        }
    }

    async function downloadCurrentPageDirect() {
        try {
            if (!state.readyFrames.find((f) => f?.hasImage)) {
                await pingIframe();
            }

            const pageData = await captureCurrentPage();
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

            const dims = calculateImageDimensions(pageData.width, pageData.height);
            pdf.addImage(pageData.data, 'JPEG', dims.offsetX, dims.offsetY, dims.drawWidth, dims.drawHeight);

            const filename = sanitizeFilename(getBookTitle() || 'vitalsource');
            const pageLabel = pageData.pageLabel || getCurrentPageLabel() || '1';
            pdf.save(`${filename}_page${pageLabel}.pdf`);

            console.log('[VS-PDF] Downloaded page', pageLabel);
        } catch (e) {
            console.error('[VS-PDF] Download failed:', e);
            alert('Download failed: ' + e.message);
        }
    }

    async function generatePDF() {
        if (state.capturedPages.length === 0) {
            updateStatus('No pages captured!', 'error');
            return;
        }

        updateStatus('Generating PDF...');
        document.getElementById('vs-action').disabled = true;

        try {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

            state.capturedPages.forEach((page, i) => {
                if (i > 0) pdf.addPage('letter', 'portrait');

                const dims = calculateImageDimensions(page.width, page.height);
                pdf.addImage(page.data, 'JPEG', dims.offsetX, dims.offsetY, dims.drawWidth, dims.drawHeight);

                updateProgress(i + 1, state.capturedPages.length);
                updateStatus(`Building PDF: ${i + 1}/${state.capturedPages.length}`);
            });

            let filename = document.getElementById('vs-filename').value.trim();
            if (!filename) filename = sanitizeFilename(getBookTitle() || 'vitalsource-book');

            const firstLabel = state.capturedPages[0].pageLabel || '1';
            const lastLabel = state.capturedPages[state.capturedPages.length - 1].pageLabel || String(state.capturedPages.length);
            pdf.save(`${filename}_p${firstLabel}-${lastLabel}.pdf`);

            updateStatus(`<strong>Download started!</strong><br>${state.capturedPages.length} pages saved.`, 'success');
        } catch (e) {
            updateStatus(`PDF error: ${e.message}`, 'error');
        } finally {
            document.getElementById('vs-action').disabled = false;
            updateModalUI();
        }
    }

    // Capture workflow
    async function startCapture() {
        if (state.isRunning) return;
        state.isRunning = true;
        updateModalUI();

        const pageLimit = parseInt(document.getElementById('vs-page-limit').value, 10) || 10;

        updateStatus('Checking connection...');

        try {
            await pingIframe();
        } catch (e) {
            updateStatus(`Error: ${e.message}`, 'error');
            state.isRunning = false;
            updateModalUI();
            return;
        }

        updateStatus('Starting capture...');

        let captured = 0;
        while (state.isRunning && captured < pageLimit) {
            try {
                await sleep(500);
                const pageData = await captureCurrentPage();
                state.capturedPages.push(pageData);
                captured++;

                const label = pageData.pageLabel || `#${captured}`;
                updateModalUI();
                updateStatus(`Captured page ${label} (${captured}/${pageLimit})`);
                updateProgress(captured, pageLimit);

                if (captured >= pageLimit) {
                    updateStatus(`Done! ${state.capturedPages.length} pages captured.`, 'success');
                    break;
                }

                await goToNextPage();
            } catch (e) {
                if (e.message === 'Last page') {
                    updateStatus(`Done! ${state.capturedPages.length} pages captured.`, 'success');
                    break;
                }
                updateStatus(`Error on page ${captured + 1}: ${e.message}`, 'error');
                try { await goToNextPage(); } catch { break; }
            }
        }

        state.isRunning = false;
        updateModalUI();
    }

    // UI helpers
    function updateStatus(message, type = 'info') {
        const statusEl = document.getElementById('vs-status');
        const statusText = document.getElementById('vs-status-text');
        if (statusEl && statusText) {
            statusText.innerHTML = message;
            statusEl.className = 'status visible ' + type;
        }
        console.log('[VS-PDF]', message);
    }

    function updateProgress(current, total) {
        const bar = document.getElementById('vs-progress');
        if (bar && total > 0) bar.style.width = `${(current / total) * 100}%`;
    }

    function updateModalUI() {
        const actionBtn = document.getElementById('vs-action');
        const clearBtn = document.getElementById('vs-clear');
        document.getElementById('vs-page-count').textContent = state.capturedPages.length;

        if (state.capturedPages.length > 0) {
            clearBtn.style.display = 'block';
            actionBtn.textContent = state.isRunning ? 'Stop' : 'Download PDF';
        } else {
            clearBtn.style.display = 'none';
            actionBtn.textContent = state.isRunning ? 'Stop' : 'Start Capture';
        }
    }

    // UI: Choice Dialog
    function createChoiceDialog() {
        if (document.getElementById('vs-choice-dialog')) return;

        const dialog = document.createElement('div');
        dialog.id = 'vs-choice-dialog';
        dialog.innerHTML = `
            <style>
                #vs-choice-dialog {
                    display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                    background: rgba(0,0,0,0.6); z-index: 999999; align-items: center; justify-content: center;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }
                #vs-choice-dialog.visible { display: flex; }
                #vs-choice-dialog .dialog-content {
                    background: #fff; border-radius: 12px; padding: 24px; width: 320px; max-width: 90vw;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center;
                }
                #vs-choice-dialog h2 { margin: 0 0 20px; font-size: 18px; font-weight: 600; color: #1a1a1a; }
                #vs-choice-dialog .buttons { display: flex; flex-direction: column; gap: 12px; }
                #vs-choice-dialog button {
                    padding: 14px 20px; border: none; border-radius: 8px;
                    font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s;
                }
                #vs-choice-dialog .btn-primary { background: #4a90d9; color: white; }
                #vs-choice-dialog .btn-primary:hover { background: #3a7bc8; }
                #vs-choice-dialog .btn-secondary { background: #f0f0f0; color: #333; }
                #vs-choice-dialog .btn-secondary:hover { background: #e0e0e0; }
                #vs-choice-dialog .btn-cancel { background: transparent; color: #888; font-weight: 400; }
                #vs-choice-dialog .btn-cancel:hover { color: #333; }
                #vs-choice-dialog .page-info { color: #666; font-size: 13px; margin-bottom: 8px; }
            </style>
            <div class="dialog-content">
                <h2>Download PDF</h2>
                <div class="page-info">Current page: <strong id="vs-current-page">--</strong></div>
                <div class="buttons">
                    <button class="btn-primary" id="vs-download-this-page">Download This Page</button>
                    <button class="btn-secondary" id="vs-download-multiple">Download Multiple Pages</button>
                    <button class="btn-cancel" id="vs-choice-cancel">Cancel</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        dialog.addEventListener('click', (e) => { if (e.target === dialog) hideChoiceDialog(); });
        dialog.querySelector('.dialog-content').addEventListener('click', (e) => e.stopPropagation());
        document.getElementById('vs-choice-cancel').addEventListener('click', hideChoiceDialog);
        document.getElementById('vs-download-this-page').addEventListener('click', async () => {
            hideChoiceDialog();
            await downloadCurrentPageDirect();
        });
        document.getElementById('vs-download-multiple').addEventListener('click', () => {
            hideChoiceDialog();
            showModal();
        });
    }

    function showChoiceDialog() {
        createChoiceDialog();
        document.getElementById('vs-current-page').textContent = getCurrentPageLabel() || '--';
        document.getElementById('vs-choice-dialog').classList.add('visible');
    }

    function hideChoiceDialog() {
        document.getElementById('vs-choice-dialog')?.classList.remove('visible');
    }

    // UI: Modal
    function createModal() {
        const modal = document.createElement('div');
        modal.id = 'vs-pdf-modal';
        modal.innerHTML = `
            <style>
                #vs-pdf-modal {
                    display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                    background: rgba(0,0,0,0.6); z-index: 999999; align-items: center; justify-content: center;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }
                #vs-pdf-modal.visible { display: flex; }
                #vs-pdf-modal .modal-content {
                    background: #fff; border-radius: 12px; padding: 24px; width: 400px; max-width: 90vw;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                }
                #vs-pdf-modal h2 { margin: 0 0 20px; font-size: 20px; font-weight: 600; color: #1a1a1a; }
                #vs-pdf-modal .form-group { margin-bottom: 16px; }
                #vs-pdf-modal label { display: block; font-size: 13px; font-weight: 500; color: #555; margin-bottom: 6px; }
                #vs-pdf-modal input {
                    width: 100%; padding: 10px 12px; border: 1px solid #ddd;
                    border-radius: 8px; font-size: 14px; box-sizing: border-box;
                }
                #vs-pdf-modal input:focus { outline: none; border-color: #4a90d9; }
                #vs-pdf-modal .buttons { display: flex; gap: 12px; margin-top: 24px; }
                #vs-pdf-modal button {
                    flex: 1; padding: 12px 20px; border: none; border-radius: 8px;
                    font-size: 14px; font-weight: 600; cursor: pointer;
                }
                #vs-pdf-modal .btn-primary { background: #4a90d9; color: white; }
                #vs-pdf-modal .btn-primary:hover { background: #3a7bc8; }
                #vs-pdf-modal .btn-primary:disabled { background: #a0c4e8; cursor: not-allowed; }
                #vs-pdf-modal .btn-secondary { background: #f0f0f0; color: #333; }
                #vs-pdf-modal .btn-secondary:hover { background: #e0e0e0; }
                #vs-pdf-modal .btn-danger { background: #dc3545; color: white; flex: none; padding: 12px 16px; }
                #vs-pdf-modal .status { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 13px; display: none; }
                #vs-pdf-modal .status.visible { display: block; }
                #vs-pdf-modal .status.info { background: #e7f3ff; color: #0066cc; }
                #vs-pdf-modal .status.success { background: #e6f4ea; color: #137333; }
                #vs-pdf-modal .status.error { background: #fce8e6; color: #c5221f; }
                #vs-pdf-modal .progress-bar { height: 4px; background: #e0e0e0; border-radius: 2px; margin-top: 8px; }
                #vs-pdf-modal .progress-fill { height: 100%; background: #4a90d9; width: 0%; transition: width 0.3s; }
                #vs-pdf-modal .page-count {
                    text-align: center; padding: 8px; background: #f5f5f5;
                    border-radius: 6px; margin-bottom: 16px; font-size: 13px; color: #666;
                }
                #vs-pdf-modal .page-count strong { color: #4a90d9; font-size: 18px; }
            </style>
            <div class="modal-content">
                <h2>Download PDF</h2>
                <div class="page-count"><strong id="vs-page-count">0</strong> pages captured</div>
                <div class="form-group">
                    <label>Number of pages to capture forward</label>
                    <input type="number" id="vs-page-limit" value="10" min="1" placeholder="Number of pages">
                </div>
                <div class="form-group">
                    <label>Filename</label>
                    <input type="text" id="vs-filename" placeholder="book-name">
                </div>
                <div class="buttons">
                    <button class="btn-secondary" id="vs-cancel">Cancel</button>
                    <button class="btn-danger" id="vs-clear" style="display:none;">Clear</button>
                    <button class="btn-primary" id="vs-action">Start Capture</button>
                </div>
                <div class="status" id="vs-status">
                    <span id="vs-status-text"></span>
                    <div class="progress-bar"><div class="progress-fill" id="vs-progress"></div></div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        state.modal = modal;

        modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });
        modal.querySelector('.modal-content').addEventListener('click', (e) => e.stopPropagation());
        document.getElementById('vs-cancel').addEventListener('click', hideModal);
        document.getElementById('vs-action').addEventListener('click', () => {
            if (state.isRunning) {
                state.isRunning = false;
                updateModalUI();
            } else if (state.capturedPages.length > 0) {
                generatePDF();
            } else {
                startCapture();
            }
        });
        document.getElementById('vs-clear').addEventListener('click', () => {
            state.capturedPages = [];
            updateModalUI();
            updateProgress(0, 1);
            updateStatus('Cleared all pages.', 'info');
        });

        const title = getBookTitle();
        if (title) document.getElementById('vs-filename').value = sanitizeFilename(title);
    }

    function showModal() {
        if (!state.modal) createModal();
        state.modal.classList.add('visible');
        updateModalUI();
    }

    function hideModal() {
        state.modal?.classList.remove('visible');
        state.isRunning = false;
    }

    // UI: Header Button
    function injectHeaderButton() {
        if (document.getElementById('vs-download-page-btn')) return;

        const header = document.querySelector('header');
        if (!header) { setTimeout(injectHeaderButton, 1000); return; }

        const moreOptionsBtn = header.querySelector('button[aria-label="More Options"]');
        if (!moreOptionsBtn) { setTimeout(injectHeaderButton, 1000); return; }

        const toolbar = moreOptionsBtn.closest('div[class*="sc-bjztik"], div[class*="gJFeZN"]') ||
            moreOptionsBtn.parentElement?.parentElement?.parentElement?.parentElement;
        if (!toolbar) { setTimeout(injectHeaderButton, 1000); return; }

        const existingWrapper = toolbar.querySelector('div[class*="sc-bhnkmi"], div[class*="bTlBzX"]');
        if (!existingWrapper) { setTimeout(injectHeaderButton, 1000); return; }

        console.log('[VS-PDF] Found toolbar, injecting header button');

        const wrapper = document.createElement('div');
        wrapper.className = existingWrapper.className;
        wrapper.id = 'vs-download-page-btn';

        const existingButton = existingWrapper.querySelector('button');
        const buttonClass = existingButton?.className || '';
        const contentClass = existingButton?.querySelector('[class*="buttonContent"]')?.className || '';
        const iconWrapperClass = existingButton?.querySelector('[class*="iconWrapper"]')?.className || '';

        wrapper.innerHTML = `
            <div class="Tooltip__Manager-eGcvbd jUUnfi IconButton__Tooltip-fOpTQX hHCicF" dir="ltr" lang="en">
                <div>
                    <button aria-label="Download Current Page" dir="ltr" lang="en" class="${buttonClass}">
                        <span class="${contentClass}">
                            <span class="${iconWrapperClass}">
                                <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" style="width: 16px; height: 16px;">
                                    <path fill="currentColor" d="M8 12l-4-4h2.5V3h3v5H12L8 12z"/>
                                    <path fill="currentColor" d="M14 13v1H2v-1h12z"/>
                                </svg>
                            </span>
                        </span>
                    </button>
                </div>
            </div>
        `;

        const moreOptionsWrapper = moreOptionsBtn.closest('[class*="Popover__Manager"]');
        if (moreOptionsWrapper?.parentElement === toolbar) {
            toolbar.insertBefore(wrapper, moreOptionsWrapper);
        } else {
            toolbar.appendChild(wrapper);
        }

        wrapper.querySelector('button').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showChoiceDialog();
        });

        console.log('[VS-PDF] Header download button injected');
    }

    // Initialize
    injectHeaderButton();
    console.log('[VS-PDF] Initialized');
})();
