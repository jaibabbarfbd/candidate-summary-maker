const MAX_CANDIDATES = 10;
let candidateIdSeq = 0;
let candidates = []; // {id, fileName, name, cv, status, matchPercent, summary, error, expanded}
let lastRankedResults = [];
let cvLimit = 10;

document.getElementById('today-date').textContent = new Date().toLocaleDateString('en-US', {year:'numeric', month:'long', day:'numeric'});

// --- Groq Config UI Bindings & Persistence ---
const apiKeyInput = document.getElementById('groq-api-key');
const modelSelect = document.getElementById('groq-model');
const toggleKeyBtn = document.getElementById('toggle-key-visibility');
const toggleConfigBtn = document.getElementById('toggle-config-btn');
const configPanelBody = document.getElementById('config-panel-body');

// Load stored values
if (localStorage.getItem('groq_api_key')) {
  apiKeyInput.value = localStorage.getItem('groq_api_key');
}
if (localStorage.getItem('groq_model')) {
  modelSelect.value = localStorage.getItem('groq_model');
}
let configCollapsed = localStorage.getItem('groq_config_collapsed') === 'true';
if (configCollapsed) {
  configPanelBody.style.display = 'none';
  toggleConfigBtn.textContent = '[ Show ]';
} else {
  configPanelBody.style.display = 'block';
  toggleConfigBtn.textContent = '[ Hide ]';
}

// Event Listeners
apiKeyInput.addEventListener('input', () => {
  localStorage.setItem('groq_api_key', apiKeyInput.value.trim());
});
modelSelect.addEventListener('change', () => {
  localStorage.setItem('groq_model', modelSelect.value);
});
toggleKeyBtn.addEventListener('click', () => {
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
    toggleKeyBtn.textContent = 'Hide';
  } else {
    apiKeyInput.type = 'password';
    toggleKeyBtn.textContent = 'Show';
  }
});
toggleConfigBtn.addEventListener('click', () => {
  if (configPanelBody.style.display === 'none') {
    configPanelBody.style.display = 'block';
    toggleConfigBtn.textContent = '[ Hide ]';
    localStorage.setItem('groq_config_collapsed', 'false');
  } else {
    configPanelBody.style.display = 'none';
    toggleConfigBtn.textContent = '[ Show ]';
    localStorage.setItem('groq_config_collapsed', 'true');
  }
});

const cvLimitInput = document.getElementById('cv-limit');
const cvLimitValueEl = document.getElementById('cv-limit-value');
const candLimitLabelEl = document.getElementById('cand-limit-label');

cvLimitInput.addEventListener('input', () => {
  cvLimit = Number(cvLimitInput.value);
  cvLimitValueEl.textContent = cvLimit;
  candLimitLabelEl.textContent = cvLimit;
  updateDropzoneAvailability();
});

function updateDropzoneAvailability(){
  const remaining = cvLimit - candidates.length;
  const dz = document.getElementById('cv-dropzone');
  const label = document.getElementById('cv-dz-label');
  if(remaining <= 0){
    dz.classList.add('disabled');
    label.textContent = `Limit reached (${cvLimit}) — remove a CV or raise the slider to add more`;
  } else {
    dz.classList.remove('disabled');
    label.textContent = `Click to upload, or drag files here — ${remaining} slot${remaining===1?'':'s'} left`;
  }
  document.getElementById('cand-count').textContent = candidates.length;
}

