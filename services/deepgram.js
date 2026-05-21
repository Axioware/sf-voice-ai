const { EventEmitter } = require('events')

class DeepgramService extends EventEmitter {
  constructor(config) {
    super()
    this.config  = config
    this.leadSocket  = null   // lead (speaker) connection
    this.agentSocket = null   // agent (mic) connection
    this.isConnected = false
    this.keepAliveInterval = null
    this.sdkVersion = null
  }

  async connect(config = {}) {
    const apiKey = config.deepgramApiKey || this.config.deepgramApiKey
    if (!apiKey) throw new Error('Deepgram API key is required.')

    let sdk
    try { sdk = require('@deepgram/sdk') }
    catch (e) { throw new Error('Deepgram SDK not installed. Run: npm install @deepgram/sdk') }

    const isV4 = typeof sdk.DeepgramClient !== 'undefined'
    this.sdkVersion = isV4 ? 4 : 3

    // Open two parallel WebSocket connections — one per channel
    const [leadSocket, agentSocket] = await Promise.all([
      this._createSocket(sdk, apiKey, 'lead'),
      this._createSocket(sdk, apiKey, 'agent')
    ])

    this.leadSocket  = leadSocket
    this.agentSocket = agentSocket
    this.isConnected = true
    this._startKeepAlive()
    this.emit('connected')
  }

  //  Create a single Deepgram WebSocket for one channel 
  _createSocket(sdk, apiKey, channel) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() =>
        reject(new Error(`Deepgram [${channel}] connection timeout. Check your API key.`))
      , 10000)

      let socket

      if (this.sdkVersion === 4) {
        const dg = new sdk.DeepgramClient({ apiKey })
        dg.listen.v2.createConnection({
          model:          'flux-general-en',
          eot_threshold:  0.7,
          eot_timeout_ms: 3000,
          encoding:       'linear16',
          sample_rate:    16000,
        }).then(s => {
          socket = s
          this._bindSocketEvents(socket, channel, timeout, resolve, reject)
          socket.connect()
        }).catch(reject)
      } else {
        const dg = sdk.createClient(apiKey)
        socket = dg.listen.live({
          model:           'nova-2',
          smart_format:    true,
          interim_results: true,
          utterance_end_ms: 600,   // 600ms silence = utterance done
          vad_events:      true,
          encoding:        'linear16',
          sample_rate:     16000,
          channels:        1,
          punctuate:       true,
        })
        this._bindSocketEventsV3(socket, channel, timeout, resolve, reject)
      }
    })
  }

  //  Bind events for SDK v4 (flux) 
  _bindSocketEvents(socket, channel, timeout, resolve, reject) {
    socket.on('open', () => {
      clearTimeout(timeout)
      resolve(socket)
    })

    socket.on('message', (data) => {
      try {
        if (data.transcript && data.transcript.trim()) {
          this.emit('transcript', {
            text:     data.transcript.trim(),
            isFinal:  data.event === 'EndOfTurn',
            channel,  // 'lead' or 'agent'
            turn:     data.turn_index || 0
          })
        }
        if (data.event === 'EndOfTurn') {
          this.emit('utterance-end', { channel, turn: data.turn_index })
        }
      } catch (e) {}
    })

    socket.on('close', (code) => {
      if (code === 1008 || code === 401) {
        const e = new Error('Deepgram API key invalid (401). Check Settings.')
        this.emit('error', e)
        reject(e)
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      const e = new Error(this._friendlyError(err?.message || String(err)))
      this.emit('error', e)
      reject(e)
    })
  }

  //  Bind events for SDK v3 (nova-2) 
  _bindSocketEventsV3(socket, channel, timeout, resolve, reject) {
    socket.on('open', () => { clearTimeout(timeout); resolve(socket) })

    socket.on('Results', (data) => {
      try {
        const alt  = data?.channel?.alternatives?.[0]
        const text = alt?.transcript?.trim()
        if (!text) return
        this.emit('transcript', {
          text,
          isFinal:  data.is_final || data.speech_final,
          channel,
          confidence: alt.confidence || 0
        })
      } catch (e) {}
    })

    socket.on('UtteranceEnd', () => this.emit('utterance-end', { channel }))

    socket.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(this._friendlyError(err?.message || String(err))))
    })

    socket.on('close', (code) => {
      if (code === 1008 || code === 401) reject(new Error('Deepgram API key invalid (401).'))
    })
  }

  //  Send audio to the correct channel socket 
  sendAudio(chunk, channel) {
    if (!this.isConnected) return
    const socket = channel === 'agent' ? this.agentSocket : this.leadSocket
    if (!socket) return
    try {
      if (this.sdkVersion === 4) socket.sendMedia(chunk)
      else if (socket.getReadyState() === 1) socket.send(chunk)
    } catch (e) {}
  }

  async disconnect() {
    this._stopKeepAlive()
    this.isConnected = false
    ;[this.leadSocket, this.agentSocket].forEach(s => {
      if (s) try { s.requestClose() } catch (e) {}
    })
    this.leadSocket  = null
    this.agentSocket = null
    this.emit('disconnected')
  }

  async testConnection(apiKey) {
    try {
      const https = require('https')
      const result = await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.deepgram.com', path: '/v1/projects',
          method: 'GET', headers: { Authorization: `Token ${apiKey}` }
        }, (res) => {
          let body = ''
          res.on('data', d => body += d)
          res.on('end', () => {
            if (res.statusCode === 200) resolve({ success: true })
            else if (res.statusCode === 401) resolve({ success: false, error: 'Invalid API key (401)' })
            else resolve({ success: false, error: `Status ${res.statusCode}` })
          })
        })
        req.on('error', e => resolve({ success: false, error: e.message }))
        req.setTimeout(5000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }) })
        req.end()
      })
      return result
    } catch (e) { return { success: false, error: e.message } }
  }

  _friendlyError(msg) {
    const m = (msg || '').toLowerCase()
    if (m.includes('401') || m.includes('unauthorized')) return 'Deepgram API key invalid (401). Check Settings.'
    if (m.includes('enotfound') || m.includes('econnrefused')) return 'Cannot reach Deepgram — check internet.'
    if (m.includes('timeout')) return 'Deepgram connection timed out.'
    return `Deepgram error: ${msg}`
  }

  _startKeepAlive() {
    this._stopKeepAlive()
    this.keepAliveInterval = setInterval(() => {
      ;[this.leadSocket, this.agentSocket].forEach(s => {
        if (s) try { s.keepAlive() } catch (e) {}
      })
    }, 10000)
  }

  _stopKeepAlive() {
    if (this.keepAliveInterval) { clearInterval(this.keepAliveInterval); this.keepAliveInterval = null }
  }
}

module.exports = DeepgramService