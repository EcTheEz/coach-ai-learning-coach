import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = root;
const allowedOrigins = new Set((process.env.COACH_ALLOWED_ORIGINS || '').split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean));
const workspace = resolve(process.env.AGENT_WORKSPACE || root);
const testCommand = process.env.AGENT_TEST_COMMAND || 'npm test -- --runInBand';
const runs = new Map();
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const stateFile = join(dataDir, 'student-state.json');
let studentState = { projects: [], study: { streak: 0, minutes: 0, subjects: [] }, calendar: [], health: { workouts: 0, minutes: 0, habits: [] }, notes: [] };
async function loadStudentState() { await mkdir(dataDir, { recursive: true }); try { studentState = JSON.parse(await readFile(stateFile, 'utf8')); } catch { await writeFile(stateFile, JSON.stringify(studentState, null, 2)); } }
async function saveStudentState() { await mkdir(dataDir, { recursive: true }); await writeFile(stateFile, JSON.stringify(studentState, null, 2)); }

const providers = [
  { id: 'builder', name: 'Builder', role: 'implementation', model: process.env.BUILDER_MODEL || process.env.OLLAMA_MODEL || 'gemma4:31b', key: process.env.BUILDER_API_KEY || process.env.OLLAMA_API_KEY },
  { id: 'critic', name: 'Critic', role: 'code review', model: process.env.CRITIC_MODEL || process.env.OLLAMA_MODEL || 'gemma4:31b', key: process.env.CRITIC_API_KEY || process.env.OLLAMA_API_KEY },
  { id: 'tester', name: 'Tester', role: 'verification', model: process.env.TESTER_MODEL || process.env.OLLAMA_MODEL || 'gemma4:31b', key: process.env.TESTER_API_KEY || process.env.OLLAMA_API_KEY },
  { id: 'fixer', name: 'Fixer', role: 'repair', model: process.env.FIXER_MODEL || process.env.OLLAMA_MODEL || 'gemma4:31b', key: process.env.FIXER_API_KEY || process.env.OLLAMA_API_KEY }
];

const safePath = (p) => { const target = resolve(workspace, p); if (target !== workspace && !target.startsWith(workspace + '\\')) throw new Error('Path escapes configured workspace'); return target; };
const json = (res, status, body, req) => { const origin = (req?.headers.origin || '').replace(/\/$/, ''); const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }; if (origin && allowedOrigins.has(origin)) { headers['access-control-allow-origin'] = origin; headers['access-control-allow-methods'] = 'GET,POST,OPTIONS'; headers['access-control-allow-headers'] = 'Content-Type'; headers.vary = 'Origin'; } res.writeHead(status, headers); res.end(JSON.stringify(body)); };
const bodyOf = async (req) => { let raw = ''; for await (const chunk of req) raw += chunk; return JSON.parse(raw || '{}'); };

async function tree(dir = workspace, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true }); const files = [];
  for (const e of entries) { if (['node_modules', '.git', '.next', 'dist'].includes(e.name)) continue; const p = join(dir, e.name); if (e.isDirectory()) files.push(...await tree(p, join(prefix, e.name))); else { const s = await stat(p); if (s.size < 120000) files.push(join(prefix, e.name)); } }
  return files.slice(0, 80);
}
async function snapshot() { const files = await tree(); const out = []; for (const f of files) { try { out.push(`\n--- ${f} ---\n${await readFile(safePath(f), 'utf8')}`); } catch {} } return out.join('\n').slice(0, 120000); }
function extract(text) { const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i); const raw = (match ? match[1] : text).trim(); try { return JSON.parse(raw); } catch { return null; } }

