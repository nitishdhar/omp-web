import os, pathlib

OUT = pathlib.Path(__file__).resolve().parent

TOKENS = """
:root{
  color-scheme: dark;
  --bg:#0f1113; --panel:#15181b; --panel-2:#1c2025; --panel-3:#232830;
  --line:rgba(255,255,255,.08); --line-strong:rgba(255,255,255,.14);
  --text:#e4e7ea; --muted:#9aa0a8; --faint:#6b7178;
  --accent:#5b8dee; --accent-2:#3f6fd1; --accent-soft:rgba(91,141,238,.10);
  --danger:#f0606a; --warn:#e0a53e; --shell:#9b8fe8; --ok:#3fb87a;
  --font-mono:"JetBrains Mono Variable",ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --font-ui:"Inter Variable",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text",sans-serif;
  --row-hover:rgba(255,255,255,.045); --pop-bg:#171a1e;
  --pop-shadow:0 8px 24px rgba(0,0,0,.36);
  --reading-width:760px; --chat-text:13.5px; --term-bg:#101214; --bubble-user:#20252b;
  --label:11px; --focus-ring:0 0 0 2px color-mix(in srgb,var(--accent) 60%,transparent);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-ui);
  -webkit-font-smoothing:antialiased}
button,input,textarea,select{font:inherit}
button{cursor:pointer;color:inherit}
.primary{background:var(--accent-2);color:#fff;border:1px solid transparent;border-radius:6px;padding:8px 13px;font-weight:680}
.ghost{background:transparent;color:var(--text);border:1px solid transparent;border-radius:6px;padding:8px 11px}
.danger{background:transparent;color:var(--danger);border:1px solid transparent;border-radius:6px;padding:7px 11px}
.icon{display:inline-flex;align-items:center;flex:none;color:var(--muted)}
.dot{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:var(--faint)}
"""

CHROME = """
.ds{padding:26px 26px 34px;display:flex;flex-direction:column;gap:22px;max-width:1180px}
.ds-head{display:flex;flex-direction:column;gap:6px}
.ds-kicker{color:var(--faint);font:650 10.5px var(--font-ui);letter-spacing:.06em;text-transform:uppercase}
.ds-head h1{margin:0;font-size:19px;font-weight:650;letter-spacing:-.025em}
.ds-head p{margin:0;max-width:64ch;color:var(--muted);font-size:12.5px;line-height:1.6}
.ds-block{display:flex;flex-direction:column;gap:12px;padding:18px;border:1px solid var(--line);
  border-radius:10px;background:var(--panel)}
.ds-block.on-bg{background:var(--bg)}
.ds-label{color:var(--faint);font:590 10.5px var(--font-ui)}
.ds-note{margin:0;max-width:72ch;color:var(--muted);font-size:12px;line-height:1.55}
.ds-note code,.ds-mono{font-family:var(--font-mono);font-size:11px;color:var(--text)}
.ds-grid{display:grid;gap:12px}
.ds-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ds-rule{height:1px;background:var(--line);border:0;margin:2px 0}
.ds-do{color:var(--ok)} .ds-dont{color:var(--danger)}
"""

def page(path, group, title, kicker, intro, body, css="", viewport=""):
    vp = viewport or ""
    card = '<!-- @dsCard group="%s"%s -->' % (group, vp)
    html = f"""{card}
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>{TOKENS}{CHROME}{css}</style>
</head>
<body>
<div class="ds">
  <header class="ds-head">
    <span class="ds-kicker">{kicker}</span>
    <h1>{title}</h1>
    <p>{intro}</p>
  </header>
{body}
</div>
</body>
</html>
"""
    p = OUT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(html, encoding="utf-8")
    return path

# ---------------------------------------------------------------- foundations

SWATCH_CSS = """
.sw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(212px,1fr));gap:10px}
.sw{display:flex;gap:11px;align-items:flex-start;padding:10px;border:1px solid var(--line);
  border-radius:8px;background:var(--panel-2)}
.sw-chip{flex:none;width:34px;height:34px;border-radius:7px;border:1px solid var(--line)}
.sw-meta{min-width:0;display:flex;flex-direction:column;gap:2px}
.sw-name{font:600 11.5px var(--font-mono);color:var(--text)}
.sw-val{font:10.5px var(--font-mono);color:var(--faint)}
.sw-use{font-size:11px;color:var(--muted);line-height:1.4}
.radius-row{display:flex;gap:14px;flex-wrap:wrap}
.radius{display:flex;flex-direction:column;gap:6px;align-items:center}
.radius span{font:10.5px var(--font-mono);color:var(--faint)}
.radius i{display:block;width:72px;height:46px;background:var(--panel-2);border:1px solid var(--line)}
"""

def sw(name, val, use, style=None):
    return ('<div class="sw"><span class="sw-chip" style="background:%s"></span>'
            '<span class="sw-meta"><span class="sw-name">%s</span>'
            '<span class="sw-val">%s</span><span class="sw-use">%s</span></span></div>'
            % (style or val, name, val, use))

surfaces = "\n".join([
  sw("--bg", "#0f1113", "App ground. Terminal host, chat log, input fills."),
  sw("--panel", "#15181b", "Sidebar, composer, modal card, cards on ground."),
  sw("--panel-2", "#1c2025", "Inset fields, search input, tool change rows."),
  sw("--panel-3", "#232830", "Hover on popover items and row menus only."),
  sw("--pop-bg", "#171a1e", "Floating layer: popovers, row menus, workflow detail."),
  sw("--bubble-user", "#20252b", "User turn bubble. Neutral on purpose - blue made every turn shout."),
])
inks = "\n".join([
  sw("--text", "#e4e7ea", "Primary reading ink and session titles."),
  sw("--muted", "#9aa0a8", "Secondary metadata, labels, assistant chrome."),
  sw("--faint", "#6b7178", "Tertiary: runtime rail, folder paths, timestamps."),
  sw("--line", "rgba(255,255,255,.08)", "The only resting border. Hairline, never a frame."),
  sw("--line-strong", "rgba(255,255,255,.14)", "Hover and focus borders exclusively."),
  sw("--row-hover", "rgba(255,255,255,.045)", "Neutral row hover. Never the accent."),
])
meaning = "\n".join([
  sw("--accent", "#5b8dee", "Affordance, focus ring, selected rail, done state."),
  sw("--accent-2", "#3f6fd1", "Primary button fill only."),
  sw("--ok", "#3fb87a", "Working / running. Pulsing dot."),
  sw("--warn", "#e0a53e", "Waiting - the one state allowed a text pill."),
  sw("--danger", "#f0606a", "Errors, kill, failed tool calls."),
  sw("--shell", "#9b8fe8", "Pane returned to a login shell; OMP is not running."),
])

body = f"""
  <section class="ds-block">
    <span class="ds-label">Surfaces - elevation is a lightness delta, never a new hue</span>
    <div class="sw-grid">{surfaces}</div>
  </section>
  <section class="ds-block">
    <span class="ds-label">Ink and hairlines</span>
    <div class="sw-grid">{inks}</div>
    <p class="ds-note">Controls carry no border at rest. Ghost buttons, rows and selects reveal
      <code>--line-strong</code> on hover or focus. A resting 1px outline on every control is what
      made the pre-reset build read as a generic dev tool.</p>
  </section>
  <section class="ds-block">
    <span class="ds-label">Chroma is reserved for meaning</span>
    <div class="sw-grid">{meaning}</div>
    <p class="ds-note">Six hues, six meanings, no decoration. Selected rows get a 2px accent rail
      plus <code>--panel</code>, not a blue wash, so hover and selection stop competing.</p>
  </section>
  <section class="ds-block">
    <span class="ds-label">Radius scale</span>
    <div class="radius-row">
      <span class="radius"><i style="border-radius:6px"></i><span>6px controls</span></span>
      <span class="radius"><i style="border-radius:7px"></i><span>7px tool cards</span></span>
      <span class="radius"><i style="border-radius:8px"></i><span>8px popovers, inputs</span></span>
      <span class="radius"><i style="border-radius:12px"></i><span>12px bubbles, modals</span></span>
      <span class="radius"><i style="border-radius:999px;width:46px"></i><span>999px pills</span></span>
    </div>
  </section>
  <section class="ds-block">
    <span class="ds-label">Typeface</span>
    <p class="ds-note">Inter Variable for UI and JetBrains Mono Variable for
      code and paths, self-hosted as latin subsets (48KB + 40KB, both OFL) in
      <code>public/vendor/fonts/</code>. Self-hosted rather than CDN so the
      console keeps working offline and over a VPN with no third-party
      request. <code>cv05</code> is enabled to give <code>l</code> a tail:
      l/1/I have to separate at 11px in an app full of paths and flags.
      These preview cards use the same UI and monospace stacks as the shipped app.
      Transcript type is <code>--chat-text: 13.5px</code>, shared by assistant
      prose, user bubbles and the composer so chat stays on the app type scale.</p>
  </section>
  <section class="ds-block">
    <span class="ds-label">Light theme</span>
    <p class="ds-note">Shipped as a single <code>:root[data-theme="light"]</code>
      token block with a toggle and an inline pre-paint script. The terminal
      stays dark in both themes &mdash; it is a device showing another
      program&rsquo;s ANSI output, and omp&rsquo;s palette is tuned for a dark
      ground.</p>
  </section>
  <section class="ds-block">
    <span class="ds-label">Motion and depth</span>
    <p class="ds-note">One shadow: <code>0 8px 24px rgba(0,0,0,.36)</code>, on popovers and modals only.
      No gradients. The sidebar's staggered row entrance is the single entrance animation in the app and
      is scoped to first paint - an unscoped rule replays on every status change and reads as flicker.
      <code>prefers-reduced-motion</code> disables all of it globally.</p>
  </section>
"""
page("foundations/tokens.html", "Foundations", "Color and surface tokens",
     "Quiet console",
     "Every value lives in base.css :root. Dark and light ship from the same token contract; the terminal "
     "stays dark because it renders another program's ANSI output.",
     body, SWATCH_CSS)

TYPE_CSS = """
.ty{display:flex;flex-direction:column;gap:12px}
.ty-row{display:grid;grid-template-columns:218px minmax(0,1fr);align-items:baseline;gap:18px;
  padding-bottom:12px;border-bottom:1px solid var(--line)}
.ty-row:last-child{border-bottom:0;padding-bottom:0}
.ty-spec{color:var(--faint);font:10.5px/1.5 var(--font-mono)}
.ty-sample{min-width:0}
.s-display{font-size:26px;font-weight:600;line-height:1.2;letter-spacing:-.03em}
.s-page{font-size:19px;font-weight:650;line-height:1.3;letter-spacing:-.025em}
.s-h2{font-size:17px;font-weight:650;line-height:1.35;letter-spacing:-.018em}
.s-h3{font-size:15.5px;font-weight:640;line-height:1.35;letter-spacing:-.014em}
.s-prose{font-size:14.5px;font-weight:400;line-height:1.7}
.s-input{font-size:14px;font-weight:400;line-height:1.6}
.s-control{font-size:12.5px;font-weight:520;line-height:1.4}
.s-label{color:var(--muted);font-size:11px;font-weight:650;line-height:1.35}
.s-meta{color:var(--faint);font-size:11px;font-weight:400;line-height:1.4}
.s-mono{color:var(--muted);font:11px/1.4 var(--font-mono)}
.s-terminal{color:var(--text);font:12px/1.65 var(--font-mono)}
.measure{width:min(100%,760px);padding:16px;border:1px dashed var(--line-strong);border-radius:8px}
@media(max-width:560px){.ty-row{grid-template-columns:1fr;gap:4px}.s-display{font-size:22px}}
"""

body = """
  <section class="ds-block">
    <span class="ds-label">Inter Variable — role scale</span>
    <div class="ty">
      <div class="ty-row"><span class="ty-spec">26px / 1.2 / 600 / −.03em<br>empty-state display</span>
        <span class="ty-sample s-display">Start an OMP session</span></div>
      <div class="ty-row"><span class="ty-spec">19px / 1.3 / 650 / −.025em<br>page and modal title</span>
        <span class="ty-sample s-page">Reload under another profile</span></div>
      <div class="ty-row"><span class="ty-spec">17px / 1.35 / 650 / −.018em<br>assistant heading 2</span>
        <span class="ty-sample s-h2">Verification surface</span></div>
      <div class="ty-row"><span class="ty-spec">15.5px / 1.35 / 640 / −.014em<br>assistant heading 3</span>
        <span class="ty-sample s-h3">Changed behavior</span></div>
      <div class="ty-row"><span class="ty-spec">14.5px / 1.7 / 400<br>assistant prose</span>
        <span class="ty-sample s-prose">The reader mirrors the append-only contract and treats a rewrite as a reset.</span></div>
      <div class="ty-row"><span class="ty-spec">14px / 1.6 / 400<br>composer and user bubble</span>
        <span class="ty-sample s-input">Reload this session under the claude profile and keep the transcript.</span></div>
      <div class="ty-row"><span class="ty-spec">12.5px / 1.4 / 520<br>session title and ordinary control</span>
        <span class="ty-sample s-control">Restore origin history</span></div>
      <div class="ty-row"><span class="ty-spec">11px / 1.35 / 650<br>label and state chrome</span>
        <span class="ty-sample s-label">Needs you</span></div>
      <div class="ty-row"><span class="ty-spec">11px / 1.4 / 400<br>runtime rail and row metadata</span>
        <span class="ty-sample s-meta">omp-web · claude · 2m ago</span></div>
      <div class="ty-row"><span class="ty-spec">11px / 1.4 / 400<br>structured value, path and chip</span>
        <span class="ty-sample s-mono">~/workspace/omp-web · opus-5[1m]</span></div>
      <div class="ty-row"><span class="ty-spec">12px / 1.65 / 400<br>terminal reading</span>
        <span class="ty-sample s-terminal">git status --short</span></div>
    </div>
  </section>
  <section class="ds-block">
    <span class="ds-label">Measure</span>
    <div class="measure">
      <p class="s-prose" style="margin:0">Conversation and composer share one centered axis at
      <code class="ds-mono">--reading-width: 760px</code>. Tool cards, receipts, notices and the
      workflow strip all snap to the same column, so the eye never re-finds the left edge.</p>
    </div>
  </section>
  <section class="ds-block">
    <span class="ds-label">Rules</span>
    <p class="ds-note"><span class="ds-do">Do</span> use the shipped Inter Variable face for every UI
      role and JetBrains Mono Variable only where values need stable character shapes. The scale becomes
      16px for editable controls on compact screens; it does not create a mobile typeface.</p>
    <p class="ds-note"><span class="ds-dont">Don't</span> add a display face, a second UI stack, or a
      second mono. Hierarchy comes from the documented size, line-height, weight and color roles—not a
      decorative font.</p>
  </section>
"""
page("foundations/typography.html", "Foundations", "Typography",
     "Dense, calm, typographic",
     "This is an operator console, not a chat app. Information density is a feature; chrome is not.",
     body, TYPE_CSS)

