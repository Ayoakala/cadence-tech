import {z} from 'zod';

/**
 * Environment schema. Every value has a default that makes the service run
 * fully deterministically with no configuration and no network access, so
 * `make determinism` and the unit tests need nothing set up.
 */
const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
  OPENAI_API_KEY: z.string().optional(),
  TRIAGE_MODEL: z.string().default('gpt-5-mini'),
  TRIAGE_LLM_MODE: z.enum(['off', 'assist', 'shadow']).default('off'),
  TRIAGE_LLM_CACHE_DIR: z.string().default('.cache/llm'),
});

/**
 * How the language model participates in a run.
 *
 *  off    — no model calls at all. The default, because the policy reduces to
 *           deterministic checks and the harness scores determinism explicitly.
 *  assist — the model adjudicates only the documents the classifier flags as
 *           ambiguous, and its answer is used.
 *  shadow — the model is consulted on the same documents, disagreements are
 *           logged, but the deterministic answer is what ships. This is how the
 *           model earns its way in: run it in shadow, read the disagreements.
 */
export type LlmMode = z.infer<typeof EnvSchema>['TRIAGE_LLM_MODE'];

export interface LlmConfig {
  mode: LlmMode;
  model: string;
  apiKey: string | undefined;
  cacheDir: string;
}

export interface Config {
  nodeEnv: string;
  logLevel: string;
  llm: LlmConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    llm: {
      mode: parsed.TRIAGE_LLM_MODE,
      model: parsed.TRIAGE_MODEL,
      apiKey: parsed.OPENAI_API_KEY,
      cacheDir: parsed.TRIAGE_LLM_CACHE_DIR,
    },
  };
}
