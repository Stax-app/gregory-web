/* ============================================================
   GREGORY — Agentic UI Components
   Task plan renderer, step progress, checkpoint controls,
   agent handoff display, and orchestration API calls.
   ============================================================ */

const ORCHESTRATE_URL = 'https://civpkkhofvpaifprhpii.supabase.co/functions/v1/gregory-orchestrate';

// ── Agentic State ──

const agenticState = {
    activeTask: null,   // { task_id, plan, status }
    stepElements: {},   // step_id → DOM element
    aiTextEl: null,     // Current AI message text element for streaming
};

// ── Plan Renderer ──

function renderPlan(plan, parentEl) {
    agenticState.activeTask = { task_id: plan.task_id, plan, status: 'awaiting_approval' };
    agenticState.aiTextEl = parentEl;

    const planEl = document.createElement('div');
    planEl.className = 'task-plan';
    planEl.id = `plan-${plan.task_id}`;
    planEl.innerHTML = `
        <div class="task-plan-header">
            <div class="task-plan-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>
            </div>
            <div>
                <div class="task-plan-title">${escapeHtml(plan.title)}</div>
                <div class="task-plan-subtitle">${plan.steps.length} steps across ${countAgents(plan.steps)} agents</div>
            </div>
        </div>
        <div class="task-plan-steps">
            ${plan.steps.map((step, i) => {
                const agentCfg = AGENTS[step.agent] || GREGORY_HUB;
                const icon = agentCfg.icon || 'G';
                const name = agentCfg.shortName || 'GREGORY';
                return `
                    <div class="task-step" data-step-id="${step.id}">
                        <div class="task-step-number">${i + 1}</div>
                        <div class="task-step-agent" title="${escapeAttr(name)}">${icon}</div>
                        <div class="task-step-info">
                            <div class="task-step-description">${escapeHtml(step.description)}</div>
                            ${step.tools_needed && step.tools_needed.length > 0
                                ? `<div class="task-step-tools">${step.tools_needed.map(t => `<span class="step-tool-tag">${escapeHtml(t)}</span>`).join('')}</div>`
                                : ''}
                            ${step.checkpoint ? '<span class="task-step-checkpoint">Checkpoint</span>' : ''}
                            ${step.parallel_group ? '<span class="task-step-parallel">\u26A1 Parallel</span>' : ''}
                        </div>
                        <div class="task-step-status">
                            <span class="step-status-dot pending"></span>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
        <div class="task-plan-actions" id="plan-actions-${plan.task_id}">
            <button class="plan-action-btn plan-approve" data-task-id="${plan.task_id}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                Approve &amp; Execute
            </button>
            <button class="plan-action-btn plan-abort" data-task-id="${plan.task_id}">
                Cancel
            </button>
        </div>
    `;

    // Insert into the message
    const messageContent = parentEl.closest('.message-content');
    messageContent.insertBefore(planEl, parentEl);

    // Clear typing indicator
    parentEl.innerHTML = '';

    // Wire buttons
    planEl.querySelector('.plan-approve').addEventListener('click', (e) => {
        e.target.disabled = true; // Prevent double-click
        startTask(plan.task_id);
    });
    planEl.querySelector('.plan-abort').addEventListener('click', () => {
        abortTask(plan.task_id);
        disablePlanActions(plan.task_id);
        parentEl.innerHTML = '<p style="color: var(--text-muted);">Task cancelled.</p>';
    });

    // Store step elements
    planEl.querySelectorAll('.task-step').forEach(el => {
        agenticState.stepElements[el.dataset.stepId] = el;
    });

    scrollToBottom();
}

function countAgents(steps) {
    return new Set(steps.map(s => s.agent)).size;
}

function disablePlanActions(taskId) {
    const actions = document.getElementById(`plan-actions-${taskId}`);
    if (actions) {
        actions.querySelectorAll('button').forEach(btn => btn.disabled = true);
        actions.classList.add('actions-disabled');
    }
}

// ── Step Update ──

function updateStepStatus(data) {
    const stepEl = agenticState.stepElements[data.step_id];
    if (!stepEl) return;

    const dot = stepEl.querySelector('.step-status-dot');
    if (dot) {
        dot.className = `step-status-dot ${data.status}`;
    }

    // Highlight active step
    if (data.status === 'running') {
        stepEl.classList.add('step-active');
    } else {
        stepEl.classList.remove('step-active');
    }

    if (data.summary) {
        let summaryEl = stepEl.querySelector('.task-step-summary');
        if (!summaryEl) {
            summaryEl = document.createElement('div');
            summaryEl.className = 'task-step-summary';
            stepEl.querySelector('.task-step-info').appendChild(summaryEl);
        }
        summaryEl.textContent = data.summary;
    }

    scrollToBottom();
}

// ── Checkpoint UI ──

function renderCheckpoint(data, parentEl) {
    const checkpointEl = document.createElement('div');
    checkpointEl.className = 'checkpoint-card';
    checkpointEl.innerHTML = `
        <div class="checkpoint-header">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>
            <span class="checkpoint-title">Checkpoint — Review Required</span>
        </div>
        <div class="checkpoint-summary">${renderMarkdown(data.summary)}</div>
        ${data.question ? `<div class="checkpoint-question">${escapeHtml(data.question)}</div>` : ''}
        <div class="checkpoint-actions">
            <button class="plan-action-btn plan-approve checkpoint-continue" data-task-id="${data.task_id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Continue
            </button>
            <button class="plan-action-btn plan-modify checkpoint-modify" data-task-id="${data.task_id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Modify Direction
            </button>
            <button class="plan-action-btn plan-abort checkpoint-abort" data-task-id="${data.task_id}">
                Abort
            </button>
        </div>
        <div class="checkpoint-feedback" style="display:none;">
            <textarea class="checkpoint-feedback-input" placeholder="Provide feedback or redirect the research..." rows="3"></textarea>
            <button class="plan-action-btn plan-approve checkpoint-send-feedback" data-task-id="${data.task_id}">Send Feedback &amp; Continue</button>
        </div>
    `;

    const messageContent = parentEl.closest('.message-content');
    messageContent.appendChild(checkpointEl);

    checkpointEl.querySelector('.checkpoint-continue').addEventListener('click', () => {
        disableCheckpointActions(checkpointEl);
        continueTask(data.task_id);
    });

    checkpointEl.querySelector('.checkpoint-modify').addEventListener('click', () => {
        const feedbackArea = checkpointEl.querySelector('.checkpoint-feedback');
        const isHidden = feedbackArea.style.display === 'none';
        feedbackArea.style.display = isHidden ? 'flex' : 'none';
        if (isHidden) {
            feedbackArea.querySelector('textarea').focus();
        }
    });

    checkpointEl.querySelector('.checkpoint-abort').addEventListener('click', () => {
        disableCheckpointActions(checkpointEl);
        abortTask(data.task_id);
    });

    checkpointEl.querySelector('.checkpoint-send-feedback').addEventListener('click', () => {
        const feedback = checkpointEl.querySelector('.checkpoint-feedback-input').value.trim();
        if (feedback) {
            disableCheckpointActions(checkpointEl);
            modifyTask(data.task_id, feedback);
        }
    });

    scrollToBottom();
}

function disableCheckpointActions(checkpointEl) {
    checkpointEl.querySelectorAll('button').forEach(btn => btn.disabled = true);
    checkpointEl.classList.add('checkpoint-resolved');
}

// ── Agent Handoff ──

function showAgentHandoff(data, parentEl) {
    const handoffEl = document.createElement('div');
    handoffEl.className = 'agent-handoff';
    handoffEl.innerHTML = `
        <span class="handoff-from">${escapeHtml(data.from)}</span>
        <svg class="handoff-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        <span class="handoff-to">${escapeHtml(data.to)}</span>
        <span class="handoff-reason">${escapeHtml(data.reason)}</span>
    `;

    const messageContent = parentEl.closest('.message-content');
    messageContent.appendChild(handoffEl);
    scrollToBottom();
}

// ── Task Complete ──

function showTaskComplete(data, parentEl) {
    if (agenticState.activeTask) {
        agenticState.activeTask.status = 'completed';
    }

    // Mark the plan UI as complete
    const messageContent = parentEl.closest('.message-content');
    const planEl = messageContent ? messageContent.querySelector('.task-plan') : null;
    if (planEl) {
        planEl.classList.add('task-complete');
    }
}

// ── Orchestration API Calls ──

async function startTask(taskId) {
    disablePlanActions(taskId);
    await callOrchestrate(taskId, 'start');
}

async function continueTask(taskId) {
    await callOrchestrate(taskId, 'continue');
}

async function modifyTask(taskId, feedback) {
    await callOrchestrate(taskId, 'modify', feedback);
}

async function abortTask(taskId) {
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (appState.user) {
            const session = await supabaseClient.auth.getSession();
            if (session.data.session) {
                headers['Authorization'] = 'Bearer ' + session.data.session.access_token;
            }
        }
        await fetch(ORCHESTRATE_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({ task_id: taskId, action: 'abort' }),
        });
    } catch (err) {
        console.error('Abort failed:', err);
    }
}

async function callOrchestrate(taskId, action, feedback) {
    let aiTextEl = agenticState.aiTextEl;
    if (!aiTextEl) return;

    // After a checkpoint, create a new AI message bubble so post-checkpoint
    // content doesn't cram into the original message with the plan + checkpoint card.
    if (action === 'continue' || action === 'modify') {
        const newAiTextEl = createAIMessage(appState.currentAgent);
        agenticState.aiTextEl = newAiTextEl;
        aiTextEl = newAiTextEl;
    }

    const MAX_RETRIES = 2;
    let attempt = 0;
    let success = false;
    let fullText = '';

    while (attempt <= MAX_RETRIES && !success) {
        attempt++;

        if (attempt > 1) {
            const delay = 1000 * Math.pow(2, attempt - 1);
            showOrchestrateRetry(aiTextEl, attempt, MAX_RETRIES + 1);
            await new Promise(function(r) { setTimeout(r, delay); });
            removeOrchestrateRetry(aiTextEl);
        }

        try {
            const headers = await getAuthHeaders();

            const payload = { task_id: taskId, action };
            if (feedback) payload.feedback = feedback;

            const response = await fetch(ORCHESTRATE_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
            });

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
                showOrchestrateRetry(aiTextEl, attempt, MAX_RETRIES + 1);
                await new Promise(function(r) { setTimeout(r, waitMs); });
                removeOrchestrateRetry(aiTextEl);
                continue;
            }

            if (!response.ok) {
                console.error('Orchestration failed:', await response.text());
                if (attempt > MAX_RETRIES) {
                    showResumeButton(aiTextEl, taskId, action, feedback);
                }
                continue;
            }

            // Process SSE stream from orchestrator
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let currentEventType = null;
            let streamTimeout;
            let streamAborted = false;

            appState.isStreaming = true;

            // Orchestration steps take much longer than simple chat (multiple LLM + tool calls)
            var orchestrateTimeoutMs = 300000; // 5 minutes
            function resetTimeout() {
                clearTimeout(streamTimeout);
                streamTimeout = setTimeout(function() {
                    streamAborted = true;
                    try { reader.cancel(); } catch (_e) {}
                }, orchestrateTimeoutMs);
            }

            resetTimeout();

            while (true) {
                const result = await reader.read();
                if (result.done || streamAborted) break;

                resetTimeout();

                buffer += decoder.decode(result.value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        currentEventType = line.slice(7).trim();
                        continue;
                    }

                    if (!line.startsWith('data: ')) continue;
                    const rawData = line.slice(6);
                    if (rawData === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(rawData);

                        switch (currentEventType) {
                            case 'step_update':
                                updateStepStatus(parsed);
                                break;

                            case 'tool_call':
                                showToolCallUI(aiTextEl, parsed);
                                break;

                            case 'tool_result':
                                showToolResultUI(aiTextEl, parsed);
                                break;

                            case 'checkpoint':
                                clearTimeout(streamTimeout);
                                renderCheckpoint(parsed, aiTextEl);
                                appState.isStreaming = false;
                                sendBtn.disabled = !messageInput.value.trim();
                                return; // Stop processing — user must approve

                            case 'agent_handoff':
                                showAgentHandoff(parsed, aiTextEl);
                                break;

                            case 'task_complete':
                                showTaskComplete(parsed, aiTextEl);
                                break;

                            case 'error':
                                if (parsed.message) {
                                    const errorEl = document.createElement('div');
                                    errorEl.className = 'tool-error-msg';
                                    errorEl.textContent = parsed.message;
                                    aiTextEl.closest('.message-content').appendChild(errorEl);
                                }
                                break;

                            case 'thinking':
                                showThinkingIndicator(aiTextEl, parsed);
                                break;

                            case 'replan':
                                showReplanNotification(aiTextEl, parsed);
                                break;

                            default: {
                                const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
                                if (delta) {
                                    removeThinkingIndicator(aiTextEl);
                                    fullText += delta;
                                    scheduleStreamRender(aiTextEl, fullText);
                                }
                            }
                        }

                        currentEventType = null;
                    } catch (_e) {
                        // Skip malformed JSON
                    }
                }
            }

            clearTimeout(streamTimeout);

            if (streamAborted && !fullText) {
                // Timed out — show resume button instead of retrying blindly
                showResumeButton(aiTextEl, taskId, 'continue');
                break;
            }

            success = true;

        } catch (err) {
            console.error('Orchestration stream error (attempt ' + attempt + '):', err);
            if (attempt > MAX_RETRIES) {
                showResumeButton(aiTextEl, taskId, 'continue');
            }
        }
    }

    flushStreamRender();

    if (fullText) {
        aiTextEl.innerHTML = renderMarkdown(fullText);

        const conv = getConversation(appState.currentAgent);
        if (conv && agenticState.activeTask) {
            conv.history.push(
                { role: 'assistant', content: fullText }
            );
            saveConversations();
        }
    }

    appState.isStreaming = false;
    sendBtn.disabled = !messageInput.value.trim();
    scrollToBottom();
}

// ── Retry & Resume Helpers ──

function showOrchestrateRetry(parentEl, attempt, maxAttempts) {
    removeOrchestrateRetry(parentEl);
    const el = document.createElement('div');
    el.className = 'retry-indicator';
    el.innerHTML = '<span class="tool-spinner"></span> Reconnecting to orchestrator (attempt ' + attempt + '/' + maxAttempts + ')...';
    parentEl.closest('.message-content').appendChild(el);
    scrollToBottom();
}

function removeOrchestrateRetry(parentEl) {
    const mc = parentEl.closest('.message-content');
    if (!mc) return;
    const existing = mc.querySelector('.retry-indicator');
    if (existing) existing.remove();
}

function showResumeButton(parentEl, taskId, action, feedback) {
    const mc = parentEl.closest('.message-content');
    if (!mc) return;

    removeOrchestrateRetry(parentEl);

    const resumeEl = document.createElement('div');
    resumeEl.className = 'resume-card';
    resumeEl.innerHTML = `
        <div class="resume-message">Connection interrupted. Your task progress has been saved.</div>
        <button class="plan-action-btn plan-approve resume-btn" data-task-id="${taskId}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Resume Task
        </button>
    `;
    mc.appendChild(resumeEl);

    resumeEl.querySelector('.resume-btn').addEventListener('click', function() {
        resumeEl.remove();
        callOrchestrate(taskId, action || 'continue', feedback);
    });

    appState.isStreaming = false;
    sendBtn.disabled = !messageInput.value.trim();
    scrollToBottom();
}
