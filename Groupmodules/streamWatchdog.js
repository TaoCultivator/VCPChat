'use strict';
// 工具审批等待期间，服务端不往聊天流里写任何数据（心跳只在模型输出时有），
// 群聊的块间看门狗会把「正在等人点允许」的回复当成僵死熔断：回复被丢掉，工具却在批准后照样执行。
// main.js 把 VCPLog 的审批请求、渲染端发出的审批回应转到这里；某个助手还有审批挂着时，看门狗只续期不熔断。

// 服务端审批默认 5 分钟超时；没收到回应（例如在别的客户端批了）的记录最多挂这么久
const MAX_HOLD_MS = 15 * 60 * 1000;

// 同一条审批最多连续豁免看门狗检查的次数。5 次 × 62s 块间超时 ≈ 5 分钟，
// 与 ApprovalManager 的默认审批超时对齐；超过则即使审批仍挂着也强制熔断，
// 宁可让气泡有终态，也不能让它永远停在「思考中」。
const MAX_CONSECUTIVE_HOLDS = 5;

const pending = new Map(); // requestId → { maid, at }
const holdStreaks = new Map(); // requestId → 连续豁免次数

const normalizeName = (name) => String(name ?? '').trim().toLowerCase();

function noteToolApprovalMessage(message, now = Date.now()) {
    const data = message && typeof message.data === 'object' && message.data ? message.data : {};
    const requestId = data.requestId;
    if (!requestId) return;
    if (message.type === 'tool_approval_request') {
        pending.set(requestId, { maid: normalizeName(data.maid), at: now });
    } else if (message.type === 'tool_approval_response') {
        pending.delete(requestId);
        holdStreaks.delete(requestId);
    }
}

/**
 * 这个助手是否有审批在等人处理。
 *
 * 只有 maid 明确匹配的审批才豁免看门狗：无主审批（maid 为空）无法证明归属，
 * 一旦拿来豁免所有人，就会让所有 agent 的块间看门狗无限续期，气泡永远停在
 * 「思考中」。宁可让看门狗兜底熔断（气泡有终态、已收到的内容保留），也不能
 * 让整条流无声地挂死。
 *
 * 同一条审批连续豁免超过 MAX_CONSECUTIVE_HOLDS 次后强制放行，避免审批
 * 自身卡住（例如弹窗无人处理）时仍然无限续期。计数器按 requestId 绑定，
 * 不同请求各自独立，不会跨话题或跨 agent 累积。
 */
function isWaitingForToolApproval(agentName, now = Date.now()) {
    const name = normalizeName(agentName);
    let waiting = false;
    for (const [requestId, entry] of pending) {
        if (now - entry.at > MAX_HOLD_MS) {
            pending.delete(requestId);
            holdStreaks.delete(requestId);
            continue;
        }
        // 无主审批不再豁免任何人，见上方说明。
        if (!entry.maid || entry.maid !== name) continue;
        const streak = (holdStreaks.get(requestId) || 0) + 1;
        if (streak > MAX_CONSECUTIVE_HOLDS) {
            holdStreaks.delete(requestId);
            console.warn(`[StreamWatchdog] 审批 ${requestId} 连续 ${streak} 次豁免看门狗超限，强制放行熔断。`);
            continue;
        }
        holdStreaks.set(requestId, streak);
        waiting = true;
    }
    return waiting;
}

function clearToolApprovals() {
    pending.clear();
    holdStreaks.clear();
}

/** 保留非 Error 拒绝值；响应头超时不属于用户主动取消。 */
function getGroupErrorMessage(error) {
    if (typeof error?.message === 'string' && error.message) return error.message;
    if (typeof error === 'string' && error) return error;
    try {
        return JSON.stringify(error) || '未知错误';
    } catch {
        return '无法序列化的错误';
    }
}

function normalizeGroupFetchError(error, controller, timeoutMs) {
    if (controller.signal.aborted && controller.signal.reason === 'ttft_timeout') {
        const timeout = new Error(`等待 VCP 响应头超过 ${Math.round(timeoutMs / 1000)} 秒，已中止本轮请求。`, { cause: error });
        timeout.name = 'TimeoutError';
        return timeout;
    }
    if (error instanceof Error) return error;
    const normalized = new Error(getGroupErrorMessage(error), { cause: error });
    if (error?.name === 'AbortError') normalized.name = 'AbortError';
    return normalized;
}
// 看门狗用字符串原因 abort（'chunk_idle_timeout'），reader 抛出的就是这个字符串，没有 .message；用户中止不带原因，抛的是 AbortError
function isWatchdogAbort(streamError, controller) {
    return typeof streamError === 'string' || (controller.signal.aborted && typeof controller.signal.reason === 'string' && streamError?.name !== 'AbortError');
}

/** 熔断时已收到的内容（可能含已执行的工具调用和结果）要留下，并写清楚为什么停了。 */
function withWatchdogNote(content, idleMs) {
    const note = `[System Message] 连续 ${Math.round(idleMs / 1000)} 秒没有收到 VCP 的数据，这一轮回复已中止${content ? '，上面是已收到的部分' : ''}。`;
    return content ? `${content}\n\n${note}` : note;
}

module.exports = { noteToolApprovalMessage, isWaitingForToolApproval, clearToolApprovals, isWatchdogAbort, withWatchdogNote, getGroupErrorMessage, normalizeGroupFetchError, MAX_HOLD_MS, MAX_CONSECUTIVE_HOLDS };
