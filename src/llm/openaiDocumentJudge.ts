import OpenAI from 'openai';
import {z} from 'zod';
import type {LlmConfig} from '../config.js';
import type {Logger} from '../lib/logger.js';
import {
  buildJudgments,
  type DocumentJudge,
  type DocumentJudgments,
  type JudgmentQuestion,
  type JudgmentRequest,
} from './documentJudge.js';
import {cacheKey, type JudgmentCache} from './cache.js';

/**
 * Model-backed adjudication for the three questions in the policy that are
 * genuinely about prose rather than about dates or thresholds:
 *
 *   1. is this document a History and Physical?
 *   2. does this consent's text say it was signed?
 *   3. does this plan actually describe perioperative management?
 *
 * Each is asked as its own call about a single document. That is more calls than
 * one big prompt, but it is the right shape: each answer is independently
 * cacheable, independently verifiable against a unit test, and a wrong answer
 * cannot contaminate an unrelated question. It also means the reasoning cannot
 * quietly re-derive the whole policy — the model never sees dates, thresholds,
 * or the decision enum, so it cannot influence anything but its one judgment.
 */

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: {
      type: 'boolean',
      description: 'true if the answer to the question is yes',
    },
    quote: {
      type: 'string',
      description:
        'The exact substring of the document text that justifies the verdict, or an empty string if none does.',
    },
  },
  required: ['verdict', 'quote'],
} as const;

const VerdictSchema = z.object({verdict: z.boolean(), quote: z.string()});

const INSTRUCTIONS: Record<JudgmentQuestion, string> = {
  is_history_and_physical: [
    'You classify clinical document metadata for a pre-operative scheduling system.',
    'Answer only this question: is this document a History and Physical (H&P) note?',
    'A History and Physical is the pre-operative history-and-examination note itself.',
    'It is NOT: an anesthesia pre-assessment, a nursing intake, a clinic follow-up note,',
    'a surgical clearance note, a medical clearance, a generic pre-op evaluation, or a consent.',
    'Judge from the document type and text as written. Do not infer intent from misspellings.',
  ].join(' '),
  consent_signed: [
    'You read clinical document text for a pre-operative scheduling system.',
    'Answer only this question: does this text state that the surgical consent has been signed?',
    'Treat "signature on file" as signed. Treat "unsigned", "awaiting signature",',
    'and "signature not yet on file" as NOT signed.',
    'If the text does not address signing at all, answer false.',
  ].join(' '),
  plan_describes_management: [
    'You read clinical document text for a pre-operative scheduling system.',
    'Answer only this question: does this text describe how the patient’s anticoagulant',
    'will be managed before and after the procedure?',
    'A qualifying plan states concrete action or timing — holding, stopping, resuming,',
    'restarting, or bridging the medication, with timing relative to the procedure.',
    'Text that defers the decision (referring to a specialist, "plan pending",',
    '"to be finalized", "details not yet documented") does NOT qualify, however',
    'clinically reasonable the deferral may be.',
  ].join(' '),
};

/** Bounded concurrency, so a 50-case batch cannot open 200 sockets at once. */
const MAX_CONCURRENCY = 6;

export class OpenAiDocumentJudge implements DocumentJudge {
  private readonly client: OpenAI;

  constructor(
    private readonly config: LlmConfig,
    private readonly cache: JudgmentCache,
    private readonly logger: Logger
  ) {
    if (config.apiKey === undefined || config.apiKey === '') {
      throw new Error(
        'OPENAI_API_KEY is required when TRIAGE_LLM_MODE is not "off"'
      );
    }
    this.client = new OpenAI({apiKey: config.apiKey});
  }

  async judge(
    requests: readonly JudgmentRequest[]
  ): Promise<DocumentJudgments> {
    const answers: {request: JudgmentRequest; verdict: boolean}[] = [];
    const queue = [...requests];

    const workers = Array.from(
      {length: Math.min(MAX_CONCURRENCY, queue.length)},
      async () => {
        for (;;) {
          const request = queue.shift();
          if (request === undefined) return;
          const verdict = await this.judgeOne(request);
          if (verdict !== undefined) answers.push({request, verdict});
        }
      }
    );
    await Promise.all(workers);

    return buildJudgments(answers);
  }

  private async judgeOne(
    request: JudgmentRequest
  ): Promise<boolean | undefined> {
    const prompt = buildPrompt(request);
    const key = cacheKey([
      this.config.model,
      request.question,
      INSTRUCTIONS[request.question],
      prompt,
    ]);

    const cached = await this.cache.get(key);
    if (cached !== undefined) return cached;

    try {
      const response = await this.client.responses.create({
        model: this.config.model,
        instructions: INSTRUCTIONS[request.question],
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{type: 'input_text', text: prompt}],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'document_verdict',
            schema: VERDICT_SCHEMA,
            strict: true,
          },
        },
      });

      const {verdict, quote} = VerdictSchema.parse(
        JSON.parse(response.output_text)
      );

      // A verdict justified by a quote that is not actually in the document is a
      // fabrication; discard it and fall back to the deterministic answer rather
      // than let it override.
      const text = request.document.text ?? '';
      if (quote !== '' && !text.includes(quote)) {
        this.logger.warn(
          {question: request.question, index: request.index, quote},
          'discarding judgment whose supporting quote is not in the document'
        );
        return undefined;
      }

      await this.cache.set(key, verdict);
      return verdict;
    } catch (err) {
      // The deterministic path is always available, so a model failure degrades
      // the answer's nuance rather than the run.
      this.logger.error(
        {err, question: request.question, index: request.index},
        'document judgment failed; falling back to the deterministic classifier'
      );
      return undefined;
    }
  }
}

function buildPrompt(request: JudgmentRequest): string {
  const lines = [
    `Document type: ${JSON.stringify(request.document.type ?? '')}`,
    `Document text: ${JSON.stringify(request.document.text ?? '')}`,
  ];
  if (request.question === 'plan_describes_management') {
    lines.push(
      `Active anticoagulant medications: ${request.drugNames.join(', ') || 'none'}`
    );
  }
  lines.push('Answer as JSON with fields "verdict" and "quote".');
  return lines.join('\n');
}
