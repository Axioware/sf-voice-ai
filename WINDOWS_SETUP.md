# Windows Setup Guide — SF Voice AI

Two paths below: a **quick path** for installing the already-built app (no Node/build tools needed), and a **developer path** for running from source. Both need VB-Audio Virtual Cable and FFmpeg on PATH first.

---

## Quick path — installing the built app (`SF-Voice-AI-*-windows-setup.exe`)

1. **Install VB-Audio Virtual Cable.** Download `VBCABLE_Setup_x64.exe` from https://vb-audio.com/Cable/, install, and **restart your PC**.
2. **Install FFmpeg and add it to PATH.**
   - Download a build from https://ffmpeg.org/download.html and unzip it somewhere permanent (e.g. `C:\ffmpeg`).
   - Open **Settings → System → About → Advanced system settings → Environment Variables**.
   - Under *System variables*, edit `Path`, add the folder containing `ffmpeg.exe` (e.g. `C:\ffmpeg\bin`).
   - Open a new terminal and verify: `ffmpeg -version`.
3. **Set your system output device to CABLE Input.** Settings → System → Sound → Output → choose **CABLE Input (VB-Audio Virtual Cable)**.
   This routes all system/browser audio (including your Salesforce softphone call) into VB-Cable so the app can capture it. If you'd rather keep normal system sound and only route your browser, see [Route Salesforce audio to VB-Cable](#route-salesforce-audio-to-vb-cable-alternative) below for a narrower alternative.
4. **Install and run** `SF-Voice-AI-<version>-windows-setup.exe`.
5. Open the app, go to **Settings**, add your Deepgram / Anthropic API keys (and Salesforce fields if you're using lead lookup — see [README.md](README.md#salesforce-lead-lookup)), and select your **Agent Audio Device** (your real mic/headset) if auto-detect doesn't pick the right one.

---

## Developer path — running from source

### Prerequisites (install in this order)

### 1. Node.js
Download LTS version from https://nodejs.org
Verify: `node --version`

### 2. FFmpeg
```cmd
winget install ffmpeg
```
OR download from https://ffmpeg.org/download.html and add to PATH (see step 2 above).
Verify: `ffmpeg -version`

### 3. VB-Audio Virtual Cable (FREE — captures call audio)
Download from https://vb-audio.com/Cable
Install and restart PC.
This creates two virtual devices:
- CABLE Input  → browser/system audio goes here
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

API keys can also be entered later from the app's **Settings** screen instead of editing `.env` by hand.

---

## Route Salesforce audio to VB-Cable (alternative)

If you don't want to change your whole system's output device, you can route just the browser:

1. Open Volume Mixer (right-click speaker icon → Open Volume Mixer)
2. Find your browser (Chrome/Edge/Firefox)
3. Change its output to **CABLE Input (VB-Audio Virtual Cable)**
4. Now the app captures call audio from **CABLE Output**

OR use the app Settings → **Lead Audio Device** → select CABLE Output

---

## Salesforce lead lookup (optional)

If you want the app to pull up CRM info by phone number during a call, fill in the **Salesforce — Lead Lookup** section in Settings (Instance URL, Connected App Client ID/Secret, Refresh Token) or the matching `SF_*` variables in `.env`. Full setup instructions (Connected App, refresh token, what gets fetched) are in the main [README.md](README.md#salesforce-lead-lookup). This step is optional — the app works fine on transcript-only suggestions without it.

---

## Build Windows installer

```cmd
npm run build:win
```

Output:
```
dist/SF-Voice-AI-<version>-windows-x64.exe   ← installer (NSIS)
dist/SF-Voice-AI-<version>-windows-*.exe     ← portable, depending on package.json target config
```

---

## Audio devices in Settings

The app has **two independent** audio device dropdowns — set both for reliable capture:

| Setting | Device | Purpose |
|---------|--------|---------|
| Lead Audio Device | CABLE Output (VB-Audio Virtual Cable) | Lead voice — call audio from Salesforce |
| Agent Audio Device | your real microphone/headset | Agent voice — your mic |

Auto-detect works for most setups, but on machines with multiple audio devices (common on Windows) it's worth picking your mic explicitly under **Agent Audio Device** rather than trusting auto-detect.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ffmpeg not found` | Add ffmpeg to PATH (see step 2) or reinstall, then open a fresh terminal |
| No audio from lead | Route your browser/system output to CABLE Input (see above) |
| Wrong mic captured as Agent voice | Set it explicitly in Settings → **Agent Audio Device** |
| `npm install` fails | Install Visual Studio Build Tools (developer path only) |
| App opens but no sound | Check VB-Cable is installed and PC restarted |
| Anthropic/Deepgram 401 error | Re-check the API key in Settings |
| Salesforce test connection fails | Re-check Instance URL / Client ID / Client Secret / Refresh Token in Settings |
