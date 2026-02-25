/* ============================================================
   GREGORY — Chat Application Logic
   ============================================================ */

const EDGE_FUNCTION_URL = 'https://civpkkhofvpaifprhpii.supabase.co/functions/v1/gregory-chat';

// State
let conversationHistory = [];
let isStreaming = false;

// DOM
const chatContainer = document.getElementById('chatContainer');
const messagesDiv = document.getElementById('messages');
const welcomeScreen = document.getElementById('welcomeScreen');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearChat');
const sidebar = document.getElementById('sidebar');
const sidebarOpen = document.getElementById('sidebarOpen');
const sidebarClose = document.getElementById('sidebarClose');

// ---------- SIDEBAR ----------

sidebarOpen?.addEventListener('click', () => sidebar.classList.add('open'));
sidebarClose?.addEventListener('click', () => sidebar.classList.remove('open'));

// Capability cards → send as question
document.querySelectorAll('.capability-card').forEach(card => {
    card.addEventListener('click', () => {
        const query = card.dataset.query;
        if (query) sendMessage(query);
        sidebar.classList.remove('open');
    });
});

// Example buttons
document.querySelectorAll('.example-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const query = btn.dataset.query;
        if (query) sendMessage(query);
    });
});

// ---------- INPUT ----------

messageInput.addEventListener('input', () => {
    // Auto-resize
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    // Enable/disable send
    sendBtn.disabled = !messageInput.value.trim() || isStreaming;
});

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) sendMessage(messageInput.value.trim());
    }
});

sendBtn.addEventListener('click', () => {
    if (!sendBtn.disabled) sendMessage(messageInput.value.trim());
});

clearBtn.addEventListener('click', () => {
    conversationHistory = [];
    messagesDiv.innerHTML = '';
    welcomeScreen.style.display = 'flex';
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;
});

// ---------- MARKDOWN RENDERING ----------

function renderMarkdown(text) {
    let html = text;

    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code class="lang-${lang}">${escapeHtml(code.trim())}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');

    // Bold & italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Blockquotes
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr>');

    // Unordered lists
    html = html.replace(/^[\s]*[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
    // Fix nested ul tags
    html = html.replace(/<\/ul>\s*<ul>/g, '');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Tables
    html = html.replace(/\|(.+)\|\n\|[-| ]+\|\n((?:\|.+\|\n?)*)/g, (_, header, body) => {
        const headers = header.split('|').map(h => h.trim()).filter(Boolean);
        const rows = body.trim().split('\n').map(row =>
            row.split('|').map(c => c.trim()).filter(Boolean)
        );
        let table = '<table><thead><tr>';
        headers.forEach(h => table += `<th>${h}</th>`);
        table += '</tr></thead><tbody>';
        rows.forEach(row => {
            table += '<tr>';
            row.forEach(c => table += `<td>${c}</td>`);
            table += '</tr>';
        });
        table += '</tbody></table>';
        return table;
    });

    // Paragraphs (lines that aren't already wrapped)
    html = html.replace(/^(?!<[huolbtph]|<\/)(.*\S.*)$/gm, '<p>$1</p>');

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');

    return html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ---------- MESSAGES ----------

function addUserMessage(text) {
    welcomeScreen.style.display = 'none';

    const msgEl = document.createElement('div');
    msgEl.className = 'message message-user';
    msgEl.innerHTML = `
    <div class="message-avatar">You</div>
    <div class="message-content">
      <div class="message-text">${escapeHtml(text)}</div>
    </div>
  `;
    messagesDiv.appendChild(msgEl);
    scrollToBottom();
}

function createAIMessage() {
    const msgEl = document.createElement('div');
    msgEl.className = 'message message-ai';
    msgEl.innerHTML = `
    <div class="message-avatar">G</div>
    <div class="message-content">
      <div class="message-text">
        <div class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
  `;
    messagesDiv.appendChild(msgEl);
    scrollToBottom();
    return msgEl.querySelector('.message-text');
}

function scrollToBottom() {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}

// ---------- STREAMING ----------

async function sendMessage(text) {
    if (!text || isStreaming) return;

    isStreaming = true;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;

    addUserMessage(text);
    const aiTextEl = createAIMessage();

    try {
        const response = await fetch(EDGE_FUNCTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: text,
                history: conversationHistory.slice(-10),
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Unknown error' }));
            aiTextEl.innerHTML = `<p style="color: var(--error);">⚠️ ${err.error || 'Something went wrong. Please try again.'}</p>`;
            isStreaming = false;
            sendBtn.disabled = false;
            return;
        }

        // Stream the response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        fullText += delta;
                        aiTextEl.innerHTML = renderMarkdown(fullText);
                        scrollToBottom();
                    }
                } catch {
                    // Skip malformed JSON chunks
                }
            }
        }

        // Final render
        if (fullText) {
            aiTextEl.innerHTML = renderMarkdown(fullText);

            // Add to history
            conversationHistory.push(
                { role: 'user', content: text },
                { role: 'assistant', content: fullText }
            );
        } else {
            aiTextEl.innerHTML = '<p style="color: var(--text-muted);">No response received. Please try again.</p>';
        }

    } catch (err) {
        console.error('GREGORY chat error:', err);
        aiTextEl.innerHTML = `<p style="color: var(--error);">⚠️ Connection error. Please check your network and try again.</p>`;
    }

    isStreaming = false;
    sendBtn.disabled = !messageInput.value.trim();
    scrollToBottom();
}

// ---------- INIT ----------

messageInput.focus();
