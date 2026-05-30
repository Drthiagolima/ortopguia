import { openai, MODEL_TEXT } from "../openaiClient.js";

const DISCLAIMER =
  "Você é um assistente de documentação clínica. Produza rascunhos para revisão médica, sem inventar dados. " +
  "Se faltar dado essencial, use [VERIFICAR]. Escreva em português técnico e objetivo.";

export const AGENTS = {
  anamnese: {
    label: "Conversor de Anamnese",
    json: true,
    system:
      `${DISCLAIMER}\n` +
      "Converta a transcrição em JSON com os campos: identificacao, queixa_principal, historia_doenca_atual, antecedentes, exame_fisico, hipoteses_diagnosticas (array), conduta_sugerida. Responda somente JSON.",
    build: ({ paciente, transcricao }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\n\nTranscrição:\n${transcricao || ""}`,
  },
  prescricao: {
    label: "Agente de Prescrição",
    json: false,
    system: `${DISCLAIMER}\nRedija prescrição com medicamento, via, posologia e duração.`,
    build: ({ paciente, anamnese, instrucoes }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\nAnamnese: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\nInstruções: ${instrucoes || ""}`,
  },
  atestado: {
    label: "Agente de Atestado",
    json: false,
    system: `${DISCLAIMER}\nRedija atestado formal com campos ausentes marcados como [VERIFICAR].`,
    build: ({ paciente, anamnese, instrucoes }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\nContexto: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\nInstruções: ${instrucoes || ""}`,
  },
  relatorio: {
    label: "Agente de Relatório",
    json: false,
    system: `${DISCLAIMER}\nRedija relatório médico com história, exame, evolução e conclusão.`,
    build: ({ paciente, anamnese, transcricao }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\nAnamnese: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\nTranscrição: ${transcricao || ""}`,
  },
  exames: {
    label: "Agente de Pedido de Exames",
    json: false,
    system: `${DISCLAIMER}\nGere pedido de exames pertinente ao quadro com justificativa curta.`,
    build: ({ paciente, anamnese, instrucoes }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\nAnamnese: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\nInstruções: ${instrucoes || ""}`,
  },
  cirurgia: {
    label: "Agente de Pedido Cirúrgico",
    json: false,
    system: `${DISCLAIMER}\nGere solicitação cirúrgica ortopédica com justificativa e status de revisão médica.`,
    build: ({ paciente, anamnese, instrucoes }) =>
      `Paciente: ${JSON.stringify(paciente || {})}\nAnamnese: ${typeof anamnese === "object" ? JSON.stringify(anamnese) : anamnese || ""}\nInstruções: ${instrucoes || ""}`,
  },
};

export async function runAgent(agentId, input) {
  const agent = AGENTS[agentId];
  if (!agent) {
    const err = new Error(`Agente desconhecido: ${agentId}`);
    err.status = 400;
    throw err;
  }

  const completion = await openai.chat.completions.create({
    model: MODEL_TEXT,
    temperature: 0.2,
    messages: [
      { role: "system", content: agent.system },
      { role: "user", content: agent.build(input || {}) },
    ],
    ...(agent.json ? { response_format: { type: "json_object" } } : {}),
  });

  const content = completion.choices?.[0]?.message?.content ?? "";
  if (agent.json) {
    try {
      return { ok: true, agent: agentId, data: JSON.parse(content) };
    } catch {
      return { ok: true, agent: agentId, data: { _raw: content, _erro: "JSON inválido" } };
    }
  }

  return { ok: true, agent: agentId, text: content.trim() };
}

export function listAgents() {
  return Object.entries(AGENTS).map(([id, a]) => ({ id, label: a.label, json: !!a.json }));
}