STATUS_CSS = """
.st-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(236px,1fr));gap:10px}
.st{display:flex;gap:10px;align-items:flex-start;padding:11px;border:1px solid var(--line);
  border-radius:8px;background:var(--panel-2)}
.st-meta{display:flex;flex-direction:column;gap:3px;min-width:0}
.st-name{font:600 12px var(--font-ui)}
.st-desc{color:var(--muted);font-size:11px;line-height:1.45}
.ind{display:inline-block;flex:none;width:8px;height:8px;margin-top:4px;border-radius:50%}
.status-idle{background:var(--muted);opacity:.55}
.status-done{background:var(--accent)}
.status-working{background:var(--ok);box-shadow:0 0 0 2px color-mix(in srgb,var(--ok) 16%,transparent);
  animation:pulse 1s ease-in-out infinite}
.status-waiting{background:var(--warn);box-shadow:0 0 0 2px color-mix(in srgb,var(--warn) 14%,transparent);
  animation:blink 1.4s steps(1,end) infinite}
.status-starting{background:var(--muted);animation:pulse 1.6s ease-in-out infinite}
.status-shell{background:var(--shell)}
.status-unknown{border:1px solid var(--muted);background:transparent}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.42;transform:scale(.72)}}
@keyframes blink{0%,45%{opacity:1}50%,100%{opacity:.22}}
.prio{display:flex;flex-direction:column;gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.prio div{display:flex;align-items:center;gap:9px;padding:9px 12px;border-bottom:1px solid var(--line);font-size:12px}
.prio div:last-child{border-bottom:0}
.prio b{font-weight:600}
.prio span.rank{width:18px;color:var(--faint);font:10.5px var(--font-mono)}
.prio small{margin-left:auto;color:var(--faint);font-size:11px}
.needs-you{flex:none;padding:1px 6px;border-radius:999px;
  background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn);
  font-size:9.5px;font-weight:700}
.recede{color:var(--muted)}
"""

def st(cls, name, desc):
    return ('<div class="st"><span class="ind %s"></span><span class="st-meta">'
            '<span class="st-name">%s</span><span class="st-desc">%s</span></span></div>'
            % (cls, name, desc))

cards = "\n".join([
  st("status-waiting", "waiting", "An ask or approval is blocking the turn. The only state that shouts, and the only one paired with a text pill."),
  st("status-working", "working", "A turn is in flight. Green pulse; chat polls at 350ms while this holds."),
  st("status-done", "done", "Turn finished cleanly. Accent dot, title at 550 weight."),
  st("status-shell", "shell", "The pane fell back to a login shell - OMP is not running in it."),
  st("status-starting", "starting", "Pane spawned, OMP has not reported yet."),
  st("status-idle", "idle", "Attached, nothing running. Dot and title both recede."),
  st("status-unknown", "unknown", "No transcript signal. Hollow ring; recedes with idle."),
])

body = f"""
  <section class="ds-block">
    <span class="ds-label">Seven lifecycle states</span>
    <div class="st-grid">{cards}</div>
    <p class="ds-note">The dot is 8px everywhere: sidebar rows, header badge, agent roster. Animation
      is a secondary channel only - weight and color carry the signal so the grammar survives
      <code>prefers-reduced-motion</code>.</p>
  </section>
  <section class="ds-block">
    <span class="ds-label">Visual priority order - identical in every surface</span>
    <div class="prio">
      <div><span class="rank">1</span><span class="ind status-waiting"></span><b>waiting</b>
        <span class="needs-you">NEEDS YOU</span><small>hoisted above Pinned in both views</small></div>
      <div><span class="rank">2</span><span class="ind" style="background:var(--danger)"></span>
        <b style="color:var(--danger)">error</b><small>red, persistent card in chat</small></div>
      <div><span class="rank">3</span><span class="ind status-working"></span><b>working</b>
        <small>green pulse</small></div>
      <div><span class="rank">4</span><span class="ind status-done"></span><b>done</b>
        <small>accent, 550 weight</small></div>
      <div><span class="rank">5</span><span class="ind status-idle"></span>
        <b class="recede">idle / unknown</b><small>faded to --muted, dot only</small></div>
    </div>
    <p class="ds-note">Before this grammar, seven states were 8px dots separated by fill alone:
      idle and unknown were indistinguishable at list density, and done collided with the blue
      selected row. Waiting - the one state that demands a human - was visually equal to noise.</p>
  </section>
"""
page("foundations/status.html", "Foundations", "Status and attention grammar",
     "What needs me?",
     "Status answers one question per glance. Waiting is the only state allowed to pair chroma with "
     "a text pill; everything else is a dot plus muted text.",
     body, STATUS_CSS)

# ---------------------------------------------------------------- components

SIDEBAR_CSS = """
.frame{width:240px;border:1px solid var(--line);border-radius:10px;background:var(--panel);
  overflow:hidden;display:flex;flex-direction:column}
.side-head{display:flex;align-items:center;gap:8px;padding:10px 10px 6px 12px}
.brand{display:flex;align-items:center;gap:7px;color:var(--text);font-weight:700;letter-spacing:-.02em;font-size:14px}
.brand-mark{flex:none;width:21px;height:21px;fill:var(--accent)}
.side-head .primary{display:inline-grid;place-items:center;width:26px;min-width:26px;height:26px;min-height:26px;
  margin-left:auto;padding:0;font-size:15px;line-height:1}
.side-sub{padding:0 12px 9px;overflow:hidden;color:var(--faint);font:11px/1.3 var(--font-ui);text-overflow:ellipsis;white-space:nowrap}
.search{position:relative;display:flex;align-items:center;margin:0 9px 5px}
.search svg{position:absolute;left:9px;width:13px;height:13px;fill:none;stroke:var(--faint);stroke-width:1.8;stroke-linecap:round}
.search input{width:100%;min-height:34px;padding:6px 27px 6px 29px;border:1px solid transparent;
  border-radius:6px;outline:0;background:var(--panel-2);color:var(--text);font-size:12.5px}
.search input::placeholder{color:var(--faint)}
.sessions{list-style:none;flex:1;margin:0;padding:3px 7px 14px;overflow:auto}
.bucket-head{display:flex;align-items:center;gap:6px;min-height:26px;padding:8px 6px 3px;color:var(--faint);font-size:11px;font-weight:590}
.needs-head{color:var(--warn)}
.pinned-head{color:var(--muted)}
.pinned-head::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--accent)}
.sess{position:relative;display:flex;align-items:stretch;min-width:0;min-height:36px;margin:1px -7px;padding-inline:7px;border-radius:0}
.sess:hover,.sess.is-hover{background:var(--row-hover)}
.sess.active{background:color-mix(in srgb,var(--accent) 10%,transparent)}
.sess.active::before{content:"";position:absolute;top:0;bottom:0;left:0;width:3px;background:var(--accent)}
.sess-open{display:flex;align-items:center;flex:1;min-width:0;min-height:36px;padding:5px 6px;border:0;background:transparent;color:var(--text);text-align:left}
.sess-lines{display:flex;flex-direction:column;gap:1px;width:100%;min-width:0}
.row1{display:flex;align-items:center;gap:6px;width:100%;min-width:0}
.row2{padding-left:14px;overflow:hidden;color:var(--faint);font:11px var(--font-ui);text-overflow:ellipsis;white-space:nowrap}
.title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:520}
.needs-you{flex:none;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--warn) 16%,transparent);
  color:var(--warn);font-size:9.5px;font-weight:700;letter-spacing:.01em}
.unread-dot{flex:none;color:var(--accent);font-size:9px;line-height:1}
.session-folder{flex:none;max-width:72px;overflow:hidden;color:var(--faint);font:500 9px var(--font-mono);text-overflow:ellipsis;white-space:nowrap}
.row-pin,.row-menu{display:inline-flex;align-items:center;justify-content:center;align-self:center;flex:none;border:0;background:transparent;color:var(--faint);opacity:0}
.row-pin{width:26px;height:26px;border-radius:5px}.row-pin svg{width:13px;height:13px;fill:currentColor;stroke:none}
.row-menu{width:28px;height:28px;margin-right:1px;border-radius:4px}
.sess:hover .row-pin,.sess:hover .row-menu,.row-pin:focus-visible,.row-menu:focus-visible,.sess.is-hover .row-pin,.sess.is-hover .row-menu{opacity:1}
.row-pin:hover,.row-menu:hover{background:var(--panel-3);color:var(--text)}
.row-pin.is-pinned{color:var(--accent)}
.folder-toggle{display:flex;align-items:center;gap:6px;width:100%;min-height:32px;padding:4px 0;border:0;background:transparent;color:var(--muted);text-align:left}
.folder-chevron{flex:none;width:10px;color:var(--faint);transform:rotate(90deg);text-align:center}
.folder-chevron.closed{transform:rotate(0)}
.folder-name{font:12px var(--font-ui)}.folder-count{margin-left:auto;color:var(--faint);font:10.5px var(--font-ui)}
.folder-sessions{list-style:none;margin:0;padding:0}
.side-foot{display:flex;align-items:center;gap:8px;padding:9px 12px;border-top:1px solid var(--line);color:var(--faint);font-size:11px}
.side-foot-copy{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.settings-btn{display:inline-grid;place-items:center;flex:none;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--faint)}
.settings-btn svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.settings-btn:hover{background:var(--row-hover);color:var(--text)}
.status-idle{background:var(--muted);opacity:.55}.status-done{background:var(--accent)}
.status-working{background:var(--ok);box-shadow:0 0 0 2px color-mix(in srgb,var(--ok) 16%,transparent);animation:pulse 1s ease-in-out infinite}
.status-waiting{background:var(--warn);animation:blink 1.4s steps(1,end) infinite}.status-shell{background:var(--shell)}
.status-unknown{border:1px solid var(--muted);background:transparent}.sess.recede .title{color:var(--muted)}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.42;transform:scale(.72)}}@keyframes blink{0%,45%{opacity:1}50%,100%{opacity:.22}}
.side-pair{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}
.pop-menu{width:200px;padding:4px;background:var(--pop-bg);border:1px solid var(--line);border-radius:8px;box-shadow:var(--pop-shadow)}
.pop-title{padding:6px 8px 4px;overflow:hidden;color:var(--faint);font-size:10px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.pop-detail{display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;margin:0 4px 4px;padding:6px 8px 8px;border-bottom:1px solid var(--line);font-size:11px}
.pop-detail dt{color:var(--faint);font-weight:500}.pop-detail dd{margin:0;overflow:hidden;color:var(--muted);font:10.5px var(--font-mono);text-overflow:ellipsis;white-space:nowrap}
.pop-item{display:flex;align-items:center;gap:7px;width:100%;min-height:36px;padding:7px 8px;border:0;border-radius:5px;background:transparent;color:var(--text);font-size:12px;text-align:left}
.pop-item.hot,.pop-item:hover{background:var(--panel-3)}.pop-item.danger{color:var(--danger)}
@media(max-width:600px){.frame{width:100%}.side-head .primary,.settings-btn{width:44px;min-width:44px;height:44px;min-height:44px}.search input,.folder-toggle,.sess,.sess-open{min-height:44px}.search input{font-size:16px}.title{font-size:14px}.row-pin,.row-menu{width:40px;height:40px;opacity:1}.row2{font-size:11.5px}.needs-you{padding:2px 7px;font-size:10.5px}}
"""

def row(title, status, folder="", row2="", pill=False, unread=False, active=False, recede=False, hover=False, pinned=False):
    cls = "sess" + (" active" if active else "") + (" recede" if recede else "") + (" is-hover" if hover else "")
    pill_html = '<span class="needs-you">NEEDS YOU</span>' if pill else ""
    unread_html = '<span class="unread-dot">&#9679;</span>' if unread else ""
    fold = '<span class="session-folder">%s</span>' % folder if folder else ""
    second = '<span class="row2">%s</span>' % row2 if row2 else ""
    pin_html = ('<button class="row-pin is-pinned" aria-label="Unpin session"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5 12.5 5l-2.2.7-2.6 2.7.6 3.1-1.4 1.4-2-3.4L1.5 12l2.6-3.4-3.4-2L2.1 5.2l3.1.6L7.8 3.7 9 1.5Z"/></svg></button>'
                if pinned else '<button class="row-pin" aria-label="Pin session"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5 12.5 5l-2.2.7-2.6 2.7.6 3.1-1.4 1.4-2-3.4L1.5 12l2.6-3.4-3.4-2L2.1 5.2l3.1.6L7.8 3.7 9 1.5Z"/></svg></button>')
    return f"""<li class="{cls}"><button class="sess-open"><span class="sess-lines">
      <span class="row1"><span class="dot {status}"></span><span class="title">{title}</span>
      {pill_html}{unread_html}{fold}</span>{second}</span></button>{pin_html}
      <button class="row-menu" aria-label="Session actions">&#8943;</button></li>"""

sidebar_html = f"""<div class="frame">
  <header class="side-head"><div class="brand"><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="12" width="4.5" height="16" rx="2.25" opacity=".45"/><rect x="11" y="6" width="4.5" height="22" rx="2.25"/><rect x="18" y="15" width="4.5" height="13" rx="2.25" opacity=".7"/><rect x="25" y="19" width="4.5" height="9" rx="2.25" opacity=".3"/></svg>omp-web</div><button class="primary" aria-label="New session">+</button></header>
  <div class="side-sub">~/workspace</div>
  <div class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg><input aria-label="Search sessions" placeholder="Search sessions"></div>
  <ul class="sessions">
    <li class="bucket-head needs-head">Needs you</li>
    {row("Migrate queue worker", "status-waiting", "", "job-runner &middot; openai &middot; now", pill=True)}
    <li class="bucket-head pinned-head">Pinned</li>
    {row("Omp Web Main", "status-working", "omp-web", "omp-web &middot; claude &middot; 1m ago", unread=True, active=True, hover=True, pinned=True)}
    {row("Release Notes", "status-done", "", "docs-site &middot; openai &middot; 12m ago")}
    <li class="bucket-head">~/workspace</li>
    <li><button class="folder-toggle"><span class="folder-chevron">&rsaquo;</span><span class="folder-name">omp-web</span><span class="folder-count">3</span></button>
      <ul class="folder-sessions">{row("Restore origin history", "status-idle", "", "omp-web &middot; mix &middot; 2h ago", recede=True)}
        {row("Proxy Setup", "status-shell", "", "omp-web &middot; ollama &middot; 5h ago")}</ul></li>
    <li><button class="folder-toggle"><span class="folder-chevron closed">&rsaquo;</span><span class="folder-name">infra</span><span class="folder-count">7</span></button></li>
    {row("Onboard Metabase", "status-unknown", "", "infra &middot; claude &middot; yesterday", recede=True)}
  </ul>
  <footer class="side-foot"><span class="side-foot-copy">14 sessions &middot; 7799</span><button class="settings-btn" aria-label="Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.88 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.88.34H9.1A1.7 1.7 0 0 0 10.13 3V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.88V9.1a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.5Z"/></svg></button></footer>
</div>"""

popover_html = """<div class="pop-menu">
  <div class="pop-title">Omp Web Main</div>
  <dl class="pop-detail"><dt>cwd</dt><dd>~/workspace/omp-web</dd><dt>profile</dt><dd>claude</dd><dt>started</dt><dd>09:14 today</dd><dt>transcript</dt><dd>1.5 MB</dd></dl>
  <button class="pop-item hot">Unpin session</button><button class="pop-item">Reload under profile&hellip;</button><button class="pop-item">Copy path</button><button class="pop-item danger">Kill session</button>
</div>"""

