const { EventEmitter } = require('events')
const { execSync, spawn } = require('child_process')

class AudioCaptureService extends EventEmitter {
  constructor(config) {
    super()
    this.config       = config
    this.leadProcess  = null
    this.agentProcess = null
    this.isRecording  = false
  }

  // ── Start both channels ────────────────────────────────────────────────────
  async start(deviceName = 'default') {
    if (this.isRecording) await this.stop()
    this.isRecording = true

    // Lead source — from Settings or auto-detect monitor
    let leadSource
    if (deviceName && deviceName !== 'default') {
      leadSource = deviceName
    } else {
      leadSource = this._autoDetectMonitor()
    }

    // Agent source — always the real mic (headset or default mic)
    const agentSource = this._autoDetectMic()

    console.log(`[Audio] Lead  → ${leadSource}`)
    console.log(`[Audio] Agent → ${agentSource}`)

    const [leadStream, agentStream] = await Promise.all([
      this._startParec(leadSource,  'lead'),
      this._startParec(agentSource, 'agent')
    ])

    return { leadStream, agentStream }
  }

  // ── Auto detect monitor (lead — what comes out of speakers/headset) ────────
  _autoDetectMonitor() {
    try {
      // Get the default output sink
      const defaultSink = execSync('pactl get-default-sink 2>/dev/null').toString().trim()
      if (defaultSink) {
        console.log(`[Audio] Default sink: ${defaultSink}`)
        return `${defaultSink}.monitor`
      }
    } catch (e) {}
    return 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor'
  }

  // ── Auto detect mic (agent — what comes from mic/headset mic) ─────────────
  _autoDetectMic() {
    try {
      const sources = execSync('pactl list sources short 2>/dev/null').toString()
      const lines   = sources.split('\n').filter(Boolean)

      // Priority 1 — USB headset mic (most specific)
      const usbMic = lines.find(l => {
        const name = l.split('\t')[1]?.trim() || ''
        return name.includes('usb') && name.includes('input')
      })
      if (usbMic) {
        const name = usbMic.split('\t')[1].trim()
        console.log(`[Audio] Found USB headset mic: ${name}`)
        return name
      }

      // Priority 2 — any analog input (3.5mm headset)
      const analogMic = lines.find(l => {
        const name = l.split('\t')[1]?.trim() || ''
        return name.includes('input') && name.includes('analog') && !name.includes('monitor')
      })
      if (analogMic) {
        const name = analogMic.split('\t')[1].trim()
        console.log(`[Audio] Found analog mic: ${name}`)
        return name
      }

      // Priority 3 — any input source that is not a monitor
      const anyMic = lines.find(l => {
        const name = l.split('\t')[1]?.trim() || ''
        return name.includes('input') && !name.includes('monitor')
      })
      if (anyMic) {
        const name = anyMic.split('\t')[1].trim()
        console.log(`[Audio] Found mic: ${name}`)
        return name
      }

      // Priority 4 — default source
      const defaultSource = execSync('pactl get-default-source 2>/dev/null').toString().trim()
      if (defaultSource && !defaultSource.includes('monitor')) {
        console.log(`[Audio] Using default source: ${defaultSource}`)
        return defaultSource
      }

    } catch (e) {
      console.error('[Audio] Mic detection error:', e.message)
    }

    return '@DEFAULT_SOURCE@'
  }

  // ── Start parec for one channel ────────────────────────────────────────────
  _startParec(source, channel) {
    return new Promise((resolve, reject) => {
      console.log(`[Audio] Starting parec for ${channel} on ${source}`)

      const args = [
        '--device', source,
        '--rate',     '16000',
        '--channels', '1',
        '--format',   's16le',
        '--raw'
      ]

      const proc = spawn('parec', args)

      proc.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error('parec not found. Run: sudo apt install pulseaudio-utils'))
        } else {
          reject(new Error(`parec [${channel}] error: ${err.message}`))
        }
      })

      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim()
        console.error(`[parec:${channel}] ${msg}`)
        if (msg.includes('Failed') || msg.includes('Connection refused') || msg.includes('No such')) {
          this.emit('error', new Error(`Audio [${channel}]: ${msg}`))
        }
      })

      let resolved = false

      // Resolve after first data chunk arrives
      proc.stdout.once('data', () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          console.log(`[Audio] ${channel} stream active`)
          resolve(proc.stdout)
        }
      })

      // Timeout — if no data in 4s, resolve anyway (mic might be silent)
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          console.warn(`[Audio] ${channel} timeout — no data yet, continuing anyway`)
          resolve(proc.stdout)
        }
      }, 4000)

      proc.stdout.on('error', (err) => this.emit('error', err))

      if (channel === 'lead')  this.leadProcess  = proc
      if (channel === 'agent') this.agentProcess = proc
    })
  }

  async stop() {
    this.isRecording = false
    ;[this.leadProcess, this.agentProcess].forEach(proc => {
      if (proc) try { proc.kill('SIGTERM') } catch (e) {}
    })
    this.leadProcess  = null
    this.agentProcess = null
    console.log('[Audio] Stopped both channels')
  }

  // ── List devices for Settings dropdown ────────────────────────────────────
  listDevices() {
    const devices = []

    try {
      const sources = execSync('pactl list sources short 2>/dev/null').toString()
      const sinks   = execSync('pactl list sinks short 2>/dev/null').toString()

      // Add monitor sources first (for lead channel)
      sources.split('\n').filter(Boolean).forEach(line => {
        const name = line.split('\t')[1]?.trim()
        if (!name || name === 'agent_sink.monitor') return

        if (name.includes('.monitor')) {
          let label = '🔊 ' + name
          if (name.includes('usb'))          label += ' — Headset output monitor ← use for lead'
          else if (name.includes('analog'))  label += ' — Speaker output monitor ← use for lead'
          devices.push({ id: name, name: label, isMonitor: true })
        }
      })

      // Add mic input sources
      sources.split('\n').filter(Boolean).forEach(line => {
        const name = line.split('\t')[1]?.trim()
        if (!name || name.includes('.monitor') || name.includes('virtual_mic')) return

        if (name.includes('input') || name.includes('mic')) {
          let label = '🎤 ' + name
          if (name.includes('usb'))    label += ' — USB Headset mic'
          else if (name.includes('analog')) label += ' — Analog mic / 3.5mm headset'
          devices.push({ id: name, name: label, isMic: true })
        }
      })

    } catch (e) {
      console.error('[Audio] listDevices error:', e.message)
    }

    // Always add auto-detect at top
    devices.unshift({
      id:   'default',
      name: '⚡ Auto-detect (uses default output monitor for lead, default mic for agent)'
    })

    return devices
  }
}

module.exports = AudioCaptureService