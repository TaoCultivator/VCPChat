'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// 每个用例独立加载一份 groupchat 模块，模块级 inviteInFlight 因此互不污染。
async function fixture(t, { members = ['a'], mode = 'invite_only' } = {}) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ginvite-lock-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const filename = path.resolve(__dirname, '../Groupmodules/groupchat.js');
    const localRequire = createRequire(filename);

    const requests = [];
    const events = [];
    let releaseFetch = null;
    // 默认闸门不打开，用来把邀请稳定地卡在「在途」状态；用例结束前统一放行。
    const gate = new Promise(resolve => { releaseFetch = resolve; });
    let holdFetch = true;

    const module = { exports: {} };
    const sandbox = {
        module, exports: module.exports,
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, AbortController, TextDecoder, URL,
        fetch: async (_url, options) => {
            requests.push(JSON.parse(options.body));
            if (holdFetch) await gate;
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'INVITE_RESPONSE' } }],
            }), { headers: { 'Content-Type': 'application/json' } });
        },
        require: name => {
            if (name === 'electron') return { ipcMain: {} };
            if (name === '../modules/modelTrajectory') return {
                beginTrajectoryCall: () => ({ chunk() {}, finish() {} }),
                sessionKeyFromContext: () => 'session',
                sourceFromContext: value => value,
            };
            if (name === '../modules/contextSanitizer') return {
                stripThoughtChains: value => value, sanitizeMessages: value => value,
            };
            if (name === '../modules/ipc/tavernHandlers') return { getActiveRules: () => [] };
            if (name === './topicTitleManager') return { triggerSummarizationIfNeeded: async () => {} };
            if (['../modules/fileManager', '../modules/ipc/canvasHandlers',
                '../modules/tavernRulesEngine',
                './jevGroupSessionOrchestrator'].includes(name)) return {};
            return localRequire(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const api = module.exports;

    localRequire('../modules/services/conversationContext').initialize({
        load: owner => api.getAgentGroupConfig(owner.id),
        update: (owner, mutate) => api.mutateGroupConfig(owner.id, mutate),
        workspace: () => ({ workspaces: [], activeWorkspaceId: null }),
        rules: async () => ({ rules: [] }),
    });

    const settingsFile = path.join(root, 'settings.json');
    await fsp.writeFile(settingsFile, JSON.stringify({
        vcpServerUrl: 'http://localhost:1234/v1/chat/completions', vcpApiKey: 'test',
    }));
    api.initializePaths({
        APP_DATA_ROOT_IN_PROJECT: root,
        USER_DATA_DIR: path.join(root, 'users'),
        AGENT_DIR: path.join(root, 'agents'),
        SETTINGS_FILE: settingsFile,
    });

    const created = await api.createAgentGroup('lockgroup', { mode, members });
    assert.equal(created.success, true);
    const groupId = created.agentGroup.id;
    const topicId = created.agentGroup.topics[0].id;

    await api.appendGroupHistoryMessage(groupId, topicId, {
        id: 'user-1', role: 'user', name: '用户', content: 'HELLO',
    });

    const loadAgent = async agentId => ({
        id: agentId, name: `Agent ${agentId}`, model: 'test',
        systemPrompt: 'PERSONA', streamOutput: false,
    });

    const invoke = agentId => api.handleInviteAgentToSpeak(
        groupId, topicId, agentId, data => events.push(data), loadAgent,
        { skipSummary: true },
    );

    const redo = (messageId, agentId) => api.redoGroupChatMessage(
        groupId, topicId, messageId, agentId, data => events.push(data), loadAgent,
    );

    // 无论用例断言是否失败都必须放行闸门，否则 fetch 永久挂起会让测试进程不退出。
    t.after(() => { holdFetch = false; releaseFetch(); });

    // 邀请在真正发出 fetch 之前还要读配置、读历史、解析规则，全是 await；
    // 断言请求次数必须等它到站，不能只看调用瞬间。
    const waitForRequests = async (expected, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (requests.length < expected) {
            if (Date.now() > deadline) {
                throw new Error(`等待 ${expected} 个请求超时，实际只有 ${requests.length} 个`);
            }
            await new Promise(resolve => setImmediate(resolve));
        }
        // 再多转几拍，让可能存在的「多余请求」有机会暴露出来。
        for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
        return requests.length;
    };

    return {
        api, groupId, topicId, invoke, redo, requests, events,
        waitForRequests,
        release: () => { holdFetch = false; releaseFetch(); },
    };
}

test('同一 (群组,话题,Agent) 的在途邀请只放行一次', async t => {
    const f = await fixture(t);
    const first = f.invoke('a');           // 卡在 fetch 闸门，保持“在途”
    await f.waitForRequests(1);

    const second = f.invoke('a');          // 应被在途锁直接拒绝，不发起请求
    await second;
    assert.equal(f.requests.length, 1, '重复邀请不得发起第二次请求');

    f.release();
    await first;
    assert.equal(f.requests.length, 1, '放行被拒绝的那次也不应补发请求');
});

test('邀请完成后锁释放，同一 Agent 的下一次邀请正常执行', async t => {
    const f = await fixture(t);
    const first = f.invoke('a');
    await f.waitForRequests(1);
    f.release();
    await first;

    const again = f.invoke('a');
    await f.waitForRequests(2);
    f.release();
    await again;
    assert.equal(f.requests.length, 2, '前一次结束后必须能再次邀请同一 Agent');
});

test('不同 Agent 的并发邀请互不误伤', async t => {
    const f = await fixture(t, { members: ['a', 'b'] });
    const firstA = f.invoke('a');
    const firstB = f.invoke('b');

    // 两者是不同的锁 key，必须各自发出请求。
    await f.waitForRequests(2);

    f.release();
    await Promise.all([firstA, firstB]);
    assert.equal(f.requests.length, 2);
});

test('成员仍在发言时 redo 被拒绝，历史不被删除', async t => {
    const f = await fixture(t);
    await f.api.appendGroupHistoryMessage(f.groupId, f.topicId, {
        id: 'assistant-1', role: 'assistant', name: 'Agent a', agentId: 'a',
        content: 'PREVIOUS_REPLY', isGroupMessage: true,
    });
    const before = await f.api.getGroupChatHistory(f.groupId, f.topicId);

    const inFlight = f.invoke('a');        // 卡住该成员，锁已建立
    await f.waitForRequests(1);

    await f.redo('assistant-1', 'a');      // 应被前置守卫拒绝

    const after = await f.api.getGroupChatHistory(f.groupId, f.topicId);
    assert.equal(after.length, before.length, 'redo 被拒绝时不得删除历史消息');
    assert.ok(after.some(message => message.id === 'assistant-1'), '被重生成的消息必须仍在历史中');
    assert.equal(f.requests.length, 1, '被拒绝的 redo 不得发起新请求');
    assert.ok(
        f.events.some(event => event.type === 'error' && /正在发言中/.test(event.error || '')),
        'redo 被拒绝时应向渲染端给出可见提示'
    );

    f.release();
    await inFlight;
});

test('成员空闲时 redo 正常执行并重建回复', async t => {
    const f = await fixture(t);
    await f.api.appendGroupHistoryMessage(f.groupId, f.topicId, {
        id: 'assistant-1', role: 'assistant', name: 'Agent a', agentId: 'a',
        content: 'PREVIOUS_REPLY', isGroupMessage: true,
    });

    const redoPromise = f.redo('assistant-1', 'a');
    f.release();
    await redoPromise;

    const after = await f.api.getGroupChatHistory(f.groupId, f.topicId);
    assert.ok(!after.some(message => message.id === 'assistant-1'), '旧回复应被移除');
    assert.ok(after.some(message => message.content === 'INVITE_RESPONSE'), '新回复应写入历史');
});