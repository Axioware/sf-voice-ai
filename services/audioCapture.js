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

  async start(deviceName) {
    if (this.isRecording) await this.stop()
    this.isRecording = true

    const platform = process.platform
    console.log('[Audio] Platform:', platform)

    var leadSource, agentSource, format

    if (platform === 'linux') {
      leadSource  = deviceName && deviceName !== 'default'
        ? deviceName
        : this._getLinuxMonitor()
      agentSource = this._getLinuxMic()
      format      = 'pulse'
      console.log('[Audio] Lead (monitor):', leadSource)
      console.log('[Audio] Agent (mic):', agentSource)
      var results = await Promise.all([
        this._startFFmpegPulse(leadSource,  'lead'),
        this._startFFmpegPulse(agentSource, 'agent')
      ])

    } else if (platform === 'win32') {
      leadSource  = deviceName && deviceName !== 'default'
        ? deviceName
        : 'CABLE Output (VB-Audio Virtual Cable)'
      agentSource = 'default'
      console.log('[Audio] Lead (VB-Cable):', leadSource)
      console.log('[Audio] Agent (mic): default')
      var results = await Promise.all([
        this._startFFmpegDShow(leadSource,  'lead'),
        this._startFFmpegDShow(agentSource, 'agent')
      ])

    } else if (platform === 'darwin') {
      leadSource  = deviceName && deviceName !== 'default'
        ? deviceName
        : this._getMacDeviceIndex('BlackHole') || '1'
      agentSource = '0'
      console.log('[Audio] Lead (BlackHole index):', leadSource)
      console.log('[Audio] Agent (mic index):', agentSource)
      var results = await Promise.all([
        this._startFFmpegAVF(leadSource + ':none',  'lead'),
        this._startFFmpegAVF(agentSource + ':none', 'agent')
      ])

    } else {
      throw new Error('Unsupported platform: ' + platform)
    }

    return { leadStream: results[0], agentStream: results[1] }
  }

  // ── Linux: FFmpeg with PulseAudio ──────────────────────────────────────────
  _startFFmpegPulse(device, channel) {
    const args = [
      '-f',  'pulse',
      '-i',  device,
      '-ar', '16000',
      '-ac', '1',
      '-f',  's16le',
      '-'
    ]
    return this._startFFmpeg(args, channel)
  }

  // ── Windows: FFmpeg with DirectShow ───────────────────────────────────────
  _startFFmpegDShow(device, channel) {
    const inputDevice = device === 'default'
      ? 'audio=@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{00000000-0000-0000-0000-000000000000}'
      : 'audio=' + device
    const args = [
      '-f',  'dshow',
      '-i',  inputDevice,
      '-ar', '16000',
      '-ac', '1',
      '-f',  's16le',
      '-'
    ]
    return this._startFFmpeg(args, channel)
  }

  // ── Mac: FFmpeg with AVFoundation ──────────────────────────────────────────
  _startFFmpegAVF(device, channel) {
    const args = [
      '-f',  'avfoundation',
      '-i',  device,
      '-ar', '16000',
      '-ac', '1',
      '-f',  's16le',
      '-'
    ]
    return this._startFFmpeg(args, channel)
  }

  // ── Core FFmpeg spawn ──────────────────────────────────────────────────────
  _startFFmpeg(args, channel) {
    const self = this
    return new Promise(function(resolve, reject) {
      console.log('[Audio] FFmpeg [' + channel + ']:', args.join(' '))

      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })

      proc.on('error', function(err) {
        self.isRecording = false
        if (err.code === 'ENOENT') {
          reject(new Error(
            'FFmpeg not found.\n' +
            'Linux:   sudo apt install ffmpeg\n' +
            'Mac:     brew install ffmpeg\n' +
            'Windows: winget install ffmpeg  OR  https://ffmpeg.org/download.html'
          ))
        } else {
          reject(new Error('Audio [' + channel + '] error: ' + err.message))
        }
      })

      proc.stderr.on('data', function(data) {
        const msg = data.toString()
        if (msg.toLowerCase().indexOf('error') > -1 ||
            msg.toLowerCase().indexOf('no such') > -1 ||
            msg.toLowerCase().indexOf('invalid') > -1) {
          console.log('[FFmpeg ' + channel + ']', msg.trim().split('\n')[0])
        }
      })

      var resolved = false

      var timeout = setTimeout(function() {
        if (!resolved) {
          resolved = true
          console.log('[Audio] ' + channel + ': waiting for audio (device may be silent)')
          resolve(proc.stdout)
        }
      }, 5000)

      proc.stdout.once('data', function() {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          console.log('[Audio] ' + channel + ': receiving audio')
          resolve(proc.stdout)
        }
      })

      proc.stdout.on('error', function(err) { self.emit('error', err) })

      proc.on('exit', function(code) {
        if (code !== 0 && code !== null && code !== undefined) {
          console.log('[Audio] FFmpeg [' + channel + '] exit code:', code)
        }
      })

      if (channel === 'lead')  self.leadProcess  = proc
      if (channel === 'agent') self.agentProcess = proc
    })
  }

  async stop() {
    this.isRecording = false
    var procs = [this.leadProcess, this.agentProcess]
    procs.forEach(function(proc) {
      if (proc) {
        try { proc.kill('SIGTERM') } catch (e) {}
      }
    })
    this.leadProcess  = null
    this.agentProcess = null
  }

  listDevices() {
    const platform = process.platform
    if (platform === 'linux')  return this._listLinux()
    if (platform === 'win32')  return this._listWindows()
    if (platform === 'darwin') return this._listMac()
    return [{ id: 'default', name: 'Default' }]
  }

  // ── Linux device list ──────────────────────────────────────────────────────
  _listLinux() {
    var devices = [{ id: 'default', name: '⚡ Auto-detect (recommended)' }]
    try {
      execSync('pactl list sources short 2>/dev/null').toString()
        .split('\n').filter(Boolean).forEach(function(line) {
          var name = line.split('\t')[1] && line.split('\t')[1].trim()
          if (!name) return
          var isMonitor = name.indexOf('.monitor') > -1
          var isMic     = name.indexOf('input') > -1 || name.indexOf('mic') > -1
          var label = isMonitor
            ? '🔊 ' + name + ' — Lead voice (call audio)'
            : isMic ? '🎤 ' + name + ' — Agent mic' : name
          devices.push({ id: name, name: label, isMonitor: isMonitor })
        })
    } catch (e) {}
    return devices
  }

  // ── Windows device list ────────────────────────────────────────────────────
  _listWindows() {
    var devices = [
      { id: 'default', name: '⚡ Auto-detect (VB-Cable for lead, default mic for agent)' },
      { id: 'CABLE Output (VB-Audio Virtual Cable)', name: '🔊 VB-Cable Output — Lead voice (call audio) ← select this' }
    ]
    try {
      var out = execSync('ffmpeg -list_devices true -f dshow -i dummy 2>&1').toString()
      out.split('\n').forEach(function(line) {
        if (line.indexOf('"') > -1) {
          var match = line.match(/"([^"]+)"/)
          if (match && match[1] &&
              match[1].indexOf('CABLE') === -1) {
            devices.push({ id: match[1], name: '🎤 ' + match[1] })
          }
        }
      })
    } catch (e) {}
    return devices
  }

  // ── Mac device list ────────────────────────────────────────────────────────
  _listMac() {
    var devices = [{ id: 'default', name: '⚡ Auto-detect (BlackHole for lead, mic for agent)' }]
    try {
      var out = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1').toString()
      out.split('\n').forEach(function(line) {
        var idxMatch  = line.match(/\[(\d+)\]/)
        var nameMatch = line.match(/\]\s+(.+)$/)
        if (idxMatch && nameMatch) {
          var name = nameMatch[1].trim()
          var isBlackhole = name.toLowerCase().indexOf('blackhole') > -1
          devices.push({
            id:   idxMatch[1],
            name: (isBlackhole ? '🔊 ' : '🎤 ') + name
          })
        }
      })
    } catch (e) {}
    return devices
  }

  // ── Linux helpers ──────────────────────────────────────────────────────────
  _getLinuxMonitor() {
    try {
      var defaultSink = execSync('pactl get-default-sink 2>/dev/null').toString().trim()
      if (defaultSink) return defaultSink + '.monitor'
    } catch (e) {}
    return 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor'
  }

  _getLinuxMic() {
    try {
      var sources = execSync('pactl list sources short 2>/dev/null').toString()
      if (sources.indexOf('virtual_mic') > -1) return 'virtual_mic'
      var defaultSrc = execSync('pactl get-default-source 2>/dev/null').toString().trim()
      if (defaultSrc && defaultSrc.indexOf('.monitor') === -1) return defaultSrc
    } catch (e) {}
    return '@DEFAULT_SOURCE@'
  }

  // ── Mac helpers ────────────────────────────────────────────────────────────
  _getMacDeviceIndex(name) {
    try {
      var out = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1').toString()
      var lines = out.split('\n')
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().indexOf(name.toLowerCase()) > -1) {
          var match = lines[i].match(/\[(\d+)\]/)
          if (match) return match[1]
        }
      }
    } catch (e) {}
    return null
  }
}

module.exports = AudioCaptureService