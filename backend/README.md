# OrtoguIA — Backend de Agentes de IA

Camada de agentes que conecta a plataforma OrtoguIA à OpenAI (GPT + Whisper). A chave da API fica **somente no servidor** — nunca no navegador.

## Agentes incluídos

| Agente | Endpoint | Saída |
|--------|----------|-------|
| Transcrição ao vivo (Whisper) | `ws://…/ws/transcribe` | texto por chunk |
| Conversor de Anamnese | `POST /api/anamnese` | JSON estruturado |
| Prescrição | `POST /api/agents/prescricao` | texto |
| Atestado | `POST /api/agents/atestado` | texto |
| Relatório médico | `POST /api/agents/relatorio` | texto |
| Pedido de exames | `POST /api/agents/exames` | texto |
| Pedido cirúrgico | `POST /api/agents/cirurgia` | texto |

Liste todos em `GET /api/agents`. Saúde do serviço em `GET /api/health`.

## Instalação

```bash
cd ortoguia-backend
npm install
cp .env.example .env      # edite com sua OPENAI_API_KEY
npm start                 # ou: npm run dev (recarrega ao salvar)
```

O servidor sobe em `http://localhost:8787` por padrão.

## Variáveis de ambiente (.env)

- `OPENAI_API_KEY` — sua chave da OpenAI (obrigatória)
- `OPENAI_MODEL_TEXT` — modelo de texto (padrão `gpt-4o`)
- `OPENAI_MODEL_TRANSCRIBE` — modelo de transcrição (padrão `whisper-1`)
- `PORT` — porta (padrão `8787`)
- `ALLOWED_ORIGINS` — domínios do front-end autorizados (CORS)
- `JWT_SECRET` — segredo para assinatura dos tokens JWT de login
- `JWT_EXPIRES_IN` — duração do token JWT (padrão `8h`)
- `AUTH_USERS_JSON` — lista opcional de usuários para login em JSON
- `WHATSAPP_REMINDER_TICK_MS` — intervalo do worker de lembretes (padrão `60000`)
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` — token de verificação do webhook (GET)
- `WHATSAPP_INBOUND_AUTH_TOKEN` — token opcional no header `x-whatsapp-token` para webhook POST
- `WHATSAPP_SEND_URL` — endpoint HTTP do provedor WhatsApp para envio (se ausente, usa log mock)
- `WHATSAPP_SEND_TOKEN` — token Bearer opcional para envio no provedor
- `WHATSAPP_FROM` — identificador/número de origem no provedor (quando necessário)

Exemplo de `AUTH_USERS_JSON`:

```json
[
  {
    "id": "med_thiago_lima",
    "email": "thiagolima@ortopguia.com.br",
    "role": "medico",
    "name": "Thiago Lima",
    "password": "<senha-forte>"
  }
]
```

## Repositório de prontuário (nuvem)

Endpoints:

- `POST /api/auth/login`
- `POST /api/repository/documents`
- `GET /api/repository/patient/:patientId`
- `DELETE /api/repository/patient/:patientId/documents/:docId`

Autenticação:

- Os endpoints exigem JWT no header `Authorization: Bearer <token>`.
- O token é emitido por `POST /api/auth/login`.

Auditoria LGPD:

- Toda criação, leitura de lista e exclusão gera evento de auditoria em `backend/data/patient-repository-audit.log`.

## Automação WhatsApp (humanizada)

Fluxo implementado:

1. Ao receber mensagem, a atendente virtual se apresenta e acolhe o paciente.
2. Pergunta o motivo ortopédico da consulta.
3. Pergunta dia/horário de preferência.
4. Pergunta modalidade (presencial ou teleconsulta).
5. Agenda automaticamente conforme disponibilidade da agenda.
6. Dispara confirmações automáticas:
   - às 18h do dia anterior (quando houver tempo);
   - 60 minutos antes da consulta.

Persistência local:

- Agenda: `backend/data/appointments.json`
- Sessões de conversa: `backend/data/whatsapp-sessions.json`
- Entrada/saída de mensagens: `backend/data/whatsapp-outbox.log`

Endpoints da automação:

- `GET /api/agenda/availability?date=YYYY-MM-DD&mode=teleconsulta|presencial`
- `POST /api/agenda/appointments`
- `GET /api/agenda/appointments`
- `GET /api/whatsapp/webhook` (verificação)
- `POST /api/whatsapp/webhook` (mensagens recebidas)
- `POST /api/whatsapp/inbound-test` (simulação local/QA)

Exemplo de teste rápido (`inbound-test`):

```bash
curl -X POST http://localhost:8787/api/whatsapp/inbound-test \
  -H "Content-Type: application/json" \
  -d '{"from":"5521994626336","name":"Paciente Teste","text":"Oi"}'