body = f"""
  <section class="ds-block on-bg">
    <span class="ds-label">Sidebar — 288px desktop rail (240–480 drag; min(420px, 100%) overlay)</span>
    <div class="side-pair">
      {sidebar_html}
      <div style="display:flex;flex-direction:column;gap:12px">
        <span class="ds-label">Hovered pinned row — pin and actions are revealed together</span>{popover_html}
        <p class="ds-note" style="max-width:34ch">The footer now carries Settings. The session detail menu
          identifies truncated twins with cwd, profile and start time; hover tooltips do not exist on touch.</p>
      </div>
    </div>
  </section>
  <section class="ds-block">
    <span class="ds-label">Rules</span>
    <p class="ds-note">Rows are <b>full-bleed, text-first bands</b>: nested sessions share the rail edge,
      rather than indented cards. Row 1 is dot + title + optional need/pin/unread/folder signal; row 2 is
      <code>folder &middot; profile &middot; relative time</code>.</p>
    <p class="ds-note">Active uses a 3px accent edge plus a 10% accent wash. Hover stays a neutral 4.5%
      wash. Pinned remains a section and a lit hover affordance, not a second background treatment.</p>
    <p class="ds-note">At 390px every session, folder, pin, menu and settings target becomes 44px; the
      rail becomes full width without changing its information order.</p>
  </section>
"""
page("components/sidebar.html", "Navigation", "Sidebar", "Workspace navigation",
     "One column answers what needs me, what is churning, and where everything lives. Search is "
     "global and flat; folders are a grouping, not a mode.",
     body, SIDEBAR_CSS)

HEADER_CSS = """
.stage{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg)}
.term-head{display:flex;align-items:center;gap:8px;min-height:56px;padding:8px 14px;
  border-bottom:1px solid var(--line);background:var(--panel)}
.term-session{display:flex;align-items:center;gap:9px;min-width:0}
.badge{flex:none;width:8px;height:8px;border-radius:50%;background:var(--faint)}
.badge.working{background:var(--ok);box-shadow:0 0 0 2px color-mix(in srgb,var(--ok) 16%,transparent);
  animation:pulse 1s ease-in-out infinite}
.badge.dead{background:var(--faint);box-shadow:0 0 0 2px var(--danger)}
.term-title{overflow:hidden;font-size:13.5px;font-weight:550;letter-spacing:-.005em}
.spacer{flex:1}
.icon-action{display:inline-grid;place-items:center;flex:none;width:38px;min-height:38px;padding:0;
  border:0;border-radius:6px;background:transparent;color:var(--text)}
.icon-action:hover{background:var(--row-hover)}
.icon-action svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-linecap:round;
  stroke-linejoin:round;stroke-width:1.8}
.icon-action.muted{color:var(--muted)}
.icon-action.on{color:var(--accent)}
.icon-action.kill{color:var(--danger)}
.term-body{display:grid;place-items:center;align-content:center;gap:10px;min-height:190px;
  padding:32px;text-align:center;color:var(--muted);background:var(--term-bg)}
.term-body h1{margin:0;color:var(--text);font:600 21px var(--font-ui);letter-spacing:-.02em}
.term-body p{max-width:380px;margin:0;font:13.5px/1.6 var(--font-ui)}
.kicker{color:var(--muted);font:590 12px var(--font-ui)}
.termish{min-height:190px;padding:14px 16px;background:var(--term-bg);
  font:12px/1.65 var(--font-mono);color:#c9d1d9;white-space:pre-wrap}
.termish .g{color:var(--ok)} .termish .b{color:var(--accent)} .termish .f{color:var(--faint)}
.update-btn{display:inline-block;padding:8px 12px;border:1px solid color-mix(in srgb,var(--accent) 55%,var(--line));
  border-radius:999px;background:var(--panel-2);color:var(--accent);font:600 11px var(--font-mono)}
.scrub{display:inline-flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--line);
  border-radius:999px;background:var(--pop-bg);color:var(--accent);font:10px var(--font-mono);
  box-shadow:var(--pop-shadow)}
.pop{width:min(420px,100%);padding:12px;border:1px solid var(--line);border-radius:8px;
  background:var(--pop-bg);box-shadow:var(--pop-shadow)}
.pop-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px;
  font-size:12.5px}
.pop-head span{color:var(--faint);font-size:11px}
.pgrid{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;font-size:11.5px}
.pgrid dt{color:var(--faint)}
.pgrid dd{margin:0;color:var(--muted);font-family:var(--font-mono);font-size:11px}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.42;transform:scale(.72)}}
"""

ICON_CHAT = ('<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>')
ICON_TERM = ('<svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>')
ICON_BELL = ('<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>')
ICON_INFO = ('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 10.5v6M12 7.5h.01"/></svg>')
ICON_BOT  = ('<svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 4v3M9 12h.01M15 12h.01M9 16h6"/></svg>')
ICON_KILL = ('<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>')
ICON_DOTS = ('<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/>'
             '<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>'
             '<circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></svg>')
ICON_USAGE = '<svg viewBox="0 0 24 24"><path d="M3 19h4v-5H3zm7 0h4V9h-4zm7 0h4V4h-4z" fill="currentColor" stroke="none"/></svg>'

head = f"""<header class="term-head">
  <div class="term-session"><span class="badge working"></span>
    <span class="term-title">Omp Web Main</span></div>
  <span class="spacer"></span>
  <button class="icon-action" title="Switch to chat mode">{ICON_CHAT}</button>
  <button class="icon-action muted">{ICON_USAGE}</button>
  <button class="icon-action muted">{ICON_INFO}</button>
  <button class="icon-action on">{ICON_BELL}</button>
  <button class="icon-action" style="font-size:16px">&#8635;</button>
  <button class="icon-action">{ICON_BOT}</button>
  <button class="icon-action kill">{ICON_KILL}</button>
</header>"""

head_compact = f"""<header class="term-head">
  <button class="icon-action">&#9776;</button>
  <div class="term-session"><span class="badge dead"></span>
    <span class="term-title">Migrate queue worker</span></div>
  <span class="spacer"></span>
  <button class="icon-action">{ICON_TERM}</button>
  <button class="icon-action muted">{ICON_DOTS}</button>
</header>"""

body = f"""
  <section class="ds-block on-bg">
    <span class="ds-label">Desktop header - session identity left, actions right</span>
    <div class="stage">{head}
      <div class="termish"><span class="f">user@mac</span> <span class="b">~/workspace/omp-web</span>
&gt; omp
<span class="g">&#9679;</span> claude &middot; opus-5[1m] &middot; 128k context
  Reading public/chat.css&hellip;
</div>
    </div>
    <p class="ds-note">The terminal sits <b>in</b> the app: xterm's theme is synced to
      <code>--term-bg #101214</code> and the old black-on-panel frame is gone. All chrome lives
      outside <code>#term-wrap</code> - zero visual interference with the TUI.</p>
  </section>
  <section class="ds-block on-bg">
    <span class="ds-label">Compact header - actions collapse behind one &#8943; toggle</span>
    <div class="stage" style="max-width:390px">{head_compact}
      <div class="term-body"><span class="kicker">No live terminal</span>
        <h1>Start an OMP session</h1>
        <p>Select a session from the workspace, or create one in a folder.</p>
        <button class="primary">New session</button></div>
    </div>
  </section>
  <section class="ds-block">
    <span class="ds-label">Header transients</span>
    <div class="ds-row">
      <span class="update-btn">Update available &middot; Reload</span>
      <span class="scrub">Live</span>
      <span class="scrub" style="color:var(--muted)">&minus;2,418 lines</span>
    </div>
    <p class="ds-note">Both are fixed, centered, and never occupy layout - the update pill sits
      under the header, the scrubber label rides the terminal's right edge while scrollback is held.</p>
  </section>
  <section class="ds-block on-bg">
    <span class="ds-label">Profile popover - anchored under its trigger</span>
    <div class="pop">
      <div class="pop-head"><strong>claude</strong><span>3 roles configured</span></div>
      <dl class="pgrid">
        <dt>default</dt><dd>claude-opus-5[1m]</dd>
        <dt>plan</dt><dd>claude-opus-5</dd>
        <dt>subagent</dt><dd>claude-sonnet-5</dd>
        <dt>compaction</dt><dd>auto &middot; 62% used</dd>
      </dl>
    </div>
  </section>
  <section class="ds-block">
    <span class="ds-label">Mode toggle rule</span>
    <p class="ds-note">One button, and it always shows the <b>destination</b> icon and label - a
      speech bubble while in Terminal, a prompt caret while in Chat. The terminal WebSocket stays
      attached behind chat so tmux sizing survives and switching back is instant.</p>
  </section>
"""
page("components/header-terminal.html", "Shell", "Header and terminal", "App shell",
     "56px header, one session identity, one destination-labelled mode toggle, and the rest of the "
     "actions in priority order. Terminal is full-fidelity mode, not the default.",
     body, HEADER_CSS)

CHAT_CSS = """
.log{display:flex;flex-direction:column;gap:20px;padding:24px;border:1px solid var(--line);
  border-radius:10px;background:var(--bg)}
.item{width:min(100%,var(--reading-width));margin-inline:auto;overflow-wrap:anywhere}
.chat-user{display:flex;justify-content:flex-end}
.chat-user-content{display:flex;flex-direction:column;align-items:flex-end;gap:5px;max-width:86%}
.chat-bubble{max-width:100%;padding:8px 12px;white-space:pre-wrap;border:1px solid var(--line);
  border-radius:12px;background:var(--bubble-user);font-size:14px;line-height:1.6}
.chat-user-meta{display:flex;align-items:center;gap:8px;color:var(--faint);font-size:10.5px}
.chat-user-state{font:650 10.5px var(--font-ui)}
.pending{color:var(--warn)} .failed{color:var(--danger)}
.chat-delivery-actions{display:flex;gap:6px}
.mini{min-height:26px;padding:3px 9px;border:1px solid var(--line);border-radius:999px;
  background:transparent;color:var(--muted);font:600 10.5px var(--font-ui)}
.mini:hover{border-color:var(--line-strong);color:var(--text)}
.chat-assistant-body{font-size:14.5px;line-height:1.7}
.chat-assistant-body p{margin:0 0 11px}
.chat-assistant-body p:last-child{margin-bottom:0}
.chat-list{margin:0 0 11px;padding-left:22px}
.chat-list li{margin:4px 0}
.chat-inline-code{padding:1px 5px;border-radius:4px;background:var(--panel-2);
  font:12px var(--font-mono);color:var(--text)}
.chat-code-wrap{margin:0 0 11px;border:1px solid var(--line);border-radius:8px;overflow:hidden;
  background:var(--panel)}
.chat-code-head{display:flex;align-items:center;justify-content:space-between;padding:5px 10px;
  border-bottom:1px solid var(--line);color:var(--faint);font:10.5px var(--font-mono)}
.chat-code-block{margin:0;padding:11px;overflow:auto;font:12px/1.6 var(--font-mono);color:var(--text)}
.chat-message-actions{display:flex;gap:4px;margin-top:6px;opacity:0;transition:opacity .12s ease}
.item:hover .chat-message-actions{opacity:1}
.chat-icon-action{display:inline-grid;place-items:center;width:26px;height:26px;border:0;
  border-radius:5px;background:transparent;color:var(--faint)}
.chat-icon-action:hover{background:var(--row-hover);color:var(--text)}
.chat-event{display:flex;align-items:center;gap:12px;color:var(--faint);font-size:11.5px}
.chat-event::before,.chat-event::after{content:"";flex:1;height:1px;
  background:color-mix(in srgb,var(--line) 65%,transparent)}
.chat-error{padding:10px 12px;border:1px solid color-mix(in srgb,var(--danger) 55%,var(--line));
  border-left:3px solid var(--danger);border-radius:7px;
  background:color-mix(in srgb,var(--danger) 7%,var(--panel))}
.chat-error-label{display:block;margin-bottom:5px;color:var(--danger);font:620 12px var(--font-ui)}
.chat-error-text{color:var(--text);font-size:12.5px;line-height:1.45}
.chat-notice{display:flex;align-items:baseline;gap:8px;padding:7px 10px;border:1px solid var(--line);
  border-left:3px solid var(--line-strong);border-radius:7px;font-size:12.5px}
.chat-notice-attr{flex:none;color:var(--muted);font:590 10.5px var(--font-ui)}
.chat-notice-text{color:var(--text);line-height:1.45}
.chat-activity{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)}
.ca-pulse{width:7px;height:7px;border-radius:50%;background:var(--accent);
  animation:cpulse 1.4s ease-in-out infinite}
.ca-tool{color:var(--text);font:600 11.5px var(--font-mono)}
.ca-sep{color:var(--line-strong)}
.chat-jump-latest{min-height:34px;padding:7px 14px;border:1px solid var(--line);border-radius:999px;
  background:var(--pop-bg);color:var(--text);font:600 11.5px var(--font-ui);box-shadow:var(--pop-shadow)}
.chat-history-reveal{align-self:center;min-height:38px;padding:7px 12px;border:1px solid var(--line);
  border-radius:999px;background:transparent;color:var(--muted);font-size:11px;font-weight:650}
.chat-placeholder{display:grid;place-items:center;gap:6px;padding:38px;text-align:center}
.chat-placeholder h1{margin:0;font:640 22px var(--font-ui);letter-spacing:-.02em}
.chat-placeholder p{margin:0;color:var(--muted);font-size:13px}
.chat-placeholder-kicker{color:var(--muted);font:590 12px var(--font-ui)}
@keyframes cpulse{0%,100%{opacity:1}50%{opacity:.4}}
"""

