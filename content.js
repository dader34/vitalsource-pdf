/**
 * VitalSource PDF Downloader - Main Content Script
 * Runs on bookshelf.vitalsource.com
 */

(function () {
    'use strict';

    if (!window.location.href.includes('/reader/books/')) return;

    console.log('[VS-PDF] Content script loaded (v2.0)');

    // IndexedDB helpers for storing captured pages on disk instead of in memory
    const pageDB = {
        _db: null,
        _dbName: 'vs_pdf_pages',
        _storeName: 'pages',

        async open() {
            if (this._db) return this._db;
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this._dbName, 2);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (db.objectStoreNames.contains(this._storeName)) {
                        db.deleteObjectStore(this._storeName);
                    }
                    db.createObjectStore(this._storeName, { autoIncrement: true });
                };
                request.onsuccess = (e) => {
                    this._db = e.target.result;
                    resolve(this._db);
                };
                request.onerror = () => reject(request.error);
            });
        },

        async add(pageData) {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this._storeName, 'readwrite');
                const request = tx.objectStore(this._storeName).add(pageData);
                request.onsuccess = () => resolve(request.result);
                tx.onerror = () => reject(tx.error);
            });
        },

        async getKeys() {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this._storeName, 'readonly');
                const request = tx.objectStore(this._storeName).getAllKeys();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        },

        async get(key) {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this._storeName, 'readonly');
                const request = tx.objectStore(this._storeName).get(key);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        },

        async count() {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this._storeName, 'readonly');
                const request = tx.objectStore(this._storeName).count();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        },

        async clear() {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this._storeName, 'readwrite');
                tx.objectStore(this._storeName).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        },
    };

    const state = {
        pageCount: 0,
        isRunning: false,
        readyFrames: [],
        pendingCaptures: {},
        modal: null,
    };

    // Message handling — accept messages from any origin since iframes
    // may be hosted on CDN domains outside vitalsource.com
    window.addEventListener('message', (event) => {
        const { type, requestId, success, data, error, hasImage, hasContent, contentType, url } = event.data || {};
        if (!type || !type.startsWith('VS_')) return;

        if (type === 'VS_PAGE_CAPTURED' && requestId && state.pendingCaptures[requestId]) {
            const { resolve, reject } = state.pendingCaptures[requestId];
            delete state.pendingCaptures[requestId];
            if (success) {
                resolve(event.data.isMultiPage ? { pages: data, isMultiPage: true } : data);
            } else {
                reject(new Error(error || 'Capture failed'));
            }
        }

        if (type === 'VS_PONG' && requestId && state.pendingCaptures[requestId] && (hasImage || hasContent)) {
            const { resolve } = state.pendingCaptures[requestId];
            delete state.pendingCaptures[requestId];
            resolve({ hasImage, hasContent, contentType, url });
        }

        if (type === 'VS_IFRAME_READY' && (hasImage || hasContent)) {
            // Keep only the most recent frames to prevent unbounded growth
            if (state.readyFrames.length > 20) state.readyFrames = state.readyFrames.slice(-10);
            state.readyFrames.push({ hasImage, hasContent, contentType, url });
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
        const readyWithContent = state.readyFrames.find((f) => f?.hasImage || f?.hasContent);
        if (readyWithContent) return readyWithContent;

        const requestId = 'ping_' + Date.now();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                delete state.pendingCaptures[requestId];
                const ready = state.readyFrames.find((f) => f?.hasImage || f?.hasContent);
                ready ? resolve(ready) : reject(new Error('No iframe with page content found. Try reloading.'));
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
            }, 60000);

            state.pendingCaptures[requestId] = {
                resolve: (data) => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeout);
                    delete state.pendingCaptures[requestId];
                    if (data.isMultiPage) {
                        data.pageLabel = getCurrentPageLabel();
                    } else {
                        data.timestamp = Date.now();
                        data.pageLabel = getCurrentPageLabel();
                    }
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
        // Wait for the Next button to be present and enabled (it can temporarily
        // disappear or become disabled during EPUB chapter transitions)
        let nextBtn = null;
        for (let i = 0; i < 20; i++) {
            nextBtn = document.querySelector('button[aria-label="Next"]');
            if (nextBtn && !nextBtn.disabled) break;
            nextBtn = null;
            await sleep(500);
        }
        if (!nextBtn) throw new Error('Last page');

        // Clear ready frames so we can detect when new content loads
        state.readyFrames = [];

        nextBtn.click();

        // Wait for new content to load via iframe ready signal
        for (let waited = 0; waited < 10000; waited += 300) {
            await sleep(300);
            if (state.readyFrames.some((f) => f?.hasImage || f?.hasContent)) {
                return;
            }
        }

        // No ready signal received — actively ping to check if content is there
        try {
            await pingIframe();
        } catch {
            await sleep(2000);
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
            if (!state.readyFrames.find((f) => f?.hasImage || f?.hasContent)) {
                await pingIframe();
            }

            const pageData = await captureCurrentPage();
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
            const filename = sanitizeFilename(getBookTitle() || 'vitalsource');
            const pageLabel = pageData.pageLabel || getCurrentPageLabel() || '1';

            if (pageData.isMultiPage) {
                for (let i = 0; i < pageData.pages.length; i++) {
                    if (i > 0) pdf.addPage('letter', 'portrait');
                    const page = pageData.pages[i];
                    const dims = calculateImageDimensions(page.width, page.height);
                    pdf.addImage(page.data, 'JPEG', dims.offsetX, dims.offsetY, dims.drawWidth, dims.drawHeight);
                }
            } else {
                const dims = calculateImageDimensions(pageData.width, pageData.height);
                pdf.addImage(pageData.data, 'JPEG', dims.offsetX, dims.offsetY, dims.drawWidth, dims.drawHeight);
            }

            pdf.save(`${filename}_page${pageLabel}.pdf`);
            console.log('[VS-PDF] Downloaded page', pageLabel);
        } catch (e) {
            console.error('[VS-PDF] Download failed:', e);
            alert('Download failed: ' + e.message);
        }
    }

    async function generatePDF() {
        const totalPages = await pageDB.count();
        if (totalPages === 0) {
            updateStatus('No pages captured!', 'error');
            return;
        }

        updateStatus('Generating PDF...');
        document.getElementById('vs-action').disabled = true;

        try {
            let filename = document.getElementById('vs-filename').value.trim();
            if (!filename) filename = sanitizeFilename(getBookTitle() || 'vitalsource-book');

            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

            let firstLabel = null;
            let lastLabel = null;

            // Get all keys, then load one page at a time in separate transactions
            // so async yields don't kill the IDB transaction
            const keys = await pageDB.getKeys();

            for (let i = 0; i < keys.length; i++) {
                if (i > 0) pdf.addPage('letter', 'portrait');

                const page = await pageDB.get(keys[i]);

                if (firstLabel === null) firstLabel = page.pageLabel || String(i + 1);
                lastLabel = page.pageLabel || String(i + 1);

                const dims = calculateImageDimensions(page.width, page.height);
                pdf.addImage(page.data, 'JPEG', dims.offsetX, dims.offsetY, dims.drawWidth, dims.drawHeight);

                updateProgress(i + 1, totalPages);
                updateStatus(`Building PDF: page ${i + 1}/${totalPages}`);

                // Yield to the event loop every 5 pages to prevent UI freeze / tab kill
                if (i % 5 === 4) await sleep(0);
            }

            pdf.save(`${filename}_p${firstLabel}-${lastLabel}.pdf`);

            // Clear stored pages after successful download
            await pageDB.clear();
            state.pageCount = 0;

            updateStatus(`<strong>Download started!</strong><br>${totalPages} pages saved.`, 'success');
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

        // Clear stale ready frames for fresh capture session
        state.readyFrames = [];

        let captured = 0;
        while (state.isRunning && captured < pageLimit) {
            try {
                await sleep(500);
                const pageData = await captureCurrentPage();

                if (pageData.isMultiPage) {
                    // EPUB: multiple viewport-sized screenshots per chapter
                    for (const page of pageData.pages) {
                        page.timestamp = Date.now();
                        page.pageLabel = pageData.pageLabel;
                        await pageDB.add(page);
                    }
                    state.pageCount = await pageDB.count();
                    captured++;

                    const label = pageData.pageLabel || `#${captured}`;
                    updateModalUI();
                    updateStatus(`Captured chapter ${label} — ${pageData.pages.length} pages (${captured}/${pageLimit} chapters)`);
                    updateProgress(captured, pageLimit);
                } else {
                    await pageDB.add(pageData);
                    state.pageCount = await pageDB.count();
                    captured++;

                    const label = pageData.pageLabel || `#${captured}`;
                    updateModalUI();
                    updateStatus(`Captured page ${label} (${captured}/${pageLimit})`);
                    updateProgress(captured, pageLimit);
                }

                if (captured >= pageLimit) {
                    updateStatus(`Done! ${state.pageCount} pages captured.`, 'success');
                    break;
                }

                await goToNextPage();
            } catch (e) {
                if (e.message === 'Last page') {
                    state.pageCount = await pageDB.count();
                    updateStatus(`Done! ${state.pageCount} pages captured.`, 'success');
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
        document.getElementById('vs-page-count').textContent = state.pageCount;

        if (state.pageCount > 0) {
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
            } else if (state.pageCount > 0) {
                generatePDF();
            } else {
                startCapture();
            }
        });
        document.getElementById('vs-clear').addEventListener('click', async () => {
            await pageDB.clear();
            state.pageCount = 0;
            updateModalUI();
            updateProgress(0, 1);
            updateStatus('Cleared all pages.', 'info');
        });

        const title = getBookTitle();
        if (title) document.getElementById('vs-filename').value = sanitizeFilename(title);
    }

    async function showModal() {
        if (!state.modal) createModal();
        // Sync page count from IndexedDB (may have pages from a previous session)
        state.pageCount = await pageDB.count();
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

    // Diagnostics
    async function runDiagnostics() {
        const info = {
            url: window.location.href,
            userAgent: navigator.userAgent,
            extensionVersion: '1.4.0',
            extensionLoaded: !!document.getElementById('vs-download-page-btn'),
            windowFrames: window.frames.length,
            iframes: [],
            mosaicBook: !!document.querySelector('mosaic-book'),
            pageInput: null,
            iframeScriptResponses: [],
        };

        document.querySelectorAll('iframe').forEach(f => {
            const entry = { src: f.src, width: f.offsetWidth, height: f.offsetHeight, accessible: false };
            try { if (f.contentDocument) entry.accessible = true; } catch {}
            info.iframes.push(entry);
        });

        const shadowIframes = [];
        document.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                el.shadowRoot.querySelectorAll('iframe').forEach(f => {
                    shadowIframes.push({ host: el.tagName, src: f.src });
                });
            }
        });
        if (shadowIframes.length) info.shadowIframes = shadowIframes;

        const input = document.querySelector('input[id^="text-field-"]');
        info.pageInput = input ? { id: input.id, value: input.value } : null;

        // Ping iframes
        const responses = [];
        const listener = (event) => {
            const d = event.data;
            if (d?.type === 'VS_PONG' || d?.type === 'VS_IFRAME_READY') {
                responses.push({ type: d.type, hasImage: d.hasImage, hasContent: d.hasContent, contentType: d.contentType, url: d.url });
            }
        };
        window.addEventListener('message', listener);

        const msg = { type: 'VS_PING', requestId: 'diag_' + Date.now() };
        for (let i = 0; i < window.frames.length; i++) {
            try { window.frames[i].postMessage(msg, '*'); } catch {}
        }
        document.querySelectorAll('iframe').forEach(f => {
            try { f.contentWindow.postMessage(msg, '*'); } catch {}
        });

        await sleep(5000);
        window.removeEventListener('message', listener);

        info.iframeScriptResponses = responses;

        if (responses.length === 0) {
            info.summary = 'NO RESPONSE: iframe.js is not running in any iframe. The extension may not be injecting scripts into cross-origin iframes.';
        } else if (responses.some(r => r.hasImage)) {
            info.summary = 'OK: iframe.js is running and found page images.';
        } else if (responses.some(r => r.hasContent)) {
            const epubCount = responses.filter(r => r.contentType === 'epub').length;
            info.summary = `OK: iframe.js is running and found EPUB content (${epubCount} epub frame${epubCount !== 1 ? 's' : ''}).`;
        } else {
            info.summary = 'PARTIAL: iframe.js is running but no iframe reported having page content.';
        }

        return info;
    }

    function showDiagnosticResults(info) {
        let overlay = document.getElementById('vs-diag-overlay');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'vs-diag-overlay';

        const jsonText = JSON.stringify(info, null, 2);
        const statusColor = info.summary?.startsWith('OK') ? '#137333'
            : info.summary?.startsWith('PARTIAL') ? '#b45309' : '#c5221f';

        overlay.innerHTML = `
            <style>
                #vs-diag-overlay {
                    display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                    background: rgba(0,0,0,0.6); z-index: 9999999; align-items: center; justify-content: center;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }
                #vs-diag-overlay .diag-content {
                    background: #fff; border-radius: 12px; padding: 24px; width: 560px; max-width: 90vw;
                    max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                }
                #vs-diag-overlay h2 { margin: 0 0 8px; font-size: 18px; font-weight: 600; color: #1a1a1a; }
                #vs-diag-overlay .diag-summary {
                    padding: 10px 14px; border-radius: 8px; font-size: 13px; font-weight: 500;
                    margin-bottom: 12px; background: #f0f0f0;
                }
                #vs-diag-overlay pre {
                    flex: 1; overflow: auto; background: #1e1e1e; color: #d4d4d4; padding: 16px;
                    border-radius: 8px; font-size: 12px; line-height: 1.5; margin: 0; white-space: pre-wrap;
                    word-break: break-all;
                }
                #vs-diag-overlay .diag-buttons { display: flex; gap: 12px; margin-top: 16px; }
                #vs-diag-overlay button {
                    padding: 10px 20px; border: none; border-radius: 8px;
                    font-size: 14px; font-weight: 600; cursor: pointer;
                }
                #vs-diag-overlay .btn-copy { background: #4a90d9; color: white; flex: 1; }
                #vs-diag-overlay .btn-copy:hover { background: #3a7bc8; }
                #vs-diag-overlay .btn-copy.copied { background: #137333; }
                #vs-diag-overlay .btn-close { background: #f0f0f0; color: #333; }
                #vs-diag-overlay .btn-close:hover { background: #e0e0e0; }
                #vs-diag-overlay .diag-hint {
                    font-size: 12px; color: #888; margin-top: 8px; text-align: center;
                }
            </style>
            <div class="diag-content">
                <h2>Extension Diagnostics</h2>
                <div class="diag-summary" style="color: ${statusColor}">${info.summary || 'Unknown'}</div>
                <pre>${jsonText}</pre>
                <div class="diag-buttons">
                    <button class="btn-close" id="vs-diag-close">Close</button>
                    <button class="btn-copy" id="vs-diag-copy">Copy to Clipboard</button>
                </div>
                <div class="diag-hint">Copy and send this to the developer for troubleshooting</div>
            </div>
        `;

        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('vs-diag-close').addEventListener('click', () => overlay.remove());
        document.getElementById('vs-diag-copy').addEventListener('click', async () => {
            const btn = document.getElementById('vs-diag-copy');
            try {
                await navigator.clipboard.writeText(jsonText);
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(() => { btn.textContent = 'Copy to Clipboard'; btn.classList.remove('copied'); }, 2000);
            } catch {
                // Fallback
                const ta = document.createElement('textarea');
                ta.value = jsonText;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(() => { btn.textContent = 'Copy to Clipboard'; btn.classList.remove('copied'); }, 2000);
            }
        });
    }

    // Inject "Diagnostics" into More Options popover
    function injectDiagnosticsMenuItem() {
        const observer = new MutationObserver(() => {
            // Look for the popover content that appears when "More Options" is clicked
            const popovers = document.querySelectorAll('[id^="popover-"]');
            popovers.forEach(popover => {
                if (popover.querySelector('#vs-diagnostics-item')) return;
                // Find the menu list inside the popover
                const menuList = popover.querySelector('ul, [role="menu"], [role="listbox"]');
                if (!menuList) return;

                const li = document.createElement('li');
                li.id = 'vs-diagnostics-item';
                // Clone styling from existing menu items
                const existingItem = menuList.querySelector('li');
                if (existingItem) li.className = existingItem.className;

                const existingBtn = existingItem?.querySelector('button, a, [role="menuitem"]');
                const btnTag = existingBtn ? existingBtn.tagName.toLowerCase() : 'button';
                const btnClass = existingBtn?.className || '';

                li.innerHTML = `<${btnTag} class="${btnClass}" style="width:100%;text-align:left;cursor:pointer;">
                    <span style="display:flex;align-items:center;gap:8px;">
                        <svg viewBox="0 0 16 16" style="width:16px;height:16px;flex-shrink:0;" fill="currentColor">
                            <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM7.25 5h1.5v4h-1.5V5zm0 5h1.5v1.5h-1.5V10z"/>
                        </svg>
                        <span>Diagnostics</span>
                    </span>
                </${btnTag}>`;

                menuList.appendChild(li);

                li.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Close the popover by clicking elsewhere
                    document.body.click();
                    updateStatus('Running diagnostics (5s)...', 'info');
                    const info = await runDiagnostics();
                    showDiagnosticResults(info);
                });
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Initialize
    injectHeaderButton();
    injectDiagnosticsMenuItem();
    console.log('[VS-PDF] Initialized');
})();
