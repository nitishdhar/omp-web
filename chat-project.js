"use strict";
const { createHash } = require("crypto");

// Pure projection of raw JSONL entries -> { items, derived, state }.
// No I/O. Caller round-trips `state` across incremental batches so that
// tools started in one batch can be settled in a later batch.
//
// project(entries, prev?) -> { items, derived, state }
//
// items  – new or updated ChatItems (client upserts by id; tool items appear
//           once as "running" and again when settled)
// derived – full derived snapshot (small; always current)
// state  – opaque carry-over; pass as `prev` on the next call

// ── Payload bounds ──────────────────────────────────────────────────────────
const RESULT_TEXT_LIMIT = 4000;
const ARGS_JSON_LIMIT   = 2000;
const TEXT_LIMIT        = 20000;
const META_TEXT_LIMIT   = 512;
const PATH_TEXT_LIMIT   = 1024;
const TASK_PREVIEW_LEN  = 120;
const ADVISORY_TEXT_LIMIT = 1000;
const MAX_PENDING_TOOLS = 256;
const MAX_SUBAGENTS     = 256;
const MAX_ASK_QUESTIONS = 20;
const MAX_ASK_OPTIONS   = 20;
const MAX_TODO_PHASES   = 50;
const MAX_TODO_TASKS    = 500;
const MAX_CHANGES       = 100;
const THINKING_TEXT_LIMIT = 8000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function cut(str, limit) {
  if (typeof str !== "string") return { text: "", truncated: false };
  if (str.length <= limit) return { text: str, truncated: false };
  return { text: str.slice(0, limit), truncated: true };
}

// Concatenate all text-type content blocks; ignore encrypted/image blocks.
function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(b => b.type === "text" && typeof b.text === "string")
    .map(b => b.text)
    .join("\n");
}

// Serialize tool arguments to JSON, applying the args bound.
function serializeArgs(args) {
  if (args == null) return { text: null, truncated: false };
  try {
    return cut(JSON.stringify(args), ARGS_JSON_LIMIT);
  } catch {
    return { text: null, truncated: false };
  }
}
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function boundedString(value, limit = META_TEXT_LIMIT) {
  return cut(typeof value === "string" ? value : "", limit).text;
}
function stripXml(value) {
  return typeof value === "string" ? value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}
function boundedId(value) {
  if (typeof value !== "string") return null;
  if (value.length <= 256) return value;
  return `${value.slice(0, 191)}:${sha256(value).slice(0, 64)}`;
}

function diffCounts(diff) {
  if (typeof diff !== "string") return {};
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (/^\+\d+[|│]/.test(line) || (line[0] === "+" && !line.startsWith("+++"))) added++;
    if (/^-\d+[|│]/.test(line) || (line[0] === "-" && !line.startsWith("---"))) removed++;
  }
  return { added, removed };
}

function changeFromResult(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.path !== "string") return null;
  const path = boundedString(entry.path, PATH_TEXT_LIMIT);
  if (!path) return null;
  return Object.assign({ path }, diffCounts(entry.diff));
}

// OMP edit results expose {path,diff} for one file or perFileResults[] for
// batches. ast_edit applies later through resolve and exposes applied file
// paths under sourceResultDetails. Prose and call arguments are never evidence.
function changesFromToolResult(toolName, details) {
  if (!details || typeof details !== "object") return { changes: null, truncated: false };
  let sourceName = toolName;
  let source = details;

  const resolved = details.sourceResultDetails
    ? details
    : details.xdev && details.xdev.inner && typeof details.xdev.inner === "object"
      ? details.xdev.inner
      : null;
  if (
    resolved
    && resolved.action === "apply"
    && resolved.sourceToolName === "ast_edit"
    && resolved.sourceResultDetails
  ) {
    sourceName = "ast_edit";
    source = resolved.sourceResultDetails;
  }

  let candidates = [];
  if (sourceName === "edit" || sourceName === "apply_patch") {
    if (Array.isArray(source.perFileResults)) candidates = source.perFileResults;
    else if (typeof source.path === "string") candidates = [source];
  } else if (sourceName === "ast_edit" && source.applied === true) {
    if (Array.isArray(source.fileReplacements)) candidates = source.fileReplacements;
    else if (Array.isArray(source.files)) candidates = source.files.map(path => ({ path }));
  }

  const truncated = candidates.length > MAX_CHANGES;
  const changes = candidates.slice(0, MAX_CHANGES).map(changeFromResult).filter(Boolean);
  return { changes: changes.length ? changes : null, truncated };
}

