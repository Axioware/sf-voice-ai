class SalesforceService {
  constructor(config) {
    this.config = config
    this.accessToken = null
    this.instanceUrl = config.salesforceUrl || ''
  }

  isConfigured() {
    return !!(this.instanceUrl && this.config.sfClientId && this.config.sfClientSecret)
  }


  async authenticate() {
    if (!this.isConfigured()) throw new Error('Salesforce not configured')

    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: this.config.sfClientId,
      client_secret: this.config.sfClientSecret,
      username: this.config.sfUsername,
      password: this.config.sfPassword + (this.config.sfSecurityToken || '')
    })

    const res = await fetch(`${this.instanceUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Salesforce auth failed: ${err.error_description || res.statusText}`)
    }

    const data = await res.json()
    this.accessToken = data.access_token
    this.instanceUrl = data.instance_url
  }

  /**
   * Save the call transcript as a Salesforce Task / Activity Note.
   * @param {string} transcript  Full call transcript text
   * @param {string} [whoId]     Optional: Contact/Lead ID to relate the task to
   */
  async saveCallNote(transcript, whoId = null) {
    if (!this.accessToken) await this.authenticate()

    const now = new Date()
    const taskBody = {
      Subject: `AI Call Note — ${now.toLocaleDateString()}`,
      Description: transcript.slice(0, 32000), // SF text area limit
      Status: 'Completed',
      ActivityDate: now.toISOString().split('T')[0],
      Type: 'Call'
    }
    if (whoId) taskBody.WhoId = whoId

    const res = await fetch(`${this.instanceUrl}/services/data/v59.0/sobjects/Task`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(taskBody)
    })

    if (!res.ok) {
      // Token may have expired — retry once
      if (res.status === 401) {
        this.accessToken = null
        await this.authenticate()
        return this.saveCallNote(transcript, whoId)
      }
      const err = await res.json().catch(() => [])
      throw new Error(`Failed to save note: ${err[0]?.message || res.statusText}`)
    }

    return res.json()
  }
}

module.exports = SalesforceService