body = f"""
  <section class="ds-block on-bg">
    <span class="ds-label">Transcript - one 760px axis, alternating silhouettes</span>
    <div class="log">
      <div class="item chat-event"><span>Model switched to claude-opus-5[1m]</span></div>

      <div class="item chat-user"><div class="chat-user-content">
        <div class="chat-bubble">Reload this session under the claude profile, keep the transcript, and tell me what the composer flicker fix actually changed.</div>
        <div class="chat-user-meta"><span>09:41</span></div>
      </div></div>

      <div class="item">
        <div class="chat-assistant-body">
          <p>The flicker came from <span class="chat-inline-code">autoGrow()</span> measuring the
          textarea by collapsing it to <span class="chat-inline-code">height:auto</span>. That grew
          the log in the same task, the browser clamped the pinned scrollTop, and the
          <span class="chat-inline-code">ResizeObserver</span> re-pinned it - a clamp/re-pin round
          trip on every keystroke.</p>
          <ul class="chat-list">
            <li>Measure in an absolutely positioned mirror, so measuring has no layout effect.</li>
            <li>Set <span class="chat-inline-code">overflow-anchor: none</span> on the log.</li>
            <li>Re-pin synchronously only when the composer's height genuinely changes.</li>
          </ul>
          <div class="chat-code-wrap">
            <div class="chat-code-head"><span>css</span><span>copy</span></div>
            <pre class="chat-code-block">.chat-input-sizer {{
  position: absolute; visibility: hidden;
  white-space: pre-wrap; pointer-events: none;
}}</pre>
          </div>
          <p>Verified: tail gap <b>0 across 120 keystrokes</b>; mirror and textarea agree at 58px.</p>
        </div>
        <div class="chat-message-actions">
          <button class="chat-icon-action" title="Copy">&#10697;</button>
          <button class="chat-icon-action" title="Timestamp">&#9201;</button>
        </div>
      </div>

      <div class="item chat-activity"><span class="ca-pulse"></span>
        <span>Working</span><span class="ca-sep">|</span>
        <span class="ca-tool">edit</span><span class="ca-sep">|</span>
        <span>Rewriting the sizer mirror in public/chat.css</span></div>
    </div>
  </section>

  <section class="ds-block on-bg">
    <span class="ds-label">Send states - a failed send is never silently replayed</span>
    <div class="log" style="gap:14px">
      <div class="item chat-user"><div class="chat-user-content">
        <div class="chat-bubble">Run the 390px smoke again.</div>
        <div class="chat-user-meta"><span class="chat-user-state pending">Queued</span>
          <span>waiting for the JSONL echo</span></div>
      </div></div>
      <div class="item chat-user"><div class="chat-user-content">
        <div class="chat-bubble">Kill the stale worker on the staging host.</div>
        <div class="chat-user-meta"><span class="chat-user-state failed">Not delivered</span>
          <span>503 from tmux injection</span></div>
        <div class="chat-delivery-actions">
          <button class="mini">Retry</button><button class="mini">Edit</button></div>
      </div></div>
    </div>
    <p class="ds-note">A successful send stays <b>Queued</b> until its own JSONL echo arrives, then
      reconciles by full-text SHA-256 - with a whitespace-normalised fallback for native multiline
      paste. Delivery-unknown sends stay visible with Retry and Edit. One authoritative message
      always replaces exactly one optimistic bubble.</p>
  </section>

  <section class="ds-block on-bg">
    <span class="ds-label">Boundaries - error, notice, event, history, tail</span>
    <div class="log" style="gap:14px">
      <div class="item chat-error"><span class="chat-error-label">Provider error &middot; 529</span>
        <span class="chat-error-text">overloaded_error: upstream is rejecting requests. The turn stopped; nothing was applied.</span></div>
      <div class="item chat-notice"><span class="chat-notice-attr">Transcript</span>
        <span class="chat-notice-text">One 21 MiB record was skipped to the next complete line. Everything after it is intact.</span></div>
      <div class="item chat-event"><span>Context compacted &middot; 186k &rarr; 42k</span></div>
      <button class="chat-history-reveal">Show 200 earlier entries</button>
      <div class="ds-row" style="justify-content:center">
        <button class="chat-jump-latest">Jump to now</button></div>
    </div>
    <p class="ds-note">240 entries are mounted at once; earlier/later controls page through the rest.
      Manual scrolling pauses live follow and raises <b>Jump to now</b>, centered in the transcript
      column and never over the composer. Session replays start at the bottom.</p>
  </section>

  <section class="ds-block on-bg">
    <span class="ds-label">Empty state - the one place a little warmth is allowed</span>
    <div class="log"><div class="chat-placeholder">
      <span class="chat-placeholder-kicker">Conversation</span>
      <h1>Ready when you are</h1>
      <p>Choose a session, then send a message below to begin.</p>
    </div></div>
  </section>
"""
page("components/chat-transcript.html", "Chat", "Transcript", "Chat mode",
     "A read projection of the session's own append-only JSONL. Message-level, never token-level - "
     "granularity the transport actually guarantees.",
     body, CHAT_CSS)

TOOLS_CSS = """
.log{display:flex;flex-direction:column;gap:18px;padding:24px;border:1px solid var(--line);
  border-radius:10px;background:var(--bg)}
.item{width:min(100%,var(--reading-width));margin-inline:auto}
.group-summary{display:flex;align-items:center;gap:6px;min-height:28px;padding:2px 0 5px;
  border-bottom:1px solid color-mix(in srgb,var(--line) 68%,transparent);cursor:pointer}
.chevron{color:var(--faint);font-size:10px;width:10px}
.chevron.open{transform:rotate(90deg)}
.group-label{color:var(--muted);font:600 11.5px var(--font-ui)}
.group-counts{color:var(--faint);font:11px var(--font-mono)}
.group-duration{margin-left:auto;color:var(--faint);font:10.5px var(--font-mono)}
.group-failure{color:var(--danger);font:600 10.5px var(--font-ui)}
.group-body{display:flex;flex-direction:column;gap:7px;padding-top:9px}
.tool{border:1px solid var(--line);border-radius:7px;background:var(--panel);overflow:hidden}
.tool.running{border-left:3px solid var(--accent)}
.tool.error{border-left:3px solid var(--danger)}
.tool-summary{display:flex;align-items:center;flex-wrap:wrap;gap:7px;min-height:38px;padding:7px 10px;
  cursor:pointer}
.tool-name{color:var(--text);font:600 11.5px var(--font-mono)}
.tool-intent{flex:1;min-width:0;overflow:hidden;color:var(--muted);font-size:12px;
  text-overflow:ellipsis;white-space:nowrap}
.state{flex:none;padding:1px 6px;border-radius:999px;background:var(--row-hover);
  font:590 10.5px var(--font-ui);color:var(--muted)}
.state.running{color:var(--accent)} .state.ok{color:var(--ok)}
.state.error{color:var(--danger)} .state.skipped{color:var(--muted)}
.chip{padding:1px 6px;border:1px solid var(--line);border-radius:999px;background:var(--panel-2);
  color:var(--muted);font:10px var(--font-mono)}
.chip.err{border-color:color-mix(in srgb,var(--danger) 55%,var(--line));color:var(--danger)}
.chip.trunc{font-style:italic}
.tool-section{padding:8px 10px;border-top:1px solid var(--line)}
.section-label{margin-bottom:5px;color:var(--faint);font:590 10.5px var(--font-ui)}
.section-body{margin:0;font:11.5px/1.55 var(--font-mono);color:var(--text);white-space:pre-wrap}
.changes{display:grid;gap:4px;padding:7px 10px 10px}
.change{display:flex;align-items:baseline;gap:10px;padding:6px 8px;border-radius:7px;
  background:var(--panel-2);font-size:11px}
.change-path{flex:1;min-width:0;overflow:hidden;color:var(--text);font-family:var(--font-mono);
  text-overflow:ellipsis;white-space:nowrap}
.change-stats{flex:none;color:var(--muted);font-family:var(--font-mono)}
.receipt{display:flex;align-items:center;gap:8px;padding:6px 0;color:var(--faint);font-size:11px}
.receipt-file{max-width:190px;padding:1px 6px;overflow:hidden;border-radius:999px;
  background:var(--row-hover);color:var(--muted);font:10.5px var(--font-mono);
  text-overflow:ellipsis;white-space:nowrap}
.receipt-more{color:var(--faint)}
"""

body = """
  <section class="ds-block on-bg">
    <span class="ds-label">Collapsed turn - every call in one active turn folds into one row</span>
    <div class="log">
      <div class="item">
        <div class="group-summary"><span class="chevron">&rsaquo;</span>
          <span class="group-label">Worked</span>
          <span class="group-counts">read &times;3 &middot; edit &middot; bash</span>
          <span class="group-failure">1 failed</span>
          <span class="group-duration">11.4s</span></div>
        <div class="receipt"><span class="receipt-file">public/chat.css</span>
          <span class="receipt-file">public/js/chat/composer.js</span>
          <span class="receipt-more">+2 more</span></div>
      </div>
      <div class="item">
        <div class="group-summary"><span class="chevron">&rsaquo;</span>
          <span class="group-label">Working</span>
          <span class="group-counts">grep &times;2 &middot; read</span>
          <span class="state running" style="margin-left:auto">running</span></div>
      </div>
    </div>
    <p class="ds-note">The accessible label carries the whole story -
      <code>Tools, 97 calls, 1 running, 1 failed</code> - so the collapsed row is not a visual-only
      summary. The turn receipt below it answers <i>what did it do while I was away</i> without
      expanding anything.</p>
  </section>

  <section class="ds-block on-bg">
    <span class="ds-label">Expanded - nested detail is built only while open</span>
    <div class="log">
      <div class="item">
        <div class="group-summary"><span class="chevron open">&rsaquo;</span>
          <span class="group-label">Worked</span>
          <span class="group-counts">3 calls</span>
          <span class="group-duration">11.4s</span></div>
        <div class="group-body">
          <div class="tool"><div class="tool-summary"><span class="tool-name">read</span>
            <span class="tool-intent">public/js/chat/composer.js</span>
            <span class="chip">418 lines</span><span class="state ok">ok</span></div></div>

          <div class="tool"><div class="tool-summary"><span class="tool-name">edit</span>
            <span class="tool-intent">Replace the collapse-measure with a mirror</span>
            <span class="state ok">ok</span></div>
            <div class="changes"><div class="change">
              <span class="change-path">public/js/chat/composer.js</span>
              <span class="change-stats">+18 &minus;6</span></div></div>
          </div>

          <div class="tool error"><div class="tool-summary"><span class="tool-name">bash</span>
            <span class="tool-intent">npm run smoke -- --viewport 390</span>
            <span class="chip err">exit 1</span><span class="state error">error</span></div>
            <div class="tool-section"><div class="section-label">Result</div>
              <p class="section-body">smoke: tail gap drifted to 42px after keystroke 88</p></div>
            <div class="tool-section"><div class="section-label">Arguments</div>
              <p class="section-body">{ "cmd": "npm run smoke -- --viewport 390" }
              <span class="chip trunc">truncated</span></p></div>
          </div>

          <div class="tool running"><div class="tool-summary"><span class="tool-name">bash</span>
            <span class="tool-intent">Re-running the smoke with the mirror in place</span>
            <span class="state running">running</span></div></div>

          <div class="tool"><div class="tool-summary"><span class="tool-name">write</span>
            <span class="tool-intent">Skipped due to queued user message</span>
            <span class="state skipped">skipped</span></div></div>
        </div>
      </div>
    </div>
  </section>

  <section class="ds-block">
    <span class="ds-label">Projection rules the visuals depend on</span>
    <p class="ds-note"><b>State</b> is derived, never invented:
      <code>details.__synthetic</code> &rarr; skipped &middot; <code>isError</code> &rarr; error &middot;
      a start with no result yet &rarr; running &middot; otherwise ok. An unknown entry type degrades
      to a bounded <code>event</code> - it never gets a fabricated status.</p>
    <p class="ds-note"><b>Changed files</b> come only from successful structured edit/apply-patch
      results and applied AST-edit metadata. Prose and tool arguments are never read as evidence
      that a file changed.</p>
    <p class="ds-note"><b>Partial data is visible.</b> Truncated fields carry a chip, bounded Todo
      and agent collections expose omitted counts, and malformed or still-scanning records produce
      an attributed notice rather than a silent gap.</p>
    <p class="ds-note"><b>Control plane never becomes prose.</b> Every <code>custom_message</code> is
      a harness envelope - async-result, irc:incoming, mid-run-todo-nudge, skill-prompt,
      todo_hud_state. The projector applies the structured effect and drops the raw content
      regardless of its display flag.</p>
  </section>
"""
page("components/chat-tools.html", "Chat", "Tool calls and receipts", "Chat mode",
     "Tool noise is the default failure of an agent UI. One collapsed row per turn, a receipt that "
     "answers what changed, and detail that only exists while you are looking at it.",
     body, TOOLS_CSS)

COMPOSER_CSS = """
.shell{display:flex;flex-direction:column;width:min(100%,var(--reading-width));margin-inline:auto;padding:10px 0 4px}.stage{padding:22px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.chat-composer{display:flex;align-items:flex-end;gap:5px;min-height:54px;padding:7px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.chat-composer.focused{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));box-shadow:var(--focus-ring)}.chat-composer textarea{flex:1;min-width:0;min-height:38px;padding:8px 7px;resize:none;border:0;border-radius:8px;outline:0;background:transparent;color:var(--text);font:14px/1.6 var(--font-ui)}.chat-composer textarea::placeholder{color:var(--faint)}
.cbtn{display:inline-grid;place-items:center;flex:none;width:40px;min-width:40px;height:40px;padding:0;border:0;border-radius:10px;background:transparent;color:var(--muted)}.cbtn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.cbtn.send{background:var(--accent-2);color:#fff;font-size:17px}.cbtn.send.off{background:var(--panel-2);color:var(--faint)}.cbtn.stop{border:1px solid color-mix(in srgb,var(--danger) 58%,var(--line));color:var(--danger)}
.chat-runtime{display:flex;align-items:center;gap:10px;min-height:24px;padding:5px 5px 0;color:var(--faint);font:11px var(--font-ui)}.runtime-status{display:flex;align-items:center;flex:1;min-width:0;overflow:hidden}.cs-item{flex:none;white-space:nowrap}.cs-item+.cs-item::before{content:"·";margin:0 7px;color:var(--line-strong)}.cs-model,.cs-effort,.cs-spend{color:var(--muted);font-weight:600}.cs-provider,.cs-cwd{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cs-cwd{flex:0 1 180px;max-width:180px}.cs-ctx{display:flex;align-items:center;flex:none;gap:4px;white-space:nowrap}.cs-ctx-bar{position:relative;display:inline-block;width:36px;height:4px;overflow:hidden;border-radius:999px;background:var(--line)}.cs-ctx-fill{position:absolute;inset:0 auto 0 0;border-radius:inherit;background:var(--accent)}.cs-ctx-bar.warn .cs-ctx-fill{background:var(--danger)}
.panels{width:100%;margin:0 auto 8px}.panels-toggle{--p:62%;position:relative;display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:9px;width:100%;min-height:40px;padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--text);text-align:left;overflow:hidden}.panels-toggle::after{content:"";position:absolute;bottom:0;left:0;width:var(--p);height:2px;background:color-mix(in srgb,var(--accent) 70%,transparent)}.workflow-mark{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}.workflow-copy{display:flex;align-items:baseline;gap:8px;min-width:0}.workflow-label{flex:none;color:var(--muted);font-size:11px;font-weight:650}.workflow-summary{min-width:0;overflow:hidden;color:var(--text);font-size:12.5px;text-overflow:ellipsis;white-space:nowrap}.workflow-meta{flex:none;color:var(--faint);font:10.5px var(--font-mono)}.panels-chevron{color:var(--faint)}.panels-content{margin-top:8px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--pop-bg);box-shadow:var(--pop-shadow)}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:9px;color:var(--faint);font:590 10.5px var(--font-ui)}.ct-phase{margin-bottom:10px}.ct-phase-name{margin-bottom:5px;color:var(--muted);font-size:11px;font-weight:590}.ct-phase.active .ct-phase-name{color:var(--accent)}.ct-tasks{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}.ct-task{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:1.4}.ct-glyph{flex:none;width:14px;margin-top:1px;font-size:10px;text-align:center;color:var(--faint)}.ct-task.done .ct-content{color:var(--faint);text-decoration:line-through}.ct-task.in .ct-glyph{color:var(--accent)}.ct-task.blocked .ct-glyph,.ct-blocker{color:var(--danger)}
.cag-row{display:flex;align-items:flex-start;flex-wrap:wrap;gap:6px;margin-bottom:7px;font-size:12px}.cag-dot{flex:none;width:7px;height:7px;margin-top:4px;border-radius:50%;background:var(--muted)}.cag-row.running .cag-dot{background:var(--ok);animation:cpulse 1.4s ease-in-out infinite}.cag-name{color:var(--text);font-weight:600}.cag-type{color:var(--muted);font:10px var(--font-mono)}.cag-preview{width:100%;padding-left:13px;overflow:hidden;color:var(--muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.advisor{margin-bottom:8px;padding:10px 12px;border:1px solid var(--line);border-left:3px solid var(--line-strong);border-radius:10px;background:var(--panel)}.advisor.concern{border-left-color:var(--warn);background:color-mix(in srgb,var(--warn) 5%,var(--panel))}.advisor-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;color:var(--muted);font-size:11px}.advisor-badge{flex:none;padding:1px 6px;border-radius:999px;color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,var(--row-hover));font-weight:620;text-transform:uppercase}.advisor-guidance{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.advisor-body{color:var(--text);font-size:12.5px;line-height:1.5;white-space:pre-wrap}
.advisor.nit{border-left-color:var(--accent);background:color-mix(in srgb,var(--accent) 5%,var(--panel))}.advisor.blocker{border-left-color:var(--danger);background:color-mix(in srgb,var(--danger) 5%,var(--panel))}.advisor.nit .advisor-badge{color:var(--accent);background:color-mix(in srgb,var(--accent) 15%,var(--row-hover))}.advisor.blocker .advisor-badge{color:var(--danger);background:color-mix(in srgb,var(--danger) 15%,var(--row-hover))}
.ask{padding:11px 12px;margin-bottom:8px;border:1px solid color-mix(in srgb,var(--warn) 45%,var(--line));border-left:3px solid var(--warn);border-radius:9px;background:color-mix(in srgb,var(--warn) 6%,var(--panel))}.cask-header{display:flex;align-items:center;gap:8px;margin-bottom:7px}.cask-label{color:var(--warn);font:650 11px var(--font-ui)}.cask-q{margin:0 0 8px;font-size:13px;line-height:1.5}.cask-opts{display:flex;flex-direction:column;gap:5px;margin-bottom:9px}.cask-opt{padding:7px 10px;border:1px solid var(--line);border-radius:7px;background:var(--panel-2);font-size:12px;color:var(--muted)}.cask-opt b{color:var(--text);font-weight:600}.cask-switch{min-height:34px;padding:7px 12px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--text);font:650 11.5px var(--font-ui)}
@keyframes cpulse{0%,100%{opacity:1}50%{opacity:.4}}@media(max-width:600px){.stage{padding:12px}.chat-composer{min-height:58px;padding:6px;gap:4px}.chat-composer textarea{min-height:44px;font-size:16px}.cbtn{width:44px;min-width:44px;height:44px}.panels-toggle{min-height:44px}.cs-provider,.cs-cwd,.cs-effort{display:none}.chat-runtime{gap:6px}}
"""

