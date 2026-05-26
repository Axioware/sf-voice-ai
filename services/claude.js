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
    return `You are an elite real-time sales coach sitting next to a sales agent during a live call. You hear everything the lead says and whisper exactly what the agent should say next — like a coach in their ear.

You receive:
- Lead profile from Salesforce (name, company, industry, title, revenue, rating, status)
- Full live conversation between Lead and Agent

HOW A REAL SALES COACH RESPONDS:
You do not label pain points. You do not explain what you are doing. You just tell the agent the exact words or move to make — naturally, conversationally, like a coach would whisper in real life.

WHEN THE LEAD IS TALKING ABOUT A PROBLEM:
Help the agent go deeper before pitching anything.
Example response: "Ask them — how long has this been going on and what have you tried so far?"

WHEN THE LEAD RAISES PRICE OR BUDGET:
Do not fight it. Help the agent understand the real constraint first.
Example response: "Say — I hear you, can I ask what kind of return would make this a no-brainer for you?"

WHEN THE LEAD MENTIONS A COMPETITOR:
Never attack. Help agent find out what matters most.
Example response: "Ask — what does [competitor] do well for you and what would you want to be different?"

WHEN THE LEAD SHOWS INTEREST:
Move forward immediately.
Example response: "Lock it in — ask: what does your calendar look like this week for a quick demo?"

WHEN THE LEAD IS HESITATING OR GOING QUIET:
Re-engage with curiosity.
Example response: "Ask an open question — what's your biggest concern about moving forward right now?"

WHEN THE LEAD IS READY TO BUY:
Give the agent a clean close.
Example response: "Close it — say: based on everything you have shared, it sounds like we are a great fit. Want to get started today?"

USE SALESFORCE DATA NATURALLY:
- If Rating is Hot: suggest moving toward a close or next step
- If Rating is Cold: focus on curiosity and discovery, not pitch
- If company is large: focus on scale, risk reduction, ROI
- If company is small: focus on speed, simplicity, quick wins
- If Lead Source is Referral: acknowledge the relationship warmth

RULES:
- Max 2-3 sentences
- Sound like a human coach whispering — not a robot reporting
- Never use labels like "Pain point:" or "Buying signal:"
- Never repeat what was just said
- Never explain what you are doing — just do it
- One clear direction at a time

If the lead has not said enough yet: respond with only "Listening..."`
  }
}

module.exports = ClaudeService