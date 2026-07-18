export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function layoutPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - Live KB</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* Daybreak tokens - ported from the mortgage platform design system */
:root{color-scheme:light;
--page-bg:#f6f6fb;--surface:#fff;--surface-sunken:#f0f0f7;--border:#eae9f3;--border-strong:#dbdaec;
--ring:rgba(88,87,214,.26);--text-primary:#191823;--text-secondary:#55536e;--text-muted:#737190;
--ink:#191823;--ink-hover:#2b2a3b;--accent:#5857d6;--accent-strong:#4f4ecb;--accent-tint:#ededfb;--accent-tint-border:#dcdbf6;
--good:#0c7d55;--good-tint:#e7f7f0;--good-tint-border:#c2e7d7;
--warning:#a95f0b;--warning-tint:#fdf3e4;--warning-tint-border:#f2dcb6;
--critical:#cf3d51;--critical-tint:#fdecef;--critical-tint-border:#f6c9d1;
--radius-sm:10px;--radius-md:14px;--radius-lg:18px;--radius-pill:999px;
--shadow-sm:0 1px 2px rgba(25,24,45,.04),0 4px 14px -6px rgba(25,24,45,.08);
--shadow-md:0 6px 26px -8px rgba(25,24,45,.14),0 2px 8px -4px rgba(25,24,45,.06);
--font-display:"Bricolage Grotesque",system-ui,sans-serif;--font-mono:"JetBrains Mono",monospace}
*{box-sizing:border-box}
body{font:15px/1.55 Inter,system-ui,sans-serif;margin:0;color:var(--text-primary);background:var(--page-bg)}
.shell{max-width:880px;margin:0 auto;padding:1.25rem 1rem 4rem}
nav{display:flex;align-items:center;gap:.25rem;background:var(--surface);border:1px solid var(--border);
border-radius:var(--radius-pill);padding:.4rem .6rem;box-shadow:var(--shadow-sm);margin-bottom:2rem}
nav .brand{font-family:var(--font-display);font-weight:700;font-size:1.02rem;padding:.2rem .7rem;margin-right:auto}
nav .brand em{color:var(--accent-strong);font-style:normal}
nav a{color:var(--text-secondary);text-decoration:none;padding:.35rem .8rem;border-radius:var(--radius-pill);font-weight:500;font-size:.92rem}
nav a:hover{background:var(--surface-sunken);color:var(--text-primary)}
h1{font-family:var(--font-display);font-weight:700;font-size:1.7rem;line-height:1.2;margin:.2rem 0 .6rem}
h2{font-family:var(--font-display);font-weight:600;font-size:1.15rem;margin:2rem 0 .6rem}
p{color:var(--text-secondary)}p b{color:var(--text-primary)}
.card,form,fieldset{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);
padding:1.1rem 1.25rem;box-shadow:var(--shadow-sm)}
fieldset{margin:.75rem 0}legend{font-weight:600;color:var(--text-primary);padding:0 .4rem}
ol{padding-left:0;list-style:none;counter-reset:step}
ol>li{counter-increment:step;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);
padding:1rem 1.25rem 1rem 3.4rem;margin:.9rem 0;box-shadow:var(--shadow-sm);position:relative}
ol>li::before{content:counter(step);position:absolute;left:1rem;top:1.05rem;width:1.7rem;height:1.7rem;
background:var(--accent-tint);border:1px solid var(--accent-tint-border);color:var(--accent-strong);
border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:.9rem}
.chip{padding:2px 10px;border-radius:var(--radius-pill);font-size:.75rem;font-weight:600;vertical-align:middle}
.chip.active{background:var(--good-tint);color:var(--good);border:1px solid var(--good-tint-border)}
.chip.stale{background:var(--warning-tint);color:var(--warning);border:1px solid var(--warning-tint-border)}
.chip.error{background:var(--critical-tint);color:var(--critical);border:1px solid var(--critical-tint-border)}
.chip.syncing,.chip.never_synced{background:var(--surface-sunken);color:var(--text-muted);border:1px solid var(--border-strong)}
table{border-collapse:collapse;width:100%;background:var(--surface);border:1px solid var(--border);
border-radius:var(--radius-md);overflow:hidden;box-shadow:var(--shadow-sm);font-size:.92rem}
th{background:var(--surface-sunken);color:var(--text-muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}
td,th{border-bottom:1px solid var(--border);padding:.55rem .8rem;text-align:left}
tr:last-child td{border-bottom:none}
input,select,textarea{width:100%;padding:.55rem .8rem;margin:4px 0;border:1px solid var(--border-strong);
border-radius:var(--radius-sm);font:inherit;background:var(--surface)}
input:focus,select:focus,textarea:focus{outline:2px solid var(--ring);outline-offset:1px;border-color:var(--accent)}
button{padding:.55rem 1.15rem;cursor:pointer;background:var(--ink);color:#fff;border:none;
border-radius:var(--radius-pill);font:inherit;font-weight:600;font-size:.92rem}
button:hover{background:var(--ink-hover)}button:disabled{background:var(--border-strong);cursor:not-allowed}
button.ghost,p>button,td button{background:var(--accent-tint);color:var(--accent-strong);border:1px solid var(--accent-tint-border)}
button.ghost:hover,p>button:hover,td button:hover{background:var(--accent-tint-border)}
code{font-family:var(--font-mono);font-size:.85em;background:var(--surface-sunken);padding:.12rem .4rem;border-radius:6px}
pre{font-family:var(--font-mono);font-size:.82rem}
a{color:var(--accent-strong)}
.err{color:var(--critical)}
.warn{background:var(--warning-tint);border:1px solid var(--warning-tint-border);color:var(--warning);padding:.6rem .9rem;border-radius:var(--radius-sm)}
small{color:var(--text-muted)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style></head>
<body><div class="shell"><nav><span class="brand">Live<em>KB</em></span><a href="/setup">Setup</a><a href="/sources">Sources</a><a href="/connect">Connection</a>
<a href="#" onclick="api('/logout',{}).then(()=>location='/login');return false">Log out</a></nav>
${body}
<script>
async function api(path, body){
  const r = await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-requested-with':'kb-bridge'},body:JSON.stringify(body)});
  const out = await r.json().catch(()=>({ok:false,error:'HTTP '+r.status}));
  if(!out.ok && out.error) alert(out.error);
  return out;
}
function formJson(f){const o={};new FormData(f).forEach((v,k)=>{o[k]=v});return o}
</script></div></body></html>`;
}

const authForm = (action, label) => `
<h1>${label}</h1><form onsubmit="api('${action}',formJson(this)).then(o=>o.ok&&(location='/setup'));return false">
<input name="email" type="email" placeholder="email" required>
<input name="password" type="password" placeholder="password (min 10 chars)" minlength="10" required>
<button>${label}</button></form>
<p><a href="${action === "/login" ? "/signup" : "/login"}">${action === "/login" ? "Create an account" : "Have an account? Log in"}</a></p>`;

export const loginPage = () => layoutPage("Log in", authForm("/login", "Log in"));
export const signupPage = () => layoutPage("Sign up", authForm("/signup", "Sign up"));

export const scopesBox = () => `
<fieldset><legend>What access to give this key</legend>
<p>Create a dedicated API key in Assistable scoped to <b>one subaccount</b> with <b>only</b> these permissions:</p>
<table>
<tr><td><code>assistants : list</code></td><td>to show your assistant picker</td></tr>
<tr><td><code>tools : create</code></td><td>to create the live-data tool in your account</td></tr>
<tr><td><code>tools : update</code></td><td>to assign the tool to assistants and refresh its description</td></tr>
<tr><td><code>tools : delete</code></td><td><i>optional</i> - only used to clean up the tool if you delete a source</td></tr>
</table>
<p><b>Nothing else.</b> No access to your knowledge bases, contacts, conversations,
calls, phone numbers, or billing is needed or requested. A key with extra scopes
still works, but least-privilege is safer - this portal stores the key encrypted
(AES-256-GCM) and never displays it again.</p></fieldset>`;

export const connectPage = (conn) => layoutPage("Connection", `
<h1>Assistable connection</h1>
${conn ? `<p>Status: <span class="chip active">connected</span></p>` : `<p>Not connected yet.</p>`}
${scopesBox()}
<form onsubmit="api('/connect',formJson(this)).then(o=>o.ok&&location.reload());return false">
<input name="api_key" type="password" placeholder="Paste your Assistable v3 API key" autocomplete="off" required>
<button>${conn ? "Replace key" : "Connect"}</button></form>
<p>The key is verified live against the Assistable API before it is accepted.</p>`);

const TYPE_LABELS = {
  csv: "Spreadsheet (CSV)", feed: "Data feed", website: "Website pages",
  webtable: "Price table on a page", database: "Database",
};

export const sourcesPage = (sources) => layoutPage("Your data", `
<h1>Your data</h1>
${sources.length === 0 ? `
<div class="card" style="text-align:center;padding:2.5rem">
<p style="font-size:1.05rem"><b>Nothing connected yet.</b></p>
<p>Connect your inventory, prices, or website - your AI assistant will answer
from it live, on calls and in chat.</p>
<a href="/sources/new"><button>Connect your first data</button></a>
</div>` : `
<p><a href="/sources/new"><button class="ghost">+ Add more data</button></a></p>
<table><tr><th>Name</th><th>Kind</th><th>Status</th><th>Updated</th></tr>
${sources.map((s) => {
  const st = humanizeStatus(s);
  return `<tr><td><a href="/sources/${esc(s.id)}">${esc(s.name)}</a></td><td>${esc(TYPE_LABELS[s.type] ?? s.type)}</td>
<td><span class="chip ${esc(st.tone)}">${esc(st.label)}</span></td><td>${esc(timeAgo(s.last_sync_at))}</td></tr>`;
}).join("")}
</table>`}`);

const TYPE_CARDS = [
  { value: "csv", title: "I have a spreadsheet or file", desc: "Upload a CSV export of your inventory, products, or price list. Works with Excel and Google Sheets exports." },
  { value: "webtable", title: "My prices are in a table on my website", desc: "Paste the link to the page that shows the table (like a scrap price list or rate sheet). We read the table itself." },
  { value: "website", title: "The answers are on my website", desc: "Hours, services, policies, FAQs - we read your site's pages and keep them fresh." },
  { value: "feed", title: "I have a data feed link", desc: "A URL that returns JSON, CSV, or XML - like a Shopify products.json or a DMS inventory export." },
  { value: "database", title: "Connect my database (advanced)", desc: "Read-only Postgres or Supabase. You'll need a connection string from your developer." },
];

export const newSourcePage = (assistants, notConnected) => layoutPage("Connect data", `
<h1>Connect your data</h1>
<p>Pick where your information lives - we'll keep a fresh copy your assistant answers from.</p>
${notConnected ? `<p class="warn">Connect your Assistable account first (Connection page) - without it we can't attach this to your assistant.</p>` : ""}
<form onsubmit="submitSource(this);return false">
<label>What should we call this? <input name="name" required maxlength="60" placeholder="e.g. Vehicle inventory, Scrap prices, Our website"></label>
<fieldset><legend>Where is the data?</legend>
${TYPE_CARDS.map((c, i) => `
<label style="display:flex;gap:.7rem;align-items:flex-start;padding:.7rem;border:1px solid var(--border);border-radius:var(--radius-md);margin:.45rem 0;cursor:pointer">
<input type="radio" name="type" value="${c.value}" ${i === 0 ? "checked" : ""} style="width:auto;margin-top:.3rem"
 onchange="document.querySelectorAll('[data-cfg]').forEach(d=>{const on=d.dataset.cfg===this.value;d.style.display=on?'':'none';d.querySelectorAll('input').forEach(i=>i.disabled=!on)})">
<span><b>${c.title}</b><br><small>${c.desc}</small></span></label>`).join("")}
</fieldset>
<div data-cfg="csv"><label>Your CSV file <input type="file" id="csvfile" accept=".csv"></label>
<small>The first row should be column names (make, model, price...).</small></div>
<div data-cfg="feed" style="display:none"><label>Feed link <input name="url_feed" type="url" placeholder="https://yourstore.com/products.json" disabled></label></div>
<div data-cfg="website" style="display:none"><label>Your website <input name="url_site" type="url" placeholder="https://yourbusiness.com" disabled></label></div>
<div data-cfg="webtable" style="display:none"><label>Link to the page with the table <input name="url_table" type="url" placeholder="https://yourbusiness.com/prices" disabled></label></div>
<div data-cfg="database" style="display:none"><label>Connection string <input name="connection_string" placeholder="postgres://..." disabled></label>
<label>Table or view name <input name="table" disabled></label>
<small>Use read-only credentials - we only ever run SELECT.</small></div>
<label>How often should we check for changes?
<select name="schedule_minutes"><option value="1440">Once a day</option>
<option value="360">Every 6 hours</option><option value="60">Every hour</option></select></label>
<small>Prices that change during the day? Your developer can also push updates instantly - see the source page after creating.</small>
<fieldset><legend>Which assistants should answer from this?</legend>
${assistants.length ? assistants.map((a) => `<label><input type="checkbox" name="assistant" value="${esc(a.id)}" style="width:auto"> ${esc(a.name)}</label>`).join("")
  : `<small>No assistants found on your Assistable account yet - create one there first, then come back.</small>`}
</fieldset><button>Connect it</button>
<p><small>What happens next: we fetch your data (usually under a minute), create the
answer tool in your Assistable account, and attach it to the assistants you ticked.</small></p></form>
<script>
async function submitSource(f){
  const body = formJson(f);
  body.assistant_ids = [...f.querySelectorAll('input[name=assistant]:checked')].map(c=>c.value);
  delete body.assistant;
  const file = document.getElementById('csvfile')?.files[0];
  if (body.type === 'csv' && file) body.csv_text = await file.text();
  const o = await api('/sources/new', body);
  if (o.ok) location = '/sources/' + o.source_id;
}
</script>`);

const stepChip = (done) => `<span class="chip ${done ? "active" : "never_synced"}">${done ? "done" : "to do"}</span>`;

export function timeAgo(iso) {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// Raw sync errors are for engineers; owners need to know what to DO.
export function humanizeError(err) {
  const e = String(err || "");
  if (/robots/i.test(e)) return "That website asks not to be copied (robots.txt). Try a different page, or upload the data as a CSV instead.";
  if (/SSRF|private address|scheme not allowed|port .* not allowed/i.test(e)) return "That address isn't reachable from the public internet. The link must be a normal public https:// page.";
  if (/no data table/i.test(e)) return "We couldn't find a table on that page. Make sure the link goes straight to the page that shows the table.";
  if (/HTTP 40[134]/i.test(e)) return "That link didn't work (page missing or blocked). Double-check the URL in a private browser window.";
  if (/validation gate/i.test(e)) return "The new data looked much smaller than before, so we kept your old data to be safe. If the change is intentional, press Force sync.";
  if (/limit is 50000/i.test(e)) return "That source has too many rows (limit 50,000). Split it into smaller sources.";
  if (/could not parse CSV/i.test(e)) return "That file doesn't look like a valid CSV. Export it again as CSV and re-upload.";
  if (/no rows|returned no rows|empty/i.test(e)) return "The source came back empty. Check that the link or table actually contains data.";
  if (/invalid table name/i.test(e)) return "That table name isn't valid. Copy it exactly as it appears in your database.";
  if (/ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|HTTP 5\d\d|HTTP 429/i.test(e)) return "We couldn't reach it just now. We'll retry automatically - no action needed yet.";
  return e;
}

export function humanizeStatus(source, lastError) {
  const updated = timeAgo(source.last_sync_at);
  const fresh = source.last_sync_at && Date.now() - Date.parse(source.last_sync_at) < 2 * source.schedule_minutes * 60_000;
  switch (source.status) {
    case "active":
      return fresh
        ? { tone: "active", label: "Working", text: `Answering calls and chats from data updated ${updated}.` }
        : { tone: "stale", label: "Working, data aging", text: `Still answering, but the data is from ${updated}. The next refresh should catch up.` };
    case "syncing": return { tone: "syncing", label: "Updating", text: "Refreshing your data right now - this usually takes under a minute." };
    case "never_synced": return { tone: "never_synced", label: "Waiting", text: "The first sync hasn't run yet." };
    case "stale": return { tone: "stale", label: "Trouble refreshing", text: `Refreshing keeps failing, so we're still answering from data updated ${updated}. ${humanizeError(lastError)}` };
    default: return { tone: "error", label: "Needs attention", text: humanizeError(lastError) || "The last sync failed." };
  }
}

