const $ = s => document.querySelector(s);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let chats = store.get('alpha.chats', []);
let outbox = store.get('alpha.outbox', []);
let settings = { key: '', system: '', model: '', mode: 'ask', theme: 'dark', ...store.get('alpha.settings', {}) };
let cur = null, busy = null, agentAllowed = true, raf = 0, attachments = [];
const pluginDefs = [{id:'workspace',name:'Workspace tools',desc:'Create, read and organise project files.',icon:'▤',core:true},{id:'voice',name:'Voice input',desc:'Dictate messages using your device speech engine.',icon:'♩',core:true},{id:'web',name:'Web Research',desc:'Search the live web and collect source links for your research.',icon:'🌐',integration:true},{id:'drive',name:'Cloud Storage',desc:'Browse Google Drive and upload text files to your cloud storage.',icon:'☁️',integration:true},{id:'calendar',name:'Calendar',desc:'View upcoming Google Calendar events and create new events.',icon:'📅',integration:true},{id:'gmail',name:'Gmail',desc:'Search and preview recent Gmail messages.',icon:'✉️',integration:true},{id:'docs',name:'Google Docs',desc:'Create documents and browse your recent Google Docs.',icon:'📄',integration:true},{id:'dropbox',name:'Dropbox',desc:'Browse files and upload notes to Dropbox.',icon:'📦',integration:true},{id:'onedrive',name:'OneDrive',desc:'Browse files and upload notes to Microsoft OneDrive.',icon:'☁️',integration:true}];
let plugins = {workspace:true,voice:true,...store.get('alpha.plugins',{})};

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const save = () => { store.set('alpha.chats', chats); store.set('alpha.outbox', outbox); store.set('alpha.settings', settings); };
const hdr = () => ({ 'Content-Type': 'application/json', 'x-alpha-key': settings.key });
const fileUrl = p => `/api/files/${p.split('/').map(encodeURIComponent).join('/')}?key=${encodeURIComponent(settings.key)}`;
const flat = m => m.role === 'user' ? m.content
  : m.blocks.filter(b => b.t === 'text').map(b => b.v).join('\n') +
    (m.blocks.some(b => b.file) ? '\n[Files created: ' + m.blocks.filter(b => b.file).map(b => b.file).join(', ') + ']' : '');

/* ---------- markdown ---------- */
function md(src) {
  const codes = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, l, c) => { codes.push({ l, c }); return `\u0000${codes.length - 1}\u0000`; });
  let h = esc(src)
    .replace(/^(#{1,4})\s+(.+)$/gm, (_, a, t) => `<h${a.length + 1}>${t}</h${a.length + 1}>`)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^(?:[-*]\s.+(?:\n|$))+/gm, m => '<ul>' + m.trim().split('\n').map(l => '<li>' + l.replace(/^[-*]\s/, '') + '</li>').join('') + '</ul>')
    .replace(/^(?:\d+\.\s.+(?:\n|$))+/gm, m => '<ol>' + m.trim().split('\n').map(l => '<li>' + l.replace(/^\d+\.\s/, '') + '</li>').join('') + '</ol>');
  h = h.split(/\n{2,}/).map(p => /^(<(h\d|ul|ol)|\u0000)/.test(p.trim()) ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const { l, c } = codes[i];
    return `<div class="code"><div class="code-h"><span>${esc(l || 'text')}</span><button type="button" data-copy>Copy</button></div><pre><code>${esc(c.replace(/\n$/, ''))}</code></pre></div>`;
  });
}

