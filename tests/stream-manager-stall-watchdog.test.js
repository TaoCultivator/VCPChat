'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const originalWindow = global.window;
const bootstrapDom = new JSDOM('<!doctype html>');
global.window = bootstrapDom.window;
test.after(() => {
    global.window = originalWindow;
    bootstrapDom.window.close();
});

const loadFactory = async () => {
    const module = await import('../modules/renderer/streamManager.js');
    const historyModule = await import('../modules/chat/streamTransientHistory.js');
    createDependencies.historyFactory = historyModule.createStreamTransientHistory;
    return module.createStreamProjection;
};

function createDependencies(dom, overrides = {}) {
    const root = dom.window.document.getElementById('chat');
    const dependencies = {
        chatRepository: {
            getHistory: async () => [],
            saveHistory: async () => ({ success: true }),
            ...overrides.chatRepository,
        },
        currentSelectedItemRef: { get: () => ({ id: 'visible-agent', type: 'agent' }) },
        currentTopicIdRef: { get: () => 'visible-topic' },
        currentChatHistoryRef: { get: () => [], set() {} },
        viewAuthority: { isCurrent: context => context?.agentId === 'visible-agent' && context?.topicId === 'visible-topic' },
        globalSettingsRef: { get: () => ({ enableSmoothStreaming: false }) },
        chatMessagesDiv: root,
        renderMessage: () => null,
        uiHelper: { scrollToBottom() {} },
        electronAPI: { onDesktopStatus: () => () => {} },
        prepareFinalTextForRender: (_messageId, text, role) => ({ text, role, depth: 0 }),
        renderPostProcessedHtml: async (content, html) => { content.textContent = html; },
        ...overrides,
    };
    dependencies.transientStreamHistory ||= createDependencies.historyFactory({
        repository: dependencies.chatRepository,
        currentHistory: {
            get: () => dependencies.currentChatHistoryRef.get(),
            replace: history => dependencies.currentChatHistoryRef.set(history),
        },
    });
    return dependencies;
}

const waitFor = async (predicate, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    return predicate();
};

const findBubble = (dom, messageId) =>
    dom.window.document.querySelector('.message-item[data-message-id="' + messageId + '"]');

test('a thinking bubble silent past the stall window degrades to interrupted and offers a retry entry', async () => {
    const createStreamProjection = await loadFactory();
    const dom = new JSDOM(
        '<!doctype html><div id="chat"><article class="message-item thinking streaming" data-message-id="stalled-agent">'
        + '<div class="md-content"><span class="thinking-indicator">思考中...</span></div></article></div>',
        { url: 'https://vcpchat.local/' },
    );
    const previousWindow = global.window;
    global.window = dom.window;
    dom.window.updateSendButtonState = () => {};
    let clock = 0;
    const retries = [];
    const projection = createStreamProjection();
    try {
        projection.attachStreamProjection(createDependencies(dom, {
            // 注入确定性时钟与巡检周期：测试不必真实等待 180 秒。
            now: () => clock,
            streamStallSweepIntervalMs: 5,
            onStalledStreamRetry: (messageId, payload) => { retries.push({ messageId, payload }); },
        }));
        await projection.startStreamingMessage({
            id: 'stalled-agent',
            agentId: 'visible-agent',
            topicId: 'visible-topic',
            content: '',
        });
        assert.equal(
            new Set(projection.getDiagnostics().activeMessageIds).has('stalled-agent'),
            true,
            'the stream must be owned before it can be judged silent',
        );

        // 静默：一块数据都不送，把注入时钟推过阈值。
        clock = 181000;
        const degraded = await waitFor(() => findBubble(dom, 'stalled-agent')?.classList.contains('stream-stalled') === true);
        assert.equal(degraded, true, 'a bubble silent past the stall window must degrade to interrupted');

        const bubble = findBubble(dom, 'stalled-agent');
        assert.equal(bubble.classList.contains('thinking'), false, 'the thinking affordance must be withdrawn');
        assert.equal(bubble.classList.contains('streaming'), false, 'the streaming affordance must be withdrawn');

        const notice = bubble.querySelector('.stream-stalled-notice');
        assert.ok(notice, 'the interrupted bubble must carry an interruption notice');
        const retryButton = notice.querySelector('.stream-stalled-retry');
        assert.ok(retryButton, 'the interrupted bubble must offer a retry entry');
        assert.equal(retryButton.textContent.trim().length > 0, true, 'the retry entry must be labelled');

        retryButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        const retried = await waitFor(() => retries.length > 0);
        assert.equal(retried, true, 'clicking the retry entry must reach the retry handler');
        assert.equal(retries[0].messageId, 'stalled-agent');
        assert.equal(retries[0].payload.context.agentId, 'visible-agent', 'the retry payload must carry the stream context');

        // 降级走的是正规终态投影，流所有权必须真的被释放，而不是只改了一层样式。
        assert.equal(
            new Set(projection.getDiagnostics().activeMessageIds).has('stalled-agent'),
            false,
            'degrading a stalled stream must release its runtime ownership',
        );
    } finally {
        await projection.dispose();
        global.window = previousWindow;
        dom.window.close();
    }
});

test('a stream that keeps receiving inflight data is never degraded no matter how long it lives', async () => {
    const createStreamProjection = await loadFactory();
    const dom = new JSDOM(
        '<!doctype html><div id="chat"><article class="message-item thinking streaming" data-message-id="busy-agent">'
        + '<div class="md-content"></div></article></div>',
        { url: 'https://vcpchat.local/' },
    );
    const previousWindow = global.window;
    global.window = dom.window;
    dom.window.updateSendButtonState = () => {};
    let clock = 0;
    const retries = [];
    const projection = createStreamProjection();
    try {
        projection.attachStreamProjection(createDependencies(dom, {
            now: () => clock,
            streamStallSweepIntervalMs: 5,
            onStalledStreamRetry: messageId => { retries.push(messageId); },
        }));
        await projection.startStreamingMessage({
            id: 'busy-agent',
            agentId: 'visible-agent',
            topicId: 'visible-topic',
            content: '',
        });

        // 总跨度 300 秒，但每次间隔 30 秒——远低于 180 秒阈值。
        for (let step = 0; step < 10; step += 1) {
            clock += 30000;
            projection.appendStreamChunk('busy-agent', { content: 'chunk-' + step }, {
                agentId: 'visible-agent',
                topicId: 'visible-topic',
            });
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        const bubble = findBubble(dom, 'busy-agent');
        assert.equal(
            bubble.classList.contains('stream-stalled'),
            false,
            'a stream receiving inflight data must never be degraded, however long it lives',
        );
        assert.equal(bubble.querySelector('.stream-stalled-notice'), null, 'no interruption notice may appear');
        assert.equal(retries.length, 0, 'the retry handler must not be armed for a live stream');
        assert.equal(
            new Set(projection.getDiagnostics().activeMessageIds).has('busy-agent'),
            true,
            'a live stream must keep its runtime ownership',
        );
    } finally {
        await projection.dispose();
        global.window = previousWindow;
        dom.window.close();
    }
});

test('the interrupted bubble styles ship with the retry affordance', () => {
    const css = fs.readFileSync(path.join(__dirname, '../styles/chat.css'), 'utf8');
    assert.match(css, /\.stream-stalled-notice\s*\{/, 'the interruption notice needs a style rule');
    assert.match(css, /\.stream-stalled-retry\s*\{/, 'the retry entry needs a style rule');
    assert.match(css, /\.stream-stalled-retry:disabled\s*\{/, 'the retry entry needs a disabled state');
});