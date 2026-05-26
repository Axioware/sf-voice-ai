const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Call control
  startCall:    () => ipcRenderer.invoke('start-call'),
  stopCall:     () => ipcRenderer.invoke('stop-call'),
  clearChat:    () => ipcRenderer.invoke('clear-chat'),

  // Salesforce
  testSalesforce: () => ipcRenderer.invoke('test-salesforce'),

  // Lead lookup
  lookupLead:   (phone) => ipcRenderer.invoke('lookup-lead', phone),

  // Settings
  getSettings:      () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  testDeepgram:     () => ipcRenderer.invoke('test-deepgram'),
  testSalesforce:   () => ipcRenderer.invoke('test-salesforce'),
  testAnthropic:    () => ipcRenderer.invoke('test-anthropic'),
  getAudioDevices:  () => ipcRenderer.invoke('get-audio-devices'),
  getInputDevices:  () => ipcRenderer.invoke('get-input-devices'),

  // Window
  minimizeWindow:      () => ipcRenderer.invoke('minimize-window'),
  closeWindow:         () => ipcRenderer.invoke('close-window'),
  toggleAlwaysOnTop: (v) => ipcRenderer.invoke('toggle-always-on-top', v),
  openExternal:      (u) => ipcRenderer.invoke('open-external', u),

  // Events: main → renderer
  onTranscriptUpdate:  (cb) => ipcRenderer.on('transcript-update',  (_, d) => cb(d)),
  onLLMReply:          (cb) => ipcRenderer.on('llm-reply',          (_, d) => cb(d)),
  onLLMThinking:       (cb) => ipcRenderer.on('llm-thinking',       (_, d) => cb(d)),
  onLLMError:          (cb) => ipcRenderer.on('llm-error',          (_, d) => cb(d)),
  onCallStatus:        (cb) => ipcRenderer.on('call-status',        (_, d) => cb(d)),
  onDeepgramStatus:    (cb) => ipcRenderer.on('deepgram-status',    (_, d) => cb(d)),
  onDeepgramError:     (cb) => ipcRenderer.on('deepgram-error',     (_, d) => cb(d)),
  onAudioError:        (cb) => ipcRenderer.on('audio-error',        (_, d) => cb(d)),
  onChatCleared:       (cb) => ipcRenderer.on('chat-cleared',       ()     => cb()),
  onSFSaved:           (cb) => ipcRenderer.on('sf-saved',           (_, d) => cb(d)),
  onNavigate:          (cb) => ipcRenderer.on('navigate',           (_, d) => cb(d)),
  onVirtualSinkReady:  (cb) => ipcRenderer.on('virtual-sink-ready', (_, d) => cb(d)),
  onLeadFound:         (cb) => ipcRenderer.on('lead-found',         (_, d) => cb(d)),
  onLeadLookupStatus:  (cb) => ipcRenderer.on('lead-lookup-status', (_, d) => cb(d)),
  onAutoRouteResult:   (cb) => ipcRenderer.on('auto-route-result',  (_, d) => cb(d)),

  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch)
})