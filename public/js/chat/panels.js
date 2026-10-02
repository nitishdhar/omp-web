"use strict";
// Renders derived session state into the contextual workflow inspector and
// composer dock. Called every poll cycle with the full derived snapshot.

import { el, elem } from "../dom.js";
import { emit, state } from "../state.js";
import { api } from "../api.js";
import { defaultChoice } from "../new-session.js";
import { workspaceRelative } from "../paths.js";
import { icon } from "../icons.js";

// ── Tiny helpers ─────────────────────────────────────────────────────────────

function clr(node) { if (node) node.replaceChildren(); return node; }
function hide(node) { if (node) node.hidden = true; }
function show(node) { if (node) node.hidden = false; }
function positive(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function omittedNotice(parts) {
  const visible = parts.filter(({ count }) => count > 0);
  if (!visible.length) return null;
  const text = visible.map(({ count, singular, plural = `${singular}s` }) =>
    `${count} ${count === 1 ? singular : plural}`).join(" and ");
  return elem("div", { class: "chat-panel-omitted", role: "note" }, `${text} omitted from this view.`);
}

function elapsed(startedAt) {
  if (!startedAt) return null;
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return null;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

const DETAILS_KEY = "omp_web_chat_details";
let detailsWired = false;
const panelCache = Object.create(null);

function changed(name, value) {
  const key = JSON.stringify(value);
  if (panelCache[name] === key) return false;
  panelCache[name] = key;
  return true;
}

function detailsCollapsed() {
  try { return localStorage.getItem(DETAILS_KEY) !== "1"; } catch { return true; }
}

function setDetailsCollapsed(off) {
  const toggle = el["chat-panels-toggle"];
  const content = el["chat-panels-content"];
  if (!toggle || !content) return;
  const rail = toggle.closest(".chat-panels");
  content.hidden = off;
  rail?.classList.toggle("is-collapsed", off);
  toggle.setAttribute("aria-expanded", String(!off));
  const chev = toggle.querySelector(".chat-panels-chevron");
  if (chev) chev.textContent = off ? "\u203a" : "\u2304";
  try { localStorage.setItem(DETAILS_KEY, off ? "0" : "1"); } catch {}
}

function wireDetailsToggle() {
  if (detailsWired) return;
  const toggle = el["chat-panels-toggle"];
  const content = el["chat-panels-content"];
  if (!toggle || !content) return;
  const rail = toggle.closest(".chat-panels");
  detailsWired = true;
  setDetailsCollapsed(detailsCollapsed());
  toggle.addEventListener("click", () => setDetailsCollapsed(!content.hidden));
  document.addEventListener("click", (event) => {
    if (!content.hidden && rail && !rail.contains(event.target)) setDetailsCollapsed(true);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !content.hidden) {
      setDetailsCollapsed(true);
      toggle.focus();
    }
  });
}

const GIT_STATUS_TTL_MS = 5_000;
let gitSessionId = null;
let gitStatus = null;
let gitRequestedAt = 0;
let gitInFlight = null;
let statusSnapshot = {};

function normalizedGitStatus(value) {
  const branch = typeof value?.branch === "string" ? value.branch.trim() : "";
  if (!branch) return null;
  return {
    branch,
    upstream: typeof value.upstream === "string" && value.upstream ? value.upstream : null,
    ahead: positive(value.ahead),
    behind: positive(value.behind),
    dirty: positive(value.dirty),
  };
}

function gitStatusTitle(git) {
  const details = [`Branch ${git.branch}`, git.upstream ? `tracking ${git.upstream}` : "no upstream"];
  details.push(git.dirty ? `${git.dirty} dirty ${git.dirty === 1 ? "file" : "files"}` : "clean working tree");
  if (git.ahead) details.push(`${git.ahead} commit${git.ahead === 1 ? "" : "s"} ahead`);
  if (git.behind) details.push(`${git.behind} commit${git.behind === 1 ? "" : "s"} behind`);
  return details.join(" · ");
}

function refreshGitStatus() {
  const id = state.current || null;
  if (id !== gitSessionId) {
    gitSessionId = id;
    gitStatus = null;
    gitRequestedAt = 0;
    gitInFlight = null;
  }
  if (!id || gitInFlight || Date.now() - gitRequestedAt < GIT_STATUS_TTL_MS) return;
  gitRequestedAt = Date.now();
  const request = api(`/sessions/${encodeURIComponent(id)}/git`);
  gitInFlight = request;
  request.then(
    (value) => { if (gitSessionId === id) gitStatus = normalizedGitStatus(value); },
    () => { if (gitSessionId === id) gitStatus = null; },
  ).finally(() => {
    if (gitInFlight !== request) return;
    gitInFlight = null;
    renderStatus(statusSnapshot);
  });
}

// ── Status bar (#chat-status) ─────────────────────────────────────────────────

function renderStatus(derived) {
  const node = el["chat-status"];
  if (!node) return;
  statusSnapshot = derived;
  refreshGitStatus();
  const git = gitStatus;
  const { model, provider, profile, cwd, context, effort, spend } = derived;
  if (!changed("status", [
    model, derived.modelSource, provider, profile, cwd, context?.percent, context?.totalTokens, effort, spend, gitSessionId, git,
  ])) return;
  clr(node);
  // Separators are drawn by CSS between siblings rather than pushed as their
  // own spans, so dropping a field on a narrow viewport cannot orphan a dot.
  const parts = [];
  const runtime = model || (profile ? `${profile} profile` : null);
  // The model chip is the fastest path to "run this under something else":
  // it opens the existing profile/model reload dialog for the live session.
  // A launch-sourced model is what omp-web started the runtime with; the
  // transcript confirms it when the first reply lands.
  const pending = derived.modelSource === "launch";
  if (runtime) parts.push(elem("button", {
    class: "cs-item cs-model cs-model-action" + (pending ? " cs-model-pending" : ""),
    type: "button",
    title: pending
      ? "Launch model — confirmed after the first reply. Click to reload under another profile or model"
      : "Reload this session under another profile or model",
    onclick: () => emit("session:reloadRequest", state.current),
  }, runtime));
  if (effort) parts.push(elem("span", { class: "cs-item cs-effort" }, `${effort} effort`));
  if (provider) parts.push(elem("span", { class: "cs-item cs-provider" }, provider));
  // The absolute path truncated mid-word and spent its width on the prefix
  // every row shares, so the rail shows the workspace-relative part with the
  // real path in the tooltip.
  if (cwd) {
    parts.push(elem("span", { class: "cs-item cs-cwd cs-secondary", title: cwd }, workspaceRelative(cwd)));
  }
  // Git reads as one coupled unit — branch icon, branch, dirty count tight
  // together — never loose text drifting in the middle of the composer.
  if (git) {
    const title = gitStatusTitle(git);
    const unit = [icon("branch", 12), elem("span", { class: "cs-git-branch" }, git.branch)];
    if (git.dirty) unit.push(elem("span", { class: "cs-git-detail" }, `${git.dirty} dirty`));
    if (git.ahead) unit.push(elem("span", { class: "cs-git-detail" }, `↑${git.ahead}`));
    if (git.behind) unit.push(elem("span", { class: "cs-git-detail" }, `↓${git.behind}`));
    parts.push(elem("span", { class: "cs-item cs-git cs-secondary", title, "aria-label": title }, ...unit));
  }

  // A null percent means the transcript did not expose a context window, so a
  // meter would be invented precision. Fall back to the raw token count.
  if (context && typeof context.percent === "number") {
    const pct = Math.min(Math.round(context.percent), 100);
    const fill = elem("span", { class: "cs-ctx-fill" });
    fill.style.width = `${pct}%`;
    const bar = elem("span", { class: `cs-ctx-bar${pct >= 80 ? " cs-ctx-warn" : ""}` }, fill);
    const label = elem("span", { class: "cs-ctx-pct" });
    label.textContent = `${pct}%`;
    parts.push(elem("span", { class: "cs-item cs-ctx cs-secondary" }, bar, label));
  } else if (context && typeof context.totalTokens === "number") {
    const label = elem("span", { class: "cs-ctx-pct" });
    label.textContent = `${Math.round(context.totalTokens / 1000)}K tokens`;
    parts.push(elem("span", { class: "cs-item cs-ctx cs-secondary" }, label));
  }

  // Spend is the one number the TUI status line carries that Chat did not, and
  // it is the one an operator running many sessions actually watches.
  if (typeof spend === "number" && spend > 0) {
    const shown = spend >= 0.01 ? `$${spend.toFixed(2)}` : "<$0.01";
    parts.push(elem("span", { class: "cs-item cs-spend cs-secondary", title: "Session spend" }, shown));
  }

  if (!parts.length) { hide(node); return; }
  show(node);
  node.append(...parts);
}

// ── Interrupt visibility (single source) ──────────────────────────────────────
// Stop is visible iff a turn is live: a chat session is set AND derived
// activity arrived within the recent window. Poll-in-flight is deliberately
// not a signal: the poll fires every 1.2s/350ms, so keying visibility to it
// strobes the control on every round trip even while the agent is idle.
// Derived-only with a grace window covers send-to-first-poll and quiet gaps.
const INTERRUPT_RECENT_MS = 3500;
let interruptHasSession = false;
let interruptLastActivityAt = 0;
let interruptPending = false;

function syncInterruptVisibility() {
  const interrupt = el["chat-interrupt"];
  if (!interrupt) return;
  // An in-flight Stop request keeps the control mounted so its pending and
  // confirmed affordances never flash on a hidden node.
  if (interruptPending) {
    interrupt.hidden = false;
    return;
  }
  const recent = Date.now() - interruptLastActivityAt < INTERRUPT_RECENT_MS;
  const live = interruptHasSession && recent;
  interrupt.hidden = !live;
}

/** Chat session selected; drives Stop visibility with poll/activity signals. */
export function setInterruptSession(on) {
  interruptHasSession = Boolean(on);
  // The activity timestamp belongs to the previous session; a fresh one must
  // re-earn Stop visibility from its own polls.
  interruptLastActivityAt = 0;
  syncInterruptVisibility();
}

/** Optimistic Stop request in flight; never hide while the agent may respond. */
export function setInterruptPending(on) {
  interruptPending = Boolean(on);
  syncInterruptVisibility();
}

// ── Activity line (#chat-activity) ────────────────────────────────────────────

function renderActivity(derived) {
  const { activity } = derived;
  if (activity) interruptLastActivityAt = Date.now();
  syncInterruptVisibility();
  const node = el["chat-activity"];
  if (!node) return;
  const activityKey = activity && [activity.intent, activity.startedAt, activity.thinking];
  if (!changed("activity", activityKey)) {
    const duration = elapsed(activity?.startedAt);
    const durationNode = node.querySelector(".ca-elapsed");
    if (durationNode && duration) durationNode.textContent = duration;
    return;
  }
  if (!activity) { clr(node); hide(node); return; }
  show(node);
  clr(node);
  node.classList.toggle("chat-activity-thinking", Boolean(activity.thinking));

  // The always-on line carries human words (intent) plus elapsed only; the
  // tool name lives in the transcript group now, so it is dropped here.
  const dot = elem("span", { class: "ca-pulse", "aria-hidden": "true" });
  const intent = elem("span", { class: "ca-intent" });
  intent.textContent = activity.intent || "";

  node.append(dot, intent);

  const dur = elapsed(activity.startedAt);
  if (dur) {
    const t = elem("span", { class: "ca-elapsed" });
    t.textContent = dur;
    node.append(elem("span", { class: "ca-sep" }, "\u00b7"), t);
  }
}

// ── Todo tree (#chat-todo) ────────────────────────────────────────────────────

const GLYPH = {
  pending:     "\u25cb", // ○
  in_progress: "\u25c9", // ◉
  completed:   "\u2713", // ✓
  abandoned:   "\u2717", // ✗
  blocked:     "\u29b8", // ⊘
};

function renderTodo(derived) {
  const node = el["chat-todo"];
  if (!node) return;
  const { todo, omitted } = derived;
  const omittedPhases = positive(todo?.omittedPhases ?? omitted?.todoPhases);
  const omittedTasks = positive(todo?.omittedTasks ?? omitted?.todoTasks);
  if (!changed("todo", [todo, omittedPhases, omittedTasks])) return;
  if ((!todo || !Array.isArray(todo.phases) || !todo.phases.length) && !omittedPhases && !omittedTasks) {
    clr(node); hide(node); return;
  }
  show(node);
  clr(node);

  const shown = positive(todo?.total);
  const done = positive(todo?.done);
  const totalLabel = omittedPhases || omittedTasks
    ? `${done} done \u00b7 ${shown} shown`
    : `${done}\u2009/\u2009${shown}`;
  node.append(elem("div", { class: "chat-panel-section-head" },
    elem("span", {}, "Todo"),
    elem("span", { class: "chat-panel-section-meta" }, totalLabel),
  ));

  for (const phase of (todo?.phases || [])) {
    // activePhase is a phase NAME, not an index.
    const isActive = todo.activePhase != null && phase.name === todo.activePhase;
    const phaseEl = elem("div", { class: `ct-phase${isActive ? " ct-active" : ""}` });
    const nameEl = elem("div", { class: "ct-phase-name" });
    nameEl.textContent = phase.name || "";
    phaseEl.append(nameEl);

    const list = elem("ul", { class: "ct-tasks" });
    for (const task of (phase.tasks || [])) {
      const status = task.status || "pending";
      const glyph = GLYPH[status] || "\u25cb";
      const li = elem("li", { class: `ct-task ct-task-${status}` },
        elem("span", { class: "ct-glyph", "aria-hidden": "true" }, glyph),
        elem("span", { class: "ct-content" }, task.content || ""),
      );
      if (status === "blocked" && task.blocker) {
        const b = elem("span", { class: "ct-blocker" });
        b.textContent = `Blocked: ${task.blocker}`;
        li.append(b);
      }
      list.append(li);
    }
    phaseEl.append(list);
    node.append(phaseEl);
  }
  const partial = omittedNotice([
    { count: omittedTasks, singular: "task" },
    { count: omittedPhases, singular: "phase" },
  ]);
  if (partial) node.append(partial);
}

// ── Subagent roster (#chat-agents) ───────────────────────────────────────────

function renderAgents(derived) {
  const node = el["chat-agents"];
  if (!node) return;
  const subagents = Array.isArray(derived.subagents) ? derived.subagents : [];
  const active = subagents.filter((a) => (a.status || "running") === "running");
  const omittedAgents = positive(derived.omitted?.subagents);
  if (!changed("agents", [active, omittedAgents])) return;
  if (!active.length && !omittedAgents) { clr(node); hide(node); return; }
  show(node);
  clr(node);

  node.append(elem("div", { class: "chat-panel-section-head" },
    elem("span", {}, "Agents"),
    elem("span", { class: "chat-panel-section-meta" }, omittedAgents ? `${active.length} shown` : String(active.length)),
  ));

  for (const agent of active) {
    const row = elem("div", { class: "cag-row cag-status-running" },
      elem("span", { class: "cag-dot", "aria-hidden": "true" }),
      elem("span", { class: "cag-name" }, agent.name || ""),
      elem("span", { class: "cag-type" }, `[${agent.agent || "task"}]`),
    );
    if (agent.taskPreview) {
      const preview = elem("div", { class: "cag-preview" });
      preview.textContent = agent.taskPreview;
      row.append(preview);
    }
    node.append(row);
  }
  const partial = omittedNotice([{ count: omittedAgents, singular: "agent record" }]);
  if (partial) node.append(partial);
}

function currentWorkflowTask(todo) {
  const phases = Array.isArray(todo?.phases) ? todo.phases : [];
  for (const status of ["in_progress", "blocked", "pending"]) {
    for (const phase of phases) {
      const task = (phase.tasks || []).find((entry) => entry.status === status);
      if (task) return { phase: phase.name || "Work", task, status };
    }
  }
  return null;
}

function renderWorkflowSummary(derived) {
  const toggle = el["chat-panels-toggle"];
  const content = el["chat-panels-content"];
  const rail = toggle?.closest(".chat-panels");
  if (!toggle || !content || !rail) return;

  const todo = derived.todo;
  const activeAgents = Array.isArray(derived.subagents)
    ? derived.subagents.filter((agent) => (agent.status || "running") === "running")
    : [];
  const omittedAgents = positive(derived.omitted?.subagents);
  const hasTodo = Boolean(todo?.phases?.length || todo?.omittedPhases || todo?.omittedTasks);
  const current = currentWorkflowTask(todo);
  // A persistent strip has to earn the most valuable row on screen every frame.
  // Reporting "No open tasks · 6/6" is not earning it; the finished checklist
  // stays in the transcript where the todo result was written.
  const settled = hasTodo && !current && activeAgents.length === 0 && omittedAgents === 0;
  const visible = (hasTodo || activeAgents.length > 0 || omittedAgents > 0) && !settled;
  if (!changed("workflowSummary", [todo, activeAgents, omittedAgents, visible])) return;

  rail.hidden = !visible;
  if (!visible) {
    if (!content.hidden) setDetailsCollapsed(true);
    return;
  }

  const done = positive(todo?.done);
  const total = positive(todo?.total);
  const progress = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  let summary = "";
  if (current?.status === "blocked") summary = `Blocked: ${current.task.content || "task"}`;
  else if (current?.status === "pending") summary = `Next: ${current.task.content || "task"}`;
  else if (current) summary = current.task.content || "Working";
  else if (hasTodo) summary = "No open tasks";
  else summary = `${activeAgents.length || omittedAgents} agent${activeAgents.length === 1 && !omittedAgents ? "" : "s"} working`;

  const meta = [];
  if (total) meta.push(`${done}/${total}`);
  if (activeAgents.length) meta.push(`${activeAgents.length} agent${activeAgents.length === 1 ? "" : "s"}`);
  if (omittedAgents) meta.push(`${omittedAgents} omitted`);
  const phase = current?.phase || (hasTodo ? "Todo" : "Agents");
  const chevron = content.hidden ? "\u203a" : "\u2304";
  toggle.style.setProperty("--workflow-progress", `${progress}%`);
  toggle.setAttribute("aria-label", [phase, summary, ...meta].filter(Boolean).join("; "));
  toggle.replaceChildren(
    elem("span", { class: "chat-workflow-mark", "aria-hidden": "true" }),
    elem("span", { class: "chat-workflow-copy" },
      elem("span", { class: "chat-workflow-label" }, phase),
      elem("span", { class: "chat-workflow-summary" }, summary),
    ),
    meta.length ? elem("span", { class: "chat-workflow-meta" }, meta.join(" \u00b7 ")) : null,
    elem("span", { class: "chat-panels-chevron", "aria-hidden": "true" }, chevron),
  );
}

// ── Pending ask (#chat-ask) ───────────────────────────────────────────────────


// Collapsed by default: an advisory is peripheral guidance, so it announces
// its severity without spending transcript height on the full note. The
// expand latch keys on advisor.id, never on render count — resetting it every
// render meant the body could never stay mounted after a click.
let advisorSeenId = null;
let advisorExpanded = false;
let advisorDismissed = null;
// Dismissing one note muted nothing: the advisor emits per turn, so the next
// note (new id) resurrected the panel. Dismiss mutes for the whole session;
// switching sessions changes state.current and unmutes naturally.
let advisorMutedSession = null;
try { advisorMutedSession = sessionStorage.getItem("omp_web_advisor_muted") || null; } catch {}

function renderAdvisor(derived) {
  const node = el["chat-advisor"];
  if (!node) return;
  const advisor = derived.advisor || null;
  if (!advisor) {
    clr(node); hide(node);
    advisorSeenId = null; advisorExpanded = false; advisorDismissed = null;
    return;
  }
  // A genuinely new advisory resets collapse/dismiss; a re-render does not.
  if (advisor.id !== advisorSeenId) {
    advisorSeenId = advisor.id;
    advisorExpanded = false;
    advisorDismissed = null;
  }
  if (advisorMutedSession && advisorMutedSession === state.current) { clr(node); hide(node); return; }
  if (advisor.id === advisorDismissed) { clr(node); hide(node); return; }
  const key = [advisor.id, advisor.severity, advisor.text, advisorExpanded];
  if (!changed("advisor", key)) return;
  show(node);
  clr(node);

  const severity = advisor.severity || "note";
  const guidance = advisor.guidance || "weigh, don't blindly obey";
  const card = elem("div", { class: `chat-advisor chat-advisor-${severity}`, role: "note" });
  const header = elem("div", { class: "chat-advisor-head" });
  const badge = elem("span", { class: "chat-advisor-badge" }, severity);
  const guide = elem("span", { class: "chat-advisor-guidance" }, guidance);
  const expand = elem("button", {
    class: "chat-advisor-expand",
    type: "button",
    "aria-expanded": String(advisorExpanded),
    "aria-label": advisorExpanded ? "Collapse advisory" : "Expand advisory",
    title: advisorExpanded ? "Collapse" : "Expand",
    onclick: () => { advisorExpanded = !advisorExpanded; renderAdvisor(derived); },
  }, elem("span", { class: "chat-advisor-chevron", "aria-hidden": "true" }, advisorExpanded ? "\u2304" : "\u203a"));
  const dismiss = elem("button", {
    class: "chat-advisor-dismiss",
    type: "button",
    "aria-label": "Dismiss advisory",
    title: "Dismiss",
    onclick: () => { advisorDismissed = advisor.id; advisorMutedSession = state.current; try { sessionStorage.setItem("omp_web_advisor_muted", state.current || ""); } catch {} clr(node); hide(node); },
  }, "\u00d7");
  header.append(badge, guide, expand, dismiss);
  card.append(header);
  if (advisorExpanded) {
    const body = elem("div", { class: "chat-advisor-body" });
    body.textContent = advisor.text || "";
    card.append(body);
  }
  node.append(card);
}

function renderAsk(derived) {
  const node = el["chat-ask"];
  if (!node) return;
  const { pendingAsk, omitted } = derived;
  const questions = Array.isArray(pendingAsk?.questions) ? pendingAsk.questions : [];
  const omittedQuestions = positive(omitted?.askQuestions);
  const omittedOptions = positive(omitted?.askOptions);
  if (!changed("ask", [questions, pendingAsk ? omittedQuestions : 0, pendingAsk ? omittedOptions : 0])) return;
  if (!pendingAsk || (!questions.length && !omittedQuestions && !omittedOptions)) {
    clr(node);
    hide(node);
    return;
  }
  show(node);
  clr(node);

  for (const q of questions) {
    const qblock = elem("div", { class: "cask-q" });
    if (q.header) {
      const hdr = elem("div", { class: "cask-header" });
      hdr.textContent = q.header;
      qblock.append(hdr);
    }
    const question = elem("div", { class: "cask-question" });
    question.textContent = q.question || "";
    qblock.append(question);

    const optList = elem("ul", { class: "cask-opts" });
    for (const opt of (q.options || [])) {
      // recommended is a string matching opt.label, or an index number
      const isRec = q.recommended != null &&
        (opt.label === q.recommended ||
         (typeof q.recommended === "number" && q.options.indexOf(opt) === q.recommended));
      const li = elem("li", { class: `cask-opt${isRec ? " cask-rec" : ""}` },
        elem("span", { class: "cask-label" }, opt.label || ""),
      );
      if (opt.description) {
        const desc = elem("span", { class: "cask-desc" });
        desc.textContent = opt.description;
        li.append(desc);
      }
      optList.append(li);
    }
    qblock.append(optList);
    node.append(qblock);
  }
  const partial = omittedNotice([
    { count: omittedQuestions, singular: "question" },
    { count: omittedOptions, singular: "option" },
  ]);
  if (partial) node.append(partial);

  // Read-only: switch to terminal to answer
  const btn = elem("button", { class: "primary cask-switch" });
  btn.textContent = "Answer in Terminal";
  btn.addEventListener("click", () => emit("mode:change", "terminal"));
  node.append(btn);
}

// ── Empty state (#chat-empty) ─────────────────────────────────────────────────

let loadingTranscript = false;

/** Show the replay placeholder instead of the "no conversation" landing copy. */
export function setChatLoading(on) {
  loadingTranscript = Boolean(on);
  const node = el["chat-loading"];
  if (node) node.hidden = !loadingTranscript;
  renderEmpty();
}

function renderEmpty() {
  const node = el["chat-empty"];
  const log = el["chat-log"];
  if (!node || !log) return;
  // A selected session mid-replay is loading, not empty: the landing copy
  // belongs to "nothing selected", never to a conversation still arriving.
  const empty = !loadingTranscript && !log.querySelector(".chat-item");
  // This placeholder shares the scroll region rather than covering the
  // composer. CSS also hides it immediately for optimistic user items.
  if (changed("empty", empty)) { if (empty) show(node); else hide(node); }
  // Outside the guard: the landing screen is shown before the session list has
  // loaded, so its offers arrive on a later refresh than the placeholder does.
  if (empty) { renderResume(); renderLandingTarget(); }
}

// The composer creates a session without a dialog, so where it lands has to be
// visible before you type — and changeable without leaving the landing screen.
function renderLandingTarget() {
  const node = el["chat-landing-target"];
  if (!node) return;
  if (state.current || state.selectedGhost) { hide(node); return; }
  const { folder, profile } = defaultChoice();
  if (!changed("landingTarget", [folder, profile])) return;
  clr(node);
  const name = folder === state.meta.workspaceRoot
    ? "Workspace"
    : String(folder || "").split("/").filter(Boolean).pop() || "Workspace";
  node.append(
    elem("span", { text: `New session in ${name} · ${profile} · ` }),
    elem("button", {
      class: "link-btn",
      type: "button",
      onclick: () => emit("session:newInFolder", folder),
    }, "Change"),
  );
  show(node);
}

/** Re-offer recent work after the session list changes. */
export function refreshLanding() { renderEmpty(); }

// The landing screen is the app's first impression and it was spending a full
// canvas on one sentence. Recent work is the one thing worth offering there.
function renderResume() {
  const node = el["chat-empty-resume"];
  if (!node) return;
  const recent = (state.sessions || [])
    .filter((session) => session.type !== "shell")
    .slice()
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    .slice(0, 4);
  // Title is in the key: omp's auto-titler rewrites it without touching
  // status or activity, and a key without it leaves stale names next to the
  // freshly repainted sidebar and header for the same session.
  if (!changed("resume", recent.map((session) => [session.id, session.title, session.status, session.lastActivity]))) return;
  clr(node);
  if (!recent.length) { hide(node); return; }
  show(node);
  for (const session of recent) {
    const dot = elem("span", { class: `dot status-${session.status || "unknown"}`, "aria-hidden": "true" });
    const title = elem("span", { class: "cr-title" }, session.title || session.id);
    const meta = elem("span", { class: "cr-meta" }, session.profile || "");
    const button = elem("button", {
      class: "cr-item",
      type: "button",
      onclick: () => emit("session:open", session.id),
    }, dot, title, meta);
    node.append(button);
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Render all panel surfaces from a derived session snapshot.
 * Defensive: silently no-ops on null/missing fields.
 *
 * @param {Derived} derived
 */
export function renderPanels(derived) {
  wireDetailsToggle();
  const snapshot = derived || {};
  renderStatus(snapshot);
  renderActivity(snapshot);
  renderAdvisor(snapshot);
  renderTodo(snapshot);
  renderAgents(snapshot);
  renderWorkflowSummary(snapshot);
  renderAsk(snapshot);
  renderEmpty();
}