ICON_CLIP = '<svg viewBox="0 0 24 24"><path d="m20.3 11.7-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.5 3.5 0 1 1 5 5l-8.5 8.5a2 2 0 0 1-2.8-2.8l7.8-7.8"/></svg>'
ICON_MIC = '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/></svg>'
ICON_STOP = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>'

body = f"""
  <section class="ds-block on-bg">
    <span class="ds-label">Idle — workflow strip, composer, runtime rail</span>
    <div class="stage"><div class="shell"><div class="panels"><button class="panels-toggle" aria-label="Composer; wire the mirror measure; 8 of 13"><span class="workflow-mark"></span><span class="workflow-copy"><span class="workflow-label">Composer</span><span class="workflow-summary">Wire the mirror measure</span></span><span class="workflow-meta">8/13 · 2 agents</span><span class="panels-chevron">›</span></button></div><div class="chat-composer"><button class="cbtn" aria-label="Attach">{ICON_CLIP}</button><textarea rows="1" aria-label="Message agent" placeholder="Send a message&hellip;"></textarea><button class="cbtn" aria-label="Dictate">{ICON_MIC}</button><button class="cbtn send off" aria-label="Send" disabled>&uarr;</button></div><div class="chat-runtime"><footer class="runtime-status"><span class="cs-item cs-model">opus-5[1m]</span><span class="cs-item cs-provider">claude</span><span class="cs-item cs-effort">high</span><span class="cs-item cs-cwd">~/workspace/omp-web</span><span class="cs-item cs-spend">$0.84</span></footer><span class="cs-ctx"><span class="cs-ctx-bar"><span class="cs-ctx-fill" style="width:38%"></span></span><span>38%</span></span></div></div></div>
    <p class="ds-note">The rail stays quiet but reports the useful model, provider, effort, folder, spend and context. At 390px provider, folder and effort drop before changing spend and context.</p>
  </section>
  <section class="ds-block on-bg">
    <span class="ds-label">Advisor — contextual guidance above the composer</span>
    <div class="stage"><div class="shell"><div class="advisor concern" role="note"><div class="advisor-head"><span class="advisor-badge">concern</span><span class="advisor-guidance">weigh, don&rsquo;t blindly obey</span></div><div class="advisor-body">The migration changes a shared contract. Confirm the consumer path before deleting the old field.</div></div><div class="chat-composer focused"><button class="cbtn" aria-label="Attach">{ICON_CLIP}</button><textarea rows="1" aria-label="Message agent">Trace the consumer and report the exact call site.</textarea><button class="cbtn stop" aria-label="Stop active work">{ICON_STOP}</button><button class="cbtn send" aria-label="Send">&uarr;</button></div></div></div>
    <div class="stage"><div class="shell"><div class="advisor nit" role="note"><div class="advisor-head"><span class="advisor-badge">nit</span><span class="advisor-guidance">optional refinement</span></div><div class="advisor-body">The copy works; trim the duplicated qualifier if it costs the row a second line.</div></div><div class="advisor blocker" role="note"><div class="advisor-head"><span class="advisor-badge">blocker</span><span class="advisor-guidance">needs resolution before proceeding</span></div><div class="advisor-body">The migration removes a required field. Resolve the consumer contract first.</div></div></div></div>
    <p class="ds-note">One derived note: nit, concern or blocker changes the left rail and restrained tint. It never becomes a persistent dashboard or a second transcript.</p>
  </section>
  <section class="ds-block on-bg">
    <span class="ds-label">Workflow expanded — optional detail, never a permanent column</span>
    <div class="stage"><div class="shell"><div class="panels"><button class="panels-toggle"><span class="workflow-mark"></span><span class="workflow-copy"><span class="workflow-label">Composer</span><span class="workflow-summary">Wire the mirror measure</span></span><span class="workflow-meta">8/13 · 2 agents</span><span class="panels-chevron">⌄</span></button><div class="panels-content"><div class="panel-head"><span>Todo</span><span>8 of 13 · 1 omitted phase</span></div><div class="ct-phase"><div class="ct-phase-name">Backend</div><ul class="ct-tasks"><li class="ct-task done"><span class="ct-glyph">&check;</span><span class="ct-content">Bounded incremental reader</span></li></ul></div><div class="ct-phase active"><div class="ct-phase-name">Composer</div><ul class="ct-tasks"><li class="ct-task in"><span class="ct-glyph">&#9679;</span><span class="ct-content">Wire the mirror measure</span></li><li class="ct-task blocked"><span class="ct-glyph">&#9650;</span><span class="ct-content">Physical iOS pass <span class="ct-blocker">&mdash; needs hardware</span></span></li></ul></div><div class="panel-head" style="margin-top:12px"><span>Active agents</span><span>2</span></div><div class="cag-row running"><span class="cag-dot"></span><span class="cag-name">chat-verify</span><span class="cag-type">general-purpose</span><span class="cag-preview">Replay the 500-entry window and report the tail gap</span></div></div></div></div></div>
  </section>
  <section class="ds-block on-bg">
    <span class="ds-label">Pending ask — read-only by design</span>
    <div class="stage"><div class="shell"><div class="ask"><div class="cask-header"><span class="dot" style="background:var(--warn)"></span><span class="cask-label">Needs you</span></div><p class="cask-q">Which profile should the reload target?</p><div class="cask-opts"><div class="cask-opt"><b>claude</b> — opus-5[1m], keeps the transcript</div><div class="cask-opt"><b>openai</b> — gpt-5-codex, recommended</div></div><button class="cask-switch">Answer in Terminal &rarr;</button></div></div></div>
    <p class="ds-note">Chat renders the question and every option, then hands the answer to Terminal. A mis-selected answer is worse than a mode switch.</p>
  </section>
"""
page("components/chat-composer.html", "Chat", "Composer, runtime and workflow", "Chat mode",
     "The input is the mission-control surface: what is running, what it is working on, what it is costing, and the one control that stops it.",
     body, COMPOSER_CSS)

MODAL_CSS = """
.wrap{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}
.dim{padding:28px;border:1px solid var(--line);border-radius:10px;
  background:linear-gradient(0deg,rgba(0,0,0,.56),rgba(0,0,0,.56)),var(--bg)}
.modal-card{width:400px;max-width:100%;padding:22px;border:1px solid var(--line);border-radius:12px;
  background:var(--panel);box-shadow:var(--pop-shadow)}
.modal-card h2{margin:0 0 16px;font-size:19px;font-weight:650;letter-spacing:-.025em}
.modal-card label{display:block;margin-bottom:13px;color:var(--muted);font-size:12px;font-weight:580}
.modal-card input,.modal-card select{display:block;width:100%;min-height:44px;margin-top:6px;
  padding:9px 11px;border:1px solid var(--line);border-radius:8px;outline:0;background:var(--bg);
  color:var(--text);font:inherit}
.modal-card select{appearance:none}
.modal-card input.focused{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));
  box-shadow:var(--focus-ring)}
.hint{color:var(--faint);font-weight:400}
.profile-summary{min-height:18px;margin:-7px 0 13px;color:var(--faint);
  font:10px/18px var(--font-mono)}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.modal-actions button{min-height:44px}
.settings-card{width:520px}.set-group{margin-bottom:20px}.set-group:last-of-type{margin-bottom:14px}
.set-group h3{margin:0 0 10px;color:var(--faint);font-size:11px;font-weight:590}.set-row{display:flex;align-items:center;gap:14px}.set-copy{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0}.set-copy strong{font-size:13px;font-weight:620}.set-copy span{color:var(--muted);font-size:11.5px;line-height:1.5}.set-icon{display:inline-grid;place-items:center;flex:none;width:38px;height:38px;padding:0;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--muted)}.set-icon:hover{border-color:var(--line-strong);color:var(--text)}.set-icon svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round}
.set-profiles{display:flex;flex-direction:column;gap:8px}.set-profile{padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg)}.set-profile-name{margin-bottom:7px;font:620 12.5px var(--font-mono)}.set-roles{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 14px;margin:0}.set-roles dt{color:var(--faint);font:11px var(--font-ui)}.set-roles dd{min-width:0;margin:0;overflow:hidden;color:var(--muted);font:11px var(--font-mono);text-overflow:ellipsis;white-space:nowrap}.set-note{margin:9px 0 0;color:var(--faint);font-size:11.5px;line-height:1.55}.set-note code{font:10.5px var(--font-mono);color:var(--muted)}
.fv{display:flex;flex-direction:column;width:min(560px,100%);height:330px;padding:0;overflow:hidden;
  border:1px solid var(--line);border-radius:12px;background:var(--panel);box-shadow:var(--pop-shadow)}
.fv-head{display:flex;align-items:center;gap:12px;flex:none;padding:15px 16px;
  border-bottom:1px solid var(--line);background:var(--panel-2)}
.fv-head h2{flex:1;min-width:0;margin:0;overflow:hidden;font:620 14px/1.35 var(--font-mono);
  text-overflow:ellipsis;white-space:nowrap}
.fv-actions{display:flex;gap:7px}
.fv-actions button{display:inline-flex;align-items:center;min-height:36px;padding:6px 9px;
  border:0;border-radius:6px;background:transparent;color:var(--text);font-size:12px}
.fv-actions button:hover{background:var(--row-hover)}
.fv-body{display:grid;flex:1;min-height:0;place-items:center;padding:18px;background:var(--bg)}
.fv-text{width:min(100%,420px);margin:0;padding:16px;border:1px solid var(--line);border-radius:9px;
  background:var(--panel);color:var(--text);font:12px/1.6 var(--font-mono);white-space:pre-wrap}
"""

body = """
  <section class="ds-block on-bg">
    <span class="ds-label">Dialogs - one card grammar, one backdrop, one action alignment</span>
    <div class="wrap">
      <div class="dim"><div class="modal-card">
        <h2>New session</h2>
        <label>Folder <span class="hint">&middot; last used</span>
          <input value="~/workspace/omp-web" class="focused"></label>
        <label>Profile
          <select><option>claude &mdash; anthropic &middot; opus-5[1m]</option></select></label>
        <div class="profile-summary">anthropic &middot; claude-opus-5[1m] &middot; 3 roles</div>
        <label>Title <span class="hint">&middot; optional</span><input placeholder="Derived from the folder"></label>
        <div class="modal-actions"><button class="ghost">Cancel</button>
          <button class="primary">Create session</button></div>
      </div></div>

      <div class="dim"><div class="modal-card">
        <h2>Reload under another profile</h2>
        <label>Profile<select><option>openai &mdash; gpt-5-codex</option></select></label>
        <div class="profile-summary">openai &middot; gpt-5-codex &middot; transcript is retained</div>
        <label>Model <span class="hint">&middot; overrides the profile default</span>
          <input placeholder="gpt-5-codex"></label>
        <p class="ds-note" style="margin:0 0 14px">The running turn is force-killed. History is
          replayed from the transcript under the new profile.</p>
        <div class="modal-actions"><button class="ghost">Cancel</button>
          <button class="primary">Reload</button></div>
      </div></div>

      <div class="dim"><div class="modal-card settings-card" role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        <section class="set-group"><h3>Appearance</h3><div class="set-row"><span class="set-copy"><strong>Theme</strong><span>Dark or light. The terminal stays dark in both.</span></span><button class="set-icon" aria-label="Switch theme"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M6.4 6.4 4.8 4.8M19.2 19.2l-1.6-1.6M17.6 6.4l1.6-1.6M4.8 19.2l1.6-1.6"/></svg></button></div></section>
        <section class="set-group"><h3>Notifications</h3><div class="set-row"><span class="set-copy"><strong>Waiting alerts</strong><span>Only when a session starts waiting while this tab is hidden.</span></span><button class="set-icon" aria-label="Toggle waiting alerts"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></button></div></section>
        <section class="set-group"><h3>Profiles</h3><div class="set-profiles"><article class="set-profile"><div class="set-profile-name">claude</div><dl class="set-roles"><dt>default</dt><dd>claude-opus-5[1m]</dd><dt>subagent</dt><dd>claude-sonnet-5</dd><dt>compaction</dt><dd>auto</dd></dl></article></div><p class="set-note">Read-only. Profiles live in <code>~/.omp/profiles/&lt;name&gt;/agent/config.yml</code>; native OMP owns them.</p></section>
        <div class="modal-actions"><button class="primary">Close</button></div>
      </div></div>
    </div>
    <p class="ds-note">12px card, 8px inputs, 44px targets everywhere, backdrop 56% dim + 6px blur,
      primary always right-aligned, <code>Esc</code> and <code>Enter</code> wired identically in
      every dialog. Inputs are filled fields on <code>--bg</code>, not outlined boxes. On phones the
      card docks to the bottom edge at 16px top corners.</p>
  </section>

  <section class="ds-block on-bg">
    <span class="ds-label">File viewer - session files keep their native form inside an authenticated dialog</span>
    <div class="dim"><div class="fv">
      <header class="fv-head"><h2>docs/plans/chat-mode.md</h2>
        <div class="fv-actions"><button>Raw</button><button>Download</button><button>Close</button></div>
      </header>
      <div class="fv-body"><pre class="fv-text"># Chat mode plan

## Goal

Add a structured chat mode beside the
existing tmux terminal mode&hellip;</pre></div>
    </div></div>
    <p class="ds-note">Text, Markdown, images and PDFs each render natively; anything else falls
      back to a download card. File links in the transcript are underlined with a 62% accent
      underline rather than colored - they are references, not actions.</p>
  </section>
"""
page("components/modals.html", "Surfaces", "Dialogs and file viewer", "Modal grammar",
     "Four dialogs share one card, one backdrop and one keyboard contract. They answer what do you "
     "want and what is sane in the same breath.",
     body, MODAL_CSS)

