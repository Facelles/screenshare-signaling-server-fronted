# 📺 Screenshare & Intercom Web App (Frontend)

A high-performance, low-latency screen sharing application with built-in bidirectional voice communication (intercom). Built with WebRTC, React, and Socket.IO.

## ✨ Features

### 🖥 For the Host
- **Screen & System Audio Sharing**: Share any window, tab, or entire screen along with its system audio.
- **Host Microphone**: Toggle your microphone at any time to talk to the viewer.
- **Document Picture-in-Picture (PiP)**: Pop out a floating mini-window containing the stream preview, viewer status, and microphone controls. (Falls back to standard Video PiP in Firefox/Safari).
- **Viewer Management**: See when the viewer is speaking via real-time audio indicators, and mute the viewer if necessary.
- **Real-time Stats**: Monitor connection quality with live FPS and Bitrate (kbps) metrics.

### 🎧 For the Viewer
- **Low-Latency Playback**: Watch the host's screen in real-time with virtually zero delay thanks to WebRTC.
- **Bidirectional Audio**: Toggle your own microphone to speak directly to the host.
- **Hardware-level Volume Boost**: The viewer's microphone is automatically boosted using the Web Audio API to ensure they are heard clearly over the game/video system audio.
- **Smart Audio Ducking (Sidechain)**: When the viewer speaks, the host's system audio is automatically reduced (ducked) to prevent echo and make the conversation clear.
- **Auto-Reconnect**: Seamlessly reconnects to the host if the network drops or the page is refreshed.

## 🚀 Tech Stack

- **React 19**
- **TypeScript**
- **Vite**
- **Tailwind CSS v4**
- **Socket.IO-client** for signaling.
- **WebRTC** for direct Peer-to-Peer media streaming.
- **Web Audio API** (`AudioContext`, `GainNode`, `DynamicsCompressorNode`, `MediaStreamAudioSourceNode`) for audio ducking and volume control.
- **Document PiP API** for advanced floating windows.

## 🛠 Installation & Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `src/config.ts`:
Update the `SIGNALING_SERVER_URL` to point to your backend (e.g., `http://localhost:3001` for local development).

3. Start the Vite development server:
```bash
npm run dev
```

## 🚢 Deployment
Can be easily deployed to [Vercel](https://vercel.com/) or Netlify.

---
*Built with ❤️ using WebRTC and React.*
