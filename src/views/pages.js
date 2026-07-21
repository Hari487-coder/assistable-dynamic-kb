export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function layoutPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - Live KB</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* iOS grouped-list idiom. The portal is a settings app in disguise: rows of
   status, a checklist, detail screens. The grouped table view solves that
   layout better than cards-on-white, so the structure is borrowed honestly:
   grey canvas, white groups at 10px radii, separators inset past the label,
   one tint for everything interactive. Tint is Assistable violet, not Apple
   blue, because the brand outranks the reference. */
:root{color-scheme:light;
--canvas:#f2f2f7;--group:#fff;
--label:#0a0a0a;--label-2:#4a5565;--label-3:#6a7282;
--separator:#e3e3ea;--separator-strong:#d1d1d8;
--tint:#7c3aed;--tint-press:#6b2fd6;--tint-wash:#f5f0ff;--on-tint:#fff;
--good:#0f7a52;--good-tint:#e6f6ee;--good-tint-border:#c3e6d5;
--warning:#a35c0c;--warning-tint:#fdf4e6;--warning-tint-border:#f0dcb8;
--critical:#c5364c;--critical-tint:#fdecef;--critical-tint-border:#f6c9d1;
--fill:#7878801f;--fill-2:#78788014;
--r-group:10px;--r-control:8px;--r-pill:980px;
--font-body:Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--font-display:var(--font-body);
--font-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}

*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--canvas);color:var(--label);
font:17px/1.47 var(--font-body);-webkit-font-smoothing:antialiased;letter-spacing:-.01em}
.shell{max-width:44rem;margin:0 auto;padding:0 1rem 5rem}

/* Nav: translucent chrome that content scrolls under, as a navigation bar
   does. Solid fallback where backdrop-filter is unsupported. */
nav{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:.15rem;
margin:0 -1rem 1.25rem;padding:.6rem 1rem;background:rgba(242,242,247,.82);
backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);
border-bottom:.5px solid var(--separator);overflow-x:auto;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
nav{background:var(--canvas)}}
nav .brand{font-weight:600;font-size:1.02rem;letter-spacing:-.02em;padding:.2rem .5rem .2rem 0;
margin-right:auto;white-space:nowrap;color:var(--label)}
nav .brand em{color:var(--tint);font-style:normal}
nav a{color:var(--tint);text-decoration:none;padding:.35rem .6rem;border-radius:var(--r-control);
font-size:.95rem;white-space:nowrap;min-height:38px;display:inline-flex;align-items:center}
nav a:active{background:var(--fill-2)}

h1{font-weight:600;font-size:1.95rem;line-height:1.15;letter-spacing:-.032em;margin:.6rem 0 .5rem}
h2{font-weight:600;font-size:1.06rem;letter-spacing:-.015em;margin:2rem 0 .5rem;color:var(--label)}
h3{font-weight:600;font-size:.95rem;margin:1.2rem 0 .3rem}
p{color:var(--label-2);margin:.45rem 0}
p b{color:var(--label)}
small{color:var(--label-3);font-size:.83rem;line-height:1.4;display:inline-block}

/* Grouped containers: white group on grey canvas, no border, no shadow. */
.card,form,fieldset,table,pre,.tile{background:var(--group);border:none;
border-radius:var(--r-group);box-shadow:none}
.card,form{padding:1rem 1.05rem;margin:.6rem 0}
fieldset{margin:.7rem 0;padding:.9rem 1.05rem;border:none}
legend{font-weight:600;color:var(--label);padding:0;font-size:.95rem}

/* Setup checklist as one inset grouped list, separators starting past the
   numeral the way a list insets past an icon. */
ol{padding:0;margin:.6rem 0;list-style:none;counter-reset:step;
background:var(--group);border-radius:var(--r-group);overflow:hidden}
ol>li{counter-increment:step;position:relative;padding:.95rem 1.05rem .95rem 3.1rem;
border-bottom:.5px solid var(--separator);background:none;border-radius:0;margin:0;box-shadow:none}
ol>li:last-child{border-bottom:none}
ol>li::before{content:counter(step);position:absolute;left:1.05rem;top:.95rem;
width:1.5rem;height:1.5rem;background:var(--tint);color:var(--on-tint);
border-radius:50%;display:flex;align-items:center;justify-content:center;
font-weight:600;font-size:.78rem}