/* ---------- rendering ---------- */
function blockHtml(b) {
  if (b.t === 'text') return md(b.v);
  if (b.t === 'error') return `<div class="err">${esc(b.v)}</div>`;
  const a = b.args || {};
  const title = b.name === 'run_command' ? '$ ' + esc(a.command || '') : b.name === 'write_file' ? 'Write ' + esc(a.path || '')
    : b.name === 'read_file' ? 'Read ' + esc(a.path || '') : 'List files';
  const label = { run: 'running', approve: 'needs approval', done: 'done', denied: 'denied' }[b.state] || '';
  const act = b.state === 'approve'
    ? `<div class="act"><button class="primary" data-approve="${b.id}" data-allow="1">Run command</button><button data-approve="${b.id}" data-allow="0">Deny</button></div>` : '';
  const out = b.output ? `<pre>${esc(b.output)}</pre>` : '';
  const file = b.file ? `<a class="file" href="${fileUrl(b.file)}" download>Download ${esc(b.file)}</a>` : '';
  return `<details class="tool ${b.state}" ${b.state !== 'done' ? 'open' : ''}><summary><b>${title}</b><em>${label}</em></summary>${act}${out}${file}</details>`;
}
function msgEl(m, live) {
  const d = document.createElement('div');
  d.className = 'msg ' + m.role;
  if (m.role === 'user') { const content = typeof m.content === 'string' ? m.content : ''; const names = (m.attachments || []).map(f => `<span class="chip">▧ ${esc(f.name)}</span>`).join(' '); d.innerHTML = `<div class="bubble">${esc(content)}${names ? '<div style="margin-top:8px">'+names+'</div>' : ''}</div>`; return d; }
  fillAssistant(d, m, live);
  return d;
}
function fillAssistant(d, m, live) {
  d.innerHTML = `<div class="av">α</div><div class="body">${m.notice ? `<div class="chip">${esc(m.notice)}</div>` : ''}${m.blocks.map(blockHtml).join('')}` +
    (m.queued ? '<div class="chip">Queued. Alpha will send this when you are back online.</div>' : '') +
    (live && !m.blocks.length ? '<span class="dots"></span>' : '') + '</div>';
}
function renderAll() {
  const box = $('#msgs');
  box.innerHTML = '';
  if (!cur || !cur.msgs.length) {
    box.innerHTML = `<div class="empty"><img class="hero-logo" src="icon.svg" alt="Alpha"><h1>Make something <span>brilliant.</span></h1><p>Your ideas, files and AI tools — all in one calm workspace.</p>
      <div class="sugg">${['Build a landing page and give me the files', 'Write a Python script that renames photos by date, then test it', 'Explain how transformers work, simply', 'Create a CSV of 20 sample customers'].map(s => `<button type="button" data-sugg="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
  } else {
    const w = document.createElement('div'); w.className = 'wrap';
    cur.msgs.forEach((m, i) => w.append(msgEl(m, busy && i === cur.msgs.length - 1)));
    box.append(w);
    box.scrollTop = box.scrollHeight;
  }
  renderList();
}
function renderLive() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const els = document.querySelectorAll('#msgs .msg.assistant');
    const el = els[els.length - 1], m = cur?.msgs.at(-1);
    if (!el || !m) return;
    const box = $('#msgs'), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    fillAssistant(el, m, !!busy);
    if (stick) box.scrollTop = box.scrollHeight;
  });
}
function renderList() {
  const q = $('#search').value.toLowerCase();
  $('#list').innerHTML = chats.filter(c => c.title.toLowerCase().includes(q)).sort((a, b) => b.ts - a.ts)
    .map(c => `<div class="item ${c === cur ? 'on' : ''}" data-id="${c.id}"><span>${esc(c.title)}</span><button data-del="${c.id}" aria-label="Delete chat">×</button></div>`).join('');
}