export const setupPage = (state) => {
  const toolName = state.firstTool?.tool_id ? state.firstToolName : "your live data tool";
  const snippet = `For ANY question about ${state.firstSourceName || "your live data"}, ALWAYS call ${toolName} first and answer only from the result. If it returns nothing, say you don't have that information. When a speech_hint is present, read it aloud. If data_freshness is "stale", say the info is as of the last update.`;
  const allDone = state.connected && state.sourceCount > 0 && state.firstTool?.tool_id;
  return layoutPage("Setup", `
<h1>Set up your Live KB</h1>
${allDone ? `<div class="card" style="background:var(--good-tint);border-color:var(--good-tint-border)">
<p style="margin:.2rem 0;color:var(--good)"><b>You're live.</b> Your assistant now answers from your own data
on calls and in chat. Call it and ask something only your data knows - then watch
the question appear on your <a href="/sources/${esc(state.firstSourceId)}">data page</a>.</p></div>`
    : `<p>Four steps and your Assistable agents answer from live data - on calls and in chat.</p>`}
<ol style="padding-left:1.2rem">
<li><p><b>Connect your Assistable account</b> ${stepChip(state.connected)}<br>
Paste your v3 API key so this portal can create tools in <i>your</i> account.
Give the key <b>only</b>: <code>assistants:list</code>, <code>tools:create</code>,
<code>tools:update</code> (and optionally <code>tools:delete</code> for cleanup) -
no knowledge, contacts, calls, or billing access is needed.
${state.connected ? "" : `<br><a href="/connect"><button>Connect Assistable</button></a>`}</p></li>
<li><p><b>Add your first live data source</b> ${stepChip(state.sourceCount > 0)}<br>
CSV, feed URL, website, or database. The first sync runs immediately and the
custom tool is created and attached to the assistants you pick.
${state.sourceCount > 0 ? `<br>Source: <a href="/sources/${esc(state.firstSourceId)}">${esc(state.firstSourceName)}</a>${state.firstTool?.tool_id ? ` - tool <code>${esc(state.firstTool.tool_id)}</code> on ${esc(JSON.parse(state.firstTool.assistant_ids_json).length)} assistant(s)` : ` - <span class="err">tool not created yet (connect Assistable, then re-create the source)</span>`}` : `<br><a href="/sources/new"><button ${state.connected ? "" : "disabled"}>Add source</button></a>`}</p></li>
<li><p><b>Paste this into your assistant's instructions</b> (in Assistable) ${stepChip(false)}<br>
<textarea id="snippet" readonly rows="4">${esc(snippet)}</textarea>
<button onclick="navigator.clipboard.writeText(document.getElementById('snippet').value);this.textContent='Copied!'">Copy</button><br>
<small>If the assistant has a static KB covering the same topic, unlink those docs - they compete with live data on voice.</small></p></li>
<li><p><b>Test it live</b><br>
${state.sourceCount > 0 ? `
<form onsubmit="testSearch(this);return false">
<input name="q" placeholder='Try: do you have a 2022 tacoma under 30k' required>
<button>Ask</button></form>
<pre id="testout" style="white-space:pre-wrap;background:#f6f6f9;padding:8px;border-radius:6px;display:none"></pre>
<script>
async function testSearch(f){
  const out = await api('/sources/${esc(state.firstSourceId)}/test', { query: f.q.value });
  const el = document.getElementById('testout');
  el.style.display = 'block';
  el.textContent = (out.speech_hint ? 'Agent would say: "' + out.speech_hint + '"\\n\\n' : '') + JSON.stringify(out, null, 1);
}
</script>` : `<i>Add a source first.</i>`}
Then call your assistant and ask for real.</p></li>
</ol>
<h2>Where your data lives</h2>
<p>Everything - your account, sources, synced items, logs - is one SQLite file
<b>on this instance</b>: <code>${esc(state.data.dbFile)}</code>${state.data.dbSizeMb ? ` (${esc(state.data.dbSizeMb)})` : ""}.
${esc(state.data.itemCount)} live item(s) currently served to your agents.
Nothing is stored on anyone else's server; delete the instance and the data is gone.</p>
<p>Automatic daily snapshots are kept on this instance (7 days${state.data.latestBackup ? `, latest: <code>${esc(state.data.latestBackup)}</code>` : " - first one runs tonight"}).
<a href="/backup"><button>Download backup now</button></a>
<small>Keep a copy off this machine. Restore = replace <code>data/kb-bridge.db</code> with a backup and restart.
On Render's free tier the disk resets on redeploys - download a backup after big changes.</small></p>`);
};