ATT_CSS = """
.north{padding:20px;border:1px solid color-mix(in srgb,var(--accent) 34%,var(--line));
  border-left:3px solid var(--accent);border-radius:10px;
  background:color-mix(in srgb,var(--accent) 6%,var(--panel))}
.north p{margin:0;font-size:15px;line-height:1.7}
.north b{font-weight:650}
.three{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.q{padding:14px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2)}
.q h3{margin:0 0 6px;font-size:13px;font-weight:620}
.q p{margin:0;color:var(--muted);font-size:11.5px;line-height:1.55}
.q span{display:inline-block;margin-bottom:8px;color:var(--faint);font:10.5px var(--font-mono)}
.chan{display:grid;grid-template-columns:150px 1fr;gap:10px 16px;align-items:start;font-size:12px}
.chan dt{color:var(--text);font-weight:600}
.chan dd{margin:0;color:var(--muted);line-height:1.55}
.demo{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.tabtitle{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid var(--line);
  border-radius:8px;background:var(--panel-2);font:12px var(--font-ui)}
.tabtitle b{color:var(--accent)}
.toast{display:flex;gap:10px;width:min(320px,100%);padding:11px 13px;border:1px solid var(--line);
  border-radius:10px;background:var(--pop-bg);box-shadow:var(--pop-shadow)}
.toast .dot{margin-top:5px;background:var(--warn)}
.toast div{min-width:0}
.toast strong{display:block;font-size:12.5px;font-weight:620;margin-bottom:2px}
.toast span{color:var(--muted);font-size:11.5px;line-height:1.45}
.pillrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.needs-you{padding:1px 6px;border-radius:999px;
  background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn);
  font-size:9.5px;font-weight:700}
.unread{color:var(--accent);font-size:9px}
"""

body = """
  <section class="north">
    <p>I sit down and answer three questions in three seconds:<br>
      <b>What needs me? What's churning? What did I miss?</b><br>
      Everything else is reach-on-demand.</p>
  </section>

  <section class="ds-block">
    <span class="ds-label">How each question is answered</span>
    <div class="three">
      <div class="q"><span>WHAT NEEDS ME</span><h3>Needs you section</h3>
        <p>Any waiting session is hoisted above Pinned in both views and carries an amber text pill.
          In chat, the pending ask renders as an action card at the live tail.</p></div>
      <div class="q"><span>WHAT'S CHURNING</span><h3>Working, pulsing green</h3>
        <p>Rank 3 in the priority order, and the reason chat polls at 350ms instead of 1.2s. Idle
          and unknown rows recede so churn is the only movement on screen.</p></div>
      <div class="q"><span>WHAT DID I MISS</span><h3>Unread from the cursor</h3>
        <p>A per-session last-viewed byte cursor in sessionStorage. Rows whose transcript advanced
          since the last view get a &#9679; chip, cleared on selection.</p></div>
    </div>
  </section>

  <section class="ds-block">
    <span class="ds-label">Four channels, escalating - never two for the same event</span>
    <dl class="chan">
      <dt>Row state</dt><dd>Always on. Dot, weight, and for waiting only, a text pill.</dd>
      <dt>Unread chip</dt><dd>Derived from the byte cursor, not a sidecar file. Clears on selection.</dd>
      <dt>Tab title</dt><dd><code class="ds-mono">(3) omp-web</code> when anything is waiting or has arrivals. Free, zero deps.</dd>
      <dt>Notification</dt><dd>Behind the header bell toggle. Fires only on transitions into waiting
        or error, and only while the tab is hidden.</dd>
    </dl>
    <div class="demo" style="margin-top:6px">
      <span class="tabtitle"><b>(3)</b> omp-web</span>
      <span class="pillrow">Migrate queue worker <span class="needs-you">NEEDS YOU</span></span>
      <span class="pillrow">Omp Web Main <span class="unread">&#9679;</span></span>
      <div class="toast"><span class="dot"></span><div>
        <strong>Migrate queue worker</strong>
        <span>Waiting on an approval &middot; ~/workspace/job-runner</span></div></div>
    </div>
  </section>

  <section class="ds-block">
    <span class="ds-label">Constraints this pattern respects</span>
    <p class="ds-note">No sidebar sidecar state file. Unread memory is sessionStorage; pin state is
      the tmux option <code>@omp_pinned</code> and dies with the session by design; the transcript
      path is <code>@omp_transcript</code>. tmux stays the only source of truth.</p>
    <p class="ds-note">Views emit intent events and <code>main.js</code> owns the actions - and every
      emitted event gets its subscriber in the same commit. <code>sidebar:rerender</code> once
      shipped with no listener, so view switches and pins silently waited for the 4s poll. That is
      the failure mode this repo checks for by reflex.</p>
  </section>
"""
page("patterns/attention.html", "Patterns", "Attention system", "North star",
     "Mission control for many parallel agents. The design exists to make one scan answer three "
     "questions without opening anything.",
     body, ATT_CSS)

MOB_CSS = """
.row{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}
.phone{width:320px;border:1px solid var(--line-strong);border-radius:22px;overflow:hidden;
  background:var(--bg);box-shadow:var(--pop-shadow)}
.ph-head{display:flex;align-items:center;gap:8px;min-height:52px;padding:8px 12px;
  border-bottom:1px solid var(--line);background:var(--panel)}
.ph-head .t{overflow:hidden;font-size:13.5px;font-weight:550;text-overflow:ellipsis;white-space:nowrap}
.ico{display:inline-grid;place-items:center;width:40px;height:40px;border:0;border-radius:8px;
  background:transparent;color:var(--text);font-size:15px}
.ph-body{display:flex;flex-direction:column;gap:14px;padding:14px 12px;min-height:250px}
.bubble{align-self:flex-end;max-width:85%;padding:8px 12px;border:1px solid var(--line);
  border-radius:12px;background:var(--bubble-user);font-size:14px;line-height:1.6}
.prose{font-size:14.5px;line-height:1.7}
.sheet{margin-top:auto;padding:14px 13px;border-top:1px solid var(--line);
  border-radius:16px 16px 0 0;background:var(--panel);box-shadow:0 -8px 24px rgba(0,0,0,.36)}
.sheet .lbl{color:var(--warn);font:650 11px var(--font-ui)}
.sheet h3{margin:6px 0 4px;font-size:14px;font-weight:620}
.sheet p{margin:0 0 11px;color:var(--muted);font-size:12px;line-height:1.5}
.sheet .primary{width:100%;min-height:44px}
.compose{display:flex;align-items:flex-end;gap:5px;margin:0 12px 12px;padding:7px;
  border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.compose textarea{flex:1;min-height:38px;border:0;outline:0;background:transparent;resize:none;
  color:var(--text);font:16px/1.5 var(--font-ui)}
.compose textarea::placeholder{color:var(--faint)}
.cb{display:inline-grid;place-items:center;width:40px;height:40px;border:0;border-radius:10px;
  background:var(--panel-2);color:var(--faint);font-size:16px}
.cb.on{background:var(--accent-2);color:#fff}
.drawer{width:290px;border:1px solid var(--line);border-radius:12px;background:var(--panel);
  overflow:hidden;box-shadow:24px 0 60px rgba(0,0,0,.56)}
.d-row{display:flex;align-items:center;gap:7px;min-height:44px;padding:7px 10px;font-size:14px}
.d-row .dot{width:8px;height:8px}
.d-row .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.d-row .m{width:40px;text-align:center;color:var(--faint)}
.d-row.active{background:color-mix(in srgb,var(--accent) 8%,transparent);position:relative}
.d-row.active::before{content:"";position:absolute;left:0;top:5px;bottom:5px;width:2px;
  border-radius:999px;background:var(--accent)}
.d-sub{padding-left:14px;color:var(--faint);font-size:11.5px}
.needs-you{padding:2px 7px;border-radius:999px;
  background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn);
  font-size:10.5px;font-weight:700}
.d-head{padding:10px 12px 6px;color:var(--warn);font:590 11px var(--font-ui)}
.status-waiting{background:var(--warn)} .status-working{background:var(--ok)}
.status-idle{background:var(--muted);opacity:.55}
"""

body = """
  <section class="ds-block on-bg">
    <span class="ds-label">390px - triage from the couch, not a shrunken desktop</span>
    <div class="row">
      <div class="phone">
        <header class="ph-head"><button class="ico">&#9776;</button>
          <span class="t">Migrate queue worker</span>
          <span style="flex:1"></span><button class="ico">&#9002;_</button></header>
        <div class="ph-body">
          <div class="bubble">Ship the dedupe fix and re-run the audit workflow.</div>
          <div class="prose">Dedupe is in. The audit needs an approval before it can touch
            the scheduler.</div>
          <div class="sheet"><span class="lbl">Needs you</span>
            <h3>Approve the audit workflow run?</h3>
            <p>It will trigger 1 workflow on the staging host and write to the jobs table.</p>
            <button class="primary">Answer in Terminal</button></div>
        </div>
        <div class="compose"><button class="cb">&#128206;</button>
          <textarea rows="1" placeholder="Send a message&hellip;"></textarea>
          <button class="cb">&#127908;</button><button class="cb on">&uarr;</button></div>
      </div>

      <div class="drawer">
        <div class="d-head">Needs you</div>
        <div class="d-row active"><span class="dot status-waiting"></span>
          <span class="t">Migrate queue worker</span><span class="needs-you">NEEDS YOU</span>
          <span class="m">&#8943;</span></div>
        <div class="d-sub" style="padding:0 10px 8px 24px">job-runner &middot; openai &middot; now</div>
        <div class="d-row"><span class="dot status-working"></span>
          <span class="t">Omp Web Main</span><span class="m">&#8943;</span></div>
        <div class="d-sub" style="padding:0 10px 8px 24px">omp-web &middot; claude &middot; 1m ago</div>
        <div class="d-row"><span class="dot status-idle"></span>
          <span class="t" style="color:var(--muted)">Restore origin history</span>
          <span class="m">&#8943;</span></div>
        <div class="d-sub" style="padding:0 10px 8px 24px">omp-web &middot; mix &middot; 2h ago</div>
      </div>
    </div>
  </section>

  <section class="ds-block">
    <span class="ds-label">Compact rules</span>
    <p class="ds-note"><b>44px targets everywhere</b> - rows, row menus, view tabs, folder toggles,
      dialog buttons. Row menus are always visible; there is no hover to reveal them.</p>
    <p class="ds-note"><b>16px inputs</b>, always - anything smaller makes iOS Safari zoom the page
      on focus.</p>
    <p class="ds-note"><b>Row 2 carries identity.</b> Desktop can lean on a hover tooltip to
      separate two rows both reading <i>Restore origin&hellip;</i>; touch cannot, so folder, profile
      and relative time are printed.</p>
    <p class="ds-note"><b>Safe areas are honoured</b> by the drawer, dialogs and the fixed update
      pill; dialogs dock to the bottom edge with 16px top corners. The terminal scrubber is
      <code>display:none</code> on compact - it is a pointer affordance.</p>
    <p class="ds-note"><b>Touch never focuses a textarea implicitly.</b> Tapping chat or terminal
      content leaves <code>BODY</code> active and the xterm helper stays
      <code>inputmode=none</code>, so the keyboard only appears when the composer is tapped.</p>
    <p class="ds-note" style="color:var(--warn)">Open: physical iOS keyboard, selection and touch
      behaviour is still unverified. 390px desktop emulation is not equivalent evidence.</p>
  </section>
"""
page("patterns/mobile.html", "Patterns", "Compact and mobile", "390px",
     "The phone's job is triage: see what needs you, answer or defer it, and get back out.",
     body, MOB_CSS)

ARCH_CSS = """
.flow{display:flex;align-items:stretch;gap:12px;flex-wrap:wrap}
.node{flex:1;min-width:170px;padding:14px;border:1px solid var(--line);border-radius:9px;
  background:var(--panel-2)}
.node h3{margin:0 0 5px;font-size:12.5px;font-weight:620}
.node p{margin:0;color:var(--muted);font-size:11.5px;line-height:1.5}
.node.writer{border-color:color-mix(in srgb,var(--ok) 40%,var(--line));
  background:color-mix(in srgb,var(--ok) 7%,var(--panel-2))}
.node.read{border-color:color-mix(in srgb,var(--accent) 34%,var(--line));
  background:color-mix(in srgb,var(--accent) 6%,var(--panel-2))}
.arrow{display:grid;place-items:center;color:var(--faint);font-size:16px;min-width:20px}
.nono{display:grid;gap:8px}
.nono div{display:flex;gap:9px;align-items:baseline;padding:9px 11px;border:1px solid var(--line);
  border-left:3px solid var(--danger);border-radius:7px;font-size:12px;line-height:1.5}
.nono b{flex:none;color:var(--danger);font:650 10.5px var(--font-ui);min-width:74px}
.inv{display:grid;gap:8px}
.inv div{display:flex;gap:9px;align-items:baseline;padding:9px 11px;border:1px solid var(--line);
  border-left:3px solid var(--ok);border-radius:7px;font-size:12px;line-height:1.5}
.inv b{flex:none;color:var(--ok);font:650 10.5px var(--font-ui);min-width:74px}
"""

