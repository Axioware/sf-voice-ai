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

  //  Get suggestion based on full conversation 
  // conversation = [{ role: 'lead'|'agent', text, time }]
  async getSuggestion({ conversation }) {
    if (!this.client) {
      this._initClient(this.config.anthropicApiKey)
      if (!this.client) throw new Error('Anthropic client not initialised. Check API key in Settings.')
    }

    // Format conversation as readable transcript
    const transcript = conversation
      .map(m => `${m.role === 'lead' ? '🔵 Lead' : '🟢 Agent'}: ${m.text}`)
      .join('\n')

    const userMessage = `## Live call transcript\n\n${transcript}\n\n---\nBased on this conversation, what should the agent say or do next?`

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
    return `You are an AI sales assistant listening to a live call between a sales agent and a lead.

You receive the full conversation transcript with two roles:
- "Lead" — the potential customer speaking through the phone/speaker
- "Agent" — the sales representative speaking into their microphone

Your job:
- Analyse the latest exchange and give the agent a SHORT, ACTIONABLE suggestion
- Identify objections, buying signals, questions, or hesitation from the lead
- Suggest exactly what the agent should say or do next
- Be concise — under 80 words, bullet points if multiple suggestions
- Never repeat the transcript back
- If not enough context yet, say "Listening..."`
  }
}

module.exports = ClaudeService