/* ---------- chat flow ---------- */
function newChat() {
  cur = { id: crypto.randomUUID(), title: 'New chat', ts: Date.now(), msgs: [] };
  chats.push(cur); return cur;
}
async function send(text) {
  text = text.trim();
  if ((!text && !attachments.length) || busy) return;
  const c = cur || newChat();
  const attached = attachments.map(f => ({name:f.name, content:f.content}));
  const fullText = text + (attached.length ? '\n\n' + attached.map(f => `--- Attached file: ${f.name} ---\n${f.content}`).join('\n\n') : '');
  c.msgs.push({ role: 'user', content: fullText, attachments: attached.map(f => ({name:f.name})) });
  attachments = []; renderAttachments();
  if (c.msgs.length === 1) c.title = text.slice(0, 50);
  const a = { role: 'assistant', blocks: [] };
  c.msgs.push(a); c.ts = Date.now();
  $('#input').value = ''; resize();
  if (!navigator.onLine) { a.queued = true; outbox.push(c.id); save(); renderAll(); return; }
  save(); renderAll();
  run(c, a);
}
async function run(c, a) {
  a.queued = false; a.blocks = []; a.notice = '';
  busy = new AbortController(); setBusy(true); renderAll();
  const history = c.msgs.slice(0, c.msgs.indexOf(a)).map(m => ({ role: m.role, content: flat(m) })).filter(m => m.content);
  const lastText = () => {
    let b = a.blocks.at(-1);
    if (!b || b.t !== 'text') { b = { t: 'text', v: '' }; a.blocks.push(b); }
    return b;
  };
  const tool = id => a.blocks.find(b => b.t === 'tool' && b.id === id);
  const on = e => {
    if (e.type === 'text') lastText().v += e.text;
    else if (e.type === 'reset') { const b = a.blocks.at(-1); if (b?.t === 'text') b.v = ''; }
    else if (e.type === 'notice') a.notice = e.message;
    else if (e.type === 'tool') a.blocks.push({ t: 'tool', id: e.id, name: e.name, args: e.args, state: 'run' });
    else if (e.type === 'approval') { const b = tool(e.id); if (b) b.state = 'approve'; }
    else if (e.type === 'tool_result') { const b = tool(e.id); if (b) { b.output = e.output; b.file = e.file; b.state = e.output.startsWith('The user denied') ? 'denied' : 'done'; } }
    else if (e.type === 'error') a.blocks.push({ t: 'error', v: e.message });
    renderLive();
  };
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', signal: busy.signal, headers: hdr(),
      body: JSON.stringify({ messages: history, model: $('#model').value.trim() || undefined, mode: $('#mode').value, system: settings.system }),
    });
    if (r.status === 401) { $('#settings').showModal(); throw new Error('Access key needed. Enter it in Settings.'); }
    if (!r.ok) throw new Error('Server error ' + r.status);
    const rd = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith('data:')) try { on(JSON.parse(line.slice(5))); } catch {}
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') { if (!a.blocks.length) a.blocks.push({ t: 'text', v: '_Stopped._' }); }
    else a.blocks.push({ t: 'error', v: navigator.onLine ? e.message : 'You are offline. Your chats are still here.' });
  } finally {
    a.blocks.forEach(b => { if (b.t === 'tool' && (b.state === 'run' || b.state === 'approve')) b.state = 'denied'; });
    busy = null; setBusy(false); save(); renderAll();
  }
}
function setBusy(b) {
  const s = $('#send'); s.textContent = b ? 'Stop' : 'Send'; s.type = b ? 'button' : 'submit';
}
async function flushOutbox() {
  const ids = [...new Set(outbox)]; outbox = []; save();
  for (const id of ids) {
    const c = chats.find(x => x.id === id), a = c?.msgs.at(-1);
    if (a?.queued) { cur = c; await run(c, a); }
  }
}

/* ---------- files, settings, misc ---------- */
async function loadFiles() {
  try {
    const list = await (await fetch('/api/files', { headers: hdr() })).json();
    $('#files').innerHTML = list.length ? list.map(f => `<div class="f"><a href="${fileUrl(f.path)}" download>${esc(f.path)}</a><small>${f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B'}</small><button data-rm="${esc(f.path)}" aria-label="Delete file">×</button></div>`).join('')
      : '<p class="mute">Nothing yet. Ask Alpha to create a file.</p>';
  } catch { $('#files').innerHTML = '<p class="mute">Files are unavailable offline.</p>'; }
}
async function loadModels() {
  let list = store.get('alpha.models', []);
  try {
    const cfg = await (await fetch('/api/config', { headers: hdr() })).json();
    agentAllowed = cfg.agentAllowed;
    if (!$('#model').value) $('#model').value = cfg.defaultModel;
    list = await (await fetch('/api/models', { headers: hdr() })).json();
    store.set('alpha.models', list);
  } catch {}
  $('#models').innerHTML = list.map(m => `<option value="${esc(m.id)}">${m.free ? 'free' : ''}</option>`).join('');
  if (!agentAllowed) { $('#mode').value = 'off'; [...$('#mode').options].forEach(o => o.disabled = o.value !== 'off'); }
}
function net() {
  $('#net').className = 'net' + (navigator.onLine ? '' : ' off');
  $('#net').title = navigator.onLine ? 'Online' : 'Offline: chats are saved, messages will queue';
}
function resize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; }
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name=theme-color]').content = settings.theme === 'dark' ? '#15122b' : '#f6f5fc';
}
function download(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' })); a.download = name; a.click();
}