body = """
  <section class="ds-block">
    <span class="ds-label">One writer, two views</span>
    <div class="flow">
      <div class="node read"><h3>Chat mode</h3><p>Read projection. Polls
        <code class="ds-mono">GET /chat?from=byte</code> and upserts items by id.</p></div>
      <div class="arrow">&rarr;</div>
      <div class="node"><h3>Session JSONL</h3><p>Append-only at runtime, newline-atomic, no fsync.
        A rewrite is a reset.</p></div>
      <div class="arrow">&larr;</div>
      <div class="node writer"><h3>tmux &rarr; omp TUI</h3><p>The single writer and the source of
        truth. Terminal mode is a PTY bridge onto the same pane.</p></div>
    </div>
    <p class="ds-note">Chat input is injected into the same tmux session the terminal already drives
      - <code>load-buffer</code> + bracketed <code>paste-buffer</code> + <code>Enter</code>. One
      input path, nothing to hand off, no ownership lease, no second process, no 409. Both modes are
      views over one session and can be switched at any time, including mid-turn.</p>
  </section>

  <section class="ds-block">
    <span class="ds-label">Why the design looks the way it does</span>
    <div class="inv">
      <div><b>Message-level</b><span>Entries are written complete, with
        <code class="ds-mono">completedAt</code> and <code class="ds-mono">stopReason</code>. So
        there is no token streaming to design for - the live signal is the tool-intent line, not a
        typing cursor.</span></div>
      <div><b>Append order</b><span>0 forward references across 6,546 measured entries. The renderer
        reads in file order: no DAG traversal, no active-leaf selection, no branch or rewind UI.</span></div>
      <div><b>Bounded by default</b><span>240 mounted entries, truncated payloads, bounded Todo and
        agent collections - every bound has a visible label or omitted count rather than a silent
        gap.</span></div>
      <div><b>Read is cheap, write is guarded</b><span>History outlives the runtime: transcript
        reads work on an exited session, while text and key writes keep the atomic tmux guard so an
        exited runtime can never turn a chat prompt into a shell command.</span></div>
    </div>
  </section>

  <section class="ds-block">
    <span class="ds-label">Non-goals - do not design these</span>
    <div class="nono">
      <div><b>No framework</b><span>Native ES modules, no bundler, no build step. A component that
        needs a compiler cannot ship here.</span></div>
      <div><b>No second writer</b><span>An RPC child process was tried and retired: upstream has no
        read-only subscribe for an existing session, so a second process is always a second
        writer.</span></div>
      <div><b>No ANSI parsing</b><span>State comes from the JSONL. Never from scraping what the TUI
        painted.</span></div>
      <div><b>No theming engine</b><span>A light theme, if it ships, is one
        <code class="ds-mono">:root[data-theme="light"]</code> block. Nothing else.</span></div>
      <div><b>No sidecar state</b><span>tmux options and sessionStorage only. No sidebar state file.</span></div>
      <div><b>Terminal stays pure</b><span>xterm passthrough with zero visual interference. All
        chrome lives outside <code class="ds-mono">#term-wrap</code>.</span></div>
    </div>
  </section>

  <section class="ds-block">
    <span class="ds-label">Working rules for anyone changing this UI</span>
    <p class="ds-note">Element ids are API - <code>initDom()</code> registers them and none get
      renamed. Views emit events; <code>main.js</code> owns actions, and every new event gets its
      subscriber in the same commit. Every shipped frontend change bumps its
      <code>?v=</code> cache-bust, and every phase is browser-verified at 1280 / 1024 / 390 before
      it is committed.</p>
  </section>
"""
page("patterns/architecture.html", "Patterns", "Constraints behind the design", "Non-negotiables",
     "The interface is shaped by one architectural fact: tmux owns the session, and everything the "
     "web app shows is a projection of what that session wrote down.",
     body, ARCH_CSS)

# ---------------------------------------------------------------- readme
README = """# omp web - design system

Mission control for many parallel OMP agent sessions, running on a Mac at
`127.0.0.1:7799` and over a VPN. Two views over one tmux-owned session:
**Terminal** (full-fidelity xterm passthrough) and **Chat** (a structured read
projection of the session's own JSONL).

Source of truth: the repo at `~/workspace/omp-web`. These pages mirror the real
`public/*.css` - they are not a parallel invention.

## Design language: quiet console

Dense, calm, typographic. This is an operator console, not a chat app.
Information density is a feature; chrome is not. Every surface shares one
header grammar, one dot grammar, one keyboard grammar.

- **Foundations / Color and surface tokens** - the token contract from `base.css`.
- **Foundations / Typography** - the shipped Inter Variable scale, JetBrains Mono values, and 760px measure.
- **Foundations / Status and attention grammar** - seven states, one priority order.

## Surfaces

- **Navigation / Sidebar** - 288px, text-first rows, Needs you before Pinned.
- **Shell / Header and terminal** - 56px header, destination-labelled mode toggle.
- **Chat / Transcript** - message silhouettes, send states, boundaries, empty state.
- **Chat / Tool calls and receipts** - one collapsed row per turn, lazy detail.
- **Chat / Composer, runtime and workflow** - the mission-control input.
- **Surfaces / Dialogs and file viewer** - one card, one backdrop, one contract.

## Patterns

- **Patterns / Attention system** - the north star and its four escalating channels.
- **Patterns / Compact and mobile** - 390px triage, 44px targets, 16px inputs.
- **Patterns / Constraints behind the design** - what the architecture forbids.

## Hard constraints

No build step, no framework, no bundler - native ES modules, static-served.
`state.js` is the only shared mutable store. Views emit events, `main.js` owns
actions, and every event ships with its subscriber. Element ids are API. tmux
options and sessionStorage are the only state stores. Dark and light share one
token contract; the terminal stays dark in both themes.

## Working on this

These pages are generated. `build.py` holds the shared token block, the preview
chrome, and one `page()` call per card - edit it, then run `python3 build.py`
from this directory to rewrite every HTML file in place. Editing the HTML
directly works for a quick look but is overwritten on the next build.

Each file's first line is a `<!-- @dsCard group="..." -->` marker. The published
copy lives in the claude.ai design-system project **omp web**
(`633d0cdc-cb30-48a3-9926-5e0a5feed8e1`); pushing a change means uploading the
same relative paths to that project.

## Status

Phases 0-6 of the 2026-09 UX refresh are shipped and live. Remaining by choice:
mobile approval bottom sheet and edge-swipe drawer.
Physical iOS verification is still open.
"""
(OUT / "README.md").write_text(README, encoding="utf-8")
print("built:")
for p in sorted(OUT.rglob("*")):
    if p.is_file():
        print(" ", p.relative_to(OUT), p.stat().st_size)

# ---------------------------------------------------------------- audit

AUDIT_CSS = """
.f{display:grid;grid-template-columns:auto 1fr;gap:0 14px;padding:14px 0;
  border-bottom:1px solid var(--line)}
.f:last-child{border-bottom:0}
.sev{grid-row:span 2;align-self:start;min-width:62px;padding:3px 8px;border-radius:999px;
  font:700 9.5px var(--font-ui);text-align:center;letter-spacing:.03em}
.sev.crit{background:color-mix(in srgb,var(--danger) 18%,transparent);color:var(--danger)}
.sev.high{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.sev.med{background:var(--row-hover);color:var(--muted)}
.f h3{margin:0 0 5px;font-size:13.5px;font-weight:620;line-height:1.35}
.f p{margin:0 0 6px;color:var(--muted);font-size:12.5px;line-height:1.6;max-width:74ch}
.f p:last-child{margin-bottom:0}
.f .ev{color:var(--faint);font-size:11.5px}
.f .ev b{color:var(--muted);font-weight:600}
.f code{font-family:var(--font-mono);font-size:11px;color:var(--text)}
.verdict{padding:18px;border:1px solid color-mix(in srgb,var(--danger) 34%,var(--line));
  border-left:3px solid var(--danger);border-radius:10px;
  background:color-mix(in srgb,var(--danger) 6%,var(--panel))}
.verdict p{margin:0 0 9px;font-size:14px;line-height:1.65}
.verdict p:last-child{margin-bottom:0}
.verdict b{font-weight:650}
.meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--faint);font:11px var(--font-mono)}
"""

def finding(sev, sevlabel, title, body, evidence):
    return f"""<div class="f"><span class="sev {sev}">{sevlabel}</span>
    <div><h3>{title}</h3>{body}<p class="ev"><b>Evidence:</b> {evidence}</p></div></div>"""

findings_a = "\n".join([
  finding("crit","CRITICAL","Chat mode loses information the terminal preserves",
    "<p>The same assistant message was captured in both modes. Terminal keeps nested list "
    "indentation, colour-coded headings, and unboxed inline code. Chat flattens the nesting, "
    "renders headings as bold body text, and boxes every code span. The structured view is "
    "currently <i>less</i> readable than the raw TUI it projects.</p>",
    "Live <b>Omp Web Main</b> at 1280&times;900, chat vs terminal, identical message."),
  finding("crit","CRITICAL","Nested Markdown lists render flat",
    "<p>A parent bullet with six sub-items - macOS, Node 22, tmux, OMP capabilities, "
    "<code>~/workspace</code>, packaged <code>node-pty</code> - renders all seven at the same "
    "indent level, so the sub-items read as peers of their parent. This is a renderer defect, "
    "not a styling preference: the meaning changes.</p>",
    "Chat, <b>Verified</b> section. Terminal renders the same list correctly nested."),
  finding("crit","CRITICAL","The transcript has no turn structure",
    "<p>At rest there is no user/assistant silhouette, no turn boundary, no timestamp and no "
    "anchor of any kind - just continuous prose from the top of the viewport to the composer. "
    "Nothing answers <i>where did this turn start</i> or <i>what did I ask</i>. Scrolling back "
    "through a long session means reading, not scanning.</p>",
    "Chat at 1280&times;900: 740px of continuous text, zero structural marks."),
  finding("high","HIGH","Inline code chips fight the prose",
    "<p>Every code span gets a filled box at near-body size. On lines with three or four spans - "
    "common in this app's output - the boxes dominate and the baseline rhythm breaks. The "
    "terminal's approach (colour, no box) carries the same signal at a fraction of the weight.</p>",
    "Chat, <b>Release work</b>: four boxed spans in four consecutive lines."),
  finding("high","HIGH","The disabled composer looks enabled",
    "<p>With no session selected the send button keeps its full accent fill and the composer keeps "
    "its resting border, so the primary action of the screen reads as available when it is inert. "
    "The only disabled cue is the placeholder text.</p>",
    "First load, no session: <code>#chat-send</code> disabled, still <code>--accent-2</code>."),
  finding("high","HIGH","The empty state wastes the entire canvas",
    "<p>A 1040&times;740 region holds one heading and one sentence. Nothing surfaces recent work, "
    "nothing teaches the keyboard grammar, nothing offers a next action beyond the sidebar the "
    "user is already looking at. This is the app's first impression for a new open-source user.</p>",
    "First load at 1280&times;900."),
])

findings_b = "\n".join([
  finding("high","HIGH","The runtime rail under-delivers against the TUI status line",
    "<p>The terminal's status line carries model, cwd, git branch with dirty counts, session name, "
    "memory, spend, and context as a percentage of a stated window. The chat rail shows model, "
    "effort, provider, a cwd truncated mid-word, and a bare token count with no denominator or "
    "bar. Cost and branch - arguably the two facts an operator checks most - appear only in the "
    "mode the user is being steered away from.</p>",
    "Terminal: <code>feat/chat-mode *14 ?1 &middot; $408.88 &middot; 28.0%/272K</code>. "
    "Chat: <code>77K tokens</code>."),
  finding("high","HIGH","The mobile session drawer is a dead end",
    "<p>At 390px the drawer is the full viewport width, so the menu button that opened it sits "
    "behind it. There is no close control, no backdrop to tap, and the edge-swipe gesture was "
    "deferred. Once the list is open the only exit is committing to a session.</p>",
    "390&times;844: <code>#sidebar</code> width 390, not <code>.hidden</code>; no dismiss "
    "control in the interactive tree."),
  finding("med","MEDIUM","The workflow strip spends a full row saying nothing",
    "<p>With all tasks complete the strip still occupies prime space directly above the composer "
    "to report <b>No open tasks &middot; 6/6</b>. A persistent surface should earn its place every "
    "frame or collapse to a marker.</p>",
    "Chat, live session with a completed Todo."),
  finding("med","MEDIUM","Seven same-weight header icons, destructive one among them",
    "<p>Mode, usage, profile, alerts, reload, profile-reload and kill all render at identical size "
    "and weight, with no grouping and no labels. The red kill affordance sits one tab-stop from "
    "routine controls.</p>",
    "Chat header at 1280&times;900 with an active session."),
  finding("med","MEDIUM","Status is inert in the common case",
    "<p>Every session in a 49-folder workspace reported <i>Idle</i>. The attention system's main "
    "visual channel - the status dot - therefore carries no information most of the time, while "
    "still consuming the leading position in every row.</p>",
    "1280 and 390 captures: 6 pinned sessions, all <code>status-idle</code>."),
  finding("med","MEDIUM","No hierarchy between projects and sessions, and a column of noise",
    "<p>Folder rows and session rows share weight, and at 390px fifteen always-visible "
    "<code>&#8943;</code> glyphs stack into a vertical line down the right edge that reads as "
    "structure but carries none. The permanent footer (<b>6 profiles &middot; 49 folders</b>) "
    "spends the sidebar's last row on a number nobody acts on.</p>",
    "390&times;844 drawer."),
  finding("med","MEDIUM","The keyboard is invisible",
    "<p><code>/</code> focuses search today and nothing advertises it. There is no cheatsheet, no "
    "shortcut hints in menus, and no discoverable path to anything faster than the mouse - in a "
    "tool whose users live in a terminal.</p>",
    "Full interactive tree at 1280: no shortcut affordance rendered."),
])

body = f"""
  <section class="verdict">
    <p><b>The headline:</b> chat mode is currently a downgrade from the terminal it projects. It
    drops list nesting, heading hierarchy, spend and branch state, then adds chrome the terminal
    does not need. Everything else in this list is ordinary craft debt; that one is a credibility
    problem for the whole chat-first bet.</p>
    <p>None of it requires restructuring. Turn structure, prose rendering, the runtime rail, the
    empty state and the mobile drawer are all fixable inside today's shape.</p>
  </section>

  <section class="ds-block">
    <span class="ds-label">Audit conditions</span>
    <div class="meta"><span>live service 127.0.0.1:7799</span><span>1280&times;900 &middot; 390&times;844</span>
      <span>authenticated</span><span>49 folders &middot; 37 sessions</span><span>2026-09-20</span></div>
  </section>

  <section class="ds-block">
    <span class="ds-label">Findings - chat mode</span>
    {findings_a}
  </section>

  <section class="ds-block">
    <span class="ds-label">Findings - shell, navigation, mobile</span>
    {findings_b}
  </section>

  <section class="ds-block">
    <span class="ds-label">What this implies for the craft pass</span>
    <p class="ds-note"><b>Renderer before styling.</b> Nesting and heading hierarchy are correctness
      bugs. No amount of typography fixes a list that lost its structure.</p>
    <p class="ds-note"><b>The TUI is the bar, not the fallback.</b> Every fact the status line shows,
      the rail should show at least as well. Chat earns its default position by being denser
      <i>and</i> more scannable, not calmer and thinner.</p>
    <p class="ds-note"><b>Turn structure is the highest-leverage single change.</b> It converts the
      transcript from a document you read into a record you scan, and it is pure CSS plus the
      boundaries the projector already knows.</p>
    <p class="ds-note"><b>Two dead ends to close:</b> the mobile drawer with no exit, and the
      first-run screen that teaches nothing.</p>
  </section>
"""
body += """
  <section class="ds-block">
    <span class="ds-label">Resolution &mdash; craft pass, same day</span>
    <p class="ds-note">Eleven of the thirteen findings are fixed in the working
      copy. Slices 1&ndash;2 are on <code>main</code>; slices 3&ndash;8 are on
      <code>feat/visual-pass</code>, held there so the look can be iterated
      before it merges. Full detail in
      <code>docs/plans/ux-aaa-craft-pass.md</code>.</p>
    <p class="ds-note"><b>Fixed:</b> list nesting and lazy continuation &middot;
      heading scale &middot; inline-code weight &middot; turn anchors with start
      times &middot; spend in the rail (verified equal to the TUI at
      <code>$408.88</code>) &middot; workspace-relative cwd &middot; rail
      degradation below 720px &middot; disabled send &middot; the workflow strip
      that reported nothing &middot; the landing screen &middot; the compact
      drawer dead end &middot; destructive-action separation. Plus a light theme
      and a fix to the update signal, which watched only
      <code>main.js?v=</code> and let CSS-only changes ship silently.</p>
    <p class="ds-note"><b>Open by choice:</b> branch and dirty state in the rail
      needs a cached endpoint rather than a git call per poll; context
      percentage stays omitted because only three models in the local
      <code>models.yml</code> carry a <code>contextWindow</code> and inventing
      precision is worse than omitting it; status being quiet when every session
      is idle is the intended priority order, not a defect.</p>
  </section>
"""

