# SF Voice AI

Real-time AI sales assistant for Salesforce calls.
Captures call audio → Deepgram STT → Claude AI → live suggestions for the agent.

---

## How it works

```
Lead speaks (through speaker/headset)
        ↓
Audio captured via FFmpeg
        ↓
Deepgram transcribes in real time (~300ms)
        ↓
Claude AI generates suggestion after each lead sentence
        ↓
Agent sees suggestion in UI instantly
```

---

## Supported platforms

| Tool | Install |
|------|---------|
| Node.js 18+ | https://nodejs.org |
| SoX (audio) | `brew install sox` (Mac) · `apt install sox` (Linux) · https://sox.sourceforge.net (Win) |
| Deepgram account | https://console.deepgram.com — free tier available |
| Anthropic account | https://console.anthropic.com |

**For capturing the other side of the call (not just your mic):**
- macOS: Install [BlackHole](https://github.com/ExistentialAudio/BlackHole) (free virtual audio device)
- Windows: Install [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) (free)
- Linux: Use PulseAudio loopback module

---

## Quick start

### Linux
```bash
sudo apt install ffmpeg
npm install
npm start
```

### Windows
See [WINDOWS_SETUP.md](WINDOWS_SETUP.md)
```cmd
npm install
npm start
```

### Mac
```bash
brew install ffmpeg
# Install BlackHole: https://github.com/ExistentialAudio/BlackHole
npm install
npm start
```

---

## API Keys required

| Key | Get from |
|-----|----------|
| Deepgram | console.deepgram.com |
| Anthropic | console.anthropic.com |

Add to `.env` file (copy from `.env.example`) or enter in app Settings.

---

## Build installers

```bash
npm run build:linux   # .deb + AppImage
npm run build:win     # .exe (run on Windows)
npm run build:mac     # .dmg (run on Mac)
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `SoX not found` | Install SoX for your platform (see Prerequisites) |
| No audio input | Check System Preferences > Privacy > Microphone |
| Deepgram timeout | Check your API key and network connection |
| Only hearing yourself (not caller) | Install BlackHole/VB-Cable and select it as audio device |
| Anthropic 401 error | Check your ANTHROPIC_API_KEY in Settings |

---

## Building for Distribution

```bash
npm run build
# Output in dist/ folder
```