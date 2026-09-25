const STATUS_VALUES = new Set(["idle", "working", "waiting", "done", "shell"]);
const TARGET = /^=omp_[A-Za-z0-9_-]{1,40}:$/;
const SOCKET = /^[A-Za-z0-9_.-]{1,64}$/;
const HEARTBEAT_MS = 30_000;
const RECENT_DONE_MS = 5 * 60_000;
const WRITE_TIMEOUT_MS = 1_500;
const THINKING_MAX = 120;
const THINKING_WRITE_MS = 1_000;
const THINKING_BUFFER = 4_000;

export default function sessionStatusExtension(pi) {
  const target = process.env.OMP_WEB_STATUS_TARGET || "";
  const socket = process.env.OMP_WEB_TMUX_SOCKET || "omp-web";
  const tmuxBin = process.env.OMP_WEB_TMUX_BIN || "tmux";
  if (!TARGET.test(target) || !SOCKET.test(socket)) return;

  let current = "idle";
  let currentActivity = "";
  let doneAt = 0;
  let writes = Promise.resolve();
  // Tracks what tmux actually holds, so a failed write is retried on the next
  // transition instead of being deduplicated away until the heartbeat.
  let written = { status: null, activity: null };
  let thinkingBuffer = "";
  let thinkingPublished = "";
  let thinkingTimer = null;

  const writeStatus = async (status, activity) => {
    const result = await pi.exec(tmuxBin, [
      "-L", socket,
      "set-option", "-t", target, "@omp_status", status,
      ";", "set-option", "-t", target, "@omp_status_at", String(Date.now()),
      ";", "set-option", "-t", target, "@omp_activity", activity,
    ], { signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
    if (result.code !== 0) {
      pi.logger?.warn?.(`omp-web status update failed: ${result.stderr || `tmux exited ${result.code}`}`);
      return;
    }
    written = { status, activity };
  };

  const publish = (status, force = false, activity = currentActivity) => {
    if (!STATUS_VALUES.has(status)) return Promise.resolve();
    if (status !== "done") doneAt = 0;
    if (!force && written.status === status && written.activity === activity) return writes;
    current = status;
    currentActivity = activity;
    writes = writes.then(() => writeStatus(status, activity)).catch((error) => {
      pi.logger?.warn?.(`omp-web status update failed: ${error?.message || error}`);
    });
    return writes;
  };

  const writeThinking = (text) => {
    writes = writes.then(() => pi.exec(tmuxBin, [
      "-L", socket,
      "set-option", "-t", target, "@omp_thinking", text,
      ";", "set-option", "-t", target, "@omp_thinking_at", String(Date.now()),
    ], { signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) })).then((result) => {
      if (result?.code !== 0) {
        pi.logger?.warn?.(`omp-web thinking update failed: ${result?.stderr || `tmux exited ${result?.code}`}`);
      }
    }).catch((error) => {
      pi.logger?.warn?.(`omp-web thinking update failed: ${error?.message || error}`);
    });
    return writes;
  };

  // Models bold the conclusion of a reasoning step, so the last bold span is
  // the closest thing to a one-line "what I am doing now". Without one, fall
  // back to the last completed sentence rather than a half-written clause.
  const headlineFrom = (buffer) => {
    let headline = "";
    for (const match of buffer.matchAll(/\*\*([^*\n]{3,120})\*\*/g)) headline = match[1];
    if (!headline) {
      const sentences = buffer.split(/(?<=[.!?])\s+/);
      for (let i = sentences.length - 1; i >= 0; i--) {
        const candidate = sentences[i].trim();
        if (candidate.length >= 8 && /[.!?]$/.test(candidate)) { headline = candidate; break; }
      }
    }
    headline = headline.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return headline.length > THINKING_MAX
      ? headline.slice(0, THINKING_MAX - 1).trimEnd() + "\u2026"
      : headline;
  };

  const flushThinking = () => {
    clearTimeout(thinkingTimer);
    thinkingTimer = null;
    const headline = headlineFrom(thinkingBuffer);
    if (!headline || headline === thinkingPublished) return;
    thinkingPublished = headline;
    void writeThinking(headline);
  };

  const clearThinking = () => {
    clearTimeout(thinkingTimer);
    thinkingTimer = null;
    thinkingBuffer = "";
    if (!thinkingPublished) return;
    thinkingPublished = "";
    void writeThinking("");
  };

  // Subagents run in-process with their own runner and inherit this extension
  // and OMP_WEB_STATUS_TARGET; only the interactive top-level session owns the
  // tmux status. Without this guard every task subagent stomps the parent's
  // state (idle on its session_start, done on its agent_end) and its own
  // heartbeat keeps re-asserting it.
  pi.on("session_start", (_event, ctx) => {
    if (!ctx?.hasUI) return;
    void publish("idle", true);
    ctx.setInterval(() => {
      if (current === "done" && Date.now() - doneAt >= RECENT_DONE_MS) {
        void publish("idle", true);
        return;
      }
      void publish(current, true);
    }, HEARTBEAT_MS);
  });
  pi.on("before_agent_start", (_event, ctx) => { if (ctx?.hasUI) void publish("working", false, ""); });
  pi.on("agent_start", (_event, ctx) => { if (ctx?.hasUI) void publish("working", false, ""); });
  pi.on("agent_end", (event, ctx) => {
    if (!ctx?.hasUI) return;
    clearThinking();
    if (event?.willContinue || event?.isTerminal === false) {
      void publish("working", false, "");
      return;
    }
    if (event?.stopReason === "error" || event?.stopReason === "aborted") {
      void publish("idle", false, "");
      return;
    }
    doneAt = Date.now();
    void publish("done", false, "");
  });

  pi.on("tool_call", (event, ctx) => {
    if (ctx?.hasUI && event?.toolName === "ask") void publish("waiting");
  });
  pi.on("tool_result", (event, ctx) => {
    if (ctx?.hasUI && event?.toolName === "ask") void publish("working");
  });
  pi.on("tool_approval_requested", (_event, ctx) => { if (ctx?.hasUI) void publish("waiting"); });
  pi.on("tool_approval_resolved", (_event, ctx) => { if (ctx?.hasUI) void publish("working"); });

  pi.on("auto_compaction_start", (_event, ctx) => { if (ctx?.hasUI) void publish("working", false, "compaction"); });
  pi.on("auto_compaction_end", (_event, ctx) => { if (ctx?.hasUI) void publish("working", true, ""); });
  pi.on("auto_retry_start", (_event, ctx) => { if (ctx?.hasUI) void publish("working", false, ""); });
  pi.on("session_shutdown", (_event, ctx) => {
    if (!ctx?.hasUI) return;
    clearThinking();
    void publish("shell", true, "");
  });

  // Live reasoning headline. The transcript only records reasoning once the
  // message completes, so a long thinking turn otherwise shows nothing at all
  // while it is the only thing happening.
  pi.on("message_update", (event, ctx) => {
    if (!ctx?.hasUI) return;
    const e = event?.assistantMessageEvent;
    if (!e) return;
    if (e.type === "thinking_start") {
      thinkingBuffer = "";
      return;
    }
    if (e.type === "thinking_delta" && typeof e.delta === "string") {
      thinkingBuffer = (thinkingBuffer + e.delta).slice(-THINKING_BUFFER);
      if (!thinkingTimer) thinkingTimer = setTimeout(flushThinking, THINKING_WRITE_MS);
      return;
    }
    // Text or a tool call means the reasoning produced something the normal
    // activity row can name; the headline would only go stale.
    if (e.type === "text_start" || e.type === "toolcall_start") clearThinking();
  });
  pi.on("message_end", (_event, ctx) => { if (ctx?.hasUI) clearThinking(); });
}
