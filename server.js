require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname, { dotfiles: 'deny' }));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Keeps prompt size (and therefore tokens-per-minute burn) bounded. The
// skills/experience signal a matcher needs is almost always front-loaded in
// a CV or JD, so trimming the tail loses little while meaningfully cutting
// how fast a batch of candidates exhausts the per-minute token budget.
const MAX_TEXT_CHARS = 6000;
function truncateForPrompt(text) {
  if (!text) return text;
  const clean = sanitizeExtractedText(text);
  if (clean.length <= MAX_TEXT_CHARS) return clean;
  return clean.slice(0, MAX_TEXT_CHARS) + '\n[...truncated for length...]';
}

// Some CVs export from Word with a custom font whose glyph-to-codepoint map
// is nonstandard, so mammoth's raw-text extraction comes out with visually-
// similar Cyrillic letters substituted for their Latin lookalikes (seen in
// the wild: U+0437 "з" standing in for "s", corrupting words like "purchase"
// into "purchaзe"). That silently hides exactly the keywords a JD match
// needs. Substituting the common lookalikes back is cheap and safe — it only
// touches characters unlikely to appear intentionally in an English CV.
const CYRILLIC_LOOKALIKES = { 'з': 's', 'З': 'S' };
function sanitizeExtractedText(text) {
  return text.replace(/[зЗ]/g, ch => CYRILLIC_LOOKALIKES[ch]);
}

// Groq's free tier caps tokens-per-minute, not just requests-per-minute.
// Running candidates in parallel means several requests compete for the same
// per-minute budget and all retry into the same reset window together, so
// they keep re-colliding. Serializing to one in-flight call at a time avoids
// that collision — slower per batch, but it actually converges instead of
// repeatedly failing.
const MAX_CONCURRENT_GROQ_CALLS = 1;
const MIN_GAP_BETWEEN_STARTS_MS = 500;
let activeGroqCalls = 0;
let lastCallStart = 0;
const groqQueue = [];

function scheduleGroqCall(fn) {
  return new Promise((resolve, reject) => {
    groqQueue.push({ fn, resolve, reject });
    pumpGroqQueue();
  });
}

function pumpGroqQueue() {
  if (activeGroqCalls >= MAX_CONCURRENT_GROQ_CALLS || groqQueue.length === 0) return;
  const wait = Math.max(0, lastCallStart + MIN_GAP_BETWEEN_STARTS_MS - Date.now());
  if (wait > 0) {
    setTimeout(pumpGroqQueue, wait);
    return;
  }
  const { fn, resolve, reject } = groqQueue.shift();
  activeGroqCalls += 1;
  lastCallStart = Date.now();
  fn().then(resolve, reject).finally(() => {
    activeGroqCalls -= 1;
    pumpGroqQueue();
  });
  pumpGroqQueue();
}

// Retries on 429, honoring Groq's Retry-After header when present and
// falling back to exponential backoff otherwise. Only gives up after
// exhausting retries, so downstream error messages are actually true.
async function fetchGroqWithRetry(body, apiKey, maxRetries = 5) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await scheduleGroqCall(() => fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    }));

    if (response.status !== 429 || attempt >= maxRetries) {
      return response;
    }

    const retryAfterHeader = response.headers.get('retry-after');
    const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : (2 ** attempt) * 1000;
    await sleep(waitMs);
  }
}

