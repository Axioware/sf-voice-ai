const { EventEmitter } = require('events')

const CONNECTION_OPTIONS = {
  model:            'nova-2',
  smart_format:     true,
  interim_results:  true,
  utterance_end_ms: 1500,
  vad_events:       true,
  encoding:         'linear16',
  sample_rate:      16000,
  channels:         1,
  punctuate:        true,
  endpointing:      600
}

class DeepgramService extends EventEmitter {
  constructor(config) {
    super()
    this.config            = config
    this.leadSocket        = null
    this.agentSocket       = null
    this.isConnected       = false
    this.keepAliveInterval = null
  }

  async connect(config) {
    config = config || {}
    const apiKey = config.deepgramApiKey || this.config.deepgramApiKey
    if (!apiKey) throw new Error('Deepgram API key is required.')

    const { DeepgramClient } = require('@deepgram/sdk')
    const dg = new DeepgramClient(apiKey)
    console.log('[Deepgram] Connecting...')

    const [leadSocket, agentSocket] = await Promise.all([
      this._createSocket(dg, 'lead'),
      this._createSocket(dg, 'agent')
    ])

    this.leadSocket  = leadSocket
    this.agentSocket = agentSocket
    this.isConnected = true
    this._startKeepAlive()
    this.emit('connected')
  }

  _createSocket(dg, channel) {
    const self = this
    return new Promise((resolve, reject) => {
      ;(async () => {
        const timeout = setTimeout(() => reject(new Error('Deepgram connection timeout.')), 10000)
        try {
          const socket = await dg.listen.v1.connect(CONNECTION_OPTIONS)

          // Register handlers BEFORE socket.connect() so nothing is missed
          socket.on('message', (data) => {
            try {
              if (!data || !data.type) return
              if (data.type === 'Results') {
                const alt  = data.channel?.alternatives?.[0]
                const text = alt?.transcript?.trim()
                if (!text) return
                const isFinal = data.is_final || data.speech_final
                self.emit('transcript', { text, isFinal, channel })
                if (data.speech_final) {
                  console.log('[Deepgram] speech_final:', channel)
                  self.emit('utterance-end', { channel })
                }
              } else if (data.type === 'UtteranceEnd') {
                console.log('[Deepgram] UtteranceEnd:', channel)
                self.emit('utterance-end', { channel })
              }
            } catch (e) {}
          })

          socket.on('error', (err) => {
            self.isConnected = false
            self.emit('error', new Error('Deepgram [' + channel + ']: ' + (err?.message || String(err))))
          })

          socket.on('close', () => {
            self.isConnected = false
            self._stopKeepAlive()
            self.emit('disconnected')
          })

          // Start the connection now that handlers are registered
          socket.connect()

          await socket.waitForOpen()
          clearTimeout(timeout)
          console.log('[Deepgram] open:', channel)
          resolve(socket)
        } catch (err) {
          clearTimeout(timeout)
          reject(err)
        }
      })()
    })
  }

  sendAudio(chunk, channel) {
    if (!this.isConnected) return
    const socket = channel === 'agent' ? this.agentSocket : this.leadSocket
    if (!socket) return
    try {
      if (socket.readyState === 1) socket.sendMedia(chunk)
    } catch (e) {}
  }

  async disconnect() {
    this._stopKeepAlive()
    this.isConnected = false
    ;[this.leadSocket, this.agentSocket].forEach(s => { if (s) try { s.close() } catch (e) {} })
    this.leadSocket  = null
    this.agentSocket = null
    this.emit('disconnected')
  }

  async testConnection(apiKey) {
    try {
      const https = require('https')
      return await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.deepgram.com', path: '/v1/projects',
          method: 'GET', headers: { Authorization: 'Token ' + apiKey }
        }, (res) => {
          if (res.statusCode === 200)      resolve({ success: true })
          else if (res.statusCode === 401) resolve({ success: false, error: 'Invalid API key (401)' })
          else                             resolve({ success: false, error: 'Status ' + res.statusCode })
          res.resume()
        })
        req.on('error', (e) => resolve({ success: false, error: e.message }))
        req.setTimeout(5000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }) })
        req.end()
      })
    } catch (e) { return { success: false, error: e.message } }
  }

  _startKeepAlive() {
    this._stopKeepAlive()
    this.keepAliveInterval = setInterval(() => {
      ;[this.leadSocket, this.agentSocket].forEach(s => {
        if (s) try { s.sendKeepAlive() } catch (e) {}
      })
    }, 10000)
  }

  _stopKeepAlive() {
    if (this.keepAliveInterval) { clearInterval(this.keepAliveInterval); this.keepAliveInterval = null }
  }
}

module.exports = DeepgramService