.chip{padding:.15rem .55rem;border-radius:var(--r-pill);font-size:.76rem;font-weight:600;
vertical-align:middle;white-space:nowrap;letter-spacing:0}
.chip.active{background:var(--good-tint);color:var(--good);border:.5px solid var(--good-tint-border)}
.chip.stale{background:var(--warning-tint);color:var(--warning);border:.5px solid var(--warning-tint-border)}
.chip.error{background:var(--critical-tint);color:var(--critical);border:.5px solid var(--critical-tint-border)}
.chip.syncing,.chip.never_synced{background:var(--fill-2);color:var(--label-3);border:.5px solid var(--separator)}

.tiles{display:flex;gap:.55rem;flex-wrap:wrap;margin:.6rem 0}
.tile{flex:1 1 8rem;padding:.85rem .95rem}
.tile b{display:block;font-size:1.6rem;font-weight:600;line-height:1.1;letter-spacing:-.03em;
font-variant-numeric:tabular-nums;color:var(--label)}
.tile span{font-size:.8rem;color:var(--label-3)}
.tile.good b{color:var(--good)}.tile.warning b{color:var(--warning)}.tile.critical b{color:var(--critical)}

/* Tables become grouped lists: hairlines, quiet caption header, no shading. */
.scroller{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:var(--r-group);background:var(--group)}
table{border-collapse:collapse;width:100%;font-size:.94rem;overflow:hidden}
th{background:none;color:var(--label-3);font-weight:500;font-size:.76rem;
text-transform:uppercase;letter-spacing:.05em;padding:.7rem 1.05rem .4rem}
td{padding:.72rem 1.05rem;color:var(--label-2);font-variant-numeric:tabular-nums}
td,th{text-align:left;border-bottom:.5px solid var(--separator)}
td:first-child{color:var(--label)}
tr:last-child td{border-bottom:none}

input,select,textarea{width:100%;padding:.7rem .85rem;margin:.3rem 0;
border:.5px solid var(--separator-strong);border-radius:var(--r-control);font:inherit;
font-size:1rem;background:var(--group);color:var(--label);min-height:44px}
input::placeholder,textarea::placeholder{color:var(--label-3)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--tint);
box-shadow:0 0 0 3.5px color-mix(in srgb,var(--tint) 18%,transparent)}
label{display:block;margin:.7rem 0;font-size:.95rem;color:var(--label)}

/* Filled tint for the primary action, tinted grey for the rest. 44px minimum
   because these get tapped on a phone. */
button{padding:.62rem 1.1rem;cursor:pointer;background:var(--tint);color:var(--on-tint);border:none;
border-radius:var(--r-control);font:inherit;font-weight:600;font-size:.94rem;min-height:44px;
transition:transform .08s ease,opacity .12s ease}
button:hover{background:var(--tint-press)}
button:active{transform:scale(.97);opacity:.85}
button:disabled{background:var(--fill);color:var(--label-3);cursor:not-allowed;transform:none}
button.ghost,p>button,td button{background:var(--fill-2);color:var(--tint);border:none;font-weight:500}
button.ghost:hover,p>button:hover,td button:hover{background:var(--fill)}

code{font-family:var(--font-mono);font-size:.85em;background:var(--fill-2);padding:.12rem .38rem;
border-radius:5px;color:var(--label)}
pre{font-family:var(--font-mono);font-size:.8rem;padding:.9rem 1.05rem;overflow-x:auto;
color:var(--label-2);line-height:1.55}
a{color:var(--tint);text-decoration:none}
a:hover{text-decoration:underline}
.err{color:var(--critical)}
.warn{background:var(--warning-tint);border:.5px solid var(--warning-tint-border);color:var(--warning);
padding:.75rem .95rem;border-radius:var(--r-group);font-size:.92rem}
details{background:var(--group);border-radius:var(--r-group);padding:.85rem 1.05rem;margin:1.2rem 0}
details summary{cursor:pointer;color:var(--tint);font-weight:500}
:focus-visible{outline:2.5px solid var(--tint);outline-offset:2px;border-radius:var(--r-control)}

