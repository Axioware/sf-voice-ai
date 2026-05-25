const { EventEmitter } = require('events')
const { execSync, spawn } = require('child_process')
const path = require('path')
const fs   = require('fs')

// In a packaged Electron app, extraResources land in process.resourcesPath.
// In dev, fall back to system ffmpeg on PATH.
function getFfmpegBin() {
  if (process.platform !== 'win32') return 'ffmpeg'
  const bundled = path.join(process.resourcesPath || '', 'ffmpeg.exe')
  return fs.existsSync(bundled) ? bundled : 'ffmpeg'
}

class AudioCaptureService extends EventEmitter {
  constructor(config) {
    super()
    this.config       = config
    this.leadProcess  = null
    this.agentProcess = null
    this.isRecording  = false
  }

  async start(deviceName = 'default') {
    if (this.isRecording) await this.stop()
    this.isRecording = true

    if (process.platform === 'win32') return this._startWindows(deviceName)
    if (process.platform === 'darwin') return this._startMac(deviceName)
    return this._startLinux(deviceName)
  }

  // ── Windows: ffmpeg WASAPI loopback (no VB-Cable required) ────────────────
  async _startWindows(deviceName) {
    // leadDevice: name of output device to loopback from, or '' for system default
    // agentDevice: name of input device (mic), or '' for system default
    const leadDevice  = (deviceName && deviceName !== 'default' && deviceName.startsWith('loopback:'))
      ? deviceName.slice('loopback:'.length)
      : ''
    const agentDevice = ''

    console.log(`[Audio] Windows WASAPI — lead loopback: "${leadDevice || 'default'}", agent mic: "default"`)

    const [leadStream, agentStream] = await Promise.all([
      this._startFfmpegWasapi('loopback', leadDevice,  'lead'),
      this._startFfmpegWasapi('mic',      agentDevice, 'agent')
    ])
    return { leadStream, agentStream }
  }

  _startFfmpegWasapi(mode, deviceName, channel) {
    return new Promise((resolve, reject) => {
      const baseArgs = ['-nostdin', '-hide_banner', '-loglevel', 'warning']
      const inputArgs = mode === 'loopback'
        ? ['-f', 'wasapi', '-loopback', '1', '-i', deviceName]
        : ['-f', 'wasapi', '-i', deviceName]
      const outputArgs = ['-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1']

      const proc = spawn(getFfmpegBin(), [...baseArgs, ...inputArgs, ...outputArgs])
      this._attachProcHandlers(proc, channel, 'ffmpeg not found — install from https://ffmpeg.org/download.html', resolve, reject)
    })
  }

  // ── macOS: ffmpeg avfoundation ─────────────────────────────────────────────
  async _startMac(deviceName) {
    // deviceName can be a numeric avfoundation audio device index, e.g. '1' for BlackHole
    // If none given, uses the default mic for both channels (lead audio won't work without
    // a loopback device like BlackHole — install from https://github.com/ExistentialAudio/BlackHole)
    const leadIndex  = deviceName && deviceName !== 'default' ? deviceName : '0'
    const agentIndex = '0'

    if (leadIndex === '0') {
      console.warn('[Audio] macOS: no loopback device set — both channels use default mic. ' +
                   'Install BlackHole and select it as the lead audio device in Settings.')
    }
    console.log(`[Audio] macOS avfoundation — lead :${leadIndex}, agent :${agentIndex}`)

    const [leadStream, agentStream] = await Promise.all([
      this._startFfmpegAvfoundation(leadIndex,  'lead'),
      this._startFfmpegAvfoundation(agentIndex, 'agent')
    ])
    return { leadStream, agentStream }
  }

  _startFfmpegAvfoundation(deviceIndex, channel) {
    return new Promise((resolve, reject) => {
      const args = [
        '-nostdin', '-hide_banner', '-loglevel', 'warning',
        '-f', 'avfoundation', '-i', `:${deviceIndex}`,
        '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'
      ]
      const proc = spawn(getFfmpegBin(), args)
      this._attachProcHandlers(proc, channel, 'ffmpeg not found — install via: brew install ffmpeg', resolve, reject)
    })
  }

  // ── Linux: parec (PulseAudio) ──────────────────────────────────────────────
  async _startLinux(deviceName) {
    const leadSource  = (deviceName && deviceName !== 'default')
      ? deviceName
      : this._autoDetectMonitor()
    const agentSource = this._autoDetectMic()

    console.log(`[Audio] Lead  → ${leadSource}`)
    console.log(`[Audio] Agent → ${agentSource}`)

    const [leadStream, agentStream] = await Promise.all([
      this._startParec(leadSource,  'lead'),
      this._startParec(agentSource, 'agent')
    ])
    return { leadStream, agentStream }
  }

  _autoDetectMonitor() {
    try {
      const defaultSink = execSync('pactl get-default-sink 2>/dev/null').toString().trim()
      if (defaultSink) {
        console.log(`[Audio] Default sink: ${defaultSink}`)
        return `${defaultSink}.monitor`
      }
    } catch (e) {}
    return 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor'
  }

