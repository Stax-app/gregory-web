/* ============================================================
   GREGORY — Chat Application Logic (Sub-Agent Architecture)
   ============================================================ */

const EDGE_FUNCTION_URL = 'https://civpkkhofvpaifprhpii.supabase.co/functions/v1/gregory-chat';

// Agent definitions
const AGENTS = {
    behavioral_psychology: { name: 'Behavioral Psychology', icon: '🧠', short: 'Psych Agent' },
    financial_intelligence: { name: 'Financial Intelligence', icon: '📊', short: 'Finance Agent' },
    regulatory_policy: { name: 'Regulatory & Policy', icon: '⚖️', short: 'Policy Agent' },
    marketing_strategy: { name: 'Marketing Strategy', icon: '🚀', short: 'Strategy Agent' },
};

// State
let conversationHistory = [];
let isStreaming = false;
let activeAgent = null; // null = auto-detect (general)

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
const agentBadge = document.getElementById('agentBadge');

// ---------- SIDEBAR ----------

sidebarOpen?.addEventListener('click', () => sidebar.classList.add('open'));
sidebarClose?.addEventListener('click', () => sidebar.classList.remove('open'));

// ---------- SUB-AGENT SELECTION ----------

function setActiveAgent(agentKey) {
    // Toggle: clicking the same agent deselects it
    if (activeAgent === agentKey) {
        activeAgent = null;
    } else {
        activeAgent = agentKey;
    }
    updateAgentUI();
}

function updateAgentUI() {
    // Update capability cards
    document.querySelectorAll('.capability-card').forEach(card => {
        const cardAgent = card.dataset.agent;
        if (cardAgent === activeAgent) {
            card.classList.add('active');
        } else {
            card.classList.remove('active');
        }
    });

    // Update header badge
    if (activeAgent && AGENTS[activeAgent]) {
        const agent = AGENTS[activeAgent];
        agentBadge.textContent = `${agent.icon} ${agent.short}`;
        agentBadge.classList.add('agent-active');
    } else {
        agentBadge.textContent = 'Citation-First AI';
        agentBadge.classList.remove('agent-active');
    }

    // Update input placeholder
    if (activeAgent && AGENTS[activeAgent]) {
        messageInput.placeholder = `Ask the ${AGENTS[activeAgent].name} agent…`;
    } else {
        messageInput.placeholder = 'Ask GREGORY anything about marketing…';
    }
}

// Capability cards → select agent (click to toggle)
document.querySelectorAll('.capability-card').forEach(card => {
    card.addEventListener('click', () => {
        const agentKey = card.dataset.agent;
        if (agentKey) {
            setActiveAgent(agentKey);
        }
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
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
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
    activeAgent = null;
    messagesDiv.innerHTML = '';
    welcomeScreen.style.display = 'flex';
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;
    updateAgentUI();
});

// ---------- MARKDOWN RENDERING ----------

function renderMarkdown(text) {
    let html = text;

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code class="lang-${lang}">${escapeHtml(code.trim())}</code></pre>`;
    });
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
    html = html.replace(/^---$/gm, '<hr>');
    html = html.replace(/^[\s]*[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
    html = html.replace(/<\/ul>\s*<ul>/g, '');
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
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
    html = html.replace(/^(?!<[huolbtph]|<\/)(.*\S.*)$/gm, '<p>$1</p>');
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

function createAIMessage(agentKey) {
    const agent = agentKey && AGENTS[agentKey] ? AGENTS[agentKey] : null;
    const avatarText = agent ? agent.icon : 'G';
    const agentLabel = agent ? `<span class="agent-label">${agent.short}</span>` : '';

    const msgEl = document.createElement('div');
    msgEl.className = 'message message-ai';
    if (agentKey) msgEl.dataset.agent = agentKey;
    msgEl.innerHTML = `
    <div class="message-avatar">${avatarText}</div>
    <div class="message-content">
      ${agentLabel}
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
    // Create AI message with current agent (may be updated by server response)
    const aiTextEl = createAIMessage(activeAgent);

    try {
        const body = {
            message: text,
            history: conversationHistory.slice(-10),
        };
        // Send agent if explicitly selected
        if (activeAgent) {
            body.agent = activeAgent;
        }

        const response = await fetch(EDGE_FUNCTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Unknown error' }));
            aiTextEl.innerHTML = `<p style="color: var(--error);">⚠️ ${err.error || 'Something went wrong. Please try again.'}</p>`;
            isStreaming = false;
            sendBtn.disabled = false;
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';
        let agentMetaReceived = false;

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

                    // First SSE event from server is agent metadata
                    if (!agentMetaReceived && parsed.agent && parsed.agent_name) {
                        agentMetaReceived = true;
                        // Update the AI message with the actual agent that responded
                        const msgEl = aiTextEl.closest('.message');
                        if (msgEl && parsed.agent !== 'general' && AGENTS[parsed.agent]) {
                            const agent = AGENTS[parsed.agent];
                            msgEl.dataset.agent = parsed.agent;
                            msgEl.querySelector('.message-avatar').textContent = agent.icon;
                            // Add label if not already present
                            if (!msgEl.querySelector('.agent-label')) {
                                const label = document.createElement('span');
                                label.className = 'agent-label';
                                label.textContent = agent.short;
                                msgEl.querySelector('.message-content').insertBefore(label, aiTextEl);
                            }
                        }
                        continue;
                    }

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

        if (fullText) {
            aiTextEl.innerHTML = renderMarkdown(fullText);
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

updateAgentUI();
messageInput.focus();