#bar{position:fixed;top:0;left:0;height:2.5px;width:0;background:var(--tint);
transition:width .25s ease;z-index:9}
body.busy #bar{width:75%}
body.busy button{pointer-events:none;opacity:.5}
body.busy{cursor:progress}
/* Toast rises from the bottom like a system banner. */
#toast{position:fixed;left:50%;bottom:1.1rem;transform:translateX(-50%) translateY(1.5rem);opacity:0;
pointer-events:none;max-width:min(28rem,92vw);background:rgba(28,28,30,.94);color:#fff;
backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
border-radius:14px;padding:.8rem 1.1rem;font-size:.94rem;line-height:1.4;
transition:opacity .22s ease,transform .22s cubic-bezier(.16,1,.3,1);z-index:10}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#toast.ok{background:rgba(15,122,82,.95)}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media (max-width:560px){
body{font-size:16px}
.shell{padding:0 .85rem 4rem}
h1{font-size:1.7rem}
.tile{flex:1 1 100%}
td,th{padding:.65rem .85rem}
}
</style></head>
<body><div id="bar"></div><div id="toast" role="status" aria-live="polite"></div>
<div class="shell"><nav><span class="brand">Live<em>KB</em></span><a href="/setup">Setup</a><a href="/sources">Sources</a><a href="/connect">Connection</a>
<a href="#" onclick="api('/logout',{}).then(()=>location='/login');return false">Log out</a></nav>
${body}
<script>
let toastTimer;
function toast(message, ok){
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('ok', !!ok);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), 6000);
}
async function api(path, body){
  document.body.classList.add('busy');
  try {
    const r = await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-requested-with':'kb-bridge'},body:JSON.stringify(body)});
    const out = await r.json().catch(()=>({ok:false,error:'Something went wrong (HTTP '+r.status+'). Try again.'}));
    if(!out.ok && out.error) toast(out.error);
    return out;
  } catch(err) {
    toast("Couldn't reach your Live KB. Check the instance is running, then try again.");
    return {ok:false,error:String(err)};
  } finally {
    document.body.classList.remove('busy');
  }
}
function formJson(f){const o={};new FormData(f).forEach((v,k)=>{o[k]=v});return o}
</script></div></body></html>`;
}

const authForm = (action, label, extraFields = "") => `
<h1>${label}</h1><form onsubmit="api('${action}',formJson(this)).then(o=>o.ok&&(location='/setup'));return false">
<input name="email" type="email" placeholder="email" autocomplete="email" required>
<input name="password" type="password" placeholder="password (min 10 chars)" minlength="10" autocomplete="${action === "/login" ? "current-password" : "new-password"}" required>
${extraFields}
<button>${label}</button></form>
<p><a href="${action === "/login" ? "/signup" : "/login"}">${action === "/login" ? "Create an account" : "Have an account? Log in"}</a></p>`;

export const loginPage = () => layoutPage("Log in", authForm("/login", "Log in"));
export const signupPage = (needsSetupToken = false) => layoutPage("Sign up", authForm("/signup", "Sign up",
  needsSetupToken ? `<input name="setup_token" type="password" placeholder="setup token (the SETUP_TOKEN you deployed with)" autocomplete="off" required>