page("audit/findings.html", "Audit", "Live app audit", "Evidence, 2026-09-20",
     "Thirteen findings from driving the running service at two widths, ranked by severity. "
     "Captured against the shipped build, not the design cards.",
     body, AUDIT_CSS)

# ---------------------------------------------------------------- identity

LOGO_CSS = """
.marks{display:grid;grid-template-columns:repeat(auto-fit,minmax(248px,1fr));gap:14px}
.mk{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--line);
  border-radius:10px;background:var(--panel-2)}
.mk-name{font:640 12.5px var(--font-ui)}
.mk-note{color:var(--muted);font-size:11.5px;line-height:1.55}
.mk-row{display:flex;align-items:center;gap:16px;padding:14px;border-radius:9px;background:var(--bg)}
.mk-row.on-light{background:#fff}
.mk-lock{display:flex;align-items:center;gap:9px}
.mk-word{font:700 15px var(--font-ui);letter-spacing:-.025em;color:var(--text)}
.mk-row.on-light .mk-word{color:#16191d}
.verdict{padding:16px;border:1px solid color-mix(in srgb,var(--accent) 34%,var(--line));
  border-left:3px solid var(--accent);border-radius:10px;
  background:color-mix(in srgb,var(--accent) 6%,var(--panel))}
.verdict p{margin:0;font-size:13.5px;line-height:1.65}
"""

def mark_lanes(size, ink="var(--accent)"):
    return f'''<svg width="{size}" height="{size}" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4"  y="12" width="4.5" height="16" rx="2.25" fill="{ink}" opacity=".45"/>
      <rect x="11" y="6"  width="4.5" height="22" rx="2.25" fill="{ink}"/>
      <rect x="18" y="15" width="4.5" height="13" rx="2.25" fill="{ink}" opacity=".7"/>
      <rect x="25" y="19" width="4.5" height="9"  rx="2.25" fill="{ink}" opacity=".3"/>
    </svg>'''

def mark_orbit(size, ink="var(--accent)"):
    return f'''<svg width="{size}" height="{size}" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="11" fill="none" stroke="{ink}" stroke-width="1.6" opacity=".34"/>
      <circle cx="16" cy="16" r="4.2" fill="{ink}"/>
      <circle cx="16" cy="5"  r="2.6" fill="{ink}"/>
      <circle cx="25.5" cy="21.5" r="2.2" fill="{ink}" opacity=".72"/>
      <circle cx="6.5"  cy="21.5" r="2.2" fill="{ink}" opacity=".45"/>
    </svg>'''

def mark_caret(size, ink="var(--accent)"):
    return f'''<svg width="{size}" height="{size}" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2.5" y="2.5" width="27" height="27" rx="8" fill="none" stroke="{ink}" stroke-width="1.8" opacity=".55"/>
      <path d="M11 11.5 16.5 16 11 20.5" fill="none" stroke="{ink}" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M19 21h4" stroke="{ink}" stroke-width="2.4" stroke-linecap="round" opacity=".6"/>
    </svg>'''

def mark_panes(size, ink="var(--accent)"):
    return f'''<svg width="{size}" height="{size}" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="4" width="11" height="11" rx="3" fill="{ink}"/>
      <rect x="17" y="4" width="11" height="11" rx="3" fill="{ink}" opacity=".42"/>
      <rect x="4" y="17" width="11" height="11" rx="3" fill="{ink}" opacity=".42"/>
      <rect x="17" y="17" width="11" height="11" rx="3" fill="{ink}" opacity=".72"/>
    </svg>'''

def mark_card(name, note, fn):
    return f'''<div class="mk">
      <span class="mk-name">{name}</span>
      <div class="mk-row">
        <span class="mk-lock">{fn(28)}<span class="mk-word">omp-web</span></span>
        <span style="margin-left:auto;display:flex;align-items:center;gap:10px">
          {fn(20)}{fn(16)}</span>
      </div>
      <div class="mk-row on-light">
        <span class="mk-lock">{fn(28, "#2f66cc")}<span class="mk-word">omp-web</span></span>
        <span style="margin-left:auto;display:flex;align-items:center;gap:10px">
          {fn(20, "#2f66cc")}{fn(16, "#2f66cc")}</span>
      </div>
      <span class="mk-note">{note}</span>
    </div>'''

body = f"""
  <section class="ds-block">
    <span class="ds-label">Four marks &middot; lockup, 20px, 16px, on both grounds</span>
    <div class="marks">
      {mark_card("Lanes", "Parallel sessions at different depths. Says what the app is for - many concurrent agents - rather than what it runs on. Reads at 16px and doubles as a status motif: bar heights could track real session states.", mark_lanes)}
      {mark_card("Orbit", "A controller with satellites: mission control made literal. Most distinctive, most likely to be mistaken for a generic AI or atom logo, and the weakest at 16px.", mark_orbit)}
      {mark_card("Caret", "A prompt in a pane. Instantly legible as a terminal tool and the safest choice, but it is the logo half the developer-tool category already uses.", mark_caret)}
      {mark_card("Panes", "Four tiles at different weights - tmux panes, or sessions in a grid. Calm and structural; also the most anonymous, and close to several existing app icons.", mark_panes)}
    </div>
  </section>

  <section class="verdict">
    <p><b>Recommendation: Lanes.</b> It is the only one of the four that means
    something specific to this app, it survives 16px, it needs no gradient or
    detail to read, and it extends: the same four bars can carry live status on
    the tab favicon. Orbit is the more beautiful mark and the worse logo.</p>
  </section>

  <section class="ds-block">
    <span class="ds-label">Where a mark has to work</span>
    <p class="ds-note">Sidebar brand at 16px (today: a bare 6px accent dot before
      the wordmark) &middot; browser tab favicon at 16px &middot; PWA icon at
      192 and 512, which is where the current <code>icon.svg</code> lives
      &middot; the iOS home-screen tile, where it sits on the user's wallpaper
      and needs its own padded ground.</p>
    <p class="ds-note">None of these are implemented yet. This card is the
      choice, not the change.</p>
  </section>
"""
page("identity/logo.html", "Identity", "Logo directions", "Four marks",
     "The app has no mark today - a 6px accent dot stands in. Four directions, "
     "each shown as a lockup and at the two sizes that actually decide a logo.",
     body, LOGO_CSS)

# ---------------------------------------------------------------- navigation

NAV_CSS = """
.opt{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,320px);gap:20px;align-items:start;
  padding:18px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2);margin-bottom:14px}
.opt h3{margin:0 0 6px;font-size:14px;font-weight:640}
.opt .tag{display:inline-block;margin-bottom:8px;padding:2px 8px;border-radius:999px;
  font:700 9.5px var(--font-ui)}
.tag.rec{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
.tag.big{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.tag.small{background:var(--row-hover);color:var(--muted)}
.opt p{margin:0 0 8px;color:var(--muted);font-size:12.5px;line-height:1.6}
.opt .cost{margin:0;color:var(--faint);font-size:11.5px;line-height:1.5}
.wire{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg);
  font:10.5px var(--font-ui)}
.w-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--line);
  background:var(--panel);color:var(--faint);font-size:9.5px}
.w-body{display:flex;min-height:186px}
.w-rail{width:112px;border-right:1px solid var(--line);padding:6px}
.w-main{flex:1;padding:8px;display:flex;flex-direction:column;gap:6px}
.w-sec{margin:5px 0 3px;color:var(--faint);font:700 8px var(--font-ui)}
.w-sec.hot{color:var(--warn)}
.w-row{display:flex;align-items:center;gap:5px;padding:3px 4px;border-radius:4px;
  color:var(--muted);font-size:9.5px}
.w-row.sel{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--text)}
.w-dot{width:5px;height:5px;border-radius:50%;flex:none}
.w-line{height:5px;border-radius:999px;background:var(--panel-3)}
.w-card{padding:7px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
.w-card .t{color:var(--text);font-size:9.5px;font-weight:600;margin-bottom:5px}
.w-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.w-cmd{margin:14px auto 0;width:82%;padding:7px 9px;border:1px solid var(--accent);border-radius:7px;
  background:var(--pop-bg);color:var(--muted);font-size:9.5px;box-shadow:var(--pop-shadow)}
.w-bar{padding:5px 8px;border:1px solid var(--line);border-radius:999px;background:var(--panel);
  color:var(--faint);font-size:9px;margin-bottom:7px}
"""

WIRE_A = """<div class="wire"><div class="w-head">Unified rail</div><div class="w-body">
  <div class="w-rail">
    <div class="w-sec hot">NEEDS YOU 1</div>
    <div class="w-row"><span class="w-dot" style="background:var(--warn)"></span>Migrate w…</div>
    <div class="w-sec">WORKING 2</div>
    <div class="w-row"><span class="w-dot" style="background:var(--ok)"></span>Omp Web M…</div>
    <div class="w-row"><span class="w-dot" style="background:var(--ok)"></span>MaVoice D…</div>
    <div class="w-sec">PINNED</div>
    <div class="w-row sel"><span class="w-dot" style="background:var(--accent)"></span>Release No…</div>
    <div class="w-sec">RECENT 24H</div>
    <div class="w-row"><span class="w-dot" style="background:var(--muted)"></span>Codex Lite…</div>
    <div class="w-sec">PROJECTS 49</div>
    <div class="w-row">› infra</div>
  </div>
  <div class="w-main">
    <div class="w-line" style="width:70%"></div><div class="w-line" style="width:88%"></div>
    <div class="w-line" style="width:54%"></div>
    <div class="w-cmd">⌘K  open session, new, reload, kill…</div>
  </div>
</div></div>"""

WIRE_B = """<div class="wire"><div class="w-head">Fleet home</div><div class="w-body">
  <div class="w-main">
    <div class="w-sec hot">NEEDS YOU</div>
    <div class="w-card"><div class="t">Migrate queue worker</div>
      <div class="w-line" style="width:60%"></div></div>
    <div class="w-sec">WORKING 2</div>
    <div class="w-grid">
      <div class="w-card"><div class="t">Omp Web Main</div><div class="w-line" style="width:80%"></div></div>
      <div class="w-card"><div class="t">MaVoice Dev</div><div class="w-line" style="width:45%"></div></div>
    </div>
    <div class="w-sec">IDLE 34</div>
    <div class="w-line" style="width:100%"></div>
  </div>
</div></div>"""

WIRE_C = """<div class="wire"><div class="w-head">Rail + command bar</div><div class="w-body">
  <div class="w-rail">
    <div class="w-bar">⌘K</div>
    <div class="w-sec">PROJECTS | RECENT</div>
    <div class="w-row"><span class="w-dot" style="background:var(--warn)"></span>Migrate w…</div>
    <div class="w-row sel"><span class="w-dot" style="background:var(--ok)"></span>Omp Web M…</div>
    <div class="w-row"><span class="w-dot" style="background:var(--muted)"></span>Release No…</div>
    <div class="w-row"><span class="w-dot" style="background:var(--muted)"></span>Codex Lite…</div>
  </div>
  <div class="w-main">
    <div class="w-line" style="width:70%"></div><div class="w-line" style="width:88%"></div>
    <div class="w-line" style="width:54%"></div>
  </div>
</div></div>"""

body = f"""
  <section class="ds-block">
    <span class="ds-label">The problem being solved</span>
    <p class="ds-note">Two parallel navigations split attention and neither answers the north star.
      <b>Projects</b> hides running and blocked work inside collapsed folders; <b>Recent</b> buries
      it under time buckets the user has to mentally filter. With 37 sessions across 49 folders, the
      common task — find the one session that needs me — is a scan, not a glance. And the keyboard,
      in a tool whose users live in a terminal, is invisible: <code>/</code> has focused search for
      months with nothing advertising it.</p>
  </section>

  <div class="opt">
    <div>
      <span class="tag rec">RECOMMENDED</span>
      <h3>A &middot; One ranked rail, plus &#8984;K</h3>
      <p>Retire the Projects/Recent split. One list, always ranked the same way:
        <b>Needs you &rarr; Working &rarr; Pinned &rarr; Recent 24h &rarr; Projects</b> (collapsed,
        below the fold). Projects becomes a grouping, not a mode. &#8984;K opens a command palette
        over everything: jump to a session by name, create in a folder, reload under a profile,
        kill, switch mode.</p>
      <p>The ranking already exists in the attention system — this makes it the only ordering
        instead of one of two. The palette is where the keyboard grammar finally becomes
        discoverable, and it scales past 37 sessions where any list stops working.</p>
      <p class="cost"><b>Cost:</b> retires <code>activity.js</code>'s bucket machinery from the
        common path, adds a palette module and a global key handler. Element ids are API, so the
        row and menu wiring is reused rather than rebuilt. Roughly one focused session.</p>
    </div>
    {WIRE_A}
  </div>

  <div class="opt">
    <div>
      <span class="tag big">BIGGEST CHANGE</span>
      <h3>B &middot; Fleet home</h3>
      <p>A new default surface: every session as a live card — status, current intent, todo
        progress, spend — with chat as the drill-in. Answers "what is churning" in one glance
        without opening anything, which is the actual job when you are running many agents at once.</p>
      <p>This is the only option that treats the fleet, rather than one session, as the subject of
        the app. It is also the one that needs new backend: per-session derived state for every
        session at once, where today the projector runs for the open session only.</p>
      <p class="cost"><b>Cost:</b> a new route and surface, a bounded multi-session projection, and
        a polling story that does not melt the machine at 37 sessions. Several sessions, and the
        highest risk of the three.</p>
    </div>
    {WIRE_B}
  </div>

  <div class="opt">
    <div>
      <span class="tag small">SMALLEST</span>
      <h3>C &middot; Keep the split, add the palette</h3>
      <p>Leave Projects/Recent alone and add &#8984;K plus a visible entry point above the list.
        Buys the keyboard grammar and the scale escape hatch without touching navigation.</p>
      <p>Honest assessment: this fixes discoverability and leaves the actual complaint — two
        navigations, neither ranked by what needs you — exactly where it is.</p>
      <p class="cost"><b>Cost:</b> palette module only. Half a session.</p>
    </div>
    {WIRE_C}
  </div>

  <section class="ds-block">
    <span class="ds-label">What does not change in any of them</span>
    <p class="ds-note">tmux stays the only writer and the only state store. Rows keep stable
      <code>created</code> ordering inside groups, because <code>session_activity</code> bumps on
      attach and reshuffles rows under the cursor. Every new event gets its subscriber in the same
      commit. No sidecar state file. Terminal stays pure passthrough.</p>
  </section>
"""
page("navigation/concepts.html", "Navigation", "Navigation directions", "Three options",
     "One ranked rail, a fleet home, or the smallest useful addition. Each shown against the "
     "constraint that tmux owns the state and there is no build step.",
     body, NAV_CSS)
