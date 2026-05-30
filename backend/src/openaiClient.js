import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  console.warn("[OrtoguIA] AVISO: OPENAI_API_KEY não definida no .env");
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-4o";
export const MODEL_TRANSCRIBE = process.env.OPENAI_MODEL_TRANSCRIBE || "whisper-1";
