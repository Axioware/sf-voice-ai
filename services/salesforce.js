/**
 * Salesforce Service
 * Uses OAuth 2.0 Refresh Token flow — same as reference project
 * Fetches contact/lead/opportunity by phone number
 */
class SalesforceService {
  constructor(config) {
    this.config      = config
    this.accessToken = null
    this.instanceUrl = config.salesforceUrl || ''
  }

  isConfigured() {
    return !!(
      this.config.salesforceUrl   &&
      this.config.sfClientId      &&
      this.config.sfClientSecret  &&
      this.config.sfRefreshToken
    )
  }

  // ── OAuth refresh token flow (same as reference project) ──────────────────
  async authenticate() {
    if (!this.isConfigured()) throw new Error('Salesforce not configured in Settings')

    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     this.config.sfClientId,
      client_secret: this.config.sfClientSecret,
      refresh_token: this.config.sfRefreshToken
    })

    const res = await fetch(`${this.instanceUrl}/services/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString()
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Salesforce auth failed: ${err.error_description || res.statusText}`)
    }

    const data       = await res.json()
    this.accessToken = data.access_token
    this.instanceUrl = data.instance_url || this.instanceUrl
    return this.accessToken
  }

  // ── Ensure we have a valid token ───────────────────────────────────────────
  async _ensureToken() {
    if (!this.accessToken) await this.authenticate()
  }

  // ── Build phone number variants (same logic as reference project) ──────────
  // Reference project builds multiple formats because SF stores phones differently
  _buildPhoneVariants(phoneNumber) {
    const digits  = phoneNumber.replace(/\D/g, '')
    const last10  = digits.slice(-10)
    if (!last10) return []

    const area   = last10.slice(0, 3)
    const prefix = last10.slice(3, 6)
    const line   = last10.slice(6, 10)

    return [
      last10,                          // 3105614025
      `+1${last10}`,                   // +13105614025
      `1${last10}`,                    // 13105614025
      `(${area}) ${prefix}-${line}`,   // (310) 561-4025  ← most common in SF
      `${area}-${prefix}-${line}`,     // 310-561-4025
      `${area}.${prefix}.${line}`,     // 310.561.4025
      `${area} ${prefix} ${line}`,     // 310 561 4025
    ]
  }

  _buildPhoneConditions(field, variants) {
    return variants.map(v => `${field} LIKE '%${v}%'`).join(' OR ')
  }

  // ── Main lookup: search Lead → Opportunity → Contact (same order as reference) ──
  async getLeadByPhone(phoneNumber) {
    await this._ensureToken()

    const variants = this._buildPhoneVariants(phoneNumber)
    if (!variants.length) return null

    // 1. Try Lead first
    const lead = await this._queryLead(variants)
    if (lead) return lead

    // 2. Try Opportunity via Account phone fields
    const opp = await this._queryOpportunity(variants)
    if (opp) return opp

    // 3. Try Contact
    const contact = await this._queryContact(variants)
    if (contact) return contact

    return null
  }

  async _queryLead(variants) {
    const conditions = this._buildPhoneConditions('Phone', variants)
    const soql = `SELECT Id, FirstName, LastName, Phone, MobilePhone, Email,
                         Company, Industry, AnnualRevenue, NumberOfEmployees,
                         Title, LeadSource, Status, Rating, Description,
                         Owner.Name, LastActivityDate, CreatedDate
                  FROM Lead
                  WHERE (${conditions}) AND IsConverted = false
                  LIMIT 1`
    const record = await this._query(soql)
    if (!record) return null
    return { ...record, _type: 'Lead', _ownerName: record.Owner?.Name }
  }

  async _queryOpportunity(variants) {
    // Match reference: check Account.Phone, Account.PersonMobilePhone, Account.PersonHomePhone
    const conditions = [
      this._buildPhoneConditions('Account.Phone',             variants),
      this._buildPhoneConditions('Account.PersonMobilePhone', variants),
      this._buildPhoneConditions('Account.PersonHomePhone',   variants),
    ].join(' OR ')

    const soql = `SELECT Id, Name, Owner.Name,
                         Account.Phone, Account.PersonMobilePhone,
                         Account.Name, Account.Industry, Account.AnnualRevenue,
                         Account.NumberOfEmployees, Account.Website,
                         CloseDate, StageName, Amount
                  FROM Opportunity
                  WHERE (${conditions})
                  ORDER BY CloseDate DESC NULLS LAST, CreatedDate DESC
                  LIMIT 1`
    const record = await this._query(soql)
    if (!record) return null
    return { ...record, _type: 'Opportunity', _ownerName: record.Owner?.Name }
  }

  async _queryContact(variants) {
    // Match reference: check Phone, MobilePhone, HomePhone
    const conditions = [
      this._buildPhoneConditions('Phone',       variants),
      this._buildPhoneConditions('MobilePhone', variants),
      this._buildPhoneConditions('HomePhone',   variants),
    ].join(' OR ')

    const soql = `SELECT Id, FirstName, LastName, Phone, MobilePhone, Email,
                         Account.Name, Account.Industry, Account.AnnualRevenue,
                         Account.NumberOfEmployees, Account.Website,
                         Title, Department, LeadSource, Owner.Name,
                         LastActivityDate, CreatedDate
                  FROM Contact
                  WHERE (${conditions})
                  LIMIT 1`
    const record = await this._query(soql)
    if (!record) return null
    return { ...record, _type: 'Contact', _ownerName: record.Owner?.Name }
  }

  // ── Execute SOQL query ─────────────────────────────────────────────────────
  async _query(soql) {
    try {
      const url = `${this.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      })

      // Token expired — re-auth once and retry
      if (res.status === 401) {
        this.accessToken = null
        await this.authenticate()
        return this._query(soql)
      }

      if (!res.ok) return null

      const data = await res.json()
      return data.records?.[0] || null
    } catch (e) {
      return null
    }
  }

  // ── Format lead info as context string for Claude ─────────────────────────
  formatLeadContext(record) {
    if (!record) return null

    const type = record._type || 'Contact'
    const name = `${record.FirstName || ''} ${record.LastName || ''}`.trim()

    // Normalise company/industry/revenue across Lead, Contact, Opportunity
    const company   = record.Account?.Name  || record.Company  || ''
    const industry  = record.Account?.Industry || record.Industry || ''
    const revenue   = record.Account?.AnnualRevenue || record.AnnualRevenue || ''
    const employees = record.Account?.NumberOfEmployees || record.NumberOfEmployees || ''

    const lines = [
      `## Lead Information (from Salesforce)`,
      `Name:          ${name || 'Unknown'}`,
      `Record Type:   ${type}`,
      company   ? `Company:       ${company}`                                      : null,
      industry  ? `Industry:      ${industry}`                                     : null,
      record.Title        ? `Title:         ${record.Title}`                       : null,
      record.Email        ? `Email:         ${record.Email}`                       : null,
      revenue             ? `Revenue:       $${Number(revenue).toLocaleString()}`  : null,
      employees           ? `Employees:     ${employees}`                          : null,
      record.LeadSource   ? `Lead Source:   ${record.LeadSource}`                 : null,
      record.Status       ? `Lead Status:   ${record.Status}`                     : null,
      record.Rating       ? `Rating:        ${record.Rating}`                     : null,
      record._ownerName   ? `Owner:         ${record._ownerName}`                 : null,
      // Opportunity-specific
      record.StageName    ? `Opp Stage:     ${record.StageName}`                  : null,
      record.Amount       ? `Opp Amount:    $${Number(record.Amount).toLocaleString()}` : null,
      record.Description  ? `Notes:         ${record.Description.slice(0, 200)}`  : null,
      record.LastActivityDate ? `Last Activity: ${record.LastActivityDate}`        : null,
    ].filter(Boolean)

    return lines.join('\n')
  }

  // ── Test connection ────────────────────────────────────────────────────────
  async testConnection() {
    try {
      await this.authenticate()
      // Simple query to verify token works
      const res = await fetch(
        `${this.instanceUrl}/services/data/v59.0/query?q=SELECT+Id+FROM+Lead+LIMIT+1`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      )
      if (res.ok) return { success: true }
      return { success: false, error: `SF query failed: ${res.status}` }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
}

module.exports = SalesforceService