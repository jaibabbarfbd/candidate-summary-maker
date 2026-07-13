require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.post('/api/analyze', async (req, res) => {
  const { jdText, jobTitle, candidateName, cvText, modelName } = req.body;
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfiguration: API key is missing' });
  }

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

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName || "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      if (response.status === 429) {
         return res.status(429).json({ error: 'Still rate-limited after retrying — try analyzing fewer candidates at once, or wait a minute and re-run the failed ones.' });
      }
      return res.status(response.status).json({ error: `API error ${response.status}` });
    }

    const data = await response.json();
    const choice = (data.choices || [])[0];
    if (!choice || !choice.message || !choice.message.content) {
      return res.status(500).json({ error: 'No text response from model' });
    }

    let cleaned = choice.message.content.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // try to salvage a JSON object substring
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) { parsed = JSON.parse(match[0]); }
      else { return res.status(500).json({ error: 'Could not parse model response' }); }
    }

    if (typeof parsed.matchPercent !== 'number' || typeof parsed.summary !== 'string') {
      return res.status(500).json({ error: 'Malformed response shape' });
    }

    res.json(parsed);
  } catch (error) {
    console.error('Error calling Groq:', error);
    res.status(500).json({ error: 'Internal server error while calling Groq API' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
