export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function layoutPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - KB Bridge</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:light}body{font:15px/1.5 system-ui;margin:2rem auto;max-width:860px;padding:0 1rem;color:#111;background:#fff}
nav a{margin-right:1rem}.chip{padding:2px 8px;border-radius:10px;font-size:12px}
.chip.active{background:#d4f7dc}.chip.stale{background:#fff3cd}.chip.error{background:#f8d7da}
.chip.syncing,.chip.never_synced{background:#e2e3e5}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}input,select,textarea{width:100%;padding:6px;margin:4px 0}
button{padding:8px 14px;cursor:pointer}.err{color:#b00}.warn{background:#fff3cd;padding:8px;border-radius:6px}
fieldset{margin:8px 0}</style></head>
<body><nav><a href="/sources">Sources</a><a href="/connect">Connection</a>
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
</script></body></html>`;
}

const authForm = (action, label) => `
<h1>${label}</h1><form onsubmit="api('${action}',formJson(this)).then(o=>o.ok&&(location='/setup'));return false">
<input name="email" type="email" placeholder="email" required>
<input name="password" type="password" placeholder="password (min 10 chars)" minlength="10" required>
<button>${label}</button></form>
<p><a href="${action === "/login" ? "/signup" : "/login"}">${action === "/login" ? "Create an account" : "Have an account? Log in"}</a></p>`;

export const loginPage = () => layoutPage("Log in", authForm("/login", "Log in"));
export const signupPage = () => layoutPage("Sign up", authForm("/signup", "Sign up"));

export const connectPage = (conn) => layoutPage("Connection", `
<h1>Assistable connection</h1>
${conn ? `<p>Status: <span class="chip active">connected</span></p>` : `<p>Not connected yet.</p>`}
<form onsubmit="api('/connect',formJson(this)).then(o=>o.ok&&location.reload());return false">
<input name="api_key" type="password" placeholder="Paste your Assistable v3 API key" autocomplete="off" required>
<button>${conn ? "Replace key" : "Connect"}</button></form>
<p>The key is verified against the Assistable API, encrypted at rest, and never shown again.</p>`);

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
<label>Type <select name="type" onchange="document.querySelectorAll('[data-cfg]').forEach(d=>d.style.display=d.dataset.cfg===this.value?'':'none')">
<option value="csv">CSV upload</option><option value="feed">Feed URL</option>
<option value="website">Website</option><option value="database">Postgres / Supabase</option></select></label>
<div data-cfg="csv"><label>CSV file <input type="file" id="csvfile" accept=".csv"></label></div>
<div data-cfg="feed" style="display:none"><label>Feed URL <input name="url" type="url"></label></div>
<div data-cfg="website" style="display:none"><label>Site URL <input name="url" type="url"></label></div>
<div data-cfg="database" style="display:none"><label>Connection string <input name="connection_string"></label>
<label>Table or view <input name="table"></label></div>
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
</ol>`);
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
<h2>Sync history</h2>
<table><tr><th>Started</th><th>Status</th><th>Items</th><th>Error</th></tr>
${runs.map((r) => `<tr><td>${esc(r.started_at)}</td><td>${esc(r.status)}</td><td>${esc(r.items_count ?? "-")}</td><td>${esc(r.error ?? "")}</td></tr>`).join("")}</table>
<h2>Recent agent queries</h2>
<table><tr><th>When</th><th>Args</th><th>Results</th><th>ms</th></tr>
${calls.map((c) => `<tr><td>${esc(c.ts)}</td><td><code>${esc(c.args_json.slice(0, 120))}</code></td><td>${esc(c.result_count ?? "-")}</td><td>${esc(c.took_ms)}</td></tr>`).join("")}</table>
${unanswered.length ? `<h2>Unanswered queries (0 results)</h2><ul>
${unanswered.map((u) => `<li><code>${esc(u.args_json.slice(0, 140))}</code> - asked ${esc(u.n)}x</li>`).join("")}</ul>
<p>Fix these by adding the missing items to your data, or extending aliases.</p>` : ""}`);
