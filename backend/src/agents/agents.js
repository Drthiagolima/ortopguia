import { openai, MODEL_TEXT } from "../openaiClient.js";

const DOCUMENT_ASSISTANT_IDS = {
  cirurgia:
    process.env.OPENAI_ASSISTANT_CIRURGIA ||
    "asst_SHFpXkdKVSzHuBFX6Bvbmo0W",
  atestado:
    process.env.OPENAI_ASSISTANT_ATESTADO ||
    "asst_t1P4wDANmTdHSIKVoI1wMwFT",
  relatorio:
    process.env.OPENAI_ASSISTANT_RELATORIO ||
    "asst_t1P4wDANmTdHSIKVoI1wMwFT",
  prescricao:
    process.env.OPENAI_ASSISTANT_PRESCRICAO ||
    "asst_PqjiIpjltvxak0hFFOOcAHpc",
  exames:
    process.env.OPENAI_ASSISTANT_EXAMES ||
    "asst_SDEYzK3jCR3IuLGJFXBNSwfS",
  terapias:
    process.env.OPENAI_ASSISTANT_TERAPIAS ||
    "asst_xvOnd3SZux3ppRAqAVvd459a",
};

/**
 * Cada agente tem:
 *  - system: instrução de papel/comportamento
 *  - build(input): monta a mensagem do usuário a partir dos dados da consulta
 *  - json: se true, pede resposta em JSON estruturado
 *
 * Todos recebem um "contexto" comum (paciente + transcrição/anamnese) e
 * retornam texto pronto para revisão do médico.
 *
 * IMPORTANTE: a saída de qualquer agente é um RASCUNHO assistivo. A decisão
 * clínica e a assinatura são sempre do médico responsável.
 */

const DISCLAIMER =
  "Você é um assistente de documentação clínica. Produza rascunhos para revisão " +
  "e assinatura do médico responsável. Nunca invente dados não fornecidos. " +
  "Se faltar informação essencial, sinalize com [VERIFICAR]. Escreva em português do Brasil, " +
  "em tom técnico, claro e objetivo. Não inclua avisos de IA no corpo do documento.";