const statTile = (value, label, tone = "") => `
<div style="flex:1 1 8rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:.8rem 1rem">
<div style="font-family:var(--font-display);font-size:1.5rem;font-weight:700;line-height:1.1${tone ? `;color:var(--${tone})` : ""}">${esc(value)}</div>
<div style="font-size:.82rem;color:var(--text-muted)">${esc(label)}</div></div>`;

export const qualitySection = (q) => {
  if (!q || q.total === 0) {
    return `<h2>How well it's answering</h2>
<p><small>No questions yet. Once your assistant starts using this data, you'll see here how
many questions it answered, what it couldn't answer, and how fast.</small></p>`;
  }
  const smarts = [
    q.qualitative && `understood vague wording like cheap or low miles ${q.qualitative}x`,
    q.spell && `fixed misheard words ${q.spell}x`,
    q.context && `remembered the conversation ${q.context}x`,
    q.relaxed && `offered near-matches ${q.relaxed}x`,
  ].filter(Boolean);
  return `<h2>How well it's answering <small style="font-weight:400">- last ${esc(q.days)} days</small></h2>
<div style="display:flex;gap:.7rem;flex-wrap:wrap;margin:.6rem 0">
${statTile(q.total, "questions asked")}
${statTile(`${q.helpedPct}%`, "got a useful answer", q.helpedPct >= 80 ? "good" : q.helpedPct >= 50 ? "warning" : "critical")}
${statTile(q.noMatch, "we couldn't help", q.noMatch ? "warning" : "good")}
${statTile(`${q.p95}ms`, "slowest 5% (1s budget)", "good")}
</div>
<p><small>${esc(q.answered)} answered exactly${q.alternatives ? `, ${esc(q.alternatives)} got the closest alternatives instead` : ""}${q.browse ? `, ${esc(q.browse)} were "what do you have?" browsing` : ""}.
${smarts.length ? `Along the way it ${esc(smarts.join(", "))}.` : ""}</small></p>
${q.unanswered.length ? `
<h3 style="font-family:var(--font-display);font-size:1rem;margin:1.2rem 0 .3rem">Questions it couldn't answer</h3>
<ul>${q.unanswered.map((u) => `<li>"${esc(u.query)}"${u.n > 1 ? ` - asked ${esc(u.n)}x` : ""}</li>`).join("")}</ul>
<p><small>Usually this means the item isn't in your data yet. Add it and press Refresh -
your assistant will know about it within seconds.</small></p>` : ""}`;
};

