/* ============================================================
   GREGORY — Document Upload UI
   File attachment handling with drag/drop, progress, and
   integration with the chat message flow.
   ============================================================ */

const TOOLS_URL = 'https://civpkkhofvpaifprhpii.supabase.co/functions/v1/gregory-tools';

// ── Upload State ──

const uploadState = {
    attachedDocuments: [],  // { id, filename, mime_type, size_bytes }
    isUploading: false,
};

// ── Init Upload UI ──

function initDocumentUpload() {
    const inputWrapper = document.getElementById('inputWrapper');
    if (!inputWrapper) return;

    // Create upload button
    const uploadBtn = document.createElement('button');
    uploadBtn.className = 'upload-btn';
    uploadBtn.id = 'uploadBtn';
    uploadBtn.title = 'Attach a document';
    uploadBtn.type = 'button';
    uploadBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
        </svg>
    `;

    // Insert before textarea
    const textarea = document.getElementById('messageInput');
    inputWrapper.insertBefore(uploadBtn, textarea);

    // Hidden file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'fileInput';
    fileInput.style.display = 'none';
    fileInput.accept = '.pdf,.csv,.xlsx,.xls,.txt,.md,.html,.json,.docx';
    document.body.appendChild(fileInput);

    // Attachment preview area
    const attachmentArea = document.createElement('div');
    attachmentArea.className = 'attachment-area';
    attachmentArea.id = 'attachmentArea';
    attachmentArea.style.display = 'none';
    inputWrapper.parentElement.insertBefore(attachmentArea, inputWrapper);

    // Wire events
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);

    // Drag and drop on the chat container
    const chatContainer = document.getElementById('chatContainer');
    if (chatContainer) {
        chatContainer.addEventListener('dragover', handleDragOver);
        chatContainer.addEventListener('dragleave', handleDragLeave);
        chatContainer.addEventListener('drop', handleDrop);
    }
}

// ── File Selection ──

function handleFileSelect(e) {
    const files = e.target.files;
    if (files && files.length > 0) {
        uploadFile(files[0]);
    }
    // Reset so the same file can be re-selected
    e.target.value = '';
}

// ── Drag and Drop ──

function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('drag-over');

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
        uploadFile(files[0]);
    }
}

// ── Upload Logic ──

async function uploadFile(file) {
    if (uploadState.isUploading) return;

    // Validate file size
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
        showUploadError('File too large. Maximum size is 10MB.');
        return;
    }

    uploadState.isUploading = true;
    showUploadProgress(file.name);

    const formData = new FormData();
    formData.append('file', file);

    try {
        const headers = {};
        if (appState.user) {
            const session = await supabaseClient.auth.getSession();
            if (session.data.session) {
                headers['Authorization'] = 'Bearer ' + session.data.session.access_token;
            }
        }

        const response = await fetch(TOOLS_URL, {
            method: 'POST',
            headers,
            body: formData,
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            showUploadError(result.error || 'Upload failed');
            return;
        }

        // Add to attached documents
        uploadState.attachedDocuments.push(result.document);
        renderAttachments();
        hideUploadProgress();

    } catch (err) {
        showUploadError('Upload failed: ' + err.message);
    } finally {
        uploadState.isUploading = false;
    }
}

// ── Attachment UI ──

function renderAttachments() {
    const area = document.getElementById('attachmentArea');
    if (!area) return;

    if (uploadState.attachedDocuments.length === 0) {
        area.style.display = 'none';
        return;
    }

    area.style.display = 'flex';
    area.innerHTML = uploadState.attachedDocuments.map((doc, i) => `
        <div class="attachment-chip" data-index="${i}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="attachment-name">${escapeHtml(doc.filename)}</span>
            <span class="attachment-size">${formatFileSize(doc.size_bytes)}</span>
            <button class="attachment-remove" data-index="${i}" title="Remove">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');

    area.querySelectorAll('.attachment-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index);
            uploadState.attachedDocuments.splice(index, 1);
            renderAttachments();
        });
    });
}

function showUploadProgress(filename) {
    const area = document.getElementById('attachmentArea');
    if (!area) return;

    area.style.display = 'flex';

    const progressEl = document.createElement('div');
    progressEl.className = 'attachment-chip uploading';
    progressEl.id = 'uploadProgress';
    progressEl.innerHTML = `
        <span class="tool-spinner"></span>
        <span class="attachment-name">Uploading ${escapeHtml(filename)}...</span>
    `;
    area.appendChild(progressEl);
}

function hideUploadProgress() {
    const progress = document.getElementById('uploadProgress');
    if (progress) progress.remove();
}

function showUploadError(message) {
    hideUploadProgress();
    const area = document.getElementById('attachmentArea');
    if (!area) return;

    area.style.display = 'flex';

    const errorEl = document.createElement('div');
    errorEl.className = 'attachment-chip upload-error';
    errorEl.innerHTML = `
        <span class="tool-error">&times;</span>
        <span class="attachment-name">${escapeHtml(message)}</span>
    `;
    area.appendChild(errorEl);

    setTimeout(() => {
        errorEl.remove();
        if (uploadState.attachedDocuments.length === 0) {
            area.style.display = 'none';
        }
    }, 4000);
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Integration with sendMessage ──

/**
 * Get attached document IDs and clear them.
 * Called by sendMessage before sending the request.
 */
function getAndClearAttachments() {
    const docs = [...uploadState.attachedDocuments];
    uploadState.attachedDocuments = [];
    renderAttachments();
    return docs;
}

// ── Initialize on load ──
document.addEventListener('DOMContentLoaded', initDocumentUpload);
// Also run immediately if DOM is already loaded
if (document.readyState !== 'loading') {
    initDocumentUpload();
}
