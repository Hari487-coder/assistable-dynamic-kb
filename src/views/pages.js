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

export const sourcesPage = (sources) => layoutPage("Sources", `
<h1>Dynamic sources</h1><p><a href="/sources/new">+ Add source</a></p>
<table><tr><th>Name</th><th>Type</th><th>Status</th><th>Last sync</th></tr>
${sources.map((s) => `<tr><td><a href="/sources/${esc(s.id)}">${esc(s.name)}</a></td><td>${esc(s.type)}</td>
<td><span class="chip ${esc(s.status)}">${esc(s.status)}</span></td><td>${esc(s.last_sync_at ?? "never")}</td></tr>`).join("")}
</table>`);

export const newSourcePage = (assistants, notConnected) => layoutPage("New source", `
<h1>New dynamic source</h1>
${notConnected ? `<p class="warn">Connect your Assistable account first - the tool can't be created without it.</p>` : ""}
<form onsubmit="submitSource(this);return false">
<label>Name <input name="name" required maxlength="60"></label>
<label>Type <select name="type" onchange="document.querySelectorAll('[data-cfg]').forEach(d=>{const on=d.dataset.cfg===this.value;d.style.display=on?'':'none';d.querySelectorAll('input').forEach(i=>i.disabled=!on)})">
<option value="csv">CSV upload</option><option value="feed">Feed URL</option>
<option value="website">Website (pages &amp; text)</option><option value="webtable">Price table on a web page</option>
<option value="database">Postgres / Supabase</option></select></label>
<div data-cfg="csv"><label>CSV file <input type="file" id="csvfile" accept=".csv"></label></div>
<div data-cfg="feed" style="display:none"><label>Feed URL <input name="url_feed" type="url" disabled></label></div>
<div data-cfg="website" style="display:none"><label>Site URL <input name="url_site" type="url" disabled></label></div>
<div data-cfg="webtable" style="display:none"><label>Page URL with the table (e.g. your prices page) <input name="url_table" type="url" disabled></label></div>
<div data-cfg="database" style="display:none"><label>Connection string <input name="connection_string" disabled></label>
<label>Table or view <input name="table" disabled></label></div>
<label>Re-sync every <select name="schedule_minutes"><option value="1440">day</option>
<option value="360">6 hours</option><option value="60">hour</option></select></label>
<fieldset><legend>Attach to assistants</legend>
${assistants.map((a) => `<label><input type="checkbox" name="assistant" value="${esc(a.id)}"> ${esc(a.name)}</label>`).join("")}
</fieldset><button>Create + provision tool</button></form>
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

export const setupPage = (state) => {
  const toolName = state.firstTool?.tool_id ? state.firstToolName : "your live data tool";
  const snippet = `For ANY question about ${state.firstSourceName || "your live data"}, ALWAYS call ${toolName} first and answer only from the result. If it returns nothing, say you don't have that information. When a speech_hint is present, read it aloud. If data_freshness is "stale", say the info is as of the last update.`;
  return layoutPage("Setup", `
<h1>Set up your Live KB</h1>
<p>Four steps and your Assistable agents answer from live data - on calls and in chat.</p>
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

export const sourceDetailPage = (source, runs, tool, calls, unanswered) => layoutPage(source.name, `
<h1>${esc(source.name)} <span class="chip ${esc(source.status)}">${esc(source.status)}</span></h1>
<p>Type: ${esc(source.type)} - last sync ${esc(source.last_sync_at ?? "never")} - next ${esc(source.next_run_at ?? "-")}</p>
${tool?.tool_id ? `<p>Tool: <code>${esc(tool.tool_id)}</code> on ${esc(JSON.parse(tool.assistant_ids_json).length)} assistant(s)</p>` : ""}
${tool?.last_error ? `<p class="err">Tool provisioning error: ${esc(tool.last_error)}</p>` : ""}
${tool && tool.updated_at > tool.created_at ? `<p class="warn">Voice agents cache the tool schema - re-save the assistant in Assistable to refresh voice.</p>` : ""}
<p>
<button onclick="api('/sources/${esc(source.id)}/sync',{}).then(()=>location.reload())">Sync now</button>
<button onclick="api('/sources/${esc(source.id)}/sync',{force:true}).then(()=>location.reload())">Force sync</button>
<button onclick="api('/sources/${esc(source.id)}/rollback',{}).then(()=>location.reload())">Roll back</button>
<button onclick="confirm('Delete source and its Assistable tool?')&&api('/sources/${esc(source.id)}/delete',{}).then(()=>location='/sources')">Delete</button>
</p>
<h2>Live update API</h2>
<p>For real-time data (live pricing, stock changes): call these from your own
system the moment something changes - answers update in seconds, no schedule wait.</p>
<p><b>Trigger a re-sync now</b> (any source type):</p>
<pre>curl -X POST -H "x-push-secret: ${esc(source.push_secret ?? "")}" \\
  {your-instance-url}/api/push/${esc(source.id)}/refresh</pre>
${source.type === "csv" ? `<p><b>Push replacement content directly</b> (CSV sources):</p>
<pre>curl -X POST -H "x-push-secret: ${esc(source.push_secret ?? "")}" \\
  -H "content-type: text/csv" --data-binary @prices.csv \\
  {your-instance-url}/api/push/${esc(source.id)}/content</pre>` : ""}
<small>The push secret is separate from the tool secret - reads and writes never share a credential.</small>
<h2>Sync history</h2>
<table><tr><th>Started</th><th>Status</th><th>Items</th><th>Error</th></tr>
${runs.map((r) => `<tr><td>${esc(r.started_at)}</td><td>${esc(r.status)}</td><td>${esc(r.items_count ?? "-")}</td><td>${esc(r.error ?? "")}</td></tr>`).join("")}</table>
<h2>Recent agent queries</h2>
<table><tr><th>When</th><th>Args</th><th>Results</th><th>ms</th></tr>
${calls.map((c) => `<tr><td>${esc(c.ts)}</td><td><code>${esc(c.args_json.slice(0, 120))}</code></td><td>${esc(c.result_count ?? "-")}</td><td>${esc(c.took_ms)}</td></tr>`).join("")}</table>
${unanswered.length ? `<h2>Unanswered queries (0 results)</h2><ul>
${unanswered.map((u) => `<li><code>${esc(u.args_json.slice(0, 140))}</code> - asked ${esc(u.n)}x</li>`).join("")}</ul>
<p>Fix these by adding the missing items to your data, or extending aliases.</p>` : ""}`);
