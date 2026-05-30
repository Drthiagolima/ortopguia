/**
 * ortoguia-agents.js
 * Camada de conexão entre a plataforma (front-end) e o backend de agentes.
 *
 * Como usar no HTML da plataforma:
 *   <script src="ortoguia-agents.js"></script>
 *   <script>OrtoguIA.config({ baseUrl: "https://api.ortopguia.com.br" });</script>
 *
 * Funções principais:
 *   - OrtoguIA.transcricaoAoVivo({ onTexto, onErro })  -> controla microfone + WebSocket
 *   - OrtoguIA.gerarAnamnese({ paciente, transcricao })
 *   - OrtoguIA.gerarDocumento(tipo, { paciente, anamnese, transcricao, instrucoes })
 *        tipo: 'prescricao' | 'atestado' | 'relatorio' | 'exames' | 'cirurgia' | 'terapias'
 */
(function (global) {
  const isLocalHost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  const cfg = {
    // Em desenvolvimento local usa localhost; em produção usa o mesmo host do front.
    baseUrl: isLocalHost ? "http://localhost:8787" : window.location.origin,
    authToken: "",
  };

  function config(opts) {
    Object.assign(cfg, opts || {});
  }

  function repositoryHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (cfg.authToken) {
      headers.Authorization = "Bearer " + cfg.authToken;
    }
    return headers;
  }

  async function login({ email, password, lgpdAccepted } = {}) {
    const r = await fetch(`${cfg.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, lgpdAccepted }),
    });
    if (!r.ok) throw new Error("Falha no login (" + r.status + ")");
    const j = await r.json();
    const data = j.data || {};
    if (data.accessToken) {
      cfg.authToken = data.accessToken;
    }
    return data;
  }

  function wsUrl() {
    const u = new URL(cfg.baseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws/transcribe";
    return u.toString();
  }

  async function ping(timeoutMs = 2500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const health = new URL(cfg.baseUrl);
      health.pathname = "/api/health";
      const r = await fetch(health.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timer);
      return r.ok;
    } catch {
      clearTimeout(timer);
      return false;
    }
  }

  // ---- Agentes de texto (REST) ----
  async function gerarAnamnese({ paciente, transcricao } = {}) {
    const r = await fetch(`${cfg.baseUrl}/api/anamnese`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paciente, transcricao }),
    });
    if (!r.ok) throw new Error("Falha ao gerar anamnese (" + r.status + ")");
    const j = await r.json();
    return j.data; // objeto estruturado
  }

  async function gerarDocumento(tipo, payload = {}) {
    const r = await fetch(`${cfg.baseUrl}/api/agents/${tipo}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("Falha no agente '" + tipo + "' (" + r.status + ")");
    const j = await r.json();
    return j.text || (j.data ? JSON.stringify(j.data, null, 2) : "");
  }

  async function gerarLinkTeleconsultaWhatsApp({ paciente, telefone, agendaAt } = {}) {
    const r = await fetch(`${cfg.baseUrl}/api/teleconsulta/whatsapp-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paciente, telefone, agendaAt }),
    });
    if (!r.ok) throw new Error("Falha ao gerar link de teleconsulta WhatsApp (" + r.status + ")");
    const j = await r.json();
    return j.data;
  }

  // ---- Repositorio em nuvem de prontuarios ----
  async function salvarDocumentoProntuario(payload = {}) {
    const r = await fetch(`${cfg.baseUrl}/api/repository/documents`, {
      method: "POST",
      headers: repositoryHeaders(),
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("Falha ao salvar prontuario em nuvem (" + r.status + ")");
    const j = await r.json();
    return j.data;
  }

  async function listarDocumentosProntuario(patientId) {
    const id = encodeURIComponent(String(patientId || ""));
    const r = await fetch(`${cfg.baseUrl}/api/repository/patient/${id}`, {
      method: "GET",
      headers: repositoryHeaders(),
    });
    if (!r.ok) throw new Error("Falha ao listar prontuario em nuvem (" + r.status + ")");
    const j = await r.json();
    return (j.data && j.data.documents) || [];
  }

  async function excluirDocumentoProntuario(patientId, docId) {
    const pid = encodeURIComponent(String(patientId || ""));
    const did = encodeURIComponent(String(docId || ""));
    const r = await fetch(`${cfg.baseUrl}/api/repository/patient/${pid}/documents/${did}`, {
      method: "DELETE",
      headers: repositoryHeaders(),
    });
    if (!r.ok) throw new Error("Falha ao excluir prontuario em nuvem (" + r.status + ")");
    const j = await r.json();
    return j.data || {};
  }

  // ---- Transcrição ao vivo (WebSocket + MediaRecorder) ----
  // Retorna um controlador { parar() }. Dispara onTexto(textoAcumulado, trecho).
  async function transcricaoAoVivo({ onTexto, onErro, intervaloMs = 4000, paciente, captureSystemAudio = false } = {}) {
    let micStream, systemStream, mixedStream, recorder, ws;
    let audioCtx, micSource, sysSource, destination;
    let stopping = false;
    let wsOpened = false;
    let wsOpenTimer = null;
    let tick = null;
    let restartAfterChunk = false;
    let acumulado = "";

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      if (onErro) {
        onErro(
          "Microfone indisponível. Abra o front em https:// ou http://localhost (não use file://)."
        );
      }
      return { parar() {} };
    }

    if (window.top !== window.self) {
      if (onErro) {
        onErro(
          "Este app está em um iframe. Se o microfone não abrir, habilite a permissão de microfone para o site principal ou abra a página em uma aba direta."
        );
      }
    }

    try {
      if (navigator.permissions?.query) {
        try {
          const p = await navigator.permissions.query({ name: "microphone" });
          if (p.state === "denied") {
            if (onErro) {
              onErro(
                "Permissão de microfone bloqueada para " +
                  window.location.origin +
                  ". Clique no cadeado da URL, permita Microfone e recarregue a página."
              );
            }
            return { parar() {} };
          }
        } catch {}
      }

      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      let msg;
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
        msg =
          "Permissão de microfone negada para " +
          window.location.origin +
          ". Clique no cadeado da URL, permita Microfone e recarregue a página.";
      } else if (e && e.name === "NotFoundError") {
        msg =
          "Nenhum microfone foi encontrado neste dispositivo. Conecte um microfone e tente novamente.";
      } else if (e && e.name === "NotReadableError") {
        msg =
          "O microfone está em uso por outro aplicativo. Feche o app que está usando o áudio e tente novamente.";
      } else {
        msg = "Não foi possível acessar o microfone: " + (e?.message || "erro desconhecido");
      }
      if (onErro) onErro(msg);
      return { parar() {} };
    }

    if (captureSystemAudio) {
      try {
        // O navegador solicitará escolha de janela/tela/aba com opção de áudio.
        systemStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          preferCurrentTab: true,
          selfBrowserSurface: "include",
          surfaceSwitching: "include",
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            sampleRate: 48000,
          },
        });
      } catch (e) {
        // Se o usuário cancelar/fechar o compartilhamento, segue com microfone.
        systemStream = null;
      }

      if (systemStream) {
        const sysAudioTracks = systemStream.getAudioTracks();
        if (!sysAudioTracks || sysAudioTracks.length === 0) {
          try { if (systemStream) systemStream.getTracks().forEach((t) => t.stop()); } catch {}
          systemStream = null;
        }

        if (systemStream) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          destination = audioCtx.createMediaStreamDestination();
          micSource = audioCtx.createMediaStreamSource(micStream);
          sysSource = audioCtx.createMediaStreamSource(new MediaStream(sysAudioTracks));
          micSource.connect(destination);
          sysSource.connect(destination);
          mixedStream = destination.stream;
        }
      }
    }

    const stream = mixedStream || micStream;

    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "audio/ogg";

    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    wsOpenTimer = setTimeout(() => {
      if (!wsOpened && !stopping) {
        try { ws.close(); } catch {}
        if (onErro) onErro("Não foi possível conectar ao servidor de transcrição.");
      }
    }, 8000);

    ws.onopen = () => {
      wsOpened = true;
      if (wsOpenTimer) clearTimeout(wsOpenTimer);
      ws.send(JSON.stringify({ type: "start", mime, paciente }));
      recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = async (ev) => {
        if (ev.data && ev.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          const buf = await ev.data.arrayBuffer();
          ws.send(buf);
        }
      };
      recorder.onstop = () => {
        if (!stopping && restartAfterChunk) {
          restartAfterChunk = false;
          try { recorder.start(); } catch {}
        }
      };
      recorder.start();
      // Gera arquivos completos por chunk (evita blocos sem cabeçalho que o Whisper rejeita).
      tick = setInterval(() => {
        if (recorder && recorder.state === "recording") {
          restartAfterChunk = true;
          try { recorder.stop(); } catch { restartAfterChunk = false; }
        }
      }, intervaloMs);
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "partial" && msg.text) {
        acumulado += (acumulado ? " " : "") + msg.text;
        if (onTexto) onTexto(acumulado, msg.text);
      } else if (msg.type === "error") {
        if (onErro) onErro(msg.message);
      }
    };

    ws.onerror = () => {
      if (wsOpenTimer) clearTimeout(wsOpenTimer);
      if (onErro) onErro("Erro de conexão com o servidor de transcrição.");
    };

    ws.onclose = () => {
      if (wsOpenTimer) clearTimeout(wsOpenTimer);
      if (!stopping && onErro) onErro("Conexão de transcrição encerrada pelo servidor.");
    };

    return {
      parar() {
        stopping = true;
        if (wsOpenTimer) clearTimeout(wsOpenTimer);
        if (tick) clearInterval(tick);
        restartAfterChunk = false;
        try {
          if (recorder && recorder.state === "recording") {
            recorder.stop();
          }
        } catch {}
        try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch {}
        try { if (systemStream) systemStream.getTracks().forEach((t) => t.stop()); } catch {}
        try { if (audioCtx) audioCtx.close(); } catch {}
        try { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "stop" })); ws.close(); } } catch {}
      },
    };
  }

  global.OrtoguIA = {
    config,
    ping,
    gerarAnamnese,
    login,
    gerarDocumento,
    gerarLinkTeleconsultaWhatsApp,
    salvarDocumentoProntuario,
    listarDocumentosProntuario,
    excluirDocumentoProntuario,
    transcricaoAoVivo,
  };
})(window);
