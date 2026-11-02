import express from 'express';
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const KEY = env.OPENROUTER_API_KEY || '';
const ACCESS = env.ACCESS_KEY || '';
const PORT = env.PORT || 3000;
const HOST = env.HOST || (ACCESS ? '0.0.0.0' : '127.0.0.1');
const WORKSPACE = path.resolve(env.WORKSPACE || path.join(__dirname, 'workspace'));
const DEFAULT_MODEL = env.DEFAULT_MODEL || 'openai/gpt-4o-mini';
const FREE = (env.FREE_MODELS || 'openrouter/free,meta-llama/llama-3.3-70b-instruct:free,deepseek/deepseek-chat-v3-0324:free')
  .split(',').map(s => s.trim()).filter(Boolean);
const OLLAMA = (env.OLLAMA_URL || '').replace(/\/$/, '');
const OLLAMA_MODEL = env.OLLAMA_MODEL || 'llama3.2';
// Commands can only run when the server is private (localhost) or protected by ACCESS_KEY.
const AGENT_ALLOWED = Boolean(ACCESS) || HOST === '127.0.0.1';
if (HOST !== '127.0.0.1' && !ACCESS) throw new Error('ACCESS_KEY is required when Alpha is exposed on a public network.');

const SYSTEM = `You are Alpha, a capable, friendly AI assistant. Be clear and direct. Use Markdown, and put code in fenced blocks with a language tag.`;
const AGENT_NOTE = `\n\nYou have tools: run_command, write_file, read_file, list_files, all inside a workspace folder. When the user wants a file (code, document, CSV, config...), create it with write_file so they can download it. Run commands to test your work when useful, then summarise what you did.`;

const fn = (name, description, properties, required = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const TOOLS = [
  fn('run_command', 'Run a shell command in the workspace and return its output.', { command: { type: 'string' } }, ['command']),
  fn('write_file', 'Create or overwrite a file in the workspace.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn('read_file', 'Read a text file from the workspace.', { path: { type: 'string' } }, ['path']),
  fn('list_files', 'List files in the workspace.', { path: { type: 'string' } }),
];

await fs.mkdir(WORKSPACE, { recursive: true });
const safe = p => {
  const full = path.resolve(WORKSPACE, p || '.');
  if (full !== WORKSPACE && !full.startsWith(WORKSPACE + path.sep)) throw new Error('Path is outside the workspace');
  return full;
};
const clip = s => (s.length > 12000 ? s.slice(0, 12000) + '\n…[truncated]' : s);

async function listFiles(dir = WORKSPACE) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFiles(f));
    else { const st = await fs.stat(f); out.push({ path: path.relative(WORKSPACE, f), size: st.size, mtime: st.mtimeMs }); }
  }
  return out;
}

async function runTool(name, a) {
  if (name === 'run_command') {
    return new Promise(done => exec(String(a.command), { cwd: WORKSPACE, timeout: 60000, maxBuffer: 1 << 20 }, (err, so, se) =>
      done(clip(`exit code: ${err ? (err.killed ? 'timeout' : err.code) : 0}\n${so}${se ? '\n[stderr]\n' + se : ''}`))));
  }
  if (name === 'write_file') {
    const f = safe(a.path);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, a.content ?? '');
    return `Wrote ${a.path} (${Buffer.byteLength(a.content ?? '')} bytes)`;
  }
  if (name === 'read_file') return clip(await fs.readFile(safe(a.path), 'utf8'));
  if (name === 'list_files') return (await listFiles(safe(a.path))).map(f => `${f.path}\t${f.size}`).join('\n') || '(empty)';
  throw new Error('Unknown tool ' + name);
}

// Provider chain: chosen model → free OpenRouter models → local Ollama.
function providers(model) {
  const OR = 'https://openrouter.ai/api/v1/chat/completions';
  const list = [];
  if (KEY) {
    list.push({ name: 'OpenRouter', url: OR, key: KEY, model });
    for (const m of FREE) if (m !== model) list.push({ name: 'OpenRouter free', url: OR, key: KEY, model: m });
  }
  if (OLLAMA) list.push({ name: 'Local Ollama', url: OLLAMA + '/v1/chat/completions', model: OLLAMA_MODEL });
  return list;
}

async function complete(p, messages, useTools, onText, signal) {
  const r = await fetch(p.url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(p.key && { Authorization: 'Bearer ' + p.key }), 'X-Title': 'Alpha' },
    body: JSON.stringify({ model: p.model, messages, stream: true, ...(useTools && { tools: TOOLS }) }),
  });
  if (!r.ok) throw Object.assign(new Error(`${p.model}: ${r.status} ${(await r.text()).slice(0, 160)}`), { status: r.status });
  const dec = new TextDecoder();
  let buf = '', text = '';
  const calls = [];
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw Object.assign(new Error(j.error.message || 'Provider error'), { status: j.error.code || 500 });
      const delta = j.choices?.[0]?.delta || {};
      if (delta.content) { text += delta.content; onText(delta.content); }
      for (const tc of delta.tool_calls || []) {
        const c = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
    }
  }
  return { text, calls: calls.filter(Boolean).map(c => ({ ...c, id: c.id || 'call_' + crypto.randomUUID().slice(0, 8) })) };
}