async function ask(provider, system, user) {
  if (!provider.key) return { offline: true, text: JSON.stringify({ summary: 'No API key configured; offline verification only.', findings: [], diff: '' }) };
  let lastError = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch('https://ollama.com/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.key}` }, body: JSON.stringify({ model: provider.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false }), signal: AbortSignal.timeout(120000) });
      if (response.ok) { const data = await response.json(); return { offline: false, text: data.message?.content || '' }; }
      lastError = `${provider.name} Ollama provider returned ${response.status}: ${await response.text()}`;
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) { lastError = `${provider.name} Ollama network request failed: ${error.message}`; }
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw new Error(lastError);
}
async function applyDiff(diff) { if (!diff?.trim()) return 'No patch returned.'; const file = join(root, `.agent-${Date.now()}.patch`); const { writeFile, unlink } = await import('node:fs/promises'); await writeFile(file, diff, 'utf8'); try { await exec('git', ['apply', '--check', '--whitespace=nowarn', file], { cwd: workspace }); await exec('git', ['apply', '--whitespace=nowarn', file], { cwd: workspace }); return 'Patch applied.'; } finally { await unlink(file).catch(() => {}); } }
async function applyFiles(files) { if (!Array.isArray(files) || !files.length) return 'No files returned.'; for (const item of files) { if (!item?.path || typeof item.content !== 'string') continue; const target = safePath(item.path); await writeFile(target, item.content, 'utf8'); } return `${files.length} file(s) written.`; }
async function tests() { try { const result = await exec(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', testCommand] : ['-lc', testCommand], { cwd: workspace, timeout: 120000, maxBuffer: 400000 }); return { pass: true, output: `${result.stdout}\n${result.stderr}`.slice(-8000) }; } catch (e) { return { pass: false, output: `${e.stdout || ''}\n${e.stderr || e.message}`.slice(-8000) }; } }
function add(run, agent, kind, text, state = 'done') { run.steps.push({ agent, kind, text, state, at: new Date().toISOString() }); }

async function execute(run) {
  try {
    const context = await snapshot();
    const builder = await ask(providers[0], 'You are the builder. Return ONLY JSON with summary and files. Each file must be {"path":"relative/path","content":"complete file content"}. Never touch secrets, dependencies, or files outside the workspace.', `${run.task}\nCurrent workspace:\n${context}`);
    const built = extract(builder.text) || { summary: builder.text.slice(0, 300), files: [] }; add(run, 'Builder', 'build', built.summary || 'Implementation proposal ready.');
    if (built.files?.length) { try { add(run, 'Builder', 'apply', await applyFiles(built.files)); } catch (e) { add(run, 'Builder', 'apply', `File write rejected: ${e.message}`, 'error'); } }
    else if (built.diff) { try { add(run, 'Builder', 'apply', await applyDiff(built.diff)); } catch (e) { add(run, 'Builder', 'apply', `Patch rejected: ${e.message}`, 'error'); } }
    for (let i = 1; i <= run.maxIterations; i++) {
      run.loop = i; const current = await snapshot();
      const critic = await ask(providers[1], 'You are the critic. Return ONLY JSON: {"summary":"...","findings":[{"severity":"high|medium|low","title":"...","detail":"..."}],"approved":true|false}. Review the implementation against the request.', `${run.task}\nWorkspace:\n${current}`);
      const review = extract(critic.text) || { summary: critic.text.slice(0, 300), findings: [], approved: false }; run.findings = review.findings || []; add(run, 'Critic', 'review', review.summary || 'Review complete.');
      const test = await tests(); add(run, 'Tester', 'test', test.pass ? 'Configured test command passed.' : `Tests failed: ${test.output.slice(-260)}`, test.pass ? 'done' : 'error');
      if (test.pass && review.approved && !(review.findings || []).some(f => f.severity === 'high')) { run.status = 'passed'; add(run, 'Fixer', 'gate', 'Quality gate passed. No further repair required.'); return; }
      const fixer = await ask(providers[3], 'You are the fixer. Return ONLY JSON with summary and files. Each file must be {"path":"relative/path","content":"complete corrected file content"}. Make the smallest safe changes. If no safe fix exists, return an empty files array.', `${run.task}\nReview: ${JSON.stringify(review)}\nTest output:\n${test.output}\nWorkspace:\n${current}`);
      const fix = extract(fixer.text) || { summary: fixer.text.slice(0, 300), files: [] }; add(run, 'Fixer', 'repair', fix.summary || 'Repair proposal ready.');
      if (fix.files?.length) { try { add(run, 'Fixer', 'apply', await applyFiles(fix.files)); } catch (e) { add(run, 'Fixer', 'apply', `File write rejected: ${e.message}`, 'error'); } }
      else if (fix.diff) { try { add(run, 'Fixer', 'apply', await applyDiff(fix.diff)); } catch (e) { add(run, 'Fixer', 'apply', `Patch rejected: ${e.message}`, 'error'); } }
      else if (!providers[3].key) { run.status = 'offline'; add(run, 'Fixer', 'pause', 'Offline mode: configure provider keys to continue autonomous repair.', 'active'); return; }
    }
    run.status = 'limit'; add(run, 'Fixer', 'pause', `Stopped after ${run.maxIterations} iterations without a passing gate.`, 'active');
  } catch (e) { run.status = 'error'; run.error = e.message; add(run, 'System', 'error', e.message, 'error'); }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { const origin = (req.headers.origin || '').replace(/\/$/, ''); if (!origin || !allowedOrigins.has(origin)) return json(res, 403, { error: 'Origin not allowed.' }, req); res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type', vary: 'Origin' }); return res.end(); }
    if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ok: true }, req);
    if (req.method === 'GET' && req.url === '/api/student') return json(res, 200, studentState, req);
    if (req.method === 'POST' && req.url === '/api/coach') { const b = await bodyOf(req); const prompt = String(b.message || '').trim(); if (!prompt) return json(res, 400, { error: 'Message is required' }, req); const coach = await ask(providers[0], 'You are a warm, practical student and health coach. Give concise, safe, personalized help. For exercise, suggest beginner-friendly options, ask about injuries when relevant, and never diagnose medical conditions. Use the student context but do not invent facts. Return plain text only.', `${prompt}\nStudent context:\n${JSON.stringify(studentState)}`); return json(res, 200, { reply: coach.text }, req); }
    if (req.method === 'POST' && req.url === '/api/student') { const b = await bodyOf(req); if (b.type === 'project') studentState.projects.unshift({ id: Date.now().toString(36), title: b.title || 'Untitled project', description: b.description || '', updatedAt: new Date().toISOString() }); if (b.type === 'study') { studentState.study.minutes += Number(b.minutes || 0); studentState.study.streak = Number(b.streak ?? studentState.study.streak); if (b.subject) { const old = studentState.study.subjects.find(s => s.name === b.subject); if (old) old.minutes += Number(b.minutes || 0); else studentState.study.subjects.push({ name: b.subject, minutes: Number(b.minutes || 0) }); } } if (b.type === 'calendar') studentState.calendar.push({ id: Date.now().toString(36), title: b.title || 'Study session', date: b.date || new Date().toISOString().slice(0, 10), kind: b.kind || 'study' }); if (b.type === 'health') { studentState.health.minutes += Number(b.minutes || 0); studentState.health.workouts += 1; if (b.habit) studentState.health.habits.push({ name: b.habit, date: new Date().toISOString() }); } if (b.type === 'note') studentState.notes.unshift({ id: Date.now().toString(36), text: b.text || '', createdAt: new Date().toISOString() }); await saveStudentState(); return json(res, 200, studentState, req); }
    if (req.method === 'GET' && req.url === '/api/providers') return json(res, 200, { providers: providers.map(p => ({ id: p.id, name: p.name, role: p.role, model: p.model, status: p.key ? 'ready' : 'needs key' })) }, req);
    if (req.method === 'GET' && req.url === '/api/config') return json(res, 200, { workspace, testCommand, hasKeys: providers.some(p => p.key) }, req);
    if (req.method === 'POST' && req.url === '/api/runs') { const b = await bodyOf(req); const run = { id: `run_${Date.now().toString(36)}`, task: String(b.task || '').trim() || 'Improve the project', maxIterations: b.maxIterations === 'unlimited' ? 999999 : Math.max(1, Math.min(100, Number(b.maxIterations || 8))), status: 'running', loop: 0, steps: [], findings: [], createdAt: new Date().toISOString() }; runs.set(run.id, run); execute(run); return json(res, 202, run, req); }
    const match = req.method === 'GET' && req.url.match(/^\/api\/runs\/([^/?]+)/); if (match) { const run = runs.get(match[1]); return run ? json(res, 200, run, req) : json(res, 404, { error: 'Run not found' }, req); }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' }, req);
    const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0]; const safe = normalize(requested).replace(/^([.][.][\\/])+/, ''); const file = join(publicDir, safe); const data = await readFile(file); const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }; res.writeHead(200, { 'content-type': `${types[extname(file)] || 'application/octet-stream'}; charset=utf-8` }); res.end(data);
  } catch (e) { json(res, e.code === 'ENOENT' ? 404 : 500, { error: e.message }, req); }
});
await loadStudentState();
server.listen(process.env.PORT || 4173, () => console.log(`Student's Coach running at http://localhost:${process.env.PORT || 4173}`));