export const AGENTS = {
  // 1) Transcrição -> Anamnese estruturada (JSON)
  anamnese: {
    label: "Conversor de Anamnese",
    json: true,
    system:
      `${DISCLAIMER}\n` +
      "Tarefa: converter a transcrição de uma consulta em uma ANAMNESE ESTRUTURADA. " +
      "Responda APENAS com um objeto JSON válido, sem texto antes ou depois, no formato:\n" +
      `{
  "identificacao": "",
  "queixa_principal": "",
  "historia_doenca_atual": "",
  "antecedentes": "",
  "exame_fisico": "",
  "hipoteses_diagnosticas": ["", ""],
  "conduta_sugerida": ""
}\n` +
      "Use somente o que aparece na transcrição. Campos sem informação ficam como string vazia " +
      "ou com [VERIFICAR]. Não faça diagnóstico definitivo; ofereça hipóteses.",
    build: ({ paciente, transcricao }) =>
      `Dados do paciente: ${JSON.stringify(paciente || {})}\n\n` +
      `Transcrição da consulta:\n"""${transcricao || ""}"""`,
  },

  // 2) Prescrição
  prescricao: {
    label: "Agente de Prescrição",
    json: false,
    system:
      `${DISCLAIMER}\n` +
      "Tarefa: redigir uma PRESCRIÇÃO MÉDICA a partir do quadro clínico fornecido. " +
      "Formato: uma linha por item, com fármaco, concentração, via, posologia e duração. " +
      "Inclua orientações não-farmacológicas quando pertinente. " +
      "Para qualquer dose ou medicamento que dependa de avaliação adicional, marque [VERIFICAR]. " +
      "Não prescreva controlados sem indicação explícita no contexto.",
    build: ({ paciente, anamnese, transcricao, instrucoes }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\n` +
      `Anamnese/resumo: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\n` +
      `Transcrição (se houver): ${transcricao || "-"}\n` +
      `Instruções do médico: ${instrucoes || "Prescrever conforme o quadro."}`,
  },

  // 3) Atestado médico
  atestado: {
    label: "Agente de Atestado",
    json: false,
    system:
      `${DISCLAIMER}\n` +
      "Tarefa: redigir um ATESTADO MÉDICO formal. " +
      "Inclua: identificação do paciente, finalidade (afastamento/comparecimento), período em dias, " +
      "e CID apenas se o médico autorizar/fornecer. Não inclua diagnóstico no atestado sem autorização. " +
      "Deixe espaços [VERIFICAR] para dados ausentes (ex.: número de dias).",
    build: ({ paciente, instrucoes, anamnese }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\n` +
      `Contexto clínico: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\n` +
      `Instruções do médico: ${instrucoes || "Atestado de afastamento; dias a definir."}`,
  },

  // 4) Relatório médico
  relatorio: {
    label: "Agente de Relatório",
    json: false,
    system:
      `${DISCLAIMER}\n` +
      "Tarefa: redigir um RELATÓRIO MÉDICO descritivo. " +
      "Estruture em: história, achados do exame, evolução, conclusão e recomendações. " +
      "Linguagem técnica adequada a outro profissional/operadora. Não invente exames não citados.",
    build: ({ paciente, anamnese, transcricao, instrucoes }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\n` +
      `Anamnese: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\n` +
      `Transcrição: ${transcricao || "-"}\n` +
      `Finalidade do relatório: ${instrucoes || "Relatório clínico geral."}`,
  },

  // 5) Pedido de exames
  exames: {
    label: "Agente de Pedido de Exames",
    json: false,
    system:
      `${DISCLAIMER}\n` +
      "Tarefa: gerar um PEDIDO DE EXAMES. Liste em tópicos (um por linha) os exames pertinentes " +
      "à hipótese diagnóstica, com lateralidade/incidência quando aplicável (ex.: Raio-X joelho D, AP e perfil). " +
      "Inclua justificativa clínica curta ao final. Não solicite exames sem relação com o quadro.",
    build: ({ paciente, anamnese, instrucoes }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\n` +
      `Hipóteses/anamnese: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\n` +
      `Instruções: ${instrucoes || "Solicitar exames para elucidar o quadro."}`,
  },

  // 6) Pedido cirúrgico ortopédico
  cirurgia: {
    label: "Agente de Pedido Cirúrgico",
    json: false,
    system:
      `${DISCLAIMER}\n` +
      "Tarefa: redigir uma SOLICITAÇÃO DE CIRURGIA ORTOPÉDICA para análise de operadora. " +
      "Inclua: procedimento proposto, lado/segmento, CID-10 (se fornecido; senão [VERIFICAR]), " +
      "justificativa clínica baseada na anamnese, materiais/OPME se citados, e caráter (eletivo/urgência). " +
      "Acrescente ao final a linha: 'Status: aguardando confirmação do médico responsável.' " +
      "Não defina técnica cirúrgica detalhada; mantenha no nível de solicitação administrativa.",
    build: ({ paciente, anamnese, instrucoes }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\n` +
      `Quadro/anamnese: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\n` +
      `Instruções do médico: ${instrucoes || "Solicitar procedimento ortopédico conforme indicação."}`,
  },

  // 7) Plano terapêutico
  terapias: {
    label: "Agente de Terapias",
    json: false,
    system:
      `${DISCLAIMER}\n` +
      "Tarefa: gerar um PLANO TERAPÊUTICO objetivo para acompanhamento clínico. " +
      "Estruture em: objetivos terapêuticos, terapias/intervenções propostas, frequência/duração e orientações de seguimento. " +
      "Inclua critérios de reavaliação e sinais de alerta para retorno. " +
      "Quando faltar dado essencial, use [VERIFICAR].",
    build: ({ paciente, anamnese, transcricao, instrucoes }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\n` +
      `Anamnese/resumo: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\n` +
      `Transcrição: ${transcricao || "-"}\n` +
      `Instruções do médico: ${instrucoes || "Montar plano terapêutico inicial e seguimento."}`,
  },
};

function resolveAssistantId(agentId) {
  return DOCUMENT_ASSISTANT_IDS[agentId] || process.env.OPENAI_DOCUMENT_ASSISTANT_ID || "";
}

async function formatWithAssistant({ draft, agentId, input }) {
  const assistantId = resolveAssistantId(agentId);
  if (!assistantId) return draft;

  const prompt =
    "Transforme o rascunho abaixo em documento final pronto para revisão médica, " +
    "preservando integralmente fatos clínicos, sem inventar dados. " +
    "Mantenha português do Brasil técnico e objetivo.\n\n" +
    `Tipo de documento: ${agentId}\n` +
    `Paciente: ${JSON.stringify(input?.paciente || {})}\n\n` +
    `Rascunho:\n${draft}`;

  const thread = await openai.beta.threads.create({
    messages: [{ role: "user", content: prompt }],
  });

  const run = await Promise.race([
    openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistantId,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout ao aguardar resposta do Assistant")), 45000)
    ),
  ]);

  if (run.status !== "completed") {
    const err = new Error(`Assistant não concluiu a execução (status: ${run.status})`);
    err.status = 502;
    throw err;
  }

  const msgs = await openai.beta.threads.messages.list(thread.id, {
    order: "desc",
    limit: 10,
  });

  const assistantMsg = msgs.data.find((m) => m.role === "assistant");
  if (!assistantMsg?.content?.length) return draft;

  const textPart = assistantMsg.content.find((c) => c.type === "text");
  return (textPart?.text?.value || draft).trim();
}

/**
 * Executa um agente. Retorna { ok, text | data, agent }.
 */
export async function runAgent(agentId, input) {
  const agent = AGENTS[agentId];
  if (!agent) {
    const e = new Error(`Agente desconhecido: ${agentId}`);
    e.status = 400;
    throw e;
  }

  const messages = [
    { role: "system", content: agent.system },
    { role: "user", content: agent.build(input || {}) },
  ];

  const completion = await openai.chat.completions.create({
    model: MODEL_TEXT,
    temperature: 0.2,
    messages,
    ...(agent.json ? { response_format: { type: "json_object" } } : {}),
  });

  const content = completion.choices?.[0]?.message?.content ?? "";

  if (agent.json) {
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      data = { _raw: content, _erro: "JSON inválido retornado pelo modelo" };
    }
    return { ok: true, agent: agentId, data };
  }

  const draft = content.trim();
  let formatted = draft;
  let assistantApplied = false;
  let assistantError = null;

  try {
    formatted = await formatWithAssistant({ draft, agentId, input });
    assistantApplied = true;
  } catch (err) {
    assistantError = err.message || "Falha ao aplicar assistant finalizador";
  }

  return {
    ok: true,
    agent: agentId,
    text: formatted,
    pipeline: {
      draftBy: MODEL_TEXT,
      finalByAssistant: resolveAssistantId(agentId) || null,
      assistantApplied,
      ...(assistantError ? { assistantError } : {}),
    },
  };
}

export function listAgents() {
  return Object.entries(AGENTS).map(([id, a]) => ({ id, label: a.label, json: !!a.json }));
}