async function withFallback(model, convo, agent, onText, send, signal) {
  const chain = providers(model);
  if (!chain.length) throw new Error('No provider configured. Set OPENROUTER_API_KEY in .env');
  let last;
  for (const p of chain) {
    for (const tools of agent ? [true, false] : [false]) {
      let emitted = 0;
      try {
        const r = await complete(p, convo, tools, t => { emitted++; onText(t); }, signal);
        if (p !== chain[0]) send('notice', { message: `Credits or limits hit, answered by ${p.name}: ${p.model}` });
        return r;
      } catch (e) {
        last = e;
        if (signal.aborted) throw e;
        if (emitted) send('reset');
        if (tools && [400, 404].includes(+e.status)) continue; // model has no tool support: retry as plain chat
        break; // otherwise try the next provider
      }
    }
  }
  throw new Error('All providers failed. ' + (last?.message || ''));
}

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use('/api', (req, res, next) => {
  if (ACCESS && req.get('x-alpha-key') !== ACCESS && req.query.key !== ACCESS) return res.status(401).json({ error: 'Invalid access key' });
  next();
});

const pending = new Map();
app.post('/api/approve', (req, res) => { pending.get(req.body.id)?.(!!req.body.allow); res.json({ ok: true }); });

app.post('/api/chat', async (req, res) => {
  const { messages = [], model = DEFAULT_MODEL, mode = 'ask', system = '' } = req.body;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (type, data = {}) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const agent = mode !== 'off' && AGENT_ALLOWED;
  const convo = [{ role: 'system', content: SYSTEM + (system ? '\n\n' + system : '') + (agent ? AGENT_NOTE : '') }, ...messages];
  try {
    for (let step = 0; step < 8; step++) {
      const { text, calls } = await withFallback(model || DEFAULT_MODEL, convo, agent, t => send('text', { text: t }), send, ac.signal);
      if (!calls.length) break;
      convo.push({ role: 'assistant', content: text || null,
        tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
      for (const c of calls) {
        let args = {}; try { args = JSON.parse(c.args || '{}'); } catch {}
        send('tool', { id: c.id, name: c.name, args });
        let out;
        if (c.name === 'run_command' && mode === 'ask') {
          const ok = await new Promise(r => { pending.set(c.id, r); ac.signal.addEventListener('abort', () => r(false)); send('approval', { id: c.id }); });
          pending.delete(c.id);
          if (!ok) out = 'The user denied this command.';
        }
        if (out === undefined) { try { out = await runTool(c.name, args); } catch (e) { out = 'Error: ' + e.message; } }
        send('tool_result', { id: c.id, output: out, file: c.name === 'write_file' && !out.startsWith('Error') ? args.path : undefined });
        convo.push({ role: 'tool', tool_call_id: c.id, content: String(out) });
      }
    }
  } catch (e) { if (!ac.signal.aborted) send('error', { message: e.message }); }
  send('done'); res.end();
});

// Optional integrations: Brave Search API and Google Drive/Calendar OAuth.
const BRAVE_SEARCH_KEY = env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY || '';
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REFRESH_TOKEN = env.GOOGLE_REFRESH_TOKEN || '';
const DROPBOX_ACCESS_TOKEN = env.DROPBOX_ACCESS_TOKEN || '';
const MICROSOFT_ACCESS_TOKEN = env.MICROSOFT_ACCESS_TOKEN || env.ONEDRIVE_ACCESS_TOKEN || '';
let googleToken = { value: '', expires: 0 };
async function getGoogleToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) throw new Error('Google integration is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN to Render environment variables.');
  if (googleToken.value && googleToken.expires > Date.now() + 60000) return googleToken.value;
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({client_id:GOOGLE_CLIENT_ID,client_secret:GOOGLE_CLIENT_SECRET,refresh_token:GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'}) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error_description || j.error || 'Google token refresh failed');
  googleToken = { value:j.access_token, expires:Date.now() + (j.expires_in || 3600)*1000 }; return googleToken.value;
}
async function googleFetch(url, options={}) {
  const token = await getGoogleToken();
  const r = await fetch(url, { ...options, headers:{ Authorization:'Bearer '+token, ...(options.headers||{}) } });
  const body = await r.json().catch(()=>({})); if (!r.ok) throw new Error(body.error?.message || body.error_description || `Google API error ${r.status}`); return body;
}
app.get('/api/integrations/status', (_,res) => { const g=!!(GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET&&GOOGLE_REFRESH_TOKEN); res.json({ web:!!BRAVE_SEARCH_KEY, drive:g, calendar:g, gmail:g, docs:g, dropbox:!!DROPBOX_ACCESS_TOKEN, onedrive:!!MICROSOFT_ACCESS_TOKEN }); });
app.post('/api/research', async (req,res) => {
  try {
    if (!BRAVE_SEARCH_KEY) return res.status(503).json({error:'Web Research is not configured. Add BRAVE_SEARCH_API_KEY to Render environment variables.'});
    const query = String(req.body.query || '').trim().slice(0,500); if (!query) return res.status(400).json({error:'Enter a research question.'});
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query); url.searchParams.set('count', '8');
    const r = await fetch(url, {headers:{'Accept':'application/json','X-Subscription-Token':BRAVE_SEARCH_KEY}});
    const j = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(j.message || j.error || `Brave Search error ${r.status}`);
    const results = (j.web?.results || []).map(x=>({title:x.title,url:x.url,content:x.description||'',score:0}));
    res.json({answer:'',results});
  } catch(e){res.status(502).json({error:e.message});}
});
app.get('/api/drive/files', async (_,res)=>{ try { const j=await googleFetch('https://www.googleapis.com/drive/v3/files?pageSize=30&orderBy=modifiedTime%20desc&fields=files(id,name,mimeType,modifiedTime,webViewLink,size)'); res.json(j.files||[]); } catch(e){res.status(503).json({error:e.message});} });
app.post('/api/drive/upload', async(req,res)=>{ try { const name=String(req.body.name||'untitled.txt').slice(0,180), content=String(req.body.content||'').slice(0,1000000); const token=await getGoogleToken(); const boundary='alpha_'+crypto.randomUUID(); const meta=JSON.stringify({name,mimeType:'text/plain'}); const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`; const r=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'multipart/related; boundary='+boundary},body}); const j=await r.json(); if(!r.ok) throw new Error(j.error?.message||'Drive upload failed'); res.json(j); }catch(e){res.status(503).json({error:e.message});} });
app.get('/api/calendar/events', async(req,res)=>{ try { const from=new Date().toISOString(), to=new Date(Date.now()+14*86400000).toISOString(); const j=await googleFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=30&singleEvents=true&orderBy=startTime&timeMin='+encodeURIComponent(from)+'&timeMax='+encodeURIComponent(to)); res.json(j.items||[]); }catch(e){res.status(503).json({error:e.message});} });
app.post('/api/calendar/events', async(req,res)=>{ try { const summary=String(req.body.summary||'').slice(0,180), start=new Date(req.body.start), end=new Date(req.body.end); if(!summary||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start) return res.status(400).json({error:'Provide a title and valid start/end times.'}); const j=await googleFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({summary,description:String(req.body.description||'').slice(0,2000),start:{dateTime:start.toISOString()},end:{dateTime:end.toISOString()}})}); res.json(j); }catch(e){res.status(503).json({error:e.message});} });


// Gmail + Google Docs use the same Google OAuth refresh token as Drive/Calendar.
app.get('/api/gmail/messages', async (req,res)=>{ try {
  const q=encodeURIComponent(String(req.query.q||'newer_than:30d').slice(0,300));
  const list=await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=${q}`);
  const items=await Promise.all((list.messages||[]).slice(0,20).map(async m=>{
   const x=await googleFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
   const h=x.payload?.headers||[]; const get=n=>h.find(v=>v.name.toLowerCase()===n.toLowerCase())?.value||'';
   return {id:m.id,threadId:m.threadId,from:get('From'),subject:get('Subject'),date:get('Date'),snippet:x.snippet||''};
  })); res.json(items);
 } catch(e){res.status(503).json({error:e.message});} });
