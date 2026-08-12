# Windows Setup Guide — SF Voice AI

## Prerequisites (install in this order)

### 1. Node.js
Download LTS version from https://nodejs.org
Verify: `node --version`

### 2. FFmpeg
```cmd
winget install ffmpeg
```
OR download from https://ffmpeg.org/download.html and add to PATH.
Verify: `ffmpeg -version`

### 3. VB-Audio Virtual Cable (FREE — captures call audio)
Download from https://vb-audio.com/Cable
Install and restart PC.
This creates two virtual devices:
- CABLE Input  → browser audio goes here
- CABLE Output → app captures from here

### 4. Visual Studio Build Tools (for native Node modules)
Download from https://visualstudio.microsoft.com/visual-cpp-build-tools
Select: "Desktop development with C++"

---

## Run the app

```cmd
cd sf-voice-ai
copy .env.example .env
:: edit .env and add your Deepgram / Anthropic (and optional Salesforce) keys
npm install
npm start
```

API keys can also be entered later from the app's **Settings** screen — that's the easier path if you don't want to hand-edit `.env`.

---

## Salesforce lead lookup (optional)

If you want the app to pull up CRM info by phone number during a call, fill in the **Salesforce — Lead Lookup** section in Settings (Instance URL, Connected App Client ID/Secret, Refresh Token) or the matching `SF_*` variables in `.env`. Full setup instructions (Connected App, refresh token, what gets fetched) are in the main [README.md](README.md#salesforce-lead-lookup). This step is optional — the app works fine on transcript-only suggestions without it.

---

## Route Salesforce audio to VB-Cable

1. Open Volume Mixer (right-click speaker icon → Open Volume Mixer)
2. Find your browser (Chrome/Edge/Firefox)
3. Change its output to **CABLE Input (VB-Audio Virtual Cable)**
4. Now the app captures call audio from **CABLE Output**

OR use the app Settings → Lead Audio Device → select CABLE Output

---

## Build Windows installer

```cmd
npm run build:win
```

Output:
```
dist/SF-Voice-AI-1.0.0-windows-setup.exe   ← installer
dist/SF-Voice-AI-1.0.0-windows-x64.exe     ← portable
```

---

## Audio device in Settings

| Device | Purpose |
|--------|---------|
| CABLE Output (VB-Audio Virtual Cable) | Lead voice — call audio from Salesforce |
| Default Microphone | Agent voice — your mic |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ffmpeg not found` | Add ffmpeg to PATH or reinstall |
| No audio from lead | Route browser to CABLE Input in Volume Mixer |
| `npm install` fails | Install Visual Studio Build Tools |
| App opens but no sound | Check VB-Cable is installed and PC restarted |