export const sourceDetailPage = (source, runs, tool, calls, quality) => {
  const lastError = runs.find((r) => r.error)?.error;
  const st = humanizeStatus(source, lastError);
  const attached = tool?.tool_id ? JSON.parse(tool.assistant_ids_json).length : 0;
  return layoutPage(source.name, `
<h1>${esc(source.name)} <span class="chip ${esc(st.tone)}">${esc(st.label)}</span></h1>
<div class="card"><p style="margin:.2rem 0"><b>${esc(st.text)}</b></p>
<p style="margin:.4rem 0 .2rem">${tool?.tool_id
    ? `Connected to ${esc(attached)} assistant${attached === 1 ? "" : "s"} - they answer from this data on calls and in chat.`
    : `<span class="err">Not connected to an assistant yet.</span> ${tool?.last_error ? esc(humanizeError(tool.last_error)) : "Connect your Assistable account, then delete and re-add this source."}`}</p>
${tool && tool.updated_at > tool.created_at ? `<p class="warn" style="margin:.5rem 0 0">The available filters changed. Open your assistant in Assistable and press Save once so phone calls pick up the change.</p>` : ""}
</div>
<h2>Try it - ask like a customer would</h2>
<form onsubmit="tryIt(this);return false">
<input name="q" placeholder="e.g. do you have a 2022 tacoma under 30k" required>
<button>Ask</button></form>
<pre id="tryout" style="white-space:pre-wrap;background:var(--surface-sunken);padding:10px;border-radius:10px;display:none"></pre>
<script>
async function tryIt(f){
  const out = await api('/sources/${esc(source.id)}/test', { query: f.q.value });
  const el = document.getElementById('tryout');
  el.style.display = 'block';
  el.textContent = (out.speech_hint ? 'Your assistant would say:\\n"' + out.speech_hint + '"\\n\\nDetails:\\n' : '') + JSON.stringify(out, null, 1);
}
</script>
<h2>Actions</h2>
<p>
<button onclick="api('/sources/${esc(source.id)}/sync',{}).then(()=>location.reload())">Refresh data now</button>
<button onclick="api('/sources/${esc(source.id)}/sync',{force:true}).then(()=>location.reload())">Force refresh</button>
<button onclick="api('/sources/${esc(source.id)}/rollback',{}).then(()=>location.reload())">Undo last refresh</button>
<button onclick="confirm('Delete this data source and its assistant tool?')&&api('/sources/${esc(source.id)}/delete',{}).then(()=>location='/sources')">Delete</button>
</p>
<p><small>Checks for changes ${source.schedule_minutes >= 1440 ? "once a day" : source.schedule_minutes >= 360 ? "every 6 hours" : "every hour"};
next check ${esc(source.next_run_at ? timeAgo(source.next_run_at).replace(" ago", " from now").replace("just now", "any moment") : "-")}.
A refresh never breaks live answers - the old data keeps serving until the new data is verified.</small></p>
${qualitySection(quality)}
<h2>What customers asked</h2>
${calls.length === 0 ? `<p><small>No questions yet - once your assistant starts using this, every question shows up here.</small></p>` : `
<table><tr><th>When</th><th>Question</th><th>Answers</th><th>Speed</th></tr>
${calls.map((c) => {
  let q = c.args_json;
  try { q = JSON.parse(c.args_json).query || c.args_json; } catch { /* raw */ }
  return `<tr><td>${esc(timeAgo(c.ts))}</td><td>${esc(String(q).slice(0, 90))}</td><td>${esc(c.result_count ?? "-")}</td><td>${esc(c.took_ms)}ms</td></tr>`;
}).join("")}</table>`}
<details><summary style="cursor:pointer;font-weight:600;margin:1.5rem 0 .5rem">For developers: instant updates &amp; history</summary>
<p>Push updates the moment something changes (live pricing, stock):</p>
<pre>curl -X POST -H "x-push-secret: ${esc(source.push_secret ?? "")}" \\
  {your-instance-url}/api/push/${esc(source.id)}/refresh</pre>
${source.type === "csv" ? `<pre>curl -X POST -H "x-push-secret: ${esc(source.push_secret ?? "")}" \\
  -H "content-type: text/csv" --data-binary @prices.csv \\
  {your-instance-url}/api/push/${esc(source.id)}/content</pre>` : ""}
<small>The push secret is separate from the tool secret - reads and writes never share a credential.</small>
<h2>Sync history</h2>
<table><tr><th>Started</th><th>Status</th><th>Items</th><th>Error</th></tr>
${runs.map((r) => `<tr><td>${esc(r.started_at)}</td><td>${esc(r.status)}</td><td>${esc(r.items_count ?? "-")}</td><td>${esc(r.error ? humanizeError(r.error) : "")}</td></tr>`).join("")}</table>
</details>`);
};