app.get('/api/docs/files', async (_req,res)=>{ try { const j=await googleFetch("https://www.googleapis.com/drive/v3/files?pageSize=30&orderBy=modifiedTime%20desc&q=mimeType%3D'application%2Fvnd.google-apps.document'&fields=files(id,name,modifiedTime,webViewLink)"); res.json(j.files||[]); } catch(e){res.status(503).json({error:e.message});} });
app.post('/api/docs/create', async(req,res)=>{ try {
 const title=String(req.body.title||'Untitled document').slice(0,180), content=String(req.body.content||'').slice(0,500000);
 const doc=await googleFetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:title,mimeType:'application/vnd.google-apps.document'})});
 if(content) await googleFetch(`https://docs.googleapis.com/v1/documents/${doc.id}:batchUpdate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requests:[{insertText:{location:{index:1},text:content}}]})});
 res.json(doc);
 } catch(e){res.status(503).json({error:e.message});} });
// Dropbox uses a scoped API access token. Uploads are limited to 10 MB.
app.get('/api/dropbox/files', async(_req,res)=>{ try { if(!DROPBOX_ACCESS_TOKEN) throw new Error('Add DROPBOX_ACCESS_TOKEN in Render environment variables.'); const r=await fetch('https://api.dropboxapi.com/2/files/list_folder',{method:'POST',headers:{Authorization:'Bearer '+DROPBOX_ACCESS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({path:'',recursive:false,limit:100})}); const j=await r.json(); if(!r.ok) throw new Error(j.error_summary||'Dropbox request failed'); res.json(j.entries||[]); }catch(e){res.status(503).json({error:e.message});} });
app.post('/api/dropbox/upload', async(req,res)=>{ try { if(!DROPBOX_ACCESS_TOKEN) throw new Error('Add DROPBOX_ACCESS_TOKEN in Render environment variables.'); const name=String(req.body.name||'alpha-note.txt').replace(/[\\/]/g,'_').slice(0,180), content=String(req.body.content||''); if(Buffer.byteLength(content)>10*1024*1024) throw new Error('File is larger than 10 MB.'); const r=await fetch('https://content.dropboxapi.com/2/files/upload',{method:'POST',headers:{Authorization:'Bearer '+DROPBOX_ACCESS_TOKEN,'Dropbox-API-Arg':JSON.stringify({path:'/'+name,mode:'add',autorename:true,mute:false}),'Content-Type':'application/octet-stream'},body:content}); const j=await r.json(); if(!r.ok) throw new Error(j.error_summary||'Dropbox upload failed'); res.json(j); }catch(e){res.status(503).json({error:e.message});} });
// OneDrive Graph token must include Files.ReadWrite.All (or equivalent delegated scopes).
app.get('/api/onedrive/files', async(_req,res)=>{ try { if(!MICROSOFT_ACCESS_TOKEN) throw new Error('Add MICROSOFT_ACCESS_TOKEN in Render environment variables.'); const r=await fetch('https://graph.microsoft.com/v1.0/me/drive/root/children?$top=50&$select=id,name,size,lastModifiedDateTime,webUrl,file,folder',{headers:{Authorization:'Bearer '+MICROSOFT_ACCESS_TOKEN}}); const j=await r.json(); if(!r.ok) throw new Error(j.error?.message||'OneDrive request failed'); res.json(j.value||[]); }catch(e){res.status(503).json({error:e.message});} });
app.post('/api/onedrive/upload', async(req,res)=>{ try { if(!MICROSOFT_ACCESS_TOKEN) throw new Error('Add MICROSOFT_ACCESS_TOKEN in Render environment variables.'); const name=String(req.body.name||'alpha-note.txt').replace(/[\\/]/g,'_').slice(0,180), content=String(req.body.content||''); if(Buffer.byteLength(content)>4*1024*1024) throw new Error('Simple OneDrive upload limit is 4 MB.'); const r=await fetch('https://graph.microsoft.com/v1.0/me/drive/root:/'+encodeURIComponent(name)+':/content',{method:'PUT',headers:{Authorization:'Bearer '+MICROSOFT_ACCESS_TOKEN,'Content-Type':'text/plain; charset=utf-8'},body:content}); const j=await r.json(); if(!r.ok) throw new Error(j.error?.message||'OneDrive upload failed'); res.json(j); }catch(e){res.status(503).json({error:e.message});} });

app.get('/api/config', (_, res) => res.json({ defaultModel: DEFAULT_MODEL, agentAllowed: AGENT_ALLOWED, hasKey: !!KEY, ollama: !!OLLAMA, free: FREE }));

let modelCache;
app.get('/api/models', async (_, res) => {
  try {
    if (!modelCache || Date.now() - modelCache.t > 36e5) {
      const j = await (await fetch('https://openrouter.ai/api/v1/models')).json();
      modelCache = { t: Date.now(), data: j.data.map(m => ({ id: m.id, free: m.pricing?.prompt === '0' })) };
    }
    res.json(modelCache.data);
  } catch { res.json([]); }
});

app.get('/api/credits', async (_, res) => {
  try {
    const d = (await (await fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: 'Bearer ' + KEY } })).json()).data;
    res.json({ left: d.total_credits - d.total_usage });
  } catch { res.json({ left: null }); }
});

app.get('/api/files', async (_, res) => res.json((await listFiles()).sort((a, b) => b.mtime - a.mtime)));
app.get('/api/files/*', (req, res) => { try { res.download(safe(req.params[0])); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/files/*', async (req, res) => { try { await fs.rm(safe(req.params[0]), { force: true }); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, HOST, () => {
  console.log(`Alpha running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!KEY) console.log('! OPENROUTER_API_KEY is not set');
  if (!AGENT_ALLOWED) console.log('! Command running is disabled: set ACCESS_KEY to enable it on a public server');
});