  _autoDetectMic() {
    try {
      const sources = execSync('pactl list sources short 2>/dev/null').toString()
      const lines   = sources.split('\n').filter(Boolean)

      const usbMic = lines.find(l => {
        const name = l.split('\t')[1]?.trim() || ''
        return name.includes('usb') && name.includes('input')
      })
      if (usbMic) return usbMic.split('\t')[1].trim()

      const analogMic = lines.find(l => {
        const name = l.split('\t')[1]?.trim() || ''
        return name.includes('input') && name.includes('analog') && !name.includes('monitor')
      })
      if (analogMic) return analogMic.split('\t')[1].trim()

      const anyMic = lines.find(l => {
        const name = l.split('\t')[1]?.trim() || ''
        return name.includes('input') && !name.includes('monitor')
      })
      if (anyMic) return anyMic.split('\t')[1].trim()

      const defaultSource = execSync('pactl get-default-source 2>/dev/null').toString().trim()
      if (defaultSource && !defaultSource.includes('monitor')) return defaultSource
    } catch (e) {
      console.error('[Audio] Mic detection error:', e.message)
    }
    return '@DEFAULT_SOURCE@'
  }

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
      this._attachProcHandlers(proc, channel, 'parec not found — run: sudo apt install pulseaudio-utils', resolve, reject)
    })
  }

  // ── Shared process lifecycle handler ──────────────────────────────────────
  _attachProcHandlers(proc, channel, notFoundMsg, resolve, reject) {
    proc.on('error', (err) => {
      reject(new Error(err.code === 'ENOENT' ? notFoundMsg : `[${channel}] ${err.message}`))
    })

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim()
      if (!msg) return
      // ffmpeg/parec print info to stderr — only surface real failures
      if (msg.includes('No such') || msg.includes('Connection refused') ||
          msg.includes('Invalid') || msg.includes('Could not')) {
        console.error(`[audio:${channel}] ${msg}`)
        this.emit('error', new Error(`Audio [${channel}]: ${msg}`))
      }
    })

    let resolved = false
    proc.stdout.once('data', () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        console.log(`[Audio] ${channel} stream active`)
        resolve(proc.stdout)
      }
    })

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
    if (process.platform === 'win32') return this._listDevicesWindows()
    if (process.platform === 'darwin') return this._listDevicesMac()
    return this._listDevicesLinux()
  }

  _listDevicesWindows() {
    const devices = [{
      id:   'default',
      name: '⚡ Auto-detect (WASAPI system-audio loopback + default mic — no VB-Cable needed)'
    }]

    try {
      const output = execSync('ffmpeg -f wasapi -list_devices true -i dummy 2>&1', { timeout: 4000 }).toString()
      output.split('\n').forEach(line => {
        const m = line.match(/"([^"]+)"\s+\((\w+)\)/)
        if (!m) return
        const [, name, type] = m
        if (type === 'output') {
          devices.push({ id: `loopback:${name}`, name: `🔊 ${name} — output loopback (for lead)`, isMonitor: true })
        } else if (type === 'input') {
          devices.push({ id: `mic:${name}`, name: `🎤 ${name} — microphone (for agent)`, isMic: true })
        }
      })
    } catch (e) {
      // ffmpeg absent or timed out — just return default
    }

    return devices
  }

  _listDevicesMac() {
    const devices = [{
      id:   'default',
      name: '⚡ Auto-detect (default mic for both channels)'
    }]

    try {
      const output = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1', { timeout: 4000 }).toString()
      output.split('\n').forEach(line => {
        const m = line.match(/\[(\d+)\]\s+(.+)/)
        if (!m) return
        const [, index, name] = m
        if (name.toLowerCase().includes('blackhole') || name.toLowerCase().includes('soundflower')) {
          devices.push({ id: index, name: `🔊 ${name} — loopback device (use for lead)`, isMonitor: true })
        } else {
          devices.push({ id: index, name: `🎤 ${name}`, isMic: true })
        }
      })
    } catch (e) {}

    return devices
  }

  _listDevicesLinux() {
    const devices = []

    try {
      const sources = execSync('pactl list sources short 2>/dev/null').toString()
      const sinks   = execSync('pactl list sinks short 2>/dev/null').toString()

      sources.split('\n').filter(Boolean).forEach(line => {
        const name = line.split('\t')[1]?.trim()
        if (!name || name === 'agent_sink.monitor') return

        if (name.includes('.monitor')) {
          let label = '🔊 ' + name
          if (name.includes('usb'))         label += ' — Headset output monitor ← use for lead'
          else if (name.includes('analog')) label += ' — Speaker output monitor ← use for lead'
          devices.push({ id: name, name: label, isMonitor: true })
        }
      })

      sources.split('\n').filter(Boolean).forEach(line => {
        const name = line.split('\t')[1]?.trim()
        if (!name || name.includes('.monitor') || name.includes('virtual_mic')) return

        if (name.includes('input') || name.includes('mic')) {
          let label = '🎤 ' + name
          if (name.includes('usb'))         label += ' — USB Headset mic'
          else if (name.includes('analog')) label += ' — Analog mic / 3.5mm headset'
          devices.push({ id: name, name: label, isMic: true })
        }
      })
    } catch (e) {
      console.error('[Audio] listDevices error:', e.message)
    }

    devices.unshift({
      id:   'default',
      name: '⚡ Auto-detect (uses default output monitor for lead, default mic for agent)'
    })

    return devices
  }
}

module.exports = AudioCaptureService