// Gemini's free tier is a separate token/request budget from Groq's, so it
// only gets called once Groq's own retries are exhausted — it exists purely
// as a rate-limit escape hatch, not a load-balancing target.
const GEMINI_MODEL = 'gemini-2.0-flash';
async function fetchGeminiForMatch(systemPrompt, userMessage, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 500,
          responseMimeType: 'application/json'
        }
      })
    }
  );

  if (!response.ok) {
    const err = new Error(`Gemini API error ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No text response from Gemini');
  return text;
}

// Shared by both providers: strips markdown fences and salvages a JSON
// object substring if the model wrapped it in commentary.
function parseModelJson(rawContent) {
  const cleaned = rawContent.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse model response');
  }
}

app.post('/api/analyze', async (req, res) => {
  const { jdText, jobTitle, candidateName, cvText, modelName } = req.body;
  const apiKey = process.env.GROQ_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfiguration: API key is missing' });
  }

  const systemPrompt = `You are an expert technical recruiter assistant. You compare a candidate's CV against a job description and produce a strict JSON object only, with no markdown fences and no extra commentary.

CVs list multiple past employers. Before concluding a candidate lacks a required industry or domain, you MUST check every employer in their CV, not just the most recent one or the first one you notice — CVs often describe what each employer manufactures or does in a company-profile line; read those descriptions literally rather than guessing from the job title alone. Do not claim a candidate "lacks experience in X industry" unless none of their listed employers' own descriptions mention X. If a candidate has MORE than the JD's minimum required years or experience level, that is not a gap — do not penalize exceeding a stated minimum. When a JD requirement lists options separated by "/" or "or" (e.g. "B.Tech / Diploma in Mechanical Engineering"), that means ANY ONE of them satisfies the requirement fully — none of the listed options is a lesser or partial match than another.

Before scoring, mentally build a checklist of the JD's concrete requirements (skills, years of experience, domain/industry, seniority) and check each one off against the CV as met, partially met, or missing — grounded in specific lines from the CV, not a general impression.

The JSON object must have exactly these keys, IN THIS ORDER (reason in "summary" first, then commit to "matchPercent" based on that reasoning — the number must be consistent with what "summary" says, never more favorable than the gaps you just described):
{
  "summary": "<70-100 words, third person, in full readable sentences (not a fragment list). Name the current/most relevant employer and what it actually manufactures or does per the CV, state whether that matches the JD's required industry, then name the specific other requirements met and the specific ones missing or weak. Do not compress this below 70 words — the employer/industry grounding and the requirement-by-requirement comparison both need room to be written out in full sentences.>",
  "matchPercent": <integer 0-100, how well the candidate fits the JD>
}

Scoring guidance — be discriminating, most real candidates are imperfect and should NOT cluster near 80: 90-100 = meets nearly every requirement with real depth. 70-89 = meets most core requirements, one or two clear gaps. 50-69 = meets roughly half the requirements, several clear gaps. 30-49 = meets only a minority of requirements. Below 30 = largely unrelated background. Two candidates with different gaps must not receive the same score — reflect the actual difference in the number and severity of unmet requirements.

Return ONLY the JSON object, nothing else.`;

  const userMessage = `JOB TITLE: ${jobTitle || '(not specified)'}

JOB DESCRIPTION:
${truncateForPrompt(jdText)}

---

CANDIDATE NAME: ${candidateName || '(unnamed)'}

CANDIDATE CV:
${truncateForPrompt(cvText)}`;

  let rawContent;
  let usedFallback = false;

  try {
    const response = await fetchGroqWithRetry({
      model: modelName || "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 500
    }, apiKey);

    if (response.ok) {
      const data = await response.json();
      const choice = (data.choices || [])[0];
      if (!choice || !choice.message || !choice.message.content) {
        return res.status(500).json({ error: 'No text response from model' });
      }
      rawContent = choice.message.content;
    } else if (response.status === 429 && geminiApiKey) {
      // Groq's own retries (fetchGroqWithRetry) are already exhausted here —
      // Gemini draws from a separate free-tier budget, so it's a genuine
      // escape hatch rather than just retrying into the same wall.
      usedFallback = true;
      rawContent = await fetchGeminiForMatch(systemPrompt, userMessage, geminiApiKey);
    } else if (response.status === 429) {
      return res.status(429).json({ error: 'Still rate-limited after retrying — try analyzing fewer candidates at once, or wait a minute and re-run the failed ones.' });
    } else {
      return res.status(response.status).json({ error: `API error ${response.status}` });
    }

    const parsed = parseModelJson(rawContent);
    if (typeof parsed.matchPercent !== 'number' || typeof parsed.summary !== 'string') {
      return res.status(500).json({ error: 'Malformed response shape' });
    }

    res.json(parsed);
  } catch (error) {
    console.error(`Error calling ${usedFallback ? 'Gemini fallback' : 'Groq'}:`, error);
    if (usedFallback) {
      return res.status(429).json({ error: 'Groq is rate-limited and the Gemini fallback also failed — try again in a minute.' });
    }
    res.status(500).json({ error: 'Internal server error while calling the AI provider' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
