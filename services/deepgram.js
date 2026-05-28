const { EventEmitter } = require('events')

class DeepgramService extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.leadSocket  = null
    this.agentSocket = null
    this.isConnected = false
    this.keepAliveInterval = null
  }

  async connect(config) {
    config = config || {}
    const apiKey = config.deepgramApiKey || this.config.deepgramApiKey
    if (!apiKey) throw new Error('Deepgram API key is required.')
    const sdk = require('@deepgram/sdk')
    const createClient = sdk.createClient
    console.log('[Deepgram] Connecting...')
    const self = this
    const results = await Promise.all([
      self._createSocket(createClient, apiKey, 'lead'),
      self._createSocket(createClient, apiKey, 'agent')
    ])
    this.leadSocket  = results[0]
    this.agentSocket = results[1]
    this.isConnected = true
    this._startKeepAlive()
    this.emit('connected')
  }

  _createSocket(createClient, apiKey, channel) {
    const self = this
    return new Promise(function(resolve, reject) {
      const timeout = setTimeout(function() {
        reject(new Error('Deepgram timeout.'))
      }, 10000)
      const dg = createClient(apiKey)
      const socket = dg.listen.live({
        model: 'nova-2',
        smart_format: true,
        interim_results: true,
        utterance_end_ms: 1000,
        vad_events: true,
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        punctuate: true,
        endpointing: 300
      })
      socket.on('open', function() {
        clearTimeout(timeout)
        console.log('[Deepgram] open:', channel)
        resolve(socket)
      })
      socket.on('Results', function(data) {
        try {
          var alt = data && data.channel && data.channel.alternatives && data.channel.alternatives[0]
          var text = alt && alt.transcript && alt.transcript.trim()
          if (!text) return
          var isFinal = data.is_final || data.speech_final
          self.emit('transcript', { text: text, isFinal: isFinal, channel: channel })
          if (data.speech_final) {
            console.log('[Deepgram] speech_final:', channel)
            self.emit('utterance-end', { channel: channel })
          }
        } catch (e) {}
      })
      // UtteranceEnd fires ~1000ms after speech_final and would reset the debounce,
      // adding ~1s of extra latency every turn. We rely solely on speech_final above.
      socket.on('UtteranceEnd', function() {
        console.log('[Deepgram] UtteranceEnd (ignored for LLM trigger):', channel)
      })
      socket.on('error', function(err) {
        clearTimeout(timeout)
        self.isConnected = false
        reject(new Error('Deepgram error: ' + (err && err.message ? err.message : String(err))))
      })
      socket.on('close', function() {
        self.isConnected = false
        self._stopKeepAlive()
        self.emit('disconnected')
      })
    })
  }

  sendAudio(chunk, channel) {
    if (!this.isConnected) return
    var socket = channel === 'agent' ? this.agentSocket : this.leadSocket
    if (!socket) return
    try { if (socket.getReadyState() === 1) socket.send(chunk) } catch (e) {}
  }

  async disconnect() {
    this._stopKeepAlive()
    this.isConnected = false
    var sockets = [this.leadSocket, this.agentSocket]
    sockets.forEach(function(s) { if (s) { try { s.requestClose() } catch (e) {} } })
    this.leadSocket  = null
    this.agentSocket = null
    this.emit('disconnected')
  }

  async testConnection(apiKey) {
    try {
      const https = require('https')
      return await new Promise(function(resolve) {
        var req = https.request({
          hostname: 'api.deepgram.com', path: '/v1/projects',
          method: 'GET', headers: { Authorization: 'Token ' + apiKey }
        }, function(res) {
          if (res.statusCode === 200) resolve({ success: true })
          else if (res.statusCode === 401) resolve({ success: false, error: 'Invalid API key (401)' })
          else resolve({ success: false, error: 'Status ' + res.statusCode })
          res.resume()
        })
        req.on('error', function(e) { resolve({ success: false, error: e.message }) })
        req.setTimeout(5000, function() { req.destroy(); resolve({ success: false, error: 'Timeout' }) })
        req.end()
      })
    } catch (e) { return { success: false, error: e.message } }
  }

  _startKeepAlive() {
    this._stopKeepAlive()
    var self = this
    this.keepAliveInterval = setInterval(function() {
      [self.leadSocket, self.agentSocket].forEach(function(s) {
        if (s) { try { s.keepAlive() } catch (e) {} }
      })
    }, 10000)
  }

  _stopKeepAlive() {
    if (this.keepAliveInterval) { clearInterval(this.keepAliveInterval); this.keepAliveInterval = null }
  }
}

module.exports = DeepgramService
