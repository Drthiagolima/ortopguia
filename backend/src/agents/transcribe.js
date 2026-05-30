import { WebSocketServer } from "ws";
import { toFile } from "openai/uploads";
import { openai, MODEL_TRANSCRIBE } from "../openaiClient.js";

export function attachTranscriptionWS(server, path = "/ws/transcribe") {
  const wss = new WebSocketServer({ server, path });

  wss.on("connection", (ws) => {
    let seq = 0;
    let mime = "audio/webm";

    ws.send(JSON.stringify({ type: "ready" }));

    ws.on("message", async (data, isBinary) => {
      try {
        if (!isBinary) {
          const msg = JSON.parse(data.toString());
          if (msg.type === "start" && msg.mime) mime = msg.mime;
          if (msg.type === "stop") ws.send(JSON.stringify({ type: "stopped" }));
          return;
        }

        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length < 1200) return;

        const ext = mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
        const file = await toFile(buf, `chunk-${seq}.${ext}`, { type: mime });

        const tr = await openai.audio.transcriptions.create({
          file,
          model: MODEL_TRANSCRIBE,
          language: "pt",
          temperature: 0,
        });

        const text = (tr.text || "").trim();
        if (text) {
          ws.send(JSON.stringify({ type: "partial", text, seq }));
          seq++;
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: err.message || "Falha na transcrição" }));
      }
    });
  });

  return wss;
}
