#!/usr/bin/env node
'use strict';

/**
 * ATLAS Bridge v1.0.0
 * Local, loopback-only debugger bridge for the ATLAS Field Instrument.
 *
 * Adapters:
 *   - GDB/MI2 (gdb --interpreter=mi2)
 *   - LLDB-DAP (lldb-dap / lldb-vscode)
 *
 * Security model:
 *   - binds only to 127.0.0.1
 *   - token-authenticated WebSocket upgrade
 *   - launch targets/cwd must resolve under --allow-root
 *   - no arbitrary shell or debugger-console RPC
 *   - bounded message and memory-read sizes
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const VERSION = '1.0.0';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const MAX_WS_MESSAGE = 1024 * 1024;
const MAX_MEMORY_READ = 64 * 1024;
const MAX_BREAKPOINTS = 1024;

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, allowRoot: process.cwd(), token: null, gdb: 'gdb', lldbDap: null, app: null, probe: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const n = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--port') out.port = Number(n());
    else if (a === '--allow-root') out.allowRoot = n();
    else if (a === '--token') out.token = n();
    else if (a === '--gdb') out.gdb = n();
    else if (a === '--lldb-dap') out.lldbDap = n();
    else if (a === '--app') out.app = n();
    else if (a === '--probe') out.probe = true;
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '--help' || a === '-h') {
      console.log(`ATLAS Bridge v${VERSION}\n\nUsage:\n  node atlas-bridge.js [options]\n\nOptions:\n  --port N             WebSocket port (default ${DEFAULT_PORT})\n  --allow-root PATH    Only launch targets/cwd under this root (default current directory)\n  --token TOKEN        Fixed token; otherwise a random token is generated\n  --gdb PATH           GDB executable (default gdb)\n  --lldb-dap PATH      LLDB DAP executable (auto-detect lldb-dap/lldb-vscode)\n  --app PATH           Serve this ATLAS HTML at http://127.0.0.1:PORT/\n  --probe              Print adapter availability and exit\n  --self-test          Run parser/protocol self-tests and exit\n`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${a}`);
  }
  if (!Number.isInteger(out.port) || out.port < 1024 || out.port > 65535) throw new Error('Port must be an integer from 1024 to 65535');
  return out;
}

function randomToken() { return crypto.randomBytes(24).toString('base64url'); }
function timingSafeToken(a, b) {
  const aa = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function asArray(v) { return Array.isArray(v) ? v : []; }
function parseAddress(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  const s = String(v ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(s)) throw new Error('Address must be an unsigned hexadecimal or decimal integer');
  const n = s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Address is outside JavaScript safe-integer range');
  return n;
}
function hexAddr(n) { return '0x' + Number(n).toString(16); }
function normalizeArgs(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error('args must be an array of strings');
  if (v.length > 256) throw new Error('Too many target arguments');
  return v.map(x => {
    const s = String(x);
    if (s.length > 8192) throw new Error('Target argument too long');
    return s;
  });
}

function canonicalRoot(p) {
  const abs = path.resolve(String(p));
  try { return fs.realpathSync.native(abs); } catch { return fs.realpathSync(abs); }
}
function resolveUnderRoot(candidate, root, { mustExist = true, executable = false } = {}) {
  if (!candidate) throw new Error('A path is required');
  let abs = path.resolve(root, String(candidate));
  if (mustExist) {
    try { abs = fs.realpathSync.native(abs); } catch { abs = fs.realpathSync(abs); }
  } else {
    const parent = canonicalRoot(path.dirname(abs));
    abs = path.join(parent, path.basename(abs));
  }
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error(`Path is outside the bridge allow-root: ${root}`);
  if (mustExist) {
    const st = fs.statSync(abs);
    if (executable && !st.isFile()) throw new Error('Debug target must be a file');
    if (!executable && !st.isDirectory()) throw new Error('Working directory must be a directory');
  }
  return abs;
}

function findCommand(name) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  const parts = String(process.env.PATH || '').split(path.delimiter);
  if (name.includes(path.sep) || (isWin && /^[A-Za-z]:[\\/]/.test(name))) {
    for (const e of exts) {
      const p = name.toLowerCase().endsWith(e.toLowerCase()) ? name : name + e;
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
    return null;
  }
  for (const d of parts) for (const e of exts) {
    const p = path.join(d, name + e);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
function probeExecutable(exe, args = ['--version']) {
  const found = findCommand(exe);
  if (!found) return { available: false, executable: exe, version: null, error: 'not found in PATH' };
  try {
    const r = spawnSync(found, args, { encoding: 'utf8', timeout: 2000, windowsHide: true });
    const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    if (r.error) return { available: false, executable: found, version: null, error: r.error.message };
    if (r.status !== 0) return { available: false, executable: found, version: null, error: text.split(/\r?\n/)[0] || `exit ${r.status}` };
    return { available: true, executable: found, version: text.split(/\r?\n/)[0] || path.basename(found), error: null };
  } catch (e) { return { available: false, executable: found, version: null, error: e.message }; }
}
function detectAdapters(opts) {
  const gdb = probeExecutable(opts.gdb, ['--version']);
  let lldbName = opts.lldbDap;
  if (!lldbName) lldbName = findCommand('lldb-dap') ? 'lldb-dap' : (findCommand('lldb-vscode') ? 'lldb-vscode' : 'lldb-dap');
  let lldb = probeExecutable(lldbName, ['--version']);
  if (!lldb.available && lldb.executable && /unknown|unrecognized|usage|option/i.test(String(lldb.error||''))) {
    const h = probeExecutable(lldbName, ['--help']);
    if (h.available) lldb = { ...h, version: 'LLDB-DAP · help probe succeeded' };
  }
  return {
    gdb: { id: 'gdb', label: 'GDB / MI2', ...gdb },
    lldb: { id: 'lldb', label: 'LLDB / DAP', ...lldb }
  };
}

// -------------------- GDB/MI parser --------------------
function miUnescape(s) {
  try { return JSON.parse('"' + s.replace(/\u0000/g, '') + '"'); }
  catch {
    return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}
function parseMiCStringAt(s, i) {
  if (s[i] !== '"') throw new Error('Expected MI string');
  i++; let raw = '';
  while (i < s.length) {
    const c = s[i++];
    if (c === '"') return { value: miUnescape(raw), i };
    if (c === '\\' && i < s.length) raw += c + s[i++];
    else raw += c;
  }
  return { value: miUnescape(raw), i };
}
function parseMiValueAt(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] === '"') return parseMiCStringAt(s, i);
  if (s[i] === '{') {
    i++; const obj = {};
    while (i < s.length && s[i] !== '}') {
      while (s[i] === ',' || /\s/.test(s[i])) i++;
      if (s[i] === '}') break;
      const k0 = i; while (i < s.length && /[A-Za-z0-9_\-.]/.test(s[i])) i++;
      const key = s.slice(k0, i); if (s[i] !== '=') { while (i < s.length && s[i] !== ',' && s[i] !== '}') i++; continue; }
      i++; const v = parseMiValueAt(s, i); i = v.i;
      if (Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = Array.isArray(obj[key]) ? [...obj[key], v.value] : [obj[key], v.value];
      else obj[key] = v.value;
    }
    if (s[i] === '}') i++;
    return { value: obj, i };
  }
  if (s[i] === '[') {
    i++; const arr = [];
    while (i < s.length && s[i] !== ']') {
      while (s[i] === ',' || /\s/.test(s[i])) i++;
      if (s[i] === ']') break;
      // A list element may itself be result syntax: name=value
      const save = i; let j = i;
      while (j < s.length && /[A-Za-z0-9_\-.]/.test(s[j])) j++;
      if (j > i && s[j] === '=') {
        const key = s.slice(i, j); i = j + 1; const v = parseMiValueAt(s, i); i = v.i; arr.push({ [key]: v.value });
      } else {
        i = save; const v = parseMiValueAt(s, i); i = v.i; arr.push(v.value);
      }
    }
    if (s[i] === ']') i++;
    return { value: arr, i };
  }
  const start = i; while (i < s.length && s[i] !== ',' && s[i] !== '}' && s[i] !== ']') i++;
  return { value: s.slice(start, i).trim(), i };
}
function parseMiResults(s) {
  const obj = {}; let i = 0;
  while (i < s.length) {
    while (s[i] === ',' || /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const k0 = i; while (i < s.length && /[A-Za-z0-9_\-.]/.test(s[i])) i++;
    const key = s.slice(k0, i);
    if (!key || s[i] !== '=') break;
    i++; const v = parseMiValueAt(s, i); i = v.i;
    if (Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = Array.isArray(obj[key]) ? [...obj[key], v.value] : [obj[key], v.value];
    else obj[key] = v.value;
  }
  return obj;
}
function parseMiRecord(line) {
  const m = String(line).match(/^(\d+)?([\^*+=~@&])(.*)$/);
  if (!m) return { kind: 'other', raw: line };
  const token = m[1] ? Number(m[1]) : null, prefix = m[2], rest = m[3];
  if ('~@&'.includes(prefix)) {
    const v = rest.startsWith('"') ? parseMiCStringAt(rest, 0).value : rest;
    return { kind: 'stream', token, prefix, text: v, raw: line };
  }
  const comma = rest.indexOf(','), cls = comma < 0 ? rest : rest.slice(0, comma), tail = comma < 0 ? '' : rest.slice(comma + 1);
  return { kind: prefix === '^' ? 'result' : (prefix === '*' ? 'exec' : 'async'), token, prefix, cls, results: parseMiResults(tail), raw: line };
}
function miQuote(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'; }
function normalizeMiList(list, key) {
  return asArray(list).map(x => x && typeof x === 'object' && key in x ? x[key] : x).filter(Boolean);
}

class GdbMiAdapter {
  constructor(executable, emit) {
    this.executable = executable; this.emit = emit; this.child = null; this.buf = ''; this.token = 1; this.pending = new Map(); this.queue = Promise.resolve();
    this.state = 'idle'; this.registerNames = null; this.target = null; this.args = []; this.cwd = null; this.lastThreadId = null; this.breakpointCache = [];
    this.capabilities = { run:true,pause:true,stop:true,restart:true,stepIntoInstruction:true,stepOverInstruction:true,stepOut:true,runToCursor:true,breakpoints:true,conditionalBreakpoints:true,watchpoints:false,registers:true,stack:true,memoryRead:true,attach:false,instructionTrace:false };
  }
  async start({ target, args, cwd }) {
    this.target = target; this.args = args; this.cwd = cwd;
    this.child = spawn(this.executable, ['--interpreter=mi2', '--quiet', '--nx'], { cwd, stdio: ['pipe','pipe','pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', d => this.onData(d));
    this.child.stderr.on('data', d => this.emit('session.output',{stream:'bridge-stderr',text:String(d)}));
    this.child.on('exit', (code, signal) => { this.state='terminated'; this.emit('session.state',{state:'terminated',reason:'debugger-exit',exitCode:code,signal}); this.rejectAll(new Error('GDB process exited')); });
    await delay(50);
    await this.exec('-gdb-set pagination off');
    await this.exec('-gdb-set confirm off');
    if (cwd) await this.exec(`-environment-cd ${miQuote(cwd)}`);
    await this.exec(`-file-exec-and-symbols ${miQuote(target)}`);
    if (args.length) await this.exec(`-exec-arguments ${args.map(miQuote).join(' ')}`);
    this.state='ready'; this.emit('session.state',{state:'ready',reason:'target-loaded'});
    return { state:this.state, capabilities:this.capabilities, target, cwd };
  }
  onData(d) {
    this.buf += d;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, idx); this.buf = this.buf.slice(idx + 1); line = line.replace(/\r$/, '');
      if (!line || line === '(gdb)') continue;
      const r = parseMiRecord(line);
      if (r.kind === 'stream') {
        const stream = r.prefix === '@' ? 'stdout' : (r.prefix === '&' ? 'debugger-log' : 'debugger');
        this.emit('session.output',{stream,text:r.text});
      } else if (r.kind === 'result' && r.token != null) {
        const p = this.pending.get(r.token); if (!p) continue; this.pending.delete(r.token);
        if (r.cls === 'error') p.reject(new Error(r.results.msg || 'GDB/MI error'));
        else p.resolve({ cls:r.cls, ...r.results });
      } else if (r.kind === 'exec') this.onExec(r);
      else if (r.kind === 'async') {
        if (r.cls === 'thread-selected' && r.results.id) this.lastThreadId = Number(r.results.id) || r.results.id;
      }
    }
  }
  onExec(r) {
    if (r.cls === 'running') {
      this.state='running'; this.emit('session.state',{state:'running',reason:'continued'}); return;
    }
    if (r.cls === 'stopped') {
      const reason = r.results.reason || 'stopped';
      const frame = r.results.frame || {};
      const pc = frame.addr ? Number.parseInt(frame.addr,16) : null;
      this.lastThreadId = Number(r.results['thread-id']) || r.results['thread-id'] || this.lastThreadId;
      if (reason === 'exited-normally' || reason === 'exited' || reason === 'exited-signalled') {
        this.state='exited'; this.emit('session.state',{state:'exited',reason,exitCode:Number(r.results['exit-code'])||0,signal:r.results['signal-name']||null});
      } else {
        this.state='stopped'; this.emit('session.state',{state:'stopped',reason,pc,threadId:this.lastThreadId,breakpointId:r.results.bkptno||null,signal:r.results['signal-name']||null});
        setTimeout(()=>this.snapshot().then(s=>this.emit('session.snapshot',s)).catch(e=>this.emit('session.output',{stream:'bridge',text:`Snapshot failed: ${e.message}\n`})),0);
      }
    }
  }
  rejectAll(e){ for (const p of this.pending.values()) p.reject(e); this.pending.clear(); }
  execNow(command, timeoutMs=10000) {
    if (!this.child || !this.child.stdin.writable) return Promise.reject(new Error('GDB session is not running'));
    const token=this.token++;
    return new Promise((resolve,reject)=>{
      const t=setTimeout(()=>{this.pending.delete(token);reject(new Error(`GDB command timed out: ${command.split(' ')[0]}`));},timeoutMs);
      this.pending.set(token,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});
      this.child.stdin.write(`${token}${command}\n`);
    });
  }
  exec(command, timeoutMs=10000){ const run=()=>this.execNow(command,timeoutMs); const p=this.queue.then(run,run); this.queue=p.catch(()=>{}); return p; }
  async command(name, params={}) {
    if (name==='run') { await this.exec('-exec-run'); return {state:'running'}; }
    if (name==='continue') { await this.exec('-exec-continue'); return {state:'running'}; }
    if (name==='pause') { await this.exec('-exec-interrupt --all'); return {state:'interrupting'}; }
    if (name==='stepInto') { await this.exec('-exec-step-instruction'); return {state:'running'}; }
    if (name==='stepOver') { await this.exec('-exec-next-instruction'); return {state:'running'}; }
    if (name==='stepOut') { await this.exec('-exec-finish'); return {state:'running'}; }
    if (name==='runTo') {
      const a=parseAddress(params.address); await this.exec(`-break-insert -t *${hexAddr(a)}`); await this.exec(this.state==='ready'||this.state==='exited'?'-exec-run':'-exec-continue'); return {state:'running',temporaryAddress:a};
    }
    if (name==='stop') {
      if (this.state==='running') { try{await this.exec('-exec-interrupt --all');}catch{} await delay(30); }
      try { await this.exec(`-interpreter-exec console ${miQuote('kill')}`); } catch {}
      this.state='ready'; this.emit('session.state',{state:'ready',reason:'inferior-killed'}); return {state:this.state};
    }
    if (name==='restart') {
      if (this.state==='running') { try{await this.exec('-exec-interrupt --all');}catch{} await delay(30); }
      try { await this.exec(`-interpreter-exec console ${miQuote('kill')}`); } catch {}
      await this.exec('-exec-run'); return {state:'running'};
    }
    throw new Error(`Unsupported GDB command: ${name}`);
  }
  async addBreakpoint({address,condition,enabled=true}) {
    const a=parseAddress(address); let cmd='-break-insert ';
    if (condition) cmd += `-c ${miQuote(String(condition))} `;
    cmd += `*${hexAddr(a)}`;
    const r=await this.exec(cmd), b=r.bkpt || {};
    const id=String(b.number||''); if (!enabled && id) await this.exec(`-break-disable ${id}`);
    return {id,address:a,enabled,condition:condition||'',resolvedAddress:b.addr||hexAddr(a),verified:b.pending!=='y'};
  }
  async removeBreakpoint(id){ await this.exec(`-break-delete ${String(id).replace(/[^0-9.]/g,'')}`); return {id:String(id)}; }
  async toggleBreakpoint(id,enabled){ const clean=String(id).replace(/[^0-9.]/g,''); await this.exec(`${enabled?'-break-enable':'-break-disable'} ${clean}`); return {id:String(id),enabled:!!enabled}; }
  async listBreakpoints(){
    const r=await this.exec('-break-list'); const body=r.BreakpointTable?.body || []; const list=normalizeMiList(body,'bkpt').map(b=>({id:String(b.number||''),enabled:b.enabled!=='n',address:b.addr&&/^0x/.test(b.addr)?parseInt(b.addr,16):null,condition:b.cond||'',hitCount:Number(b.times)||0,verified:b.pending!=='y'})); this.breakpointCache=list; return list;
  }
  async readMemory(address,length){
    const a=parseAddress(address), n=Math.max(1,Math.min(MAX_MEMORY_READ,Number(length)||128)); const r=await this.exec(`-data-read-memory-bytes ${hexAddr(a)} ${n}`); const mem=normalizeMiList(r.memory,'memory')[0] || asArray(r.memory)[0] || {}; const contents=mem.contents||''; const bytes=[]; for(let i=0;i+1<contents.length;i+=2)bytes.push(parseInt(contents.slice(i,i+2),16)); return {address:a,bytes};
  }
  async registers(){
    if (!this.registerNames) { const n=await this.exec('-data-list-register-names'); this.registerNames=asArray(n['register-names']); }
    const r=await this.exec('-data-list-register-values x'); const vals=normalizeMiList(r['register-values'],'number').length?asArray(r['register-values']):asArray(r['register-values']);
    const out=[]; for(const entry of vals){ const e=entry?.number!=null?entry:(entry?.['register-value']||entry); if(e?.number==null)continue; const idx=Number(e.number),name=this.registerNames[idx]||`r${idx}`; if(!name)continue; out.push({name,value:String(e.value??'')}); }
    return out;
  }
  async frames(){ const r=await this.exec('-stack-list-frames 0 31'); return normalizeMiList(r.stack,'frame').map(f=>({level:Number(f.level)||0,address:f.addr&&/^0x/.test(f.addr)?parseInt(f.addr,16):null,function:f.func||'',file:f.fullname||f.file||'',line:Number(f.line)||null})); }
  async snapshot(){
    if (!['stopped','ready'].includes(this.state)) return {state:this.state,registers:[],frames:[],stack:null,breakpoints:await this.listBreakpoints().catch(()=>[])};
    const [regs,frames,bps]=await Promise.all([this.registers().catch(()=>[]),this.frames().catch(()=>[]),this.listBreakpoints().catch(()=>[])]);
    const by=Object.fromEntries(regs.map(r=>[r.name.toLowerCase(),r.value])); const pcRaw=by.rip||by.eip||by.pc||null, spRaw=by.rsp||by.esp||by.sp||null; const pc=pcRaw&&/^0x/i.test(pcRaw)?parseInt(pcRaw,16):null, sp=spRaw&&/^0x/i.test(spRaw)?parseInt(spRaw,16):null;
    const stack=sp!=null?await this.readMemory(sp,128).catch(()=>null):null;
    return {state:this.state,pc,sp,threadId:this.lastThreadId,registers:regs,frames,stack,breakpoints:bps};
  }
  async close(){
    if (!this.child) return; try { await this.exec('-gdb-exit',1500); } catch {}
    try { this.child.kill('SIGTERM'); } catch {} this.child=null; this.state='terminated';
  }
}

// -------------------- DAP transport / LLDB adapter --------------------
class DapTransport {
  constructor(child, emit) { this.child=child; this.emit=emit; this.seq=1; this.pending=new Map(); this.buf=Buffer.alloc(0); child.stdout.on('data',d=>this.onData(d)); child.stderr.setEncoding('utf8'); child.stderr.on('data',d=>emit('session.output',{stream:'bridge-stderr',text:String(d)})); child.on('exit',(code,signal)=>{for(const p of this.pending.values())p.reject(new Error('LLDB-DAP exited'));this.pending.clear();emit('session.state',{state:'terminated',reason:'debugger-exit',exitCode:code,signal});}); }
  onData(d){ this.buf=Buffer.concat([this.buf,Buffer.from(d)]); for(;;){ const idx=this.buf.indexOf('\r\n\r\n'); if(idx<0)return; const head=this.buf.slice(0,idx).toString('ascii'); const m=head.match(/Content-Length:\s*(\d+)/i); if(!m){this.buf=this.buf.slice(idx+4);continue;} const n=Number(m[1]); if(this.buf.length<idx+4+n)return; const body=this.buf.slice(idx+4,idx+4+n).toString('utf8'); this.buf=this.buf.slice(idx+4+n); let msg; try{msg=JSON.parse(body);}catch{continue;} this.onMessage(msg); } }
  onMessage(m){ if(m.type==='response'){const p=this.pending.get(m.request_seq);if(!p)return;this.pending.delete(m.request_seq);m.success?p.resolve(m.body||{}):p.reject(new Error(m.message||m.body?.error?.format||'DAP request failed'));} else if(m.type==='event')this.emit('dap.event',m); else if(m.type==='request')this.emit('dap.request',m); }
  request(command,args={},timeoutMs=10000){ const seq=this.seq++, msg={seq,type:'request',command,arguments:args}; const raw=Buffer.from(JSON.stringify(msg)); const frame=Buffer.concat([Buffer.from(`Content-Length: ${raw.length}\r\n\r\n`),raw]); return new Promise((resolve,reject)=>{const t=setTimeout(()=>{this.pending.delete(seq);reject(new Error(`DAP request timed out: ${command}`));},timeoutMs);this.pending.set(seq,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});this.child.stdin.write(frame);}); }
}

class LldbDapAdapter {
  constructor(executable, emit){ this.executable=executable;this.emit=emit;this.child=null;this.dap=null;this.state='idle';this.threadId=null;this.frameId=null;this.capRaw={};this.breakpoints=[];this.bpSeq=1;this.target=null;this.args=[];this.cwd=null;this.initializedPromise=null;this.initializedResolve=null;this.terminated=false;this.capabilities={run:true,pause:true,stop:true,restart:false,stepIntoInstruction:true,stepOverInstruction:true,stepOut:true,runToCursor:false,breakpoints:true,conditionalBreakpoints:false,watchpoints:false,registers:true,stack:true,memoryRead:false,attach:false,instructionTrace:false}; }
  async start({target,args,cwd}){
    this.target=target;this.args=args;this.cwd=cwd;this.child=spawn(this.executable,[],{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true}); this.dap=new DapTransport(this.child,(e,b)=>this.onTransport(e,b));
    this.initializedPromise=new Promise(r=>this.initializedResolve=r);
    const caps=await this.dap.request('initialize',{clientID:'atlas',clientName:'ATLAS',adapterID:'lldb',pathFormat:'path',linesStartAt1:true,columnsStartAt1:true,supportsVariableType:true,supportsVariablePaging:true,supportsRunInTerminalRequest:false,locale:'en-US'},10000); this.capRaw=caps||{};
    this.capabilities.breakpoints=!!caps.supportsInstructionBreakpoints; this.capabilities.conditionalBreakpoints=this.capabilities.breakpoints&&!!caps.supportsConditionalBreakpoints; this.capabilities.memoryRead=!!caps.supportsReadMemoryRequest; this.capabilities.restart=!!caps.supportsRestartRequest; this.capabilities.stepIntoInstruction=!!caps.supportsSteppingGranularity; this.capabilities.stepOverInstruction=!!caps.supportsSteppingGranularity;
    const launchPromise=this.dap.request('launch',{program:target,args,cwd,stopOnEntry:true,disableASLR:false},20000);
    await Promise.race([this.initializedPromise,delay(3000)]);
    await this.applyBreakpoints();
    try { await this.dap.request('configurationDone',{},10000); } catch(e) { if(caps.supportsConfigurationDoneRequest) throw e; }
    await launchPromise;
    this.state='running'; this.emit('session.state',{state:'running',reason:'launching'});
    return {state:this.state,capabilities:this.capabilities,target,cwd};
  }
  onTransport(event,body){
    if(event==='session.output'||event==='session.state'){this.emit(event,body);return;}
    if(event==='dap.request'){ this.emit('session.output',{stream:'bridge',text:`LLDB-DAP requested unsupported client action: ${body.command}\n`}); return; }
    if(event!=='dap.event')return; const m=body, b=m.body||{};
    if(m.event==='initialized'){this.initializedResolve?.();return;}
    if(m.event==='output'){this.emit('session.output',{stream:b.category||'console',text:b.output||''});return;}
    if(m.event==='continued'){this.state='running';this.emit('session.state',{state:'running',reason:'continued',threadId:b.threadId||this.threadId});return;}
    if(m.event==='stopped'){this.state='stopped';this.threadId=b.threadId||this.threadId;this.emit('session.state',{state:'stopped',reason:b.reason||'stopped',threadId:this.threadId,breakpointIds:b.hitBreakpointIds||[]});setTimeout(()=>this.snapshot().then(s=>this.emit('session.snapshot',s)).catch(e=>this.emit('session.output',{stream:'bridge',text:`Snapshot failed: ${e.message}\n`})),0);return;}
    if(m.event==='exited'){this.state='exited';this.emit('session.state',{state:'exited',reason:'exited',exitCode:b.exitCode});return;}
    if(m.event==='terminated'){this.state='terminated';this.emit('session.state',{state:'terminated',reason:'terminated'});return;}
    if(m.event==='process'){this.emit('session.output',{stream:'bridge',text:`Process ${b.name||''} ${b.systemProcessId?`PID ${b.systemProcessId}`:''}\n`});}
  }
  async ensureThread(){ if(this.threadId)return this.threadId;const t=await this.dap.request('threads');this.threadId=t.threads?.[0]?.id||null;if(!this.threadId)throw new Error('No stopped thread is available');return this.threadId; }
  async command(name,params={}){
    const tid=await this.ensureThread().catch(()=>null);
    if(name==='run'||name==='continue'){if(!tid)throw new Error('No thread available');await this.dap.request('continue',{threadId:tid,singleThread:false});return {state:'running'};}
    if(name==='pause'){if(!tid)throw new Error('No thread available');await this.dap.request('pause',{threadId:tid});return {state:'interrupting'};}
    if(name==='stepInto'){if(!tid)throw new Error('No thread available');await this.dap.request('stepIn',{threadId:tid,granularity:'instruction'});return {state:'running'};}
    if(name==='stepOver'){if(!tid)throw new Error('No thread available');await this.dap.request('next',{threadId:tid,granularity:'instruction'});return {state:'running'};}
    if(name==='stepOut'){if(!tid)throw new Error('No thread available');await this.dap.request('stepOut',{threadId:tid});return {state:'running'};}
    if(name==='stop'){try{await this.dap.request('terminate',{restart:false},5000);}catch{await this.dap.request('disconnect',{restart:false,terminateDebuggee:true},5000).catch(()=>{});}this.state='terminated';return {state:this.state};}
    if(name==='restart'){if(!this.capabilities.restart)throw new Error('This LLDB-DAP does not advertise restart support');await this.dap.request('restart',{});return {state:'running'};}
    if(name==='runTo')throw new Error('Run-to-cursor is not exposed by the LLDB-DAP adapter in ATLAS v0.9; use a temporary breakpoint and Continue');
    throw new Error(`Unsupported LLDB command: ${name}`);
  }
  async applyBreakpoints(){
    const requested=this.breakpoints.filter(b=>b.enabled).map(b=>({instructionReference:hexAddr(b.address),condition:b.condition||undefined}));
    const r=await this.dap.request('setInstructionBreakpoints',{breakpoints:requested},10000).catch(e=>{if(!requested.length)return {breakpoints:[]};throw e;});
    let j=0;for(const b of this.breakpoints){if(!b.enabled){b.backendId=null;b.verified=false;continue;}const rb=r.breakpoints?.[j++]||{};b.backendId=rb.id!=null?String(rb.id):null;b.verified=rb.verified!==false;b.message=rb.message||'';}return this.breakpoints;
  }
  async addBreakpoint({address,condition,enabled=true}){if(!this.capabilities.breakpoints)throw new Error('This LLDB-DAP does not advertise instruction-breakpoint support');if(this.breakpoints.length>=MAX_BREAKPOINTS)throw new Error('Breakpoint limit reached');const b={id:`l${this.bpSeq++}`,address:parseAddress(address),condition:String(condition||''),enabled:!!enabled,verified:false,backendId:null,hitCount:0};this.breakpoints.push(b);await this.applyBreakpoints();return {...b};}
  async removeBreakpoint(id){const i=this.breakpoints.findIndex(b=>b.id===String(id));if(i<0)throw new Error('Breakpoint not found');this.breakpoints.splice(i,1);await this.applyBreakpoints();return {id:String(id)};}
  async toggleBreakpoint(id,enabled){const b=this.breakpoints.find(x=>x.id===String(id));if(!b)throw new Error('Breakpoint not found');b.enabled=!!enabled;await this.applyBreakpoints();return {...b};}
  async listBreakpoints(){return this.breakpoints.map(b=>({...b}));}
  async frames(){const tid=await this.ensureThread();const r=await this.dap.request('stackTrace',{threadId:tid,startFrame:0,levels:32});const fs=r.stackFrames||[];if(fs[0])this.frameId=fs[0].id;return fs.map((f,i)=>({level:i,id:f.id,address:f.instructionPointerReference?parseInt(f.instructionPointerReference,16):null,function:f.name||'',file:f.source?.path||f.source?.name||'',line:f.line||null}));}
  async registers(frameId){
    if(frameId==null){const fs=await this.frames();frameId=this.frameId;if(!frameId)return [];}
    const sc=await this.dap.request('scopes',{frameId});let scope=(sc.scopes||[]).find(s=>/register/i.test(s.name));if(!scope)return [];
    const r=await this.dap.request('variables',{variablesReference:scope.variablesReference});let vars=r.variables||[];
    // Some LLDB-DAP versions group registers. Flatten one level if needed.
    if(vars.length && vars.every(v=>v.variablesReference>0) && vars.length<20){const flat=[];for(const g of vars){const q=await this.dap.request('variables',{variablesReference:g.variablesReference}).catch(()=>({variables:[]}));for(const v of q.variables||[])flat.push(v);}if(flat.length)vars=flat;}
    return vars.map(v=>({name:v.name,value:String(v.value??'')}));
  }
  async readMemory(address,length){if(!this.capabilities.memoryRead)throw new Error('This LLDB-DAP does not advertise readMemory support');const a=parseAddress(address),n=Math.max(1,Math.min(MAX_MEMORY_READ,Number(length)||128));const r=await this.dap.request('readMemory',{memoryReference:hexAddr(a),offset:0,count:n});const data=Buffer.from(r.data||'','base64');return {address:a+(Number(r.offset)||0),bytes:[...data]};}
  async snapshot(){if(this.state!=='stopped')return {state:this.state,registers:[],frames:[],stack:null,breakpoints:await this.listBreakpoints()};const frames=await this.frames().catch(()=>[]);const regs=await this.registers(this.frameId).catch(()=>[]);const by=Object.fromEntries(regs.map(r=>[r.name.toLowerCase(),r.value]));const pcRaw=by.rip||by.eip||by.pc||by['program counter']||null,spRaw=by.rsp||by.esp||by.sp||by['stack pointer']||null;const pc=pcRaw&&/0x[0-9a-f]+/i.test(pcRaw)?parseInt(pcRaw.match(/0x[0-9a-f]+/i)[0],16):(frames[0]?.address??null);const sp=spRaw&&/0x[0-9a-f]+/i.test(spRaw)?parseInt(spRaw.match(/0x[0-9a-f]+/i)[0],16):null;const stack=sp!=null&&this.capabilities.memoryRead?await this.readMemory(sp,128).catch(()=>null):null;return {state:this.state,pc,sp,threadId:this.threadId,registers:regs,frames,stack,breakpoints:await this.listBreakpoints()};}
  async close(){if(!this.dap)return;try{await this.dap.request('disconnect',{restart:false,terminateDebuggee:true},2500);}catch{}try{this.child.kill('SIGTERM');}catch{}this.state='terminated';this.dap=null;this.child=null;}
}

// -------------------- Minimal RFC6455 server --------------------
function encodeWsText(text) {
  const payload=Buffer.from(String(text));let head;
  if(payload.length<126){head=Buffer.alloc(2);head[0]=0x81;head[1]=payload.length;}
  else if(payload.length<=0xffff){head=Buffer.alloc(4);head[0]=0x81;head[1]=126;head.writeUInt16BE(payload.length,2);}
  else{head=Buffer.alloc(10);head[0]=0x81;head[1]=127;head.writeBigUInt64BE(BigInt(payload.length),2);}return Buffer.concat([head,payload]);
}
function encodeWsControl(opcode,payload=Buffer.alloc(0)){const p=Buffer.from(payload);const h=Buffer.from([0x80|opcode,p.length]);return Buffer.concat([h,p]);}
class WsPeer {
  constructor(socket,onMessage,onClose){this.socket=socket;this.buf=Buffer.alloc(0);this.onMessage=onMessage;this.onClose=onClose;this.closed=false;socket.on('data',d=>this.feed(d));socket.on('close',()=>this.close(false));socket.on('error',()=>this.close(false));}
  send(obj){if(this.closed)return;const s=typeof obj==='string'?obj:JSON.stringify(obj);if(Buffer.byteLength(s)>MAX_WS_MESSAGE)throw new Error('Outbound message too large');this.socket.write(encodeWsText(s));}
  feed(d){this.buf=Buffer.concat([this.buf,Buffer.from(d)]);while(this.buf.length>=2){const b0=this.buf[0],b1=this.buf[1],fin=!!(b0&0x80),opcode=b0&0xf,masked=!!(b1&0x80);let len=b1&0x7f,pos=2;if(!fin){this.close(true,1003,'fragmentation unsupported');return;}if(len===126){if(this.buf.length<4)return;len=this.buf.readUInt16BE(2);pos=4;}else if(len===127){if(this.buf.length<10)return;const big=this.buf.readBigUInt64BE(2);if(big>BigInt(MAX_WS_MESSAGE)){this.close(true,1009,'message too large');return;}len=Number(big);pos=10;}if(len>MAX_WS_MESSAGE){this.close(true,1009,'message too large');return;}let mask=null;if(masked){if(this.buf.length<pos+4)return;mask=this.buf.slice(pos,pos+4);pos+=4;}else{this.close(true,1002,'client frames must be masked');return;}if(this.buf.length<pos+len)return;let payload=Buffer.from(this.buf.slice(pos,pos+len));this.buf=this.buf.slice(pos+len);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];if(opcode===0x8){this.close(true,1000,'bye');return;}if(opcode===0x9){this.socket.write(encodeWsControl(0xA,payload));continue;}if(opcode!==0x1)continue;try{this.onMessage(payload.toString('utf8'));}catch{}}
  }
  close(send=true,code=1000,reason=''){if(this.closed)return;this.closed=true;if(send){const r=Buffer.from(reason);const p=Buffer.alloc(2+r.length);p.writeUInt16BE(code,0);r.copy(p,2);try{this.socket.write(encodeWsControl(0x8,p));}catch{}}try{this.socket.end();}catch{}this.onClose?.();}
}
function validOrigin(origin){if(!origin||origin==='null')return true;try{const u=new URL(origin);return (u.protocol==='http:'||u.protocol==='https:')&&['localhost','127.0.0.1','::1'].includes(u.hostname);}catch{return false;}}

class BridgeClient {
  constructor(peer,ctx){this.peer=peer;this.ctx=ctx;this.adapter=null;this.session=null;}
  sendEvent(event,body={}){this.peer.send({type:'event',event,body});}
  async close(){if(this.adapter){try{await this.adapter.close();}catch{}this.adapter=null;}}
  async message(text){let m;try{m=JSON.parse(text);}catch{return this.peer.send({type:'error',error:'Invalid JSON'});}if(m?.type!=='request'||!Number.isInteger(m.id)||typeof m.method!=='string')return this.peer.send({type:'response',id:m?.id??null,ok:false,error:'Invalid request envelope'});try{const result=await this.dispatch(m.method,m.params||{});this.peer.send({type:'response',id:m.id,ok:true,result});}catch(e){this.peer.send({type:'response',id:m.id,ok:false,error:e.message||String(e)});}}
  async dispatch(method,p){
    if(method==='bridge.hello')return {name:'ATLAS Bridge',version:VERSION,host:HOST,allowRoot:this.ctx.allowRoot,adapters:Object.values(this.ctx.adapters).map(a=>({id:a.id,label:a.label,available:a.available,version:a.version,error:a.error})),limits:{memoryRead:MAX_MEMORY_READ,breakpoints:MAX_BREAKPOINTS},security:{loopbackOnly:true,tokenRequired:true,pathRootRestricted:true,arbitraryConsole:false}};
    if(method==='session.start'){
      if(this.adapter)throw new Error('A debugger session is already active; close it first');const id=String(p.adapter||'auto');let spec;if(id==='auto')spec=this.ctx.adapters.gdb.available?this.ctx.adapters.gdb:(this.ctx.adapters.lldb.available?this.ctx.adapters.lldb:null);else spec=this.ctx.adapters[id];if(!spec||!spec.available)throw new Error(spec?`${spec.label} unavailable: ${spec.error||'probe failed'}`:'No supported debugger adapter is available');const target=resolveUnderRoot(p.target,this.ctx.allowRoot,{mustExist:true,executable:true});const cwd=p.cwd?resolveUnderRoot(p.cwd,this.ctx.allowRoot,{mustExist:true,executable:false}):path.dirname(target);const args=normalizeArgs(p.args);const emit=(e,b)=>this.sendEvent(e,b);this.adapter=spec.id==='gdb'?new GdbMiAdapter(spec.executable,emit):new LldbDapAdapter(spec.executable,emit);const started=await this.adapter.start({target,args,cwd});this.session={adapter:spec.id,target,cwd,args};return {...started,adapter:spec.id,adapterLabel:spec.label,adapterVersion:spec.version};
    }
    if(method==='session.close'){if(this.adapter)await this.adapter.close();this.adapter=null;this.session=null;return {state:'closed'};}
    if(!this.adapter)throw new Error('No debugger session is active');
    if(method==='session.command')return await this.adapter.command(String(p.command||''),p);
    if(method==='session.snapshot')return await this.adapter.snapshot();
    if(method==='memory.read')return await this.adapter.readMemory(p.address,p.length);
    if(method==='breakpoint.add')return await this.adapter.addBreakpoint({address:p.address,condition:p.condition||'',enabled:p.enabled!==false});
    if(method==='breakpoint.remove')return await this.adapter.removeBreakpoint(p.id);
    if(method==='breakpoint.toggle')return await this.adapter.toggleBreakpoint(p.id,p.enabled!==false);
    if(method==='breakpoints.list')return await this.adapter.listBreakpoints();
    throw new Error(`Unknown method: ${method}`);
  }
}

function runSelfTest(){
  const tests=[];const ok=(name,fn)=>{try{fn();tests.push([name,true]);}catch(e){tests.push([name,false,e.message]);}};
  ok('MI result parser',()=>{const r=parseMiRecord('12^done,bkpt={number="1",addr="0x401126",enabled="y"}');if(r.token!==12||r.results.bkpt.number!=='1'||r.results.bkpt.addr!=='0x401126')throw new Error('unexpected parse');});
  ok('MI stopped parser',()=>{const r=parseMiRecord('*stopped,reason="breakpoint-hit",thread-id="1",frame={addr="0x401126",func="main"}');if(r.cls!=='stopped'||r.results.frame.func!=='main')throw new Error('unexpected parse');});
  ok('WebSocket frame encode',()=>{const f=encodeWsText('abc');if(f[0]!==0x81||f[1]!==3||f.slice(2).toString()!=='abc')throw new Error('bad frame');});
  ok('Address parser',()=>{if(parseAddress('0x401000')!==0x401000||parseAddress('42')!==42)throw new Error('bad address');});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-bridge-test-'));const f=path.join(root,'x');fs.writeFileSync(f,'x');ok('Path root allow',()=>{if(resolveUnderRoot(f,canonicalRoot(root),{mustExist:true,executable:true})!==f)throw new Error('path mismatch');});ok('Path root reject',()=>{let threw=false;try{resolveUnderRoot('/etc/passwd',canonicalRoot(root),{mustExist:true,executable:true});}catch{threw=true;}if(!threw)throw new Error('outside path accepted');});fs.rmSync(root,{recursive:true,force:true});
  let fail=0;for(const [n,v,e] of tests){console.log(`${v?'PASS':'FAIL'} · ${n}${e?' · '+e:''}`);if(!v)fail++;}if(fail)process.exitCode=1;else console.log(`ATLAS Bridge v${VERSION} self-test passed (${tests.length} checks).`);
}

async function main(){
  let opts;try{opts=parseArgs(process.argv.slice(2));}catch(e){console.error(`ATLAS Bridge: ${e.message}\nUse --help for usage.`);process.exit(2);}
  if(opts.selfTest){runSelfTest();return;}
  let allowRoot;try{allowRoot=canonicalRoot(opts.allowRoot);}catch(e){console.error(`Could not resolve --allow-root: ${e.message}`);process.exit(2);}
  const adapters=detectAdapters(opts);
  if(opts.probe){console.log(JSON.stringify({version:VERSION,allowRoot,adapters},null,2));return;}
  const token=opts.token||randomToken();
  let appFile=null;if(opts.app){try{appFile=canonicalRoot(opts.app);if(!fs.statSync(appFile).isFile())throw new Error('not a file');}catch(e){console.error(`Could not resolve --app: ${e.message}`);process.exit(2);}}
  const ctx={allowRoot,adapters,token,appFile};
  const clients=new Set();
  const server=http.createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'http://127.0.0.1:'+opts.port});res.end(JSON.stringify({name:'ATLAS Bridge',version:VERSION,adapters:Object.values(adapters).map(a=>({id:a.id,available:a.available,version:a.version,error:a.error}))}));return;}if(appFile&&(req.url==='/'||req.url==='/atlas-v1.0.0.html')){try{const html=fs.readFileSync(appFile);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(html);}catch(e){res.writeHead(500,{'Content-Type':'text/plain'});res.end('Could not read ATLAS app: '+e.message);}return;}res.writeHead(404,{'Content-Type':'text/plain'});res.end('ATLAS Bridge\n');});
  server.on('upgrade',(req,socket)=>{
    try{
      if(req.socket.remoteAddress&&!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw new Error('loopback clients only');
      if(!validOrigin(req.headers.origin))throw new Error('origin not allowed');
      const u=new URL(req.url||'/',`http://${HOST}:${opts.port}`);if(!timingSafeToken(u.searchParams.get('token'),token))throw new Error('invalid token');
      if(String(req.headers.upgrade||'').toLowerCase()!=='websocket'||!req.headers['sec-websocket-key'])throw new Error('invalid WebSocket upgrade');
      const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
      let client;const peer=new WsPeer(socket,text=>client.message(text),()=>{clients.delete(client);client?.close();});client=new BridgeClient(peer,ctx);clients.add(client);client.sendEvent('bridge.ready',{version:VERSION,allowRoot,adapters:Object.values(adapters).map(a=>({id:a.id,label:a.label,available:a.available,version:a.version,error:a.error}))});
    }catch(e){try{socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n'+e.message);socket.destroy();}catch{}}
  });
  server.listen(opts.port,HOST,()=>{
    console.log(`ATLAS Bridge v${VERSION}`);
    console.log(`Listening: ws://${HOST}:${opts.port}`);
    console.log(`Allow root: ${allowRoot}`);
    console.log(`Token: ${token}`);
    if(appFile)console.log(`ATLAS app: http://${HOST}:${opts.port}/`);
    console.log('Adapters:');
    for(const a of Object.values(adapters))console.log(`  ${a.label}: ${a.available?'AVAILABLE · '+a.version:'UNAVAILABLE · '+a.error}`);
    console.log('\nKeep this terminal open while debugging. The bridge accepts loopback clients only.');
  });
  const shutdown=async()=>{for(const c of [...clients])await c.close().catch(()=>{});server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}

if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exit(1);});

module.exports={parseMiRecord,parseMiResults,encodeWsText,parseAddress,resolveUnderRoot};