/* ---------- events ---------- */
$('#composer').onsubmit = e => { e.preventDefault(); send($('#input').value); };
$('#send').onclick = () => { if (busy) busy.abort(); };
$('#input').oninput = resize;
$('#input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#input').value); } };
$('#newChat').onclick = () => { cur = null; renderAll(); $('#side').classList.remove('open'); $('#input').focus(); };
$('#search').oninput = renderList;
$('#menu').onclick = () => $('#side').classList.toggle('open');
$('#theme').onclick = () => { settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; applyTheme(); save(); };
$('#mode').onchange = () => { settings.mode = $('#mode').value; save(); };
$('#model').onchange = () => { settings.model = $('#model').value; save(); };
$('#pluginsBtn').onclick = () => { renderPlugins(); $('#plugins').showModal(); };
function renderPlugins(){
  $('#pluginList').innerHTML = pluginDefs.map(p => `<div class="plugin-card"><div class="plugin-icon">${p.icon}</div><div class="plugin-info"><b>${p.name}</b><small>${p.desc}</small></div>${p.integration ? `<button type="button" class="plugin-open" data-open-plugin="${p.id}">Open</button>` : `<input type="checkbox" data-plugin="${p.id}" ${plugins[p.id] ? 'checked' : ''} aria-label="Enable ${p.name}">`}</div>`).join('');
  const custom = store.get('alpha.customPlugins', []);
  $('#customPluginList').innerHTML = custom.map((p,i)=>`<div class="plugin-card"><div class="plugin-icon">🔗</div><div class="plugin-info"><b>${esc(p.name)}</b><small>${esc(p.desc||p.url)}</small></div><a class="plugin-open" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a><button type="button" data-remove-custom="${i}" aria-label="Remove plugin">×</button></div>`).join('');
  $('#pluginCount').textContent = (Object.values(plugins).filter(Boolean).length + custom.length) + ' active';
  if (typeof SR !== 'undefined') $('#mic').hidden = !plugins.voice || !SR;
  [...$('#mode').options].forEach(o => { if (o.value !== 'off') o.disabled = !plugins.workspace || !agentAllowed; });
  if (!plugins.workspace) $('#mode').value = 'off';
}
async function integrationRequest(url, options={}) { const r=await fetch(url,{...options,headers:{...hdr(),...(options.headers||{})}}); const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||`Request failed (${r.status})`); return j; }
function pluginPanel(html){ const w=$('#pluginWork'); w.hidden=false; w.innerHTML=html; }
$('#pluginList').addEventListener('click', async e=>{
 const id=e.target.dataset.openPlugin; if(!id) return; const work=$('#pluginWork');
 if(id==='web') { pluginPanel(`<h3>🌐 Web Research</h3><p class="mute">Search the web using Brave Search. Results include source links.</p><label>Research question<input id="researchQuery" placeholder="e.g. Latest advances in solar energy"></label><button class="primary" id="researchGo">Search web</button><div id="integrationOutput" class="integration-output"></div>`); }
 if(id==='drive') { pluginPanel(`<h3>☁️ Google Drive</h3><p class="mute">Browse your Drive files or upload a text file.</p><button class="primary" id="driveLoad">Load recent files</button><label>File name<input id="driveName" value="alpha-note.txt"></label><label>Text content<textarea id="driveContent" rows="3" placeholder="Content to upload"></textarea></label><button class="primary" id="driveUpload">Upload to Drive</button><div id="integrationOutput" class="integration-output"></div>`); }
 if(id==='gmail') { pluginPanel(`<h3>✉️ Gmail</h3><p class="mute">Search and preview recent messages. Alpha does not send or delete email.</p><label>Search query<input id="gmailQuery" placeholder="newer_than:30d" value="newer_than:30d"></label><button class="primary" id="gmailLoad">Search inbox</button><div id="integrationOutput" class="integration-output"></div>`); }
 if(id==='docs') { pluginPanel(`<h3>📄 Google Docs</h3><button class="primary" id="docsLoad">Recent documents</button><label>Document title<input id="docsTitle" value="New Alpha document"></label><label>Document content<textarea id="docsContent" rows="4" placeholder="Write your document…"></textarea></label><button class="primary" id="docsCreate">Create Google Doc</button><div id="integrationOutput" class="integration-output"></div>`); }
 if(id==='dropbox') { pluginPanel(`<h3>📦 Dropbox</h3><button class="primary" id="dropboxLoad">Browse files</button><label>File name<input id="dropboxName" value="alpha-note.txt"></label><label>Text content<textarea id="dropboxContent" rows="3"></textarea></label><button class="primary" id="dropboxUpload">Upload file</button><div id="integrationOutput" class="integration-output"></div>`); }
 if(id==='onedrive') { pluginPanel(`<h3>☁️ Microsoft OneDrive</h3><button class="primary" id="onedriveLoad">Browse files</button><label>File name<input id="onedriveName" value="alpha-note.txt"></label><label>Text content<textarea id="onedriveContent" rows="3"></textarea></label><button class="primary" id="onedriveUpload">Upload file</button><div id="integrationOutput" class="integration-output"></div>`); }
 if(id==='calendar') { pluginPanel(`<h3>📅 Google Calendar</h3><p class="mute">View events in the next 14 days or create an event.</p><button class="primary" id="calendarLoad">Load upcoming events</button><label>Event title<input id="eventTitle" placeholder="Project meeting"></label><label>Start<input id="eventStart" type="datetime-local"></label><label>End<input id="eventEnd" type="datetime-local"></label><button class="primary" id="eventCreate">Create event</button><div id="integrationOutput" class="integration-output"></div>`); }
});
$('#pluginWork').addEventListener('click',async e=>{ const out=$('#integrationOutput'); if(!out)return; out.textContent='Working…'; try {
 if(e.target.id==='researchGo'){ const j=await integrationRequest('/api/research',{method:'POST',body:JSON.stringify({query:$('#researchQuery').value})}); out.innerHTML=(j.answer?`<p>${esc(j.answer)}</p>`:'')+(j.results||[]).map(x=>`<article><b>${esc(x.title||'Source')}</b><p>${esc(x.content||'')}</p><a href="${esc(x.url)}" target="_blank" rel="noopener">Open source ↗</a></article>`).join('')||'No results found.'; }
 else if(e.target.id==='driveLoad'){ const j=await integrationRequest('/api/drive/files'); out.innerHTML=j.length?j.map(f=>`<article><b>${esc(f.name)}</b><p class="mute">${esc(f.mimeType||'File')} · ${f.modifiedTime?new Date(f.modifiedTime).toLocaleString():''}</p>${f.webViewLink?`<a href="${esc(f.webViewLink)}" target="_blank" rel="noopener">Open in Drive ↗</a>`:''}</article>`).join(''):'No Drive files found.'; }
 else if(e.target.id==='driveUpload'){ const j=await integrationRequest('/api/drive/upload',{method:'POST',body:JSON.stringify({name:$('#driveName').value,content:$('#driveContent').value})}); out.innerHTML=`Uploaded <b>${esc(j.name)}</b>. ${j.webViewLink?`<a href="${esc(j.webViewLink)}" target="_blank" rel="noopener">Open in Drive ↗</a>`:''}`; }
 else if(e.target.id==='gmailLoad'){ const j=await integrationRequest('/api/gmail/messages?q='+encodeURIComponent($('#gmailQuery').value)); out.innerHTML=j.length?j.map(m=>`<article><b>${esc(m.subject||'(No subject)')}</b><p>${esc(m.from)} · ${esc(m.date)}</p><p>${esc(m.snippet)}</p></article>`).join(''):'No messages found.'; }
 else if(e.target.id==='docsLoad'){ const j=await integrationRequest('/api/docs/files'); out.innerHTML=j.length?j.map(f=>`<article><b>${esc(f.name)}</b><p class="mute">${esc(f.modifiedTime||'')}</p>${f.webViewLink?`<a href="${esc(f.webViewLink)}" target="_blank" rel="noopener">Open document ↗</a>`:''}</article>`).join(''):'No documents found.'; }
 else if(e.target.id==='docsCreate'){ const j=await integrationRequest('/api/docs/create',{method:'POST',body:JSON.stringify({title:$('#docsTitle').value,content:$('#docsContent').value})}); out.innerHTML=`Created <b>${esc(j.name)}</b>. ${j.webViewLink?`<a href="${esc(j.webViewLink)}" target="_blank" rel="noopener">Open Google Doc ↗</a>`:''}`; }
 else if(e.target.id==='dropboxLoad'){ const j=await integrationRequest('/api/dropbox/files'); out.innerHTML=j.length?j.map(f=>`<article><b>${esc(f.name)}</b><p class="mute">${esc(f['.tag']||'File')} · ${f.size||0} bytes</p></article>`).join(''):'Dropbox folder is empty.'; }
 else if(e.target.id==='dropboxUpload'){ const j=await integrationRequest('/api/dropbox/upload',{method:'POST',body:JSON.stringify({name:$('#dropboxName').value,content:$('#dropboxContent').value})}); out.innerHTML=`Uploaded <b>${esc(j.name)}</b> to Dropbox.`; }
 else if(e.target.id==='onedriveLoad'){ const j=await integrationRequest('/api/onedrive/files'); out.innerHTML=j.length?j.map(f=>`<article><b>${esc(f.name)}</b><p class="mute">${f.size||0} bytes · ${esc(f.lastModifiedDateTime||'')}</p>${f.webUrl?`<a href="${esc(f.webUrl)}" target="_blank" rel="noopener">Open in OneDrive ↗</a>`:''}</article>`).join(''):'OneDrive folder is empty.'; }
 else if(e.target.id==='onedriveUpload'){ const j=await integrationRequest('/api/onedrive/upload',{method:'POST',body:JSON.stringify({name:$('#onedriveName').value,content:$('#onedriveContent').value})}); out.innerHTML=`Uploaded <b>${esc(j.name)}</b> to OneDrive. ${j.webUrl?`<a href="${esc(j.webUrl)}" target="_blank" rel="noopener">Open file ↗</a>`:''}`; }
 else if(e.target.id==='calendarLoad'){ const j=await integrationRequest('/api/calendar/events'); out.innerHTML=j.length?j.map(v=>`<article><b>${esc(v.summary||'(No title)')}</b><p class="mute">${esc(v.start?.dateTime||v.start?.date||'')} – ${esc(v.end?.dateTime||v.end?.date||'')}</p></article>`).join(''):'No upcoming events.'; }
 else if(e.target.id==='eventCreate'){ const j=await integrationRequest('/api/calendar/events',{method:'POST',body:JSON.stringify({summary:$('#eventTitle').value,start:$('#eventStart').value,end:$('#eventEnd').value})}); out.innerHTML=`Created <b>${esc(j.summary)}</b> in Google Calendar.`; }
 else return;
 }catch(err){out.textContent=err.message;}
});
$('#addCustomPlugin').onclick = () => { const name=$('#customPluginName').value.trim(), desc=$('#customPluginDesc').value.trim(), url=$('#customPluginUrl').value.trim(); if(!name || !/^https:\/\//i.test(url)){ alert('Enter a plugin name and a valid https:// website URL.'); return; } const list=store.get('alpha.customPlugins',[]); list.push({name,desc,url}); store.set('alpha.customPlugins',list); $('#customPluginName').value=''; $('#customPluginDesc').value=''; $('#customPluginUrl').value=''; renderPlugins(); };
$('#customPluginList').addEventListener('click',e=>{ const i=e.target.dataset.removeCustom; if(i===undefined)return; const list=store.get('alpha.customPlugins',[]); list.splice(Number(i),1); store.set('alpha.customPlugins',list); renderPlugins(); });
$('#filesBtn').onclick = () => { $('#drawer').hidden = false; loadFiles(); };
$('#closeFiles').onclick = () => $('#drawer').hidden = true;
$('#setBtn').onclick = async () => {
  $('#key').value = settings.key; $('#sys').value = settings.system; $('#credits').textContent = '';
  $('#settings').showModal();
  try { const { left } = await (await fetch('/api/credits', { headers: hdr() })).json(); $('#credits').textContent = left == null ? '' : `OpenRouter credits left: $${left.toFixed(2)}`; } catch {}
};
$('#settings').onclose = () => { settings.key = $('#key').value.trim(); settings.system = $('#sys').value; save(); loadModels(); };
$('#clearAll').onclick = () => { if (confirm('Delete all chats on this device?')) { chats = []; cur = null; save(); renderAll(); } };
$('#export').onclick = () => {
  if (cur?.msgs.length) download((cur.title || 'chat').replace(/[^\w-]+/g, '_') + '.md', cur.msgs.map(m => `### ${m.role === 'user' ? 'You' : 'Alpha'}\n\n${flat(m)}`).join('\n\n'));
};
$('#attach').onclick = () => $('#file').click();
$('#file').onchange = async e => {
  for (const f of [...e.target.files]) {
    if (f.size > 200000) { alert(`${f.name} is over the 200 KB limit.`); continue; }
    if (!/\.(txt|md|csv|json|js|ts|jsx|tsx|html|css|py|java|c|cpp|xml|ya?ml|log|sql)$/i.test(f.name)) { alert(`${f.name}: this file type is not supported yet.`); continue; }
    if (attachments.length >= 5) { alert('Attach up to 5 files per message.'); break; }
    attachments.push({name:f.name,content:await f.text()});
  }
  renderAttachments(); e.target.value = '';
};
function renderAttachments(){ const tray=$('#attachmentTray'); tray.hidden=!attachments.length; tray.innerHTML=attachments.map((f,i)=>`<span class="attachment">▧ ${esc(f.name)} <button type="button" data-attachment-remove="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join(''); }
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) $('#mic').hidden = true;
else $('#mic').onclick = () => {
  const r = new SR(); r.interimResults = false;
  r.onresult = e => { $('#input').value += (($('#input').value ? ' ' : '') + e.results[0][0].transcript); resize(); };
  r.start();
};
document.addEventListener('click', async e => {
  const t = e.target;
  if (t.dataset.copy !== undefined) { await navigator.clipboard?.writeText(t.closest('.code').querySelector('code').textContent); t.textContent = 'Copied'; setTimeout(() => t.textContent = 'Copy', 1200); }
  else if (t.dataset.sugg) send(t.dataset.sugg);
  else if (t.dataset.approve) {
    const allow = t.dataset.allow === '1', b = cur?.msgs.at(-1)?.blocks.find(x => x.id === t.dataset.approve);
    if (b) { b.state = allow ? 'run' : 'denied'; renderLive(); }
    fetch('/api/approve', { method: 'POST', headers: hdr(), body: JSON.stringify({ id: t.dataset.approve, allow }) });
  }
  else if (t.dataset.del) { chats = chats.filter(c => c.id !== t.dataset.del); if (cur?.id === t.dataset.del) cur = null; save(); renderAll(); }
  else if (t.dataset.attachmentRemove !== undefined) { attachments.splice(Number(t.dataset.attachmentRemove),1); renderAttachments(); }
  else if (t.dataset.rm) { await fetch('/api/files/' + t.dataset.rm.split('/').map(encodeURIComponent).join('/'), { method: 'DELETE', headers: hdr() }); loadFiles(); }
  else if (t.closest('.item') && !busy) { cur = chats.find(c => c.id === t.closest('.item').dataset.id); renderAll(); $('#side').classList.remove('open'); }
});
$('#pluginList').addEventListener('change', e => { if(e.target.dataset.plugin){plugins[e.target.dataset.plugin]=e.target.checked;store.set('alpha.plugins',plugins);renderPlugins();} });
$('#sideClose').onclick = () => $('#side').classList.remove('open');
addEventListener('online', () => { net(); flushOutbox(); });
addEventListener('offline', net);

/* ---------- start ---------- */
$('#mode').value = settings.mode; $('#model').value = settings.model;
applyTheme(); net(); renderAll(); renderPlugins(); renderAttachments(); loadModels();
if (navigator.onLine && outbox.length) flushOutbox();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
