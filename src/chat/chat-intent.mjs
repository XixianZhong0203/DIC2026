// Pre-send intent detection for chat input: before a message is answered (and
// before project memory is retrieved) the app decides which conversation the
// input belongs to:
//   continue — follow-up in the current conversation (no prompt card);
//   new      — an independent new task in the same workspace;
//   switch   — the user moves to another existing workspace;
//   compare  — a cross-workspace comparison, or a reference to another
//              workspace without a clear switch intent.
//
// Code ownership (aligned with the decision-card window):
//   this module — deterministic rules (explicit switch phrases, workspace
//     mentions, comparison signals) and validation of the LLM's suggestion;
//   server.mjs — /api/chat-intent: runs the rules, then asks the model only
//     when the rules are uncertain, and validates the target workspace;
//   dist/app.js — the prompt card and the single-send wiring.
//
// A mention of another workspace name is only a signal; the whole sentence
// decides. When the judgment is uncertain (or the model assist fails), the
// input stays as written and the manual workspace switcher remains the entry.

export const INTENT_ACTIONS = ['continue', 'new', 'switch', 'compare'];

// Explicit "move the conversation to another workspace" phrasing.
const SWITCH_RE = /切换到|切到|换到|换成|换个(?:项目|客户|工作区)?|转到|转移到|挪到|switch to|switch over to|change to|change over to|move to|move over to|turn to|jump to/i;
// Explicit "start a fresh conversation" phrasing (same workspace).
const NEW_RE = /新开?(?:一个|一条)?(?:对话|会话|聊天)|新对话|新会话|另起|另开|start a new (?:conversation|chat)|open a new (?:conversation|chat)|new (?:conversation|chat)/i;
// Comparison phrasing that marks a cross-workspace request.
const COMPARE_RE = /对比|比较|对照|compared to|compared with|compare|comparison|versus|\bvs\.?/i;

// Which known workspaces are named in the text (case-insensitive substring).
// `mentions` excludes the current workspace; `mentionsAll` includes it so a
// comparison like "对比 A 和 B" from A counts both sides.
export function workspaceMentions(text, workspaces, current = '') {
  const lowered = String(text).toLowerCase();
  const names = (workspaces ?? []).filter(name => typeof name === 'string' && name.trim());
  const seen = name => lowered.includes(name.trim().toLowerCase());
  const mentionsAll = names.filter(seen);
  return {
    mentions: mentionsAll.filter(name => name.trim() !== String(current).trim()),
    mentionsAll,
  };
}

// The deterministic pass. Returns null when the input is ambiguous and the
// model assist should decide (see the route in server.mjs).
export function ruleIntent(text, workspaces, current = '') {
  const { mentions, mentionsAll } = workspaceMentions(text, workspaces, current);
  // 1. Explicit switch phrase naming exactly one other existing workspace.
  if (SWITCH_RE.test(text) && mentions.length === 1) {
    return { action: 'switch', workspace: mentions[0], involved: [], reason: '明确的切换措辞指向一个已存在的工作区。' };
  }
  // 2. Explicit fresh-conversation request, no other workspace named.
  if (NEW_RE.test(text) && mentions.length === 0) {
    return { action: 'new', workspace: '', involved: [], reason: '明确要求另开对话，且没有指向其他工作区。' };
  }
  // 3. Comparison phrasing naming at least two workspaces (the current one
  //    counts as a side of the comparison).
  if (COMPARE_RE.test(text) && mentionsAll.length >= 2) {
    return { action: 'compare', workspace: '', involved: mentionsAll, reason: '比较措辞涉及多个工作区，按跨工作区请求处理。' };
  }
  return null;
}

// Validate the model's suggestion. The target workspace must exist in the
// supplied list; anything else is rejected as uncertain (the caller keeps the
// original input and the manual switch entry).
export function normalizeIntent(raw, { workspaces = [], current = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : '';
  if (!INTENT_ACTIONS.includes(action)) return null;
  const workspace = typeof raw.workspace === 'string' ? raw.workspace.trim() : '';
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 200) : '';
  if (action === 'continue') return { action, workspace: '', involved: [], reason };
  if (action === 'new') return { action, workspace: '', involved: [], reason };
  if (workspace && !workspaces.includes(workspace)) return null; // target must exist
  if (action === 'switch') {
    if (!workspace || workspace === String(current).trim()) return null;
    return { action, workspace, involved: [], reason };
  }
  return { action: 'compare', workspace, involved: [], reason };
}
