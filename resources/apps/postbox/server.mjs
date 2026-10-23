import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { google } from 'googleapis';

import { fileURLToPath } from 'node:url';
import path from 'node:path';
const dir = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.POSTBOX_DATA_DIR || path.join(process.env.LOCALAPPDATA || dir, 'MaazLeadSuite', 'Postbox');
const envPath = path.join(STATE_DIR, '.env');
await mkdir(STATE_DIR, { recursive: true });
if (existsSync(envPath)) {
  for (const line of (await readFile(envPath, 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const PORT = Number(process.env.PORT || 3000);
const ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
const HOST = process.env.POSTBOX_HOST || 'localhost';
const DB = path.join(STATE_DIR, 'tokens.json');
const JOB_DB = path.join(STATE_DIR, 'scheduled.json');
const SEND_STATE_DB = path.join(STATE_DIR, 'send-state.json');
const PERFORMANCE_DB = path.join(STATE_DIR, 'performance-events.json');
const SUPPRESSION_DB = path.join(STATE_DIR, 'suppressions.json');
const DATA_DIR = process.env.POSTBOX_REFERENCE_DIR || path.join(dir, 'data');
async function readReferenceFile(name, fallback) {
  try { return await readFile(path.join(DATA_DIR, name), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const AUTHORIZED_SENDERS = new Set(['maazbinyousaf@gmail.com','maazbinyousaf4@gmail.com','devspace33@gmail.com','maaz@hiretopremote.com']);
const DAILY_SEND_LIMIT = 500;
const MIN_SEND_GAP_MS = 30_000;
const ACCOUNT_DAY_TIME_ZONE = 'Asia/Karachi';
const APP_STARTED_AT = Date.now();
let accounts = existsSync(DB) ? JSON.parse(await readFile(DB, 'utf8')) : [];
let jobs = existsSync(JOB_DB) ? JSON.parse(await readFile(JOB_DB, 'utf8')) : [];
let heldPastDueJobs = false;
for (const job of jobs) {
  if (job.status === 'scheduled' && Date.parse(job.sendAt) < APP_STARTED_AT) {
    job.status = 'held_review';
    job.error = 'Past-due job held at desktop app startup. Review and reschedule manually.';
    job.updatedAt = new Date().toISOString();
    heldPastDueJobs = true;
  }
}
if (heldPastDueJobs) await writeFile(JOB_DB, JSON.stringify(jobs, null, 2), { mode: 0o600 });
let sendState = existsSync(SEND_STATE_DB) ? JSON.parse(await readFile(SEND_STATE_DB, 'utf8')) : { lastSendStartedAt: 0, history: [] };
let performance = existsSync(PERFORMANCE_DB) ? JSON.parse(await readFile(PERFORMANCE_DB, 'utf8')) : { contacts: {}, events: [] };
let suppressions = existsSync(SUPPRESSION_DB) ? JSON.parse(await readFile(SUPPRESSION_DB, 'utf8')) : [];
let sendGate = Promise.resolve();
sendState.history ||= [];
function parseCsv(text) {
  const rows=[];let row=[],value='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){value+='"';i++;}else if(c==='"')quoted=false;else value+=c;continue;}
    if(c==='"'&&value===''){quoted=true;continue;}
    if(c===','){row.push(value);value='';continue;}
    if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(x=>x!==''))rows.push(row);row=[];value='';continue;}
    value+=c;
  }
  if(value!==''||row.length){row.push(value);if(row.some(x=>x!==''))rows.push(row);}
  if(!rows.length)return[];
  const headers=rows.shift().map((h,i)=>i===0?h.replace(/^\uFEFF/,''):h);
  return rows.map(cells=>Object.fromEntries(headers.map((h,i)=>[h,cells[i]||''])));
}
const allCityContacts=parseCsv(await readReferenceFile('therapist-email-personal-contacts-all-cities.csv',''));
const reviewContacts=parseCsv(await readReferenceFile('therapist-email-personal-contact-review-queue.csv',''));
const approvedHandoff=JSON.parse(await readReferenceFile('approved-nyc-email-handoff.json','{"records":[]}'));
const approvedContacts=approvedHandoff.records||[];
function normalizeLead(r,index,bucket){
  const pick=(...keys)=>{for(const k of keys)if(r[k]!==undefined&&r[k]!==null&&r[k]!=='')return String(r[k]);return'';};
  return {id:String(index),bucket,name:pick('Therapist name','practitionerName','name'),email:pick('Email','email'),city:pick('City','city'),location:pick('Location as published','location'),country:pick('Country','country'),context:pick('Public bio / work context','publicContextExcerpt','publicBioWorkContext'),contextUrl:pick('Context evidence URL','contextEvidenceUrl'),profileUrl:pick('practitionerProfileUrl','Profile URL','profileUrl'),website:pick('Website','website'),emailEvidence:pick('emailEvidenceExcerpt','Email evidence excerpt','emailEvidenceExcerpt','Email evidence'),emailEvidenceUrl:pick('Email evidence URL','emailEvidenceUrl'),matchBasis:pick('Contact match basis','contactMatchBasis'),verificationStatus:pick('Verification status','verificationStatus'),soloEvidence:pick('soloPracticeEvidenceExcerpt','Solo-practice evidence excerpt'),soloEvidenceUrl:pick('soloPracticeEvidenceUrl','Solo-practice evidence URL'),sourceRow:pick('Source row','sourceRow'),additionalEvidence:pick('Additional evidence URLs','additionalEvidenceUrls')};
}
const save = async () => writeFile(DB, JSON.stringify(accounts, null, 2), { mode: 0o600 });
const saveJobs = async () => writeFile(JOB_DB, JSON.stringify(jobs, null, 2), { mode: 0o600 });
const saveSendState = async () => writeFile(SEND_STATE_DB, JSON.stringify(sendState, null, 2), { mode: 0o600 });
const savePerformance = async () => writeFile(PERFORMANCE_DB, JSON.stringify(performance, null, 2), { mode: 0o600 });
const saveSuppressions = async () => writeFile(SUPPRESSION_DB, JSON.stringify(suppressions, null, 2), { mode: 0o600 });
const client = () => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new Error('Add your Google OAuth client ID and secret in the local .env file first.');
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${ORIGIN}/oauth/callback`);
};
const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = async req => { let b=''; for await (const c of req) b+=c; return JSON.parse(b || '{}'); };
const authFor = account => { const c=client(); c.setCredentials(account.tokens); c.on('tokens', async t=>{account.tokens={...account.tokens,...t};await save()}); return c; };
const html = async res => { res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(await readFile(`${dir}/index.html`)); };
const validEmail = email => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(email||'').trim());
function zoneParts(date,zone){const f=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});return Object.fromEntries(f.formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
function dayKey(date,zone=ACCOUNT_DAY_TIME_ZONE){const p=zoneParts(date,zone);return `${p.year}-${p.month}-${p.day}`;}
function contactKey(r,i){return String(r.Email||r.email||r['Therapist name']||r.name||`row-${i}`).trim().toLowerCase();}
function hasSmykm(r){const email=String(r.Email||r.email||'').trim(),context=String(r['Public bio / work context']||r.publicContextExcerpt||r.publicBioWorkContext||'').trim();return validEmail(email)&&Boolean(context);}
async function refreshPerformanceContacts(){
  const current=parseCsv(await readReferenceFile('therapist-email-personal-contacts-all-cities.csv',''));
  const now=new Date().toISOString();
  for(let i=0;i<current.length;i++){
    const r=current[i],key=contactKey(r,i),hasContext=hasSmykm(r),known=performance.contacts[key];
    if(!known){performance.contacts[key]={firstSeenAt:now,smykmSeenAt:hasContext?now:null};performance.events.push({type:'lead_found',at:now,key});if(hasContext)performance.events.push({type:'smykm_found',at:now,key});}
    else if(hasContext&&known.smykmSeenAt===null){known.smykmSeenAt=now;performance.events.push({type:'smykm_found',at:now,key});}
  }
  await savePerformance();
  return current;
}
if(!existsSync(PERFORMANCE_DB)){
  for(let i=0;i<allCityContacts.length;i++){const r=allCityContacts[i],key=contactKey(r,i);performance.contacts[key]={firstSeenAt:null,smykmSeenAt:hasSmykm(r)?'baseline':null};}
  await savePerformance();
}
let repliesCache={key:'',at:0,value:null};
const headerAddress=value=>{const m=String(value||'').match(/<([^>]+)>/);return (m?m[1]:value).trim().toLowerCase();};
async function campaignReplies(date){
  const start=new Date(`${date}T00:00:00+05:00`),end=new Date(start.getTime()+86400000),key=date;
  if(repliesCache.key===key&&Date.now()-repliesCache.at<60000)return repliesCache.value;
  const sentJobs=jobs.filter(j=>j.status==='sent'&&j.sentAt&&Date.parse(j.sentAt)<end.getTime());
  const byRecipient=new Map();for(const j of sentJobs){const email=String(j.to||'').toLowerCase();if(!byRecipient.has(email))byRecipient.set(email,[]);byRecipient.get(email).push(j);}
  if(!byRecipient.size)return {count:0,responders:0,available:accounts.length>0};
  let count=0;const responders=new Set();let available=accounts.length>0;
  for(const account of accounts){
    try{
      const gmail=google.gmail({version:'v1',auth:authFor(account)});
      const recipients=[...byRecipient].filter(([,records])=>records.some(j=>String(j.account||'').toLowerCase()===account.email.toLowerCase())).map(([recipient])=>recipient);
      if(!recipients.length)continue;
      const messages=[];
      for(let offset=0;offset<recipients.length;offset+=35){const q=`in:inbox after:${Math.floor(start.getTime()/1000)} before:${Math.floor(end.getTime()/1000)} {${recipients.slice(offset,offset+35).map(email=>`from:${email}`).join(' ')}}`;const {data}=await gmail.users.messages.list({userId:'me',q,maxResults:500});messages.push(...(data.messages||[]));}
      const threadIds=new Set();
      for(const m of messages){const {data}=await gmail.users.messages.get({userId:'me',id:m.id,format:'metadata',metadataHeaders:['From','Date']});const h=Object.fromEntries((data.payload?.headers||[]).map(x=>[x.name.toLowerCase(),x.value]));const from=headerAddress(h.from);const received=Date.parse(h.date||'');if(!byRecipient.has(from)||!Number.isFinite(received)||received<start.getTime()||received>=end.getTime())continue;threadIds.add(data.threadId);}
      for(const threadId of threadIds){
        const {data}=await gmail.users.threads.get({userId:'me',id:threadId,format:'metadata',metadataHeaders:['From','To','Date']});
        const threadMessages=data.messages||[];const sentCampaignRecipients=new Set();
        for(const m of threadMessages){const h=Object.fromEntries((m.payload?.headers||[]).map(x=>[x.name.toLowerCase(),x.value]));const from=headerAddress(h.from),to=String(h.to||'').toLowerCase(),when=Date.parse(h.date||'');
          for(const [recipient,records] of byRecipient){if(records.some(j=>String(j.account||'').toLowerCase()===from&&to.includes(recipient)&&Number.isFinite(when)&&Math.abs(when-Date.parse(j.sentAt))<10*60*1000))sentCampaignRecipients.add(recipient);}
        }
        for(const m of threadMessages){const h=Object.fromEntries((m.payload?.headers||[]).map(x=>[x.name.toLowerCase(),x.value]));const from=headerAddress(h.from),when=Date.parse(h.date||'');if(sentCampaignRecipients.has(from)&&Number.isFinite(when)&&when>=start.getTime()&&when<end.getTime()){count++;responders.add(from);}}
      }
    }catch{available=false;}
  }
  const result={count,responders:responders.size,available};repliesCache={key,at:Date.now(),value:result};return result;
}
function inBusinessWindow(date,zone){const p=zoneParts(date,zone);const weekday=new Date(Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day))).getUTCDay();const mins=Number(p.hour)*60+Number(p.minute);return weekday>=1&&weekday<=5&&mins>=540&&mins<960;}
function nextBusinessTime(after,zone){
  const current=zoneParts(after,zone);const base=Date.UTC(Number(current.year),Number(current.month)-1,Number(current.day));
  for(let offset=0;offset<22;offset++){const d=new Date(base+offset*86400000);const weekday=d.getUTCDay();if(weekday===0||weekday===6)continue;let hour=9,minute=0;if(offset===0){const mins=Number(current.hour)*60+Number(current.minute);if(mins<540){hour=9;}else if(mins<720){hour=12;}else if(mins<960){hour=Number(current.hour);minute=Number(current.minute)+1;if(minute>=60){hour++;minute-=60;}}else continue;}const guess={year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),hour,minute,second:0};let ms=Date.UTC(guess.year,guess.month-1,guess.day,guess.hour,guess.minute);for(let i=0;i<4;i++){const p=zoneParts(new Date(ms),zone);const shown=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));const desired=Date.UTC(guess.year,guess.month-1,guess.day,guess.hour,guess.minute);ms+=desired-shown;}if(ms>after.getTime())return new Date(ms);}throw new Error(`Could not find an upcoming weekday business window for ${zone}.`);
}
function accountUsage(accountId,instant,excludeJobId=''){const key=dayKey(instant);const sent=sendState.history.filter(h=>h.accountId===accountId&&dayKey(new Date(h.startedAt))===key).length;const pending=jobs.filter(j=>j.accountId===accountId&&j.id!==excludeJobId&&j.status==='scheduled'&&dayKey(new Date(j.sendAt))===key).length;return sent+pending;}
function isSuppressed(email){const normalized=String(email||'').trim().toLowerCase();return suppressions.some(s=>String(typeof s==='string'?s:s.email||'').trim().toLowerCase()===normalized);}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function sendWithGmail(job) {
  const account=accounts.find(a=>a.id===job.accountId);
  if(!account) throw new Error('The sending Gmail account is no longer connected.');
  const operation=sendGate.then(async()=>{
    const wait=MIN_SEND_GAP_MS-(Date.now()-Number(sendState.lastSendStartedAt||0));if(wait>0)await sleep(wait);
    const actual=new Date();
    if(isSuppressed(job.to))return {suppressed:true};
    if(job.campaignId&&job.recipientTimeZone&&!inBusinessWindow(actual,job.recipientTimeZone))return {deferUntil:nextBusinessTime(new Date(actual.getTime()+1000),job.recipientTimeZone).toISOString()};
    if(accountUsage(account.id,actual,job.id)>=DAILY_SEND_LIMIT){let later=nextBusinessTime(new Date(actual.getTime()+86400000),job.recipientTimeZone||ACCOUNT_DAY_TIME_ZONE);for(let i=0;i<14&&accountUsage(account.id,later,job.id)>=DAILY_SEND_LIMIT;i++)later=nextBusinessTime(new Date(later.getTime()+86400000),job.recipientTimeZone||ACCOUNT_DAY_TIME_ZONE);return {deferUntil:later.toISOString()};}
    sendState.lastSendStartedAt=actual.getTime();sendState.history.push({accountId:account.id,account:account.email,startedAt:actual.toISOString(),jobId:job.id});sendState.history=sendState.history.filter(h=>Date.now()-Date.parse(h.startedAt)<45*86400000);await saveSendState();
    const message=[`To: ${job.to}`,`Subject: ${job.subject}`,'Content-Type: text/plain; charset=utf-8','MIME-Version: 1.0','',job.body].join('\r\n');
    const raw=Buffer.from(message).toString('base64url');const gmail=google.gmail({version:'v1',auth:authFor(account)});await gmail.users.messages.send({userId:'me',requestBody:{raw}});return {sentAt:actual.toISOString()};
  });sendGate=operation.catch(()=>{});return operation;
}
let schedulerBusy=false;
async function dispatchDueJobs(){
  if(schedulerBusy)return;schedulerBusy=true;
  try{
    for(const job of jobs.filter(j=>j.status==='scheduled'&&Date.parse(j.sendAt)<=Date.now())){
      job.status='sending';job.updatedAt=new Date().toISOString();await saveJobs();
      try{const result=await sendWithGmail(job);if(result.suppressed){job.status='suppressed';job.error='Recipient is on the suppression list.';}else if(result.deferUntil){job.status='scheduled';job.sendAt=result.deferUntil;job.error='Deferred to preserve account cap or recipient local business hours.';}else{job.status='sent';job.sentAt=result.sentAt;job.error=null;}}
      catch(e){job.status='failed';job.error=e.message||'Gmail send failed';}
      job.updatedAt=new Date().toISOString();await saveJobs();
    }
  }finally{schedulerBusy=false;}
}
function createScheduledBatch(requests){
  if(!Array.isArray(requests)||requests.length<1||requests.length>1000)throw new Error('Provide between 1 and 1000 scheduled messages.');
  const now=Date.now();const candidates=requests.map((b,index)=>{
    const account=accounts.find(a=>a.id===b.accountId||a.email.toLowerCase()===String(b.accountEmail||'').toLowerCase());
    const to=String(b.to||'').trim().toLowerCase();const subject=String(b.subject||'').trim();const body=String(b.body||'');const when=Date.parse(b.sendAt);
    if(!account||!AUTHORIZED_SENDERS.has(account.email.toLowerCase()))throw new Error(`Message ${index+1}: choose an authorized Gmail account.`);
    if(!validEmail(to)||!subject||!body.trim())throw new Error(`Message ${index+1}: recipient, subject, or body is invalid.`);
    if(isSuppressed(to))throw new Error(`Message ${index+1}: recipient ${to} is suppressed.`);
    if(!Number.isFinite(when)||when<now+30000)throw new Error(`Message ${index+1}: schedule must be at least 30 seconds in the future.`);
    if(b.campaignId){if(!b.consentConfirmed)throw new Error(`Message ${index+1}: campaign consent confirmation is missing.`);try{new Intl.DateTimeFormat('en-US',{timeZone:b.recipientTimeZone}).format(new Date(when));}catch{throw new Error(`Message ${index+1}: recipient time zone is invalid.`);}if(!inBusinessWindow(new Date(when),b.recipientTimeZone))throw new Error(`Message ${index+1}: scheduled instant is outside the recipient's weekday 9 AM–4 PM window.`);}
    return {id:crypto.randomUUID(),accountId:account.id,account:account.email,to,subject,body,sendAt:new Date(when).toISOString(),recipientTimeZone:b.recipientTimeZone||ACCOUNT_DAY_TIME_ZONE,localSendAt:b.localSendAt||'',leadId:b.leadId||'',campaignId:b.campaignId||'',consentConfirmed:Boolean(b.consentConfirmed),status:'scheduled',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),error:null};
  });
  const seenRecipients=new Set();for(const j of jobs.filter(j=>j.status==='scheduled'))seenRecipients.add(j.to.toLowerCase());for(const j of candidates){if(seenRecipients.has(j.to))throw new Error(`Duplicate or already queued recipient: ${j.to}.`);seenRecipients.add(j.to);}
  const timeline=[...jobs.filter(j=>j.status==='scheduled').map(j=>Date.parse(j.sendAt)),...candidates.map(j=>Date.parse(j.sendAt))].sort((a,b)=>a-b);for(let i=1;i<timeline.length;i++)if(timeline[i]-timeline[i-1]<MIN_SEND_GAP_MS)throw new Error('The queue must keep at least 30 seconds between every scheduled send.');
  const daily=new Map();for(const j of candidates){const key=`${j.accountId}|${dayKey(new Date(j.sendAt))}`;if(!daily.has(key))daily.set(key,accountUsage(j.accountId,new Date(j.sendAt)));const used=daily.get(key);if(used>=DAILY_SEND_LIMIT)throw new Error(`The ${j.account} daily limit of ${DAILY_SEND_LIMIT} would be exceeded on ${dayKey(new Date(j.sendAt))}.`);daily.set(key,used+1);}
  jobs.push(...candidates);return candidates;
}
setInterval(dispatchDueJobs,5000).unref();
http.createServer(async (req,res)=>{
  const u=new URL(req.url,ORIGIN);
  try {
    if(req.method==='GET'&&u.pathname==='/'){await html(res);return;}
    if(req.method==='GET'&&u.pathname==='/api/status'){json(res,200,{configured:!!process.env.GOOGLE_CLIENT_ID&&!!process.env.GOOGLE_CLIENT_SECRET,accounts:accounts.map(({id,email})=>({id,email}))});return;}
    if(req.method==='GET'&&u.pathname==='/api/performance'){
      const today=dayKey(new Date()),date=u.searchParams.get('date')||today;
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(`${date}T00:00:00Z`)))throw new Error('Choose a valid date.');
      const contacts=await refreshPerformanceContacts(),events=performance.events.filter(e=>dayKey(new Date(e.at))===date);
      const replies=await campaignReplies(date);
      const written=jobs.filter(j=>j.createdAt&&dayKey(new Date(j.createdAt))===date).length;
      const sent=jobs.filter(j=>j.status==='sent'&&j.sentAt&&dayKey(new Date(j.sentAt))===date).length;
      json(res,200,{date,timeZone:ACCOUNT_DAY_TIME_ZONE,leadsFound:events.filter(e=>e.type==='lead_found').length,emailsWithSmykm:events.filter(e=>e.type==='smykm_found').length,emailsWritten:written,emailsSent:sent,replies:replies.count,uniqueReplySenders:replies.responders,repliesAvailable:replies.available,contactsTotal:contacts.length,contactsWithSmykm:contacts.filter(hasSmykm).length,connectedAccounts:accounts.length,updatedAt:new Date().toISOString()});return;
    }
    if(req.method==='GET'&&u.pathname==='/api/leads'){
      const bucket=u.searchParams.get('bucket')||'contacts';
      const source=bucket==='contacts'?allCityContacts:bucket==='review'?reviewContacts:bucket==='approved'?approvedContacts:null;
      if(!source)throw new Error('Unknown contact section.');
      const q=(u.searchParams.get('q')||'').trim().toLowerCase();
      const status=u.searchParams.get('status')||'';
      let records=source.map((r,i)=>normalizeLead(r,i,bucket));
      if(q)records=records.filter(r=>[r.name,r.email,r.city,r.location,r.context,r.verificationStatus].join(' ').toLowerCase().includes(q));
      if(status)records=records.filter(r=>r.verificationStatus===status);
      const page=Math.max(1,Number(u.searchParams.get('page')||1));
      const limit=Math.min(100,Math.max(1,Number(u.searchParams.get('limit')||40)));
      const statusCounts=source.map((r,i)=>normalizeLead(r,i,bucket).verificationStatus).reduce((a,s)=>(a[s]=(a[s]||0)+1,a),{});
      json(res,200,{bucket,total:records.length,page,limit,counts:{contacts:allCityContacts.length,review:reviewContacts.length,approved:approvedContacts.filter(r=>r.verificationStatus==='approved_solo').length},statusCounts,records:records.slice((page-1)*limit,page*limit)});return;
    }
    if(req.method==='GET'&&u.pathname==='/api/scheduled'){json(res,200,{jobs:jobs.slice().sort((a,b)=>Date.parse(a.sendAt)-Date.parse(b.sendAt)).map(({body,...j})=>j)});return;}
    if(req.method==='POST'&&u.pathname==='/api/scheduled'){const b=await readBody(req);const [job]=createScheduledBatch([b]);await saveJobs();json(res,201,{job:{...job,body:undefined}});return;}
    if(req.method==='POST'&&u.pathname==='/api/scheduled/batch'){const b=await readBody(req);const created=createScheduledBatch(b.jobs);await saveJobs();json(res,201,{count:created.length,jobs:created.map(({body,...j})=>j)});return;}
    if(req.method==='GET'&&u.pathname==='/api/suppressions'){json(res,200,{suppressions});return;}
    if(req.method==='POST'&&u.pathname==='/api/suppressions'){const b=await readBody(req);const email=String(b.email||'').trim().toLowerCase();if(!validEmail(email))throw new Error('Enter a valid email address to suppress.');if(!isSuppressed(email))suppressions.push({email,reason:String(b.reason||'opt-out').slice(0,200),addedAt:new Date().toISOString()});for(const job of jobs.filter(j=>j.status==='scheduled'&&j.to.toLowerCase()===email)){job.status='suppressed';job.error='Recipient was added to the suppression list.';job.updatedAt=new Date().toISOString();}await Promise.all([saveSuppressions(),saveJobs()]);json(res,200,{ok:true,suppressedCount:suppressions.length});return;}
    if(req.method==='DELETE'&&u.pathname.startsWith('/api/scheduled/')){const id=u.pathname.split('/').pop();const job=jobs.find(j=>j.id===id);if(!job)throw new Error('Scheduled message not found.');if(job.status!=='scheduled')throw new Error('Only queued messages can be cancelled.');job.status='cancelled';job.updatedAt=new Date().toISOString();await saveJobs();json(res,200,{ok:true});return;}
    if(req.method==='GET'&&u.pathname==='/oauth/start'){const c=client();const url=c.generateAuthUrl({access_type:'offline',prompt:'consent select_account',scope:scopes,include_granted_scopes:true,state:crypto.randomUUID()});res.writeHead(302,{location:url});res.end();return;}
    if(req.method==='GET'&&u.pathname==='/oauth/callback'){if(u.searchParams.get('error'))throw new Error(`Google authorization failed: ${u.searchParams.get('error')}`);const c=client();const {tokens}=await c.getToken(u.searchParams.get('code'));c.setCredentials(tokens);const oauth2=google.oauth2({version:'v2',auth:c});const {data}=await oauth2.userinfo.get();if(!data.email)throw new Error('Google did not return an email address.');const existing=accounts.find(a=>a.email.toLowerCase()===data.email.toLowerCase());if(existing){existing.tokens={...existing.tokens,...tokens};}else{if(accounts.length>=5)throw new Error('This prototype supports up to five Gmail accounts.');accounts.push({id:crypto.randomUUID(),email:data.email,tokens});}await save();res.writeHead(302,{location:ORIGIN});res.end();return;}
    if(req.method==='DELETE'&&u.pathname.startsWith('/api/accounts/')){const id=u.pathname.split('/').pop();accounts=accounts.filter(a=>a.id!==id);await save();json(res,200,{ok:true});return;}
    if(req.method==='GET'&&u.pathname==='/api/messages'){const aid=u.searchParams.get('account');const selected=aid?accounts.filter(a=>a.id===aid):accounts;if(!selected.length){json(res,200,{messages:[]});return;}const result=await Promise.all(selected.map(async a=>{const gmail=google.gmail({version:'v1',auth:authFor(a)});const {data}=await gmail.users.messages.list({userId:'me',maxResults:35,labelIds:['INBOX']});return Promise.all((data.messages||[]).map(async m=>{const {data:d}=await gmail.users.messages.get({userId:'me',id:m.id,format:'metadata',metadataHeaders:['From','To','Subject','Date']});const h=Object.fromEntries((d.payload?.headers||[]).map(x=>[x.name.toLowerCase(),x.value]));return {id:d.id,threadId:d.threadId,accountId:a.id,account:a.email,from:h.from||'',to:h.to||'',subject:h.subject||'(no subject)',date:h.date||'',snippet:d.snippet||'',unread:d.labelIds?.includes('UNREAD')||false,star:d.labelIds?.includes('STARRED')||false};}));}));json(res,200,{messages:result.flat().sort((a,b)=>Date.parse(b.date)-Date.parse(a.date))});return;}
    if(req.method==='GET'&&u.pathname.startsWith('/api/messages/')){const [, , ,aid,mid]=u.pathname.split('/');const a=accounts.find(x=>x.id===aid);if(!a){json(res,404,{error:'Account not found'});return;}const gmail=google.gmail({version:'v1',auth:authFor(a)});const {data}=await gmail.users.messages.get({userId:'me',id:mid,format:'full'});const headers=Object.fromEntries((data.payload?.headers||[]).map(x=>[x.name.toLowerCase(),x.value]));const decode=p=>p?.body?.data?Buffer.from(p.body.data,'base64url').toString('utf8'):'';let text=decode(data.payload);const walk=p=>{if(!text&&p.mimeType==='text/plain')text=decode(p);for(const child of p.parts||[])walk(child)};walk(data.payload||{});json(res,200,{id:data.id,threadId:data.threadId,accountId:a.id,account:a.email,from:headers.from||'',to:headers.to||'',subject:headers.subject||'',date:headers.date||'',body:text.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim()||data.snippet||''});return;}
    if(req.method==='POST'&&u.pathname==='/api/send'){json(res,423,{error:'Immediate sending is paused. Use a reviewed scheduled message.'});return;}
    if(req.method==='POST'&&u.pathname==='/api/settings'){const b=await readBody(req);if(!b.clientId||!b.clientSecret)throw new Error('Enter both values.');const content=`GOOGLE_CLIENT_ID=${b.clientId.trim()}\nGOOGLE_CLIENT_SECRET=${b.clientSecret.trim()}\nAPP_ORIGIN=${ORIGIN}\nPORT=${PORT}\n`;await writeFile(envPath,content,{mode:0o600});process.env.GOOGLE_CLIENT_ID=b.clientId.trim();process.env.GOOGLE_CLIENT_SECRET=b.clientSecret.trim();json(res,200,{ok:true});return;}
    json(res,404,{error:'Not found'});
  }catch(e){json(res,400,{error:e.message||'Request failed'});}
}).listen(PORT,HOST,()=>console.log(`Postbox is running at ${ORIGIN}`));