function guessNameFromText(text, fallbackFileName){
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for(let i=0; i<Math.min(lines.length, 8); i++){
    const line = lines[i];
    if(line.length < 3 || line.length > 45) continue;
    if(/[@0-9]/.test(line)) continue;
    if(/resume|curriculum|vitae|\bcv\b|profile|address|phone|email/i.test(line)) continue;
    const words = line.split(/\s+/);
    if(words.length < 2 || words.length > 4) continue;
    const looksNameish = words.every(w => /^[A-Za-z][A-Za-z.'-]*$/.test(w));
    if(!looksNameish) continue;
    return line;
  }
  return fallbackFileName.replace(/\.(docx|txt)$/i,'').replace(/[_\-]+/g,' ').replace(/\s+/g,' ').trim();
}

async function handleFiles(fileList){
  const files = Array.from(fileList);
  const statusEl = document.getElementById('cv-dz-status');
  const remaining = cvLimit - candidates.length;

  if(remaining <= 0){
    statusEl.textContent = `You've reached the limit of ${cvLimit}. Raise the slider or remove a CV first.`;
    statusEl.classList.add('err');
    return;
  }

  const toProcess = files.slice(0, remaining);
  if(files.length > toProcess.length){
    statusEl.textContent = `Only added ${toProcess.length} of ${files.length} files — limit is ${cvLimit}. Raise the slider for more.`;
    statusEl.classList.add('err');
  } else {
    statusEl.textContent = '';
    statusEl.classList.remove('err');
  }

  for(const file of toProcess){
    candidateIdSeq += 1;
    const id = candidateIdSeq;
    candidates.push({id, fileName:file.name, name:'Reading CV…', cv:'', status:'reading', matchPercent:null, summary:'', error:'', expanded:false});
    renderCandidateList();
    updateDropzoneAvailability();

    const text = await extractTextFromFile(file, null);
    const c = candidates.find(x => x.id === id);
    if(!c) continue;
    if(text === null){
      c.status = 'error';
      c.error = 'Could not read this file — try re-saving it as .docx or .txt.';
      c.name = file.name.replace(/\.(docx|txt)$/i,'');
    } else if(text.length === 0){
      c.status = 'error';
      c.error = 'This file appears to be empty.';
      c.name = file.name.replace(/\.(docx|txt)$/i,'');
    } else {
      c.cv = text;
      c.name = guessNameFromText(text, file.name);
      c.status = 'idle';
    }
    renderCandidateList();
  }
  updateDropzoneAvailability();
}

function removeCandidate(id){
  candidates = candidates.filter(c => c.id !== id);
  renderCandidateList();
  updateDropzoneAvailability();
}

function renderCandidateList(){
  const container = document.getElementById('candidate-list');
  container.innerHTML = '';
  candidates.forEach(c => {
    const card = document.createElement('div');
    card.className = 'uploaded-card';
    let metaNote = '';
    if(c.status === 'reading') metaNote = ' — reading file…';
    else if(c.status === 'error') metaNote = ' — read error';
    card.innerHTML = `
      <div class="uc-top">
        <input type="text" class="uc-name" data-id="${c.id}" value="${escapeAttr(c.name)}" placeholder="Candidate name">
        <button class="remove-btn" data-id="${c.id}" title="Remove">✕</button>
      </div>
      <div class="uc-meta">
        <span class="uc-file">${escapeHtml(c.fileName)}${metaNote}</span>
        ${c.status !== 'reading' ? `<button class="uc-toggle" data-id="${c.id}">${c.expanded ? 'Hide text' : 'View / edit text'}</button>` : ''}
      </div>
      ${c.status === 'error' ? `<div class="status-line err">${escapeHtml(c.error)}</div>` : ''}
      ${c.expanded && c.status !== 'reading' ? `<textarea class="uc-text" data-id="${c.id}" placeholder="CV text">${escapeHtml(c.cv)}</textarea>` : ''}
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', e => removeCandidate(Number(e.target.dataset.id)));
  });
  container.querySelectorAll('.uc-name').forEach(inp => {
    inp.addEventListener('input', e => {
      const c = candidates.find(x => x.id === Number(e.target.dataset.id));
      if(c) c.name = e.target.value;
    });
  });
  container.querySelectorAll('.uc-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      const c = candidates.find(x => x.id === Number(e.target.dataset.id));
      if(c){ c.expanded = !c.expanded; renderCandidateList(); }
    });
  });
  container.querySelectorAll('.uc-text').forEach(ta => {
    ta.addEventListener('input', e => {
      const c = candidates.find(x => x.id === Number(e.target.dataset.id));
      if(c) c.cv = e.target.value;
    });
  });

  document.getElementById('cand-count').textContent = candidates.length;
}

function escapeHtml(s){
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escapeAttr(s){
  return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
}

updateDropzoneAvailability();

// ---------- File upload helpers ----------

function wireDropzone(dropzoneEl, fileInputEl, labelEl, statusEl, onFile){
  dropzoneEl.addEventListener('click', () => fileInputEl.click());
  fileInputEl.addEventListener('change', () => {
    if(fileInputEl.files && fileInputEl.files[0]) onFile(fileInputEl.files[0]);
  });
  dropzoneEl.addEventListener('dragover', e => { e.preventDefault(); dropzoneEl.classList.add('drag-over'); });
  dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('drag-over'));
  dropzoneEl.addEventListener('drop', e => {
    e.preventDefault();
    dropzoneEl.classList.remove('drag-over');
    if(e.dataTransfer.files && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
}

async function extractTextFromFile(file, statusEl){
  const name = file.name.toLowerCase();
  if(statusEl){ statusEl.textContent = `Reading ${file.name}...`; statusEl.classList.remove('err'); }
  try{
    if(name.endsWith('.docx')){
      if(typeof mammoth === 'undefined'){
        throw new Error('Word file reader failed to load — check your connection and try again.');
      }
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      if(statusEl) statusEl.textContent = `Loaded ${file.name}`;
      return result.value.trim();
    } else if(name.endsWith('.txt')){
      const text = await file.text();
      if(statusEl) statusEl.textContent = `Loaded ${file.name}`;
      return text.trim();
    } else {
      if(statusEl){ statusEl.textContent = `Unsupported file type. Please upload .docx or .txt.`; statusEl.classList.add('err'); }
      return null;
    }
  }catch(err){
    if(statusEl){ statusEl.textContent = err.message || 'Could not read this file.'; statusEl.classList.add('err'); }
    return null;
  }
}

function wireMultiDropzone(dropzoneEl, fileInputEl, onFiles){
  dropzoneEl.addEventListener('click', () => {
    if(!dropzoneEl.classList.contains('disabled')) fileInputEl.click();
  });
  fileInputEl.addEventListener('change', () => {
    if(fileInputEl.files && fileInputEl.files.length) onFiles(fileInputEl.files);
    fileInputEl.value = '';
  });
  dropzoneEl.addEventListener('dragover', e => { e.preventDefault(); dropzoneEl.classList.add('drag-over'); });
  dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('drag-over'));
  dropzoneEl.addEventListener('drop', e => {
    e.preventDefault();
    dropzoneEl.classList.remove('drag-over');
    if(e.dataTransfer.files && e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  });
}

wireMultiDropzone(
  document.getElementById('cv-dropzone'),
  document.getElementById('cv-files'),
  (fileList) => handleFiles(fileList)
);

wireDropzone(
  document.getElementById('jd-dropzone'),
  document.getElementById('jd-file'),
  document.getElementById('jd-dz-label'),
  document.getElementById('jd-dz-status'),
  async (file) => {
    const text = await extractTextFromFile(file, document.getElementById('jd-dz-status'));
    if(text !== null){
      document.getElementById('jd-text').value = text;
      document.getElementById('jd-dz-label').textContent = `Loaded: ${file.name}`;
    }
  }
);

// ---------- Analysis ----------

function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchWithRetry(apiKey, body, maxAttempts = 5){
  let attempt = 0;
  while(true){
    attempt += 1;
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if(response.status === 429 || response.status === 529 || response.status === 503){
      if(attempt >= maxAttempts) return response; // give up, let caller surface the error
      const retryAfterHeader = response.headers.get('retry-after');
      const waitMs = retryAfterHeader
        ? Math.max(parseFloat(retryAfterHeader) * 1000, 1000)
        : Math.min(1500 * Math.pow(2, attempt - 1), 20000);
      await sleep(waitMs);
      continue;
    }
    return response;
  }
}

async function callGroqForMatch(apiKey, modelName, jdText, jobTitle, candidateName, cvText){
  const systemPrompt = `You are an expert technical recruiter assistant. You compare a candidate's CV against a job description and produce a strict JSON object only, with no markdown fences and no extra commentary.

The JSON object must have exactly these keys:
{
  "matchPercent": <integer 0-100, how well the candidate fits the JD>,
  "summary": "<around 50 words, third person, explaining concretely why this candidate suits THIS role, referencing specific skills/experience that align with the JD>"
}

Scoring guidance: 90-100 = near-perfect fit on skills, experience level, and domain. 70-89 = strong fit with minor gaps. 50-69 = partial fit, some relevant experience but notable gaps. Below 50 = weak fit. Be discriminating — do not default to a narrow band; use the full range based on genuine alignment.

Return ONLY the JSON object, nothing else.`;

  const userMessage = `JOB TITLE: ${jobTitle || '(not specified)'}

JOB DESCRIPTION:
${jdText}

---

CANDIDATE NAME: ${candidateName || '(unnamed)'}

CANDIDATE CV:
${cvText}`;

  const response = await fetchWithRetry(apiKey, {
    model: modelName || "llama-3.1-8b-instant",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 1000
  });

  if(!response.ok){
    if(response.status === 429){
      throw new Error('Still rate-limited after retrying — try analyzing fewer candidates at once, or wait a minute and re-run the failed ones.');
    }
    if(response.status === 401){
      throw new Error('Invalid Groq API key. Please check your credentials.');
    }
    throw new Error(`API error ${response.status}`);
  }

  const data = await response.json();
  const choice = (data.choices || [])[0];
  if(!choice || !choice.message || !choice.message.content) {
    throw new Error('No text response from model');
  }

  let cleaned = choice.message.content.trim().replace(/^```json/i,'').replace(/^```/,'').replace(/```$/,'').trim();
  let parsed;
  try{
    parsed = JSON.parse(cleaned);
  }catch(e){
    // try to salvage a JSON object substring
    const match = cleaned.match(/\{[\s\S]*\}/);
    if(match){ parsed = JSON.parse(match[0]); }
    else throw new Error('Could not parse model response');
  }
  if(typeof parsed.matchPercent !== 'number' || typeof parsed.summary !== 'string'){
    throw new Error('Malformed response shape');
  }
  return parsed;
}

document.getElementById('analyze-btn').addEventListener('click', analyzeAll);

async function analyzeAll(){
  const jdText = document.getElementById('jd-text').value.trim();
  const jobTitle = document.getElementById('job-title').value.trim();
  const helper = document.getElementById('analyze-helper');
  const analyzeBtn = document.getElementById('analyze-btn');

  const apiKey = (localStorage.getItem('groq_api_key') || '').trim();
  if(!apiKey){
    helper.textContent = 'Please enter your Groq API Key first.';
    helper.style.color = 'var(--stamp)';
    configPanelBody.style.display = 'block';
    toggleConfigBtn.textContent = '[ Hide ]';
    localStorage.setItem('groq_config_collapsed', 'false');
    apiKeyInput.focus();
    return;
  }

  if(!jdText){
    helper.textContent = 'Add the job description before analyzing.';
    helper.style.color = 'var(--stamp)';
    return;
  }
  const stillReading = candidates.some(c => c.status === 'reading');
  if(stillReading){
    helper.textContent = 'Still reading uploaded files — try again in a moment.';
    helper.style.color = 'var(--stamp)';
    return;
  }

  const activeCandidates = candidates.filter(c => c.cv.trim().length > 0 && c.status !== 'error');
  if(activeCandidates.length === 0){
    helper.textContent = 'Upload at least one candidate CV before analyzing.';
    helper.style.color = 'var(--stamp)';
    return;
  }

  analyzeBtn.disabled = true;
  helper.style.color = 'var(--ink-soft)';
  document.getElementById('results-panel').style.display = 'block';
  document.getElementById('email-panel').style.display = 'none';

  activeCandidates.forEach(c => { c.status = 'loading'; c.error=''; });
  renderResults(activeCandidates, jobTitle, true);

  let completed = 0;
  const total = activeCandidates.length;
  helper.textContent = `Analyzing 0 / ${total} candidates...`;

  const CONCURRENCY = 3; // keep request bursts small to avoid rate limits
  let cursor = 0;
  const modelName = modelSelect.value || 'llama-3.1-8b-instant';

  async function worker(){
    while(cursor < activeCandidates.length){
      const c = activeCandidates[cursor];
      cursor += 1;
      try{
        const result = await callGroqForMatch(apiKey, modelName, jdText, jobTitle, c.name || 'Unnamed candidate', c.cv);
        c.matchPercent = Math.max(0, Math.min(100, Math.round(result.matchPercent)));
        c.summary = result.summary.trim();
        c.status = 'done';
      }catch(err){
        c.status = 'error';
        c.error = err.message || 'Something went wrong analyzing this candidate.';
      }finally{
        completed += 1;
        helper.textContent = `Analyzing ${completed} / ${total} candidates...`;
        renderResults(activeCandidates, jobTitle, false);
      }
    }
  }

  const workers = Array.from({length: Math.min(CONCURRENCY, activeCandidates.length)}, () => worker());
  await Promise.all(workers);

  helper.textContent = `Done. ${activeCandidates.filter(c=>c.status==='done').length} of ${total} candidates scored.`;
  analyzeBtn.disabled = false;

  lastRankedResults = rankCandidates(activeCandidates);
  if(lastRankedResults.some(c => c.status === 'done')){
    document.getElementById('email-panel').style.display = 'block';
    buildEmail();
  }
}

function rankCandidates(list){
  const done = list.filter(c => c.status === 'done');
  const others = list.filter(c => c.status !== 'done');
  done.sort((a,b) => b.matchPercent - a.matchPercent);
  return [...done, ...others];
}

function stampClass(pct){
  if(pct >= 80) return '';
  if(pct >= 60) return 'mid';
  return 'low';
}

function renderResults(list, jobTitle, forceOrderAsIs){
  const ranked = forceOrderAsIs ? list : rankCandidates(list);
  lastRankedResults = ranked;
  const container = document.getElementById('results-list');
  document.getElementById('results-count').textContent = `${ranked.filter(c=>c.status==='done').length} scored`;
  container.innerHTML = '';

  ranked.forEach((c, idx) => {
    const div = document.createElement('div');
    const displayName = c.name || `Unnamed candidate ${idx+1}`;

    if(c.status === 'loading'){
      div.className = 'dossier';
      div.innerHTML = `
        <div class="stamp-col"><div class="rank-num">—</div><div class="stamp low"><span class="pct">…</span></div></div>
        <div class="dossier-body">
          <div class="dossier-name">${escapeHtml(displayName)}</div>
          <div class="status-line">Analyzing against job description…</div>
        </div>`;
    } else if(c.status === 'error'){
      div.className = 'dossier error';
      div.innerHTML = `
        <div class="stamp-col"><div class="rank-num">—</div><div class="stamp low"><span class="pct">!</span></div></div>
        <div class="dossier-body">
          <div class="dossier-name">${escapeHtml(displayName)}</div>
          <div class="status-line err">Could not score this candidate: ${escapeHtml(c.error)}</div>
        </div>`;
    } else if(c.status === 'done'){
      div.className = 'dossier';
      const wc = c.summary.split(/\s+/).filter(Boolean).length;
      div.innerHTML = `
        <div class="stamp-col">
          <div class="rank-num">#${idx+1}</div>
          <div class="stamp ${stampClass(c.matchPercent)}">
            <span class="pct">${c.matchPercent}%</span>
            <span class="pct-label">MATCH</span>
          </div>
        </div>
        <div class="dossier-body">
          <div class="dossier-name">${escapeHtml(displayName)}</div>
          <div class="dossier-summary">${escapeHtml(c.summary)}<span class="wordcount">${wc} words</span></div>
        </div>`;
    } else {
      div.className = 'dossier';
      div.innerHTML = `
        <div class="stamp-col"><div class="rank-num">—</div><div class="stamp low"><span class="pct">·</span></div></div>
        <div class="dossier-body"><div class="dossier-name">${escapeHtml(displayName)}</div><div class="status-line">Waiting to analyze…</div></div>`;
    }
    container.appendChild(div);
  });
}

// ---------- Email builder ----------

function buildEmail(){
  const jobTitle = document.getElementById('job-title').value.trim() || 'the open role';
  const clientName = document.getElementById('client-name').value.trim();
  const clientCompany = document.getElementById('client-company').value.trim();
  const done = lastRankedResults.filter(c => c.status === 'done');

  const greeting = clientName ? `Hi ${clientName},` : 'Hi,';
  const companyPhrase = clientCompany ? ` for ${clientCompany}` : '';

  let body = `Subject: Shortlist for ${jobTitle}\n\n`;
  body += `${greeting}\n\n`;
  body += `Please find below our ranked shortlist of ${done.length} candidate${done.length===1?'':'s'} for ${jobTitle}${companyPhrase}, ordered by fit against the job description.\n\n`;

  done.forEach((c, idx) => {
    const name = c.name || `Candidate ${idx+1}`;
    body += `${idx+1}. ${name} — ${c.matchPercent}% match\n${c.summary}\n\n`;
  });

  body += `Happy to arrange interviews with any of the above at your convenience, or share full CVs for further review.\n\n`;
  body += `Best regards,\n[Your name]\n[Your consultancy]`;

  document.getElementById('email-output').value = body;
}

document.getElementById('regen-email-btn').addEventListener('click', buildEmail);

document.getElementById('copy-email-btn').addEventListener('click', () => {
  const ta = document.getElementById('email-output');
  ta.select();
  navigator.clipboard.writeText(ta.value).then(() => {
    const msg = document.getElementById('copied-msg');
    msg.style.display = 'inline';
    setTimeout(() => msg.style.display = 'none', 2000);
  });
});