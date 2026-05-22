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
  async start(deviceName) {
    if (this.isRecording) await this.stop()
    this.isRecording = true

    const platform = process.platform
    const devices  = this._getDevices(platform, deviceName)

    console.log('[Audio] Platform:', platform)
    console.log('[Audio] Lead device:', devices.lead)
    console.log('[Audio] Agent device:', devices.agent)

    const [leadStream, agentStream] = await Promise.all([
      this._startFFmpeg(devices.lead,  devices.leadFormat,  'lead'),
      this._startFFmpeg(devices.agent, devices.agentFormat, 'agent')
    ])

    return { leadStream, agentStream }
  }

  // ── Get platform-specific device names and formats ────────────────────────
  _getDevices(platform, deviceName) {
    if (platform === 'linux') {
      // Linux: PulseAudio
      // Lead  = monitor of default output (captures speaker/call audio)
      // Agent = default microphone input
      const monitor = this._getLinuxMonitor(deviceName)
      const mic     = this._getLinuxMic()
      return {
        lead:        monitor,
        leadFormat:  'pulse',
        agent:       mic,
        agentFormat: 'pulse'
      }

    } else if (platform === 'win32') {
      // Windows: DirectShow
      // Lead  = VB-Audio Virtual Cable output (captures call audio from browser)
      // Agent = default microphone
      const leadDevice  = deviceName && deviceName !== 'default'
        ? deviceName
        : 'audio=CABLE Output (VB-Audio Virtual Cable)'
      return {
        lead:        leadDevice,
        leadFormat:  'dshow',
        agent:       'audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{default}',
        agentFormat: 'dshow'
      }

    } else if (platform === 'darwin') {
      // Mac: AVFoundation
      // Lead  = BlackHole 2ch (virtual loopback — captures speaker output)
      // Agent = default microphone (index 0)
      const leadDevice = deviceName && deviceName !== 'default'
        ? deviceName
        : 'BlackHole 2ch'
      const leadIndex  = this._getMacDeviceIndex(leadDevice) || '1'
      return {
        lead:        leadIndex + ':none',   // audio:video (none = no video)
        leadFormat:  'avfoundation',
        agent:       '0:none',              // default mic
        agentFormat: 'avfoundation'
      }

    } else {
      throw new Error('Unsupported platform: ' + platform)
    }
  }

  // ── Start FFmpeg process for one channel ──────────────────────────────────
  _startFFmpeg(device, format, channel) {
    const self = this
    return new Promise(function(resolve, reject) {

      const args = [
        '-f',  format,          // input format (pulse / dshow / avfoundation)
        '-i',  device,          // input device
        '-ar', '16000',         // sample rate 16kHz (what Deepgram expects)
        '-ac', '1',             // mono channel
        '-f',  's16le',         // output format: signed 16-bit little-endian PCM
        '-'                     // output to stdout (pipe)
      ]

      console.log('[Audio] FFmpeg args [' + channel + ']:', args.join(' '))

      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })

      proc.on('error', function(err) {
        self.isRecording = false
        if (err.code === 'ENOENT') {
          reject(new Error(
            'FFmpeg not found.\n' +
            'Linux:   sudo apt install ffmpeg\n' +
            'Mac:     brew install ffmpeg\n' +
            'Windows: https://ffmpeg.org/download.html'
          ))
        } else {
          reject(new Error('Audio capture error [' + channel + ']: ' + err.message))
        }
      })

      // FFmpeg writes info/errors to stderr
      proc.stderr.on('data', function(data) {
        const msg = data.toString()
        // Only log actual errors, not normal FFmpeg output
        if (msg.toLowerCase().indexOf('error') > -1 ||
            msg.toLowerCase().indexOf('no such') > -1) {
          console.log('[FFmpeg ' + channel + ']', msg.trim())
        }
      })

      // Resolve as soon as audio data starts flowing
      let resolved = false

      const timeout = setTimeout(function() {
        if (!resolved) {
          resolved = true
          // Resolve anyway — device may be silent until call starts
          console.log('[Audio] ' + channel + ' stream ready (waiting for audio)')
          resolve(proc.stdout)
        }
      }, 4000)

      proc.stdout.once('data', function() {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          console.log('[Audio] ' + channel + ' receiving audio data')
          resolve(proc.stdout)
        }
      })

      proc.stdout.on('error', function(err) {
        self.emit('error', err)
      })

      proc.on('exit', function(code) {
        if (code !== 0 && code !== null) {
          console.log('[Audio] FFmpeg [' + channel + '] exited with code:', code)
        }
      })

      if (channel === 'lead')  self.leadProcess  = proc
      if (channel === 'agent') self.agentProcess = proc
    })
  }

  // ── Stop all capture ───────────────────────────────────────────────────────
  async stop() {
    this.isRecording = false
    const procs = [this.leadProcess, this.agentProcess]
    procs.forEach(function(proc) {
      if (proc) {
        try { proc.stdin.write('q') } catch (e) {}   // graceful FFmpeg quit
        try { proc.kill('SIGTERM') }  catch (e) {}
      }
    })
    this.leadProcess  = null
    this.agentProcess = null
  }

  // ── List audio devices ────────────────────────────────────────────────────
  listDevices() {
    const platform = process.platform
    if (platform === 'linux')  return this._listLinuxDevices()
    if (platform === 'win32')  return this._listWindowsDevices()
    if (platform === 'darwin') return this._listMacDevices()
    return [{ id: 'default', name: 'Default' }]
  }

  // ── Linux: list PulseAudio sources ────────────────────────────────────────
  _listLinuxDevices() {
    const devices = [{ id: 'default', name: '⚡ Auto-detect monitor (recommended)' }]
    try {
      execSync('pactl list sources short 2>/dev/null').toString()
        .split('\n').filter(Boolean).forEach(function(line) {
          const parts = line.split('\t')
          const name  = parts[1] && parts[1].trim()
          if (!name) return
          const isMonitor = name.indexOf('.monitor') > -1
          const isMic     = name.indexOf('input') > -1 || name.indexOf('mic') > -1
          const label = isMonitor
            ? '🔊 ' + name + ' — Lead voice (call audio)'
            : isMic ? '🎤 ' + name + ' — Agent mic' : name
          devices.push({ id: name, name: label, isMonitor: isMonitor })
        })
    } catch (e) {}
    return devices
  }

  // ── Windows: list DirectShow devices ──────────────────────────────────────
  _listWindowsDevices() {
    const devices = [
      { id: 'default', name: '⚡ Auto-detect (VB-Cable for lead, default mic for agent)' },
      { id: 'audio=CABLE Output (VB-Audio Virtual Cable)', name: '🔊 VB-Cable Output — Lead voice (call audio) ← select this' },
    ]
    try {
      // List DirectShow audio devices via FFmpeg
      const out = execSync('ffmpeg -list_devices true -f dshow -i dummy 2>&1 || true').toString()
      const lines = out.split('\n').filter(function(l) { return l.indexOf('"') > -1 && l.indexOf('audio') > -1 })
      lines.forEach(function(l) {
        const match = l.match(/"([^"]+)"/)
        if (match && match[1]) {
          devices.push({ id: 'audio=' + match[1], name: '🎤 ' + match[1] })
        }
      })
    } catch (e) {}
    return devices
  }

  // ── Mac: list AVFoundation devices ────────────────────────────────────────
  _listMacDevices() {
    const devices = [
      { id: 'default', name: '⚡ Auto-detect (BlackHole for lead, mic for agent)' },
    ]
    try {
      const out = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true').toString()
      const lines = out.split('\n').filter(function(l) { return l.indexOf('[AVFoundation') > -1 && l.indexOf(']') > -1 })
      lines.forEach(function(l) {
        const idxMatch  = l.match(/\[(\d+)\]/)
        const nameMatch = l.match(/\] (.+)$/)
        if (idxMatch && nameMatch) {
          const isBlackhole = nameMatch[1].toLowerCase().indexOf('blackhole') > -1
          devices.push({
            id:   idxMatch[1],
            name: (isBlackhole ? '🔊 ' : '🎤 ') + nameMatch[1].trim()
          })
        }
      })
    } catch (e) {}
    return devices
  }

  // ── Linux helpers ──────────────────────────────────────────────────────────
  _getLinuxMonitor(deviceName) {
    if (deviceName && deviceName !== 'default') return deviceName
    try {
      const defaultSink = execSync('pactl get-default-sink 2>/dev/null').toString().trim()
      if (defaultSink) return defaultSink + '.monitor'
    } catch (e) {}
    return 'default.monitor'
  }

  _getLinuxMic() {
    try {
      // Prefer virtual_mic if it exists (for testing)
      const sources = execSync('pactl list sources short 2>/dev/null').toString()
      if (sources.indexOf('virtual_mic') > -1) return 'virtual_mic'
      const defaultSrc = execSync('pactl get-default-source 2>/dev/null').toString().trim()
      if (defaultSrc && defaultSrc.indexOf('.monitor') === -1) return defaultSrc
    } catch (e) {}
    return 'default'
  }

  // ── Mac helpers ────────────────────────────────────────────────────────────
  _getMacDeviceIndex(deviceName) {
    try {
      const out = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true').toString()
      const lines = out.split('\n')
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().indexOf(deviceName.toLowerCase()) > -1) {
          const match = lines[i].match(/\[(\d+)\]/)
          if (match) return match[1]
        }
      }
    } catch (e) {}
    return null
  }
}

module.exports = AudioCaptureService