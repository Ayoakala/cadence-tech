import {loadConfig, type Config} from './config.js';
import {logger, type Logger} from './lib/logger.js';
import {TriageService} from './core/triage/triageService.js';
import {DocumentEnricher} from './core/triage/enrichment.js';
import {NullDocumentJudge, type DocumentJudge} from './llm/documentJudge.js';
import {OpenAiDocumentJudge} from './llm/openaiDocumentJudge.js';
import {
  FileJudgmentCache,
  MemoryJudgmentCache,
  type JudgmentCache,
} from './llm/cache.js';

export interface Dependencies {
  config: Config;
  logger: Logger;
  triage: TriageService;
}

/**
 * Composition root. Constructs and wires everything; nothing else in the
 * codebase reads the environment or instantiates a collaborator, which is what
 * lets every rule and the service itself be unit-tested with plain constructor
 * arguments.
 *
 * With `TRIAGE_LLM_MODE=off` (the default) no OpenAI client is constructed and
 * no API key is required, so a fresh clone runs the full dataset offline.
 */
export function initializeDependencies(
  env: NodeJS.ProcessEnv = process.env
): Dependencies {
  const config = loadConfig(env);

  const triage =
    config.llm.mode === 'off'
      ? new TriageService()
      : new TriageService(
          undefined,
          new DocumentEnricher(
            config.llm.mode,
            buildJudge(config, logger),
            logger
          )
        );

  return {config, logger, triage};
}

function buildJudge(config: Config, log: Logger): DocumentJudge {
  if (config.llm.mode === 'off') return new NullDocumentJudge();

  const cache: JudgmentCache =
    config.llm.cacheDir === ''
      ? new MemoryJudgmentCache()
      : new FileJudgmentCache(config.llm.cacheDir);

  return new OpenAiDocumentJudge(config.llm, cache, log);
}