<small>This instance asks the first account to prove it owns the deployment.</small>` : ""));

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
<form onsubmit="doConnect(this);return false">
<label>Your Assistable v3 API key
<input name="api_key" type="password" placeholder="Paste the key here" autocomplete="off" required></label>
<label>Subaccount / Location ID <small>- only needed if your key covers more than one subaccount</small>
<input name="subaccount_id" placeholder="optional" autocomplete="off"></label>
<button>${conn ? "Replace key" : "Connect"}</button></form>
<p id="connect-error" class="warn" style="display:none"></p>
<p><small>The key is verified live against the Assistable API before it is accepted. If it
fails, the exact reason from Assistable is shown above so you know what to change.</small></p>
<script>
async function doConnect(f){
  const box = document.getElementById('connect-error');
  box.style.display = 'none';
  const r = await fetch('/connect',{method:'POST',headers:{'content-type':'application/json','x-requested-with':'kb-bridge'},body:JSON.stringify(formJson(f))});
  const out = await r.json().catch(()=>({ok:false,error:'Unexpected response ('+r.status+')'}));
  if (out.ok) { location.reload(); return; }
  box.textContent = out.error;
  box.style.display = '';
  if (out.needs_subaccount) f.subaccount_id.focus();
}
</script>`);

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
<div class="scroller"><table><tr><th>Name</th><th>Kind</th><th>Status</th><th>Updated</th></tr>
${sources.map((s) => {
  const st = humanizeStatus(s);
  return `<tr><td><a href="/sources/${esc(s.id)}">${esc(s.name)}</a></td><td>${esc(TYPE_LABELS[s.type] ?? s.type)}</td>
<td><span class="chip ${esc(st.tone)}">${esc(st.label)}</span></td><td>${esc(timeAgo(s.last_sync_at))}</td></tr>`;
}).join("")}
</table></div>`}`);

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
On Render's free tier the disk resets on redeploys - download a backup after big changes.</small></p>
${state.keyFromEnv ? "" : `<p class="warn"><b>Set ENCRYPTION_KEY before you rely on backups.</b>
Your encryption key was auto-generated on this instance's disk. If the host resets the disk
(Render's free tier does on every redeploy), the key is destroyed with it - and the API keys and
source settings inside your downloaded backups can never be decrypted again. Copy
<code>data/.encryption-key</code> into an <code>ENCRYPTION_KEY</code> environment variable on your
host now; env vars survive wipes.</p>`}`);
};

const statTile = (value, label, tone = "") =>
  `<div class="tile${tone ? ` ${tone}` : ""}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

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
<div class="tiles">
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
<div class="scroller"><table><tr><th>When</th><th>Question</th><th>Answers</th><th>Speed</th></tr>
${calls.map((c) => {
  let q = c.args_json;
  try { q = JSON.parse(c.args_json).query || c.args_json; } catch { /* raw */ }
  return `<tr><td>${esc(timeAgo(c.ts))}</td><td>${esc(String(q).slice(0, 90))}</td><td>${esc(c.result_count ?? "-")}</td><td>${esc(c.took_ms)}ms</td></tr>`;
}).join("")}</table></div>`}
<details><summary style="cursor:pointer;font-weight:600;margin:1.5rem 0 .5rem">For developers: instant updates &amp; history</summary>
<p>Push updates the moment something changes (live pricing, stock):</p>
<pre>curl -X POST -H "x-push-secret: ${esc(source.push_secret ?? "")}" \\
  {your-instance-url}/api/push/${esc(source.id)}/refresh</pre>
${source.type === "csv" ? `<pre>curl -X POST -H "x-push-secret: ${esc(source.push_secret ?? "")}" \\
  -H "content-type: text/csv" --data-binary @prices.csv \\
  {your-instance-url}/api/push/${esc(source.id)}/content</pre>` : ""}
<small>The push secret is separate from the tool secret - reads and writes never share a credential.</small>
<h2>Sync history</h2>
<div class="scroller"><table><tr><th>Started</th><th>Status</th><th>Items</th><th>Error</th></tr>
${runs.map((r) => `<tr><td>${esc(r.started_at)}</td><td>${esc(r.status)}</td><td>${esc(r.items_count ?? "-")}</td><td>${esc(r.error ? humanizeError(r.error) : "")}</td></tr>`).join("")}</table></div>
</details>`);
};