```

Observação operacional:

- Se `WHATSAPP_SEND_URL` não estiver configurado, o backend continua processando toda a automação e grava as mensagens no outbox mock (sem envio real ao WhatsApp).

## Como a transcrição "ao vivo" funciona

O Whisper não tem streaming nativo, então usamos *near-real-time*: o navegador grava o microfone em pedaços curtos (a cada ~4s via `MediaRecorder`), envia cada pedaço pelo WebSocket, o servidor transcreve com o Whisper e devolve o texto. O front concatena os trechos. É simples de operar e suficiente para anamnese; para latência menor no futuro, dá para trocar por um serviço de streaming dedicado sem mexer no resto.

## Integrando na plataforma (front-end)

1. Copie `public-client/ortoguia-agents.js` para junto da plataforma (mesmo servidor do `app.html`).
2. No `app.html`, antes do `</body>`:

```html
<script src="ortoguia-agents.js"></script>
<script>
  OrtoguIA.config({ baseUrl: "https://api.ortopguia.com.br" }); // sua URL do backend
</script>
```

### Transcrição (presencial e teleconsulta)

```js
let ctrl;
// ao clicar em "Iniciar":
ctrl = await OrtoguIA.transcricaoAoVivo({
  paciente: { nome: "Carlos Eduardo Silva", cpf: "123.456.789-00" },
  onTexto: (textoCompleto, trecho) => {
    document.getElementById("transcript").innerText = textoCompleto;
  },
  onErro: (msg) => console.error(msg),
});
// ao clicar em "Parar":
ctrl.parar();
```

### Anamnese estruturada (a partir da transcrição)

```js
const anamnese = await OrtoguIA.gerarAnamnese({
  paciente: { nome: "Carlos Eduardo Silva" },
  transcricao: document.getElementById("transcript").innerText,
});
// anamnese.queixa_principal, anamnese.historia_doenca_atual, anamnese.hipoteses_diagnosticas, ...
```

### Documentos (prescrição, atestado, relatório, exames, cirurgia)

```js
const texto = await OrtoguIA.gerarDocumento("prescricao", {
  paciente: { nome: "Carlos Eduardo Silva" },
  anamnese,                 // o objeto gerado acima
  instrucoes: "Dor no joelho, sem alergias conhecidas",
});
document.querySelector("#docarea textarea").value = texto;
```

Os mesmos parâmetros valem para `atestado`, `relatorio`, `exames` e `cirurgia` — basta trocar o primeiro argumento.

## Segurança e conformidade (LGPD)

- A chave da OpenAI nunca chega ao navegador.
- Toda saída de agente é **rascunho assistivo** — a decisão e a assinatura são do médico.
- Para produção com pacientes reais:
  - rode atrás de **HTTPS/WSS** (certificado válido);
  - adicione **autenticação** (token/sessão) aos endpoints — hoje estão abertos para facilitar o teste;
  - avalie um **BAA/acordo de tratamento de dados** com a OpenAI e a base legal da LGPD para dados de saúde (dados sensíveis);
  - registre logs sem expor dados sensíveis; defina retenção mínima.

  ## Publicação em produção (WebSocket)

  Para transcrição ao vivo, use uma plataforma com suporte a conexão persistente (WebSocket), como Render/Fly/Railway. Exemplo com Render:

  1. Crie o serviço Web usando o blueprint em `backend/render.yaml`.
  2. Defina o segredo `OPENAI_API_KEY` no painel do serviço.
  3. Aguarde o deploy e copie a URL pública do backend (ex.: `https://ortopguia-backend.onrender.com`).
  4. No DNS (GoDaddy), crie o registro:
    - Tipo: `CNAME`
    - Nome: `api`
    - Valor: host do backend (ex.: `ortopguia-backend.onrender.com`)
  5. Teste os endpoints:
    - `https://api.ortopguia.com.br/api/health`
    - `wss://api.ortopguia.com.br/ws/transcribe`

  O front-end já está preparado para tentar automaticamente `https://api.ortopguia.com.br` e, se indisponível, fazer fallback para o mesmo host do site.

## Próximos agentes (fáceis de adicionar)

Cada agente é um objeto em `src/agents/agents.js` com `system` + `build()`. Para criar um novo (ex.: "orientações ao paciente", "resumo para o convênio", "triagem de risco"), basta adicionar uma entrada nesse objeto — ele aparece automaticamente em `/api/agents` e ganha endpoint `POST /api/agents/<id>`.
