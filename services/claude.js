class ClaudeService {
  constructor(config) {
    this.config = config
    this.client = null
    this._initClient(config.anthropicApiKey)
  }

  _initClient(apiKey) {
    if (!apiKey) return
    try {
      const Anthropic = require('@anthropic-ai/sdk')
      this.client = new Anthropic({ apiKey: apiKey.trim() })
    } catch (e) { this.client = null }
  }

  isConfigured() {
    return !!this.client && !!this.config.anthropicApiKey
  }

  // ── Get suggestion based on full conversation + lead context ────────────
  // conversation  = [{ role: 'lead'|'agent', text, time }]
  // leadContext   = formatted string from salesforce.formatLeadContext()
  async getSuggestion({ conversation, leadContext }) {
    if (!this.client) {
      this._initClient(this.config.anthropicApiKey)
      if (!this.client) throw new Error('Anthropic client not initialised. Check API key in Settings.')
    }

    // Format conversation as readable transcript
    const transcript = conversation
      .map(m => `${m.role === 'lead' ? '🔵 Lead' : '🟢 Agent'}: ${m.text}`)
      .join('\n')

    // Build user message — include lead context if available
    const contextSection = leadContext
      ? `${leadContext}\n\n`
      : ''

    const userMessage = `${contextSection}## Live Call Transcript\n\n${transcript}\n\n---\nBased on this conversation and the lead information above, what should the agent say or do next?`

    const response = await this.client.messages.create({
      model:      'claude-haiku-4-5-20251001',  // fastest Claude model — lowest latency
      max_tokens: 150,                           // suggestions are short, no need for more
      system: this.config.systemPrompt || this._defaultSystemPrompt(),
      messages: [{ role: 'user', content: userMessage }]
    })

    return response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
  }

  async testConnection(apiKey) {
    try {
      const https = require('https')
      const body  = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }]
      })
      return await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: {
            'x-api-key': apiKey.trim(),
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body)
          }
        }, (res) => {
          let raw = ''
          res.on('data', d => raw += d)
          res.on('end', () => {
            if (res.statusCode === 200) resolve({ success: true })
            else if (res.statusCode === 401) resolve({ success: false, error: 'Invalid API key (401). Check console.anthropic.com' })
            else {
              try { const p = JSON.parse(raw); resolve({ success: false, error: p?.error?.message || `Status ${res.statusCode}` }) }
              catch { resolve({ success: false, error: `Status ${res.statusCode}` }) }
            }
          })
        })
        req.on('error', e => resolve({ success: false, error: e.message }))
        req.setTimeout(8000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }) })
        req.write(body); req.end()
      })
    } catch (e) { return { success: false, error: e.message } }
  }

  _defaultSystemPrompt() {
    return `You are a real-time AI coach sitting beside a sales agent during a live call.

ROLES IN TRANSCRIPT:
- 🔵 Lead = potential customer (the person the agent is trying to convert)
- 🟢 Agent = sales representative (the person you are helping)

YOUR ONLY JOB:
After the lead finishes speaking, tell the agent exactly what to say or do next.

RESPONSE RULES:
- Max 60 words — the agent is reading this live, keep it short
- Lead with the single most important action first
- Use bullet points only if there are 2-3 distinct actions needed
- Never repeat what was just said
- Never explain your reasoning — just give the suggestion
- If the lead asked a direct question, give the agent the exact answer or talking point
- If the lead expressed an objection, name it and give one rebuttal
- If the lead showed buying intent, tell the agent to move toward closing

DETECT AND RESPOND TO:
- Price objection → acknowledge + pivot to value or offer payment plan
- Budget concern → ask about timeline or suggest smaller entry package
- Competitor mention → highlight unique differentiators, never badmouth
- Feature question → answer directly + connect to their specific pain point
- Hesitation/silence → suggest an open-ended question to re-engage
- Buying signal (interest, asking about next steps) → guide agent toward close
- Request for discount → hold value first, offer discount only as last resort

TONE:
Professional, confident, empathetic. The agent should sound helpful not pushy.

If transcript has less than one full sentence from the lead, respond with only:
"Listening..."`
  }
}

module.exports = ClaudeService