function sanitizeQuestions(questions) {
  if (!Array.isArray(questions)) return { questions: [], omitted: 0, omittedOptions: 0 };
  let omittedOptions = 0;
  const kept = questions.slice(0, MAX_ASK_QUESTIONS).map((question) => {
    const options = Array.isArray(question && question.options) ? question.options : [];
    omittedOptions += Math.max(0, options.length - MAX_ASK_OPTIONS);
    return {
      header: boundedString(question && question.header),
      question: boundedString(question && question.question),
      recommended: Number.isFinite(question && question.recommended)
        ? question.recommended
        : boundedString(question && question.recommended),
      options: options.slice(0, MAX_ASK_OPTIONS).map(option => ({
        label: boundedString(option && option.label),
        description: boundedString(option && option.description),
      })),
    };
  });
  return {
    questions: kept,
    omitted: questions.length - kept.length,
    omittedOptions,
  };
}

function sanitizeTodo(details) {
  const source = Array.isArray(details && details.phases) ? details.phases : [];
  const phases = [];
  let remainingTasks = MAX_TODO_TASKS;
  let omittedTasks = 0;
  for (const phase of source.slice(0, MAX_TODO_PHASES)) {
    const tasks = Array.isArray(phase && phase.tasks) ? phase.tasks : [];
    const take = Math.min(tasks.length, remainingTasks);
    phases.push({
      name: boundedString(phase && phase.name),
      tasks: tasks.slice(0, take).map(task => ({
        content: boundedString(task && task.content),
        status: boundedString(task && task.status, 64),
        blocker: boundedString(task && task.blocker),
      })),
    });
    omittedTasks += tasks.length - take;
    remainingTasks -= take;
  }
  return {
    phases,
    omittedPhases: Math.max(0, source.length - phases.length),
    omittedTasks,
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

function defaultState() {
  return {
    pendingTools: Object.create(null),
    toolStartTimes: Object.create(null),
    title: null,
    model: null,
    modelAt: null,
    provider: null,
    cwd: null,
    effort: null,
    effortSource: null,
    latestUsage: null,
    spend: 0,
    latestTodo: null,
    subagents: [],
    latestAdvisor: null,
    exited: null,
    pendingAsk: null,
    working: null,
    error: null,
    omitted: {
      pendingTools: 0,
      subagents: 0,
      askQuestions: 0,
      askOptions: 0,
      todoPhases: 0,
      todoTasks: 0,
      jobUpdates: 0,
    },
  };
}

// Copy every nested value mutated during projection. Checkpoints may share
// immutable strings/snapshots, but never mutable tool, work, or agent records.
function cloneState(prev) {
  if (!prev) return defaultState();
  return {
    pendingTools: Object.assign(
      Object.create(null),
      Object.fromEntries(
        Object.entries(prev.pendingTools || {}).map(([key, value]) => [key, Object.assign({}, value)])
      )
    ),
    toolStartTimes: Object.assign(Object.create(null), prev.toolStartTimes),
    title: prev.title,
    model: prev.model,
    modelAt: prev.modelAt || null,
    provider: prev.provider,
    cwd: prev.cwd,
    latestUsage: prev.latestUsage,
    spend: prev.spend || 0,
    effort: prev.effort,
    effortSource: prev.effortSource || null,
    latestTodo: prev.latestTodo,
    subagents: (prev.subagents || []).map(agent => Object.assign({}, agent)),
    latestAdvisor: prev.latestAdvisor || null,
    exited: prev.exited,
    pendingAsk: prev.pendingAsk,
    working: prev.working ? Object.assign({}, prev.working) : null,
    error: prev.error,
    omitted: Object.assign(defaultState().omitted, prev.omitted),
  };
}

// ── Projection ────────────────────────────────────────────────────────────────

function latestRunningSubagent(state, name) {
  for (let i = state.subagents.length - 1; i >= 0; i--) {
    const candidate = state.subagents[i];
    if (candidate.name === name && candidate.status === "running") return candidate;
  }
  return null;
}
function rememberPendingTool(state, toolCallId, toolItem, startedAt) {
  if (state.pendingTools[toolCallId]) {
    state.pendingTools[toolCallId] = toolItem;
    if (startedAt) state.toolStartTimes[toolCallId] = startedAt;
    return true;
  }
  if (Object.keys(state.pendingTools).length >= MAX_PENDING_TOOLS) {
    state.omitted.pendingTools++;
    return false;
  }
  state.pendingTools[toolCallId] = toolItem;
  if (startedAt) state.toolStartTimes[toolCallId] = startedAt;
  return true;
}

function rememberSubagent(state, task) {
  if (state.subagents.length >= MAX_SUBAGENTS) {
    const settled = state.subagents.findIndex(agent => agent.status !== "running");
    if (settled !== -1) state.subagents.splice(settled, 1);
  }
  if (state.subagents.length >= MAX_SUBAGENTS) {
    state.omitted.subagents++;
    return;
  }
  state.subagents.push({
    name: boundedString(task && task.name) || "unnamed",
    agent: boundedString(task && task.agent, 128) || "task",
    taskPreview: cut(typeof (task && task.task) === "string" ? task.task : "", TASK_PREVIEW_LEN).text,
    status: "running",
  });
}

// `keepEffort`: a model_change is OMP's own record of a switch, and OMP writes
// thinking_level_change after it only when the level changed, so the level in
// force carries over. Inferred changes (a reply naming another model) still
// clear it.
function applyRuntimeIdentity(state, model, provider, at, { keepEffort = false } = {}) {
  const nextModel = model ? boundedString(model) : null;
  const nextProvider = provider ? boundedString(provider) : null;
  const changed =
    (state.model && nextModel && state.model !== nextModel)
    || (state.provider && nextProvider && state.provider !== nextProvider);
  if (changed && !keepEffort) {
    state.effort = null;
    state.effortSource = null;
  }
  if (nextModel) {
    state.model = nextModel;
    state.modelAt = at || state.modelAt;
  }
  if (nextProvider) state.provider = nextProvider;
}

function project(entries, prev) {
  const state = cloneState(prev);
  const items = [];

  for (const entry of entries) {
    const type = boundedString(entry && entry.type, 128);
    const id = boundedId(entry && entry.id);
    const at = typeof (entry && entry.timestamp) === "string"
      ? boundedString(entry.timestamp, 64)
      : null;

    // ── Legacy title pad — skip silently ──
    if (type === "title") continue;

    // ── Session header — seed cwd/title but emit nothing ──
    if (type === "session") {
      if (entry.cwd && state.cwd == null) state.cwd = boundedString(entry.cwd, PATH_TEXT_LIMIT);
      if (entry.title && state.title == null) state.title = boundedString(entry.title);
      continue;
    }

    // ── Credential pin — never render ──
    if (type === "credential_pin") continue;

    // ── Title change ──
    if (type === "title_change") {
      state.title = boundedString(entry.title);
      items.push({ id, at, kind: "event", text: `Title: "${state.title}"` });
      continue;
    }

    // ── Model change ──
    if (type === "model_change") {
      // model_change carries `provider/id` while replies carry `id` plus a
      // provider field; split it so the two never read as a model change.
      const named = typeof entry.model === "string" ? entry.model : "";
      const slash = named.indexOf("/");
      applyRuntimeIdentity(
        state,
        slash > 0 ? named.slice(slash + 1) : named,
        slash > 0 ? named.slice(0, slash) : null,
        at,
        { keepEffort: true },
      );
      items.push({ id, at, kind: "event", text: `Model: ${state.model || "unknown"}` });
      continue;
    }

    // Reasoning controls remain available in Terminal mode; chat uses the
    // activity row instead of rendering thinking-level timeline noise.
    if (type === "thinking_level_change") {
      state.effort = boundedString(entry.thinkingLevel) || null;
      state.effortSource = state.effort ? "transcript" : null;
      continue;
    }

    // ── Compaction ──
    if (type === "compaction") {
      const before = entry.tokensBefore;
      const after  = entry.tokensAfter;
      const text = (before != null && after != null)
        ? `Compacted ${Number(before)} \u2192 ${Number(after)} tokens`
        : `Compaction: ${boundedString(entry.shortSummary) || "context compacted"}`;
      items.push({ id, at, kind: "event", text: boundedString(text) });
      continue;
    }

    // ── Custom entries ──
    if (type === "custom") {
      const { customType, data } = entry;

      if (customType === "tool_execution_start") {
        const { toolName, startedAt, args, intent } = data || {};
        const toolCallId = boundedId((data || {}).toolCallId);
        if (!toolCallId) continue;

        // Any new execution proves a previously recorded session exit is
        // historical (profile reloads copy the old transcript before appending).
        state.exited = null;
        state.error = null;
        const safeToolName = boundedString(toolName, 128);
        const safeIntent = boundedString(intent);
        if (!state.working) {
          state.working = {
            startedAt: startedAt || at,
            intent: safeIntent || (safeToolName ? `Running ${safeToolName}` : "Working"),
          };
        } else if (safeIntent) {
          state.working.intent = safeIntent;
        }

        let toolItem = state.pendingTools[toolCallId];
        if (!toolItem) {
          const argsResult = serializeArgs(args);
          toolItem = {
            id: toolCallId,
            at: startedAt || at,
            kind: "tool",
            toolCallId,
            name: safeToolName || null,
            intent: safeIntent || null,
            args: argsResult.text,
            state: "running",
            resultText: null,
            truncated: argsResult.truncated || undefined,
          };
          rememberPendingTool(state, toolCallId, toolItem, startedAt);
        } else {
          if (safeIntent) toolItem.intent = safeIntent;
          if (startedAt) state.toolStartTimes[toolCallId] = startedAt;
        }

        items.push(Object.assign({}, toolItem));
        continue;
      }

      // OMP persists its terminal Todo HUD immediately after the authoritative
      // todo tool result. The result above already owns structured state; the
      // HUD record is presentation metadata, not a conversation event.
      if (customType === "todo_hud_state") {
        continue;
      }
      if (customType === "session_exit") {
        state.exited = {
          reason: boundedString((data || {}).reason) || null,
          kind: boundedString((data || {}).kind, 128) || null,
          at: (data || {}).recordedAt || at,
        };
        // Runtime-local state cannot survive an OMP process exit. Keep durable
        // Todo/agent history, but do not present its model or work as current.
        state.pendingTools = {};
        state.toolStartTimes = {};
        state.pendingAsk = null;
        state.latestAdvisor = null;
        state.working = null;
        state.model = null;
        state.modelAt = null;
        state.provider = null;
        state.effort = null;
        state.effortSource = null;
        state.latestUsage = null;
        state.subagents = state.subagents.map((s) =>
          s.status === "running" ? Object.assign({}, s, { status: "ended" }) : s,
        );
        const label = state.exited.reason || state.exited.kind || "exit";
        items.push({ id, at, kind: "event", text: `Session exited: ${label}` });
        continue;
      }

      // Unknown custom type — generic event.
      items.push({ id, at, kind: "event", text: `custom/${boundedString(customType, 128) || "unknown"}` });
      continue;
    }

    // ── Control-plane messages ──────────────────────────────────────────────
    // custom_message records are harness control envelopes, not conversation:
    // async-result embeds full subagent output, irc:incoming embeds agent
    // coordination, mid-run-todo-nudge is hidden guidance, and skill-prompt
    // embeds private runtime instructions. Project their structured effects
    // only; never leak their raw content into the user transcript.
    if (type === "custom_message") {
      if (entry.customType === "advisor") {
        const details = entry.details || {};
        const notes = Array.isArray(details.notes) ? details.notes : [];
        const text = typeof entry.content === "string" ? entry.content : "";
        // Surface the latest advisory note so the Chat rail can mirror the
        // TUI's active advisor banner without rendering full advisory XML.
        const noteText = notes.map(n => typeof n.note === "string" ? n.note : "").filter(Boolean).join(" ") || text;
        if (noteText) {
          const firstNote = notes[0] || {};
          const xmlAttrs = text.match(/<advisory\s+([^>]*)>/)?.[1] || "";
          const xmlSeverity = xmlAttrs.match(/severity=(["\u0027])([^\1]+)\1/)?.[2];
          const xmlGuidance = xmlAttrs.match(/guidance=(["\u0027])([^\1]+)\1/)?.[2];
          state.latestAdvisor = {
            id,
            at,
            severity: boundedString(firstNote.severity || xmlSeverity || details.severity || entry.severity, 32) || "note",
            guidance: boundedString(xmlGuidance || details.guidance || entry.guidance, 128) || "",
            text: cut(stripXml(noteText), ADVISORY_TEXT_LIMIT).text,
          };
        }
        continue;
      }
      if (entry.customType === "async-result") {
        // details.jobs[].jobId is the reliable join to a task call.
        const sourceJobs = Array.isArray(entry.details && entry.details.jobs)
          ? entry.details.jobs
          : [];
        const jobs = sourceJobs.slice(0, MAX_SUBAGENTS);
        state.omitted.jobUpdates += Math.max(0, sourceJobs.length - jobs.length);
        for (const job of jobs) {
          if (!job || job.type !== "task") continue;
          const key = boundedString(job.jobId || job.label);
          const hit = latestRunningSubagent(state, key);
          if (hit) {
            hit.status = "complete";
            if (Number.isFinite(job.durationMs)) hit.durationMs = Math.max(0, Math.round(job.durationMs));
          }
        }
      }
      continue;
    }

    // ── Messages ──
    if (type === "message") {
      const msg  = entry.message || {};
      const role = msg.role;

      // ── User message ──
      if (role === "user") {
        // A user message starts a new turn and, after a profile reload, a new
        // runtime epoch within the copied transcript.
        state.exited = null;
        state.error = null;
        state.working = { startedAt: at, intent: "Thinking" };
        // An advisory belongs to the turn that produced it. A new user turn
        // expires it; otherwise the latest note in history renders forever,
        // long after the advisor is disabled or the moment has passed.
        state.latestAdvisor = null;
        const raw = textFromContent(msg.content);
        if (raw) {
          const t = cut(raw, TEXT_LIMIT);
          const item = { id, at, kind: "user", text: t.text, textHash: sha256(raw) };
          if (t.truncated) item.truncated = true;
          items.push(item);
        }
        continue;
      }

      // ── Assistant message ──
      if (role === "assistant") {
        state.exited = null;
        const stopReason = boundedString(msg.stopReason, 64) || null;
        const failed = stopReason === "error" || stopReason === "aborted";
        if (failed) {
          const raw = typeof msg.errorMessage === "string"
            ? msg.errorMessage
            : `Assistant ${stopReason}`;
          const t = cut(raw, RESULT_TEXT_LIMIT);
          const errorStatus = typeof msg.errorStatus === "string"
            ? boundedString(msg.errorStatus, 128)
            : Number.isFinite(msg.errorStatus) ? msg.errorStatus : null;
          state.error = {
            status: errorStatus,
            reason: stopReason,
            message: t.text,
            at,
          };
          state.working = null;
          items.push({
            id: `${id}:error`,
            at,
            kind: "error",
            status: errorStatus,
            text: t.text,
            truncated: t.truncated || undefined,
          });
        } else if (stopReason === "stop") {
          state.working = null;
        } else {
          state.error = null;
          state.working = state.working || { startedAt: at, intent: "Thinking" };
        }
        applyRuntimeIdentity(state, msg.model, msg.provider, at);
        if (msg.usage && Number.isFinite(msg.usage.totalTokens)) {
          state.latestUsage = { totalTokens: msg.usage.totalTokens };
        }
        // Spend is per-message and additive, unlike totalTokens which is a
        // running context size. Accumulating it here is the only place the
        // whole session is seen, so it must survive checkpoint carry.
        if (msg.usage && Number.isFinite(msg.usage.cost?.total)) {
          state.spend += msg.usage.cost.total;
        }

        let assistantText = null;

        // Reasoning is emitted in order with the text/tool it precedes, so a
        // thinking item never reorders a turn. Consecutive blocks join into one
        // item: providers split reasoning arbitrarily and one row per fragment
        // would shred a tool run into unrelated groups.
        let thinkingParts = [];
        let thinkingIndex = -1;
        const flushThinking = () => {
          if (!thinkingParts.length) return;
          const t = cut(thinkingParts.join("\n\n"), THINKING_TEXT_LIMIT);
          items.push({
            id: `${id}:thinking:${thinkingIndex}`,
            at,
            kind: "thinking",
            text: t.text,
            truncated: t.truncated || undefined,
          });
          thinkingParts = [];
          thinkingIndex = -1;
        };

        let blockIndex = -1;
        for (const block of (msg.content || [])) {
          blockIndex++;
          if (block.type === "thinking") {
            // Redacted reasoning arrives as an empty `thinking` string with a
            // signature; there is nothing to show.
            const text = typeof block.thinking === "string" ? block.thinking.trim() : "";
            if (text) {
              if (thinkingIndex < 0) thinkingIndex = blockIndex;
              thinkingParts.push(text);
            }
            continue;
          }
          // Any other block ends the reasoning run, so it lands before that
          // block's item.
          flushThinking();

          // Text block — accumulate (there should be at most one per message,
          // but join defensively).
          if (block.type === "text" && block.text) {
            assistantText = assistantText == null
              ? block.text
              : assistantText + "\n" + block.text;
            continue;
          }

          // Tool call block — emit as a running tool item.
          if (block.type === "toolCall") {
            const toolCallId = boundedId(block.id);
            const name = boundedString(block.name, 128);
            const args = block.arguments || {};
            const rawIntent = (args && typeof args.i === "string") ? args.i : block.intent;
            const intent = boundedString(rawIntent) || null;
            const argsResult = serializeArgs(args);

            const toolItem = {
              id: toolCallId,
              at,
              kind: "tool",
              toolCallId,
              name,
              intent,
              args: argsResult.text,
              state: "running",
              resultText: null,
            };
            if (argsResult.truncated) toolItem.truncated = true;

            rememberPendingTool(state, toolCallId, toolItem, null);
            if (!state.working) {
              state.working = { startedAt: at, intent: intent || (name ? `Running ${name}` : "Working") };
            } else if (intent) {
              state.working.intent = intent;
            }

            if (name === "ask" && Array.isArray(args.questions)) {
              const sanitized = sanitizeQuestions(args.questions);
              state.pendingAsk = { toolCallId, questions: sanitized.questions };
              state.omitted.askQuestions += sanitized.omitted;
              state.omitted.askOptions += sanitized.omittedOptions;
            }

            if (name === "task" && Array.isArray(args.tasks)) {
              for (const task of args.tasks.slice(0, MAX_SUBAGENTS)) rememberSubagent(state, task);
              state.omitted.subagents += Math.max(0, args.tasks.length - MAX_SUBAGENTS);
            }

            items.push(Object.assign({}, toolItem));
            continue;
          }
        }
        flushThinking();

        // Emit assistant text item after all blocks are scanned.
        if (assistantText != null) {
          const t = cut(assistantText, TEXT_LIMIT);
          const item = { id, at, kind: "assistant", text: t.text };
          if (t.truncated) item.truncated = true;
          items.push(item);
        }

        continue;
      }


      // ── Tool result ──
      if (role === "toolResult") {
        const toolCallId = boundedId(msg.toolCallId);
        const toolName = boundedString(msg.toolName, 128);
        const details = msg.details && typeof msg.details === "object" ? msg.details : {};
        const isError = msg.isError === true;
        // Job snapshots carry authoritative task lifecycle, including
        // cancellation/failure paths that do not emit async-result records.
        // Matched by shape, not tool name: OMP moved `wait` out of `hub` into
        // its own tool, and agents finished through it stayed "running".
        if (Array.isArray(details.jobs)) {
          const jobs = details.jobs.slice(0, MAX_SUBAGENTS);
          state.omitted.jobUpdates += Math.max(0, details.jobs.length - jobs.length);
          for (const job of jobs) {
            if (!job || job.type !== "task" || job.status === "running") continue;
            const hit = latestRunningSubagent(state, boundedString(job.id || job.label));
            if (!hit) continue;
            hit.status = boundedString(job.status, 64) || "complete";
            if (Number.isFinite(job.durationMs)) hit.durationMs = Math.max(0, Math.round(job.durationMs));
          }
        }

        // Determine settled state.
        let toolState;
        if (details.__synthetic === true) {
          // Skipped due to queued user message — muted, not an error.
          toolState = "skipped";
        } else if (isError) {
          toolState = "error";
        } else {
          toolState = "ok";
        }

        // Result text from content blocks; ignore image/encrypted blocks.
        const rawResult  = textFromContent(msg.content);
        const rt         = cut(rawResult, RESULT_TEXT_LIMIT);

        // exitCode present only on failing bash executions.
        const exitCode = Number.isFinite(details.exitCode) ? details.exitCode : undefined;

        // Duration: from tool_execution_start.startedAt to result timestamp.
        // msg.timestamp is Unix ms (not an ISO string).
        let durationMs;
        const startedAt = toolCallId ? state.toolStartTimes[toolCallId] : undefined;
        const resultMs  = typeof msg.timestamp === "number" ? msg.timestamp : null;
        if (startedAt && resultMs != null) {
          const elapsed = resultMs - new Date(startedAt).getTime();
          if (Number.isFinite(elapsed) && elapsed >= 0) durationMs = elapsed;
        }

        const pending = toolCallId ? (state.pendingTools[toolCallId] || {}) : {};

        const toolItem = {
          id:          toolCallId || id,
          at:          pending.at || at,
          kind:        "tool",
          toolCallId:  toolCallId || null,
          name:        toolName || pending.name || null,
          intent:      pending.intent || null,
          args:        pending.args || null,
          state:       toolState,
          resultText:  rt.text || null,
        };
        if (rt.truncated || pending.truncated) toolItem.truncated = true;
        if (exitCode !== undefined) toolItem.exitCode = exitCode;
        if (durationMs !== undefined) toolItem.durationMs = Math.round(durationMs);
        const changeResult = changesFromToolResult(toolName, details);
        if (changeResult.changes) toolItem.changes = changeResult.changes;
        if (changeResult.truncated) toolItem.changesTruncated = true;

        items.push(toolItem);

        // Settle pending state.
        if (toolCallId) {
          delete state.pendingTools[toolCallId];
          delete state.toolStartTimes[toolCallId];
        }
        // With no tool outstanding the model is reasoning about what it just
        // learned, not still "Running read". Keeping the settled tool's intent
        // made the activity row lie for the whole gap between steps.
        if (state.working && Object.keys(state.pendingTools).length === 0) {
          state.working = { startedAt: at, intent: "Thinking" };
        }

        // Clear pending ask when the ask call settles.
        if (toolName === "ask" &&
            state.pendingAsk &&
            state.pendingAsk.toolCallId === toolCallId) {
          state.pendingAsk = null;
        }

        // Track the latest todo details (authoritative per upstream docs).
        if (toolName === "todo" && Array.isArray(details.phases)) {
          state.latestTodo = sanitizeTodo(details);
          state.omitted.todoPhases += state.latestTodo.omittedPhases;
          state.omitted.todoTasks += state.latestTodo.omittedTasks;
        }

        // A task result carries details.async = {state, jobId, type}. "running"
        // means the agent was only dispatched; any other terminal state settles
        // it here (a synchronous batch never emits an async-result notice).
        if (toolName === "task") {
          const async = details.async || null;
          const jobId = boundedString(async && (async.jobId || async.label));
          const hit = jobId ? state.subagents.find((s) => s.name === jobId) : null;
          if (hit) {
            if (isError && !details.__synthetic) hit.status = "error";
            else if (async.state && async.state !== "running") hit.status = "complete";
          }
        }

        continue;
      }

      // Unknown role — skip.
      continue;
    }

    // ── Unknown entry type — generic event, never fabricate status ──
    if (type === "mode_change") {
      const mode = boundedString(entry.mode, 64);
      items.push({ id, at, kind: "event", text: mode ? `Switched to ${mode} mode` : "Mode changed" });
      continue;
    }
    items.push({
      id,
      at,
      kind: "event",
      text: (boundedString(type, 128) || "event").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    });
  }

  // ── Build derived snapshot ───────────────────────────────────────────────

  // Activity: prefer the currently running tool. Between tools, retain the
  // latest human-readable intent until the assistant stops/errors.
  let activity = null;
  {
    let latestStartedAt = null;
    for (const [toolCallId, toolItem] of Object.entries(state.pendingTools)) {
      const startedAt = state.toolStartTimes[toolCallId];
      if (startedAt && (!latestStartedAt || startedAt > latestStartedAt)) {
        latestStartedAt = startedAt;
        activity = {
          toolName: toolItem.name,
          intent:   toolItem.intent || "Working",
          startedAt,
        };
      }
    }
    if (!activity && state.working && !state.exited && !state.error) {
      activity = {
        toolName: null,
        intent: state.working.intent || "Working",
        startedAt: state.working.startedAt,
      };
    }
  }

  // Context: totalTokens from the most recent assistant message usage.
  // percent omitted — no reliable context-window ceiling in the transcript.
  let context = null;
  if (state.latestUsage && state.latestUsage.totalTokens != null) {
    context = { totalTokens: state.latestUsage.totalTokens, percent: null };
  }
  const spend = state.spend > 0 ? state.spend : null;

  // Todo: derived from the single latest todo toolResult details object.
  let todo = null;
  if (state.latestTodo && Array.isArray(state.latestTodo.phases)) {
    let done = 0;
    let total = 0;
    let activePhase = null;

    const phases = state.latestTodo.phases.map(phase => {
      const tasks = (phase.tasks || []).map(task => ({
        content: task.content,
        status:  task.status,
        blocker: task.blocker,
      }));
      return { name: phase.name, tasks };
    });

    for (const phase of phases) {
      for (const task of phase.tasks) {
        total++;
        if (task.status === "completed") done++;
        if (task.status === "in_progress" && activePhase == null) {
          activePhase = phase.name;
        }
      }
    }

    // activePhase falls back to the first phase that has open work.
    if (activePhase == null) {
      for (const phase of phases) {
        if (phase.tasks.some(t => t.status === "pending" || t.status === "blocked")) {
          activePhase = phase.name;
          break;
        }
      }
    }

    todo = {
      phases,
      done,
      total,
      activePhase,
      omittedPhases: state.latestTodo.omittedPhases || 0,
      omittedTasks: state.latestTodo.omittedTasks || 0,
    };
  }

  const derived = {
    title:      state.title,
    model:      state.model,
    provider:   state.provider,
    // When the transcript last named the runtime model. A reload after this
    // means the named model is history, not what is running now.
    modelAt:    state.modelAt,
    effort:     state.effort,
    cwd:        state.cwd,
    context,
    spend,
    activity,
    pendingAsk: state.pendingAsk,
    todo,
    subagents: state.subagents.map(agent => Object.assign({}, agent)),
    advisor: state.latestAdvisor || null,
    error: state.error,
    exited: state.exited,
    omitted: Object.values(state.omitted).some(Boolean) ? Object.assign({}, state.omitted) : null,
  };

  return { items: collapse(items), derived, state };
}

// The wire contract is upsert-by-id, so emitting a tool as "running" and again
// as settled inside ONE batch is redundant: the client would apply both and
// keep the last. Collapsing here is observably identical and removes ~40% of a
// full-transcript payload (a 12MB transcript's first page carried 342 running
// items that had already settled in the same response). Last write wins, and
// first-seen order is preserved so the client still renders chronologically.
function collapse(items) {
  const seen = new Map();
  for (const item of items) seen.set(item.id, item);
  if (seen.size === items.length) return items;
  const out = [];
  const emitted = new Set();
  for (const item of items) {
    if (emitted.has(item.id)) continue;
    emitted.add(item.id);
    out.push(seen.get(item.id));
  }
  return out;
}

module.exports = { project };
