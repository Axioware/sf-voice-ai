const { EventEmitter } = require('events')

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
    config   = config || {}
    // Always read fresh from passed config — never rely on stale constructor config
    const apiKey = (config.deepgramApiKey || this.config.deepgramApiKey || '').trim()
    if (!apiKey) throw new Error('Deepgram API key is required. Go to Settings and add it.')

    let createClient
    try {
      const sdk = require('@deepgram/sdk')
      createClient = sdk.createClient
      if (!createClient) throw new Error('createClient not found in SDK')
    } catch (e) {
      throw new Error('Deepgram SDK not installed. Run: npm install @deepgram/sdk')
    }

    console.log('[Deepgram] API key length:', apiKey.length)
    console.log('[Deepgram] Connecting with listen.live...')

    const self = this
    const [leadSocket, agentSocket] = await Promise.all([
      self._createSocket(createClient, apiKey, 'lead'),
      self._createSocket(createClient, apiKey, 'agent')
    ])

    this.leadSocket  = leadSocket
    this.agentSocket = agentSocket
    this.isConnected = true
    this._startKeepAlive()
    this.emit('connected')
  }

  _createSocket(createClient, apiKey, channel) {
    const self = this
    return new Promise(function(resolve, reject) {
      const timeout = setTimeout(function() {
        reject(new Error('Deepgram connection timeout. Check your API key and internet.'))
      }, 10000)

      let socket
      try {
        const dg = createClient(apiKey)
        socket = dg.listen.live({
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
        })
      } catch (e) {
        clearTimeout(timeout)
        return reject(new Error('Failed to create Deepgram socket: ' + e.message))
      }

      socket.on('open', function() {
        clearTimeout(timeout)
        console.log('[Deepgram] Socket open:', channel)
        resolve(socket)
      })

      socket.on('Results', function(data) {
        try {
          const alt  = data && data.channel && data.channel.alternatives && data.channel.alternatives[0]
          const text = alt && alt.transcript && alt.transcript.trim()
          if (!text) return
          const isFinal = data.is_final || data.speech_final
          self.emit('transcript', { text: text, isFinal: isFinal, channel: channel })
          if (data.speech_final) {
            console.log('[Deepgram] speech_final:', channel)
            self.emit('utterance-end', { channel: channel })
          }
        } catch (e) {}
      })

      socket.on('UtteranceEnd', function() {
        console.log('[Deepgram] UtteranceEnd:', channel)
        self.emit('utterance-end', { channel: channel })
      })

      socket.on('SpeechStarted', function() {
        self.emit('speech-started', { channel: channel })
      })

      socket.on('error', function(err) {
        clearTimeout(timeout)
        self.isConnected = false
        const msg = err && err.message ? err.message : String(err)
        const e   = new Error(self._friendlyError(msg))
        self.emit('error', e)
        reject(e)
      })

      socket.on('close', function(code) {
        clearTimeout(timeout)
        self.isConnected = false
        self._stopKeepAlive()
        self.emit('disconnected')
        if (code === 1008 || code === 401) {
          const e = new Error('Deepgram API key invalid (401). Check Settings.')
          self.emit('error', e)
          reject(e)
        }
      })
    })
  }

  sendAudio(chunk, channel) {
    if (!this.isConnected) return
    const socket = channel === 'agent' ? this.agentSocket : this.leadSocket
    if (!socket) return
    try {
      if (socket.getReadyState() === 1) socket.send(chunk)
    } catch (e) {}
  }

  async disconnect() {
    this._stopKeepAlive()
    this.isConnected = false
    var sockets = [this.leadSocket, this.agentSocket]
    sockets.forEach(function(s) {
      if (s) { try { s.requestClose() } catch (e) {} }
    })
    this.leadSocket  = null
    this.agentSocket = null
    this.emit('disconnected')
  }

  async testConnection(apiKey) {
    try {
      const https = require('https')
      return await new Promise(function(resolve) {
        const req = https.request({
          hostname: 'api.deepgram.com',
          path:     '/v1/projects',
          method:   'GET',
          headers:  { Authorization: 'Token ' + apiKey.trim() }
        }, function(res) {
          if (res.statusCode === 200)      resolve({ success: true })
          else if (res.statusCode === 401) resolve({ success: false, error: 'Invalid API key (401)' })
          else                             resolve({ success: false, error: 'Status ' + res.statusCode })
          res.resume()
        })
        req.on('error', function(e) { resolve({ success: false, error: e.message }) })
        req.setTimeout(5000, function() { req.destroy(); resolve({ success: false, error: 'Timeout' }) })
        req.end()
      })
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  _friendlyError(msg) {
    const m = (msg || '').toLowerCase()
    if (m.indexOf('401') > -1 || m.indexOf('unauthorized') > -1) return 'Deepgram API key invalid (401). Go to Settings and re-enter your key.'
    if (m.indexOf('400') > -1) return 'Deepgram rejected parameters (400). Check audio settings.'
    if (m.indexOf('enotfound') > -1 || m.indexOf('econnrefused') > -1) return 'Cannot reach Deepgram — check internet connection.'
    if (m.indexOf('timeout') > -1) return 'Deepgram connection timed out.'
    return 'Deepgram error: ' + msg
  }

  _startKeepAlive() {
    this._stopKeepAlive()
    const self = this
    this.keepAliveInterval = setInterval(function() {
      var sockets = [self.leadSocket, self.agentSocket]
      sockets.forEach(function(s) {
        if (s) { try { s.keepAlive() } catch (e) {} }
      })
    }, 10000)
  }

  _stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }
  }
}

module.exports = DeepgramService