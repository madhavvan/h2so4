// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  questionClassifier — pin every category's pattern coverage
//
//  This drives both auto reasoning_effort selection and (future) model
//  routing — a misclassification cascades. Every category gets a
//  representative happy-path test PLUS a key disambiguation test
//  (e.g., a behavioral question that mentions Spark must classify
//  behavioral, not coding/data).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyQuestion, CATEGORIES } = require('../src/services/questionClassifier.js');

describe('CATEGORIES — canonical set', () => {
  it('exports the 10 documented categories', () => {
    expect(Object.values(CATEGORIES).sort()).toEqual([
      'behavioral', 'clarifier', 'coding', 'concept', 'ml_data', 'other',
      'practice', 'quantitative', 'strategy_case', 'system_design',
    ]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE QUESTIONS A NON-SOFTWARE SPECIALIST ACTUALLY GETS ASKED.
//
//  Every pattern list in the classifier was software, ML, PM or consulting,
//  and CLARIFIER — "under 80 chars and contains a wh-word" — sat underneath
//  them catching the remainder. So a CQV lead with twelve years of
//  validation experience had his entire domain routed to the one bucket
//  whose prompt shape is "1-2 sentences max", and the app answered the
//  question his career is about in two lines.
//
//  These are real questions from a real session (Kneat Gx / lab-instrument
//  qualification). They are fixtures, not illustrations: five of the eight
//  landed in clarifier/other before this.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('classifyQuestion — practice / process ownership', () => {
  const practice = [
    'How have you managed qualification documentation in kneat?',
    'How do you decide IQ versus OQ scope?',
    'Can you walk me through a turnover package?',
    'What is your approach to risk-based qualification?',
    'How do you handle vendor FAT evidence?',
    'How would you manage reviewer capacity during a startup?',
    "What's your process for deviation disposition?",
    'How did you govern electronic approvals across the lab assets?',
  ];
  for (const q of practice) {
    it(`practice: ${q}`, () => {
      const { category } = classifyQuestion(q);
      expect(
        category,
        `"${q}" must not fall to clarifier/other — that is the 1-2-sentence bucket`,
      ).toBe(CATEGORIES.PRACTICE);
    });
  }
});

describe('isClarifier — short is not the same as contentless', () => {
  // A real clarifier leans on the previous turn and carries no subject.
  // Every one of these leans on the previous turn and names nothing of its
  // own. ("the second one?" / "so you'd use Postgres?" are follow-ups too,
  // but carry no wh-word and have always resolved to OTHER — same 'none'
  // effort, so they are left alone rather than fixture-fitted to here.)
  const real = [
    'what do you mean?',
    'why?',
    'like what?',
    'can you repeat that?',
    'how would you handle nulls?',   // a coding follow-up, not process ownership
  ];
  for (const q of real) {
    it(`still a clarifier: ${q}`, () => {
      expect(classifyQuestion(q).category).toBe(CATEGORIES.CLARIFIER);
    });
  }

  it('never routes a question naming a system or document to clarifier', () => {
    // The exact regression, stated as the property rather than the instance:
    // a question with a subject of its own is never a follow-up.
    const withSubject = [
      'How have you managed qualification documentation in kneat?',
      'Which deviations require a technical impact assessment?',
      'How do you decide IQ versus OQ scope?',
    ];
    for (const q of withSubject) {
      expect(classifyQuestion(q).category, q).not.toBe(CATEGORIES.CLARIFIER);
    }
  });
});

describe('classifyQuestion — coding', () => {
  const cases = [
    'implement a function that reverses a singly linked list iteratively',
    'write a function to find the longest substring without repeating characters',
    'given an array of integers, find the missing number',
    'reverse a string in place',
    'what is the time complexity of quicksort?',
    'find the first non-repeating character in a string',
    'write a SQL query to find the top 5 customers by revenue',
    'solve this leetcode problem: two sum',
  ];
  for (const q of cases) {
    it(`"${q.slice(0, 50)}..." → coding`, () => {
      expect(classifyQuestion(q).category).toBe(CATEGORIES.CODING);
    });
  }
});

describe('classifyQuestion — system_design', () => {
  const cases = [
    'design a rate limiter that supports per-user quotas across multiple regions',
    'design a url shortener for 100M URLs',
    'how would you build a chat application like WhatsApp?',
    'design a notification system for our app',
    'walk me through how you would architect a payment service',
    'what is your approach to high-throughput distributed systems?',
  ];
  for (const q of cases) {
    it(`"${q.slice(0, 50)}..." → system_design`, () => {
      expect(classifyQuestion(q).category).toBe(CATEGORIES.SYSTEM_DESIGN);
    });
  }
});

describe('classifyQuestion — ml_data', () => {
  const cases = [
    'how would you build a fraud detection model?',
    'how would you build a search ranking system for an e-commerce catalog?',
    'how would you train a recommender system?',
    'how would you evaluate a classifier with imbalanced classes?',
    'how would you build a data pipeline using Airflow?',
    'design a feature store for ML',
  ];
  for (const q of cases) {
    it(`"${q.slice(0, 50)}..." → ml_data`, () => {
      expect(classifyQuestion(q).category).toBe(CATEGORIES.ML_DATA);
    });
  }
});

describe('classifyQuestion — behavioral (framing wins over content)', () => {
  const cases = [
    'tell me about a time you debugged a tricky production issue',
    'tell me about a time you debugged a memory leak in a Spark job',  // mentions Spark — still behavioral
    'describe a situation where you had to push back on a deadline',
    'how do you handle conflict with a co-worker?',
    'walk me through a project you led end to end',
    'what are your strengths and weaknesses?',
    'tell me about yourself',
    'have you ever made a mistake at work?',
    'describe your biggest challenge as an engineer',
  ];
  for (const q of cases) {
    it(`"${q.slice(0, 50)}..." → behavioral`, () => {
      expect(classifyQuestion(q).category).toBe(CATEGORIES.BEHAVIORAL);
    });
  }
});

describe('classifyQuestion — concept', () => {
  const cases = [
    'what is a hashmap?',
    'explain recursion',
    'what is the difference between TCP and UDP?',
    'compare REST and GraphQL',
    'how does a load balancer work?',
    'why is Postgres better than MySQL for relational data?',
  ];
  for (const q of cases) {
    it(`"${q.slice(0, 50)}..." → concept`, () => {
      expect(classifyQuestion(q).category).toBe(CATEGORIES.CONCEPT);
    });
  }
});

describe('classifyQuestion — quantitative', () => {
  const cases = [
    'estimate how many gas stations are in the United States',
    'how many piano tuners are in Chicago?',
    'what is the market size for online learning in India?',
    'estimate the daily revenue of a coffee shop',
  ];
  for (const q of cases) {
    it(`"${q.slice(0, 50)}..." → quantitative`, () => {
      expect(classifyQuestion(q).category).toBe(CATEGORIES.QUANTITATIVE);
    });
  }
});

describe('classifyQuestion — strategy_case', () => {
  const cases = [
    'profits are down 20% at our SaaS company. what is going on?',
    'our weekly active users dropped 7%. what could be causing this?',
    'should we enter the European market?',
    'churn is up 15% this quarter — diagnose it',
    'how would you prioritize between these two features?',
  ];
  for (const q of cases) {
    it(`"${q.slice(0, 50)}..." → strategy_case`, () => {
      expect(classifyQuestion(q).category).toBe(CATEGORIES.STRATEGY_CASE);
    });
  }
});

describe('classifyQuestion — clarifier (short + interrogative)', () => {
  const cases = [
    'why O(n) space?',
    'what about edge case empty?',
    'can you elaborate?',
    'why that approach?',
    'how would you handle nulls?',
  ];
  for (const q of cases) {
    it(`"${q}" → clarifier`, () => {
      expect(classifyQuestion(q).category).toBe(CATEGORIES.CLARIFIER);
    });
  }
});

describe('classifyQuestion — disambiguation', () => {
  it('"tell me about a time you used Spark" → behavioral, NOT ml_data', () => {
    expect(classifyQuestion('tell me about a time you used Spark on a large dataset').category)
      .toBe(CATEGORIES.BEHAVIORAL);
  });
  it('"profits dropped — design a fix" → strategy_case (framing wins)', () => {
    expect(classifyQuestion('profits dropped 20%, what would you do?').category)
      .toBe(CATEGORIES.STRATEGY_CASE);
  });
  it('"design a rate limiter" → system_design', () => {
    expect(classifyQuestion('design a rate limiter').category).toBe(CATEGORIES.SYSTEM_DESIGN);
  });
  it('"how does a hashmap work?" → concept (long-form, definition-shaped)', () => {
    expect(classifyQuestion('how does a hashmap work? explain in detail').category).toBe(CATEGORIES.CONCEPT);
  });
});

describe('classifyQuestion — edge cases', () => {
  it('empty string → other/low confidence', () => {
    const r = classifyQuestion('');
    expect(r.category).toBe(CATEGORIES.OTHER);
    expect(r.confidence).toBe('low');
  });
  it('null/undefined → other', () => {
    expect(classifyQuestion(null).category).toBe(CATEGORIES.OTHER);
    expect(classifyQuestion(undefined).category).toBe(CATEGORIES.OTHER);
  });
  it('uncategorizable text → other', () => {
    expect(classifyQuestion('the quick brown fox jumps over the lazy dog').category)
      .toBe(CATEGORIES.OTHER);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE HARDEST QUESTIONS WERE THE ONES IT COULD NOT NAME
//
//  Found 2026-07-25 by driving the real app and reading the [cover] log
//  line: a textbook exactly-once design question came back cat=other.
//  That is not a cosmetic label. `other` maps to auto-effort 'none' AND
//  sits outside DEEP_CATEGORIES, so on precisely the hardest questions
//  an interviewer asks, the app reasoned LESS and covered SHORTER than
//  it does on "what is a hashmap".
//
//  Measured over thirteen questions a real hiring manager asks a senior
//  data engineer: 5 misclassified, and three of the five were deep
//  engineering questions falling to `other`. Now 0.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('classifyQuestion — the deep questions that used to fall through', () => {
  const deep = (q) => classifyQuestion(q).category;

  it('exactly-once delivery into a non-idempotent sink → system_design', () => {
    // Missed because the design pattern required an ARTICLE right after
    // the verb ("design a…"), and "delivery" is uncountable.
    expect(deep('How would you design exactly-once delivery from an event stream into a warehouse when the sink is not idempotent and you cannot change it?'))
      .toBe(CATEGORIES.SYSTEM_DESIGN);
  });

  it('the vocabulary of delivery semantics is enough on its own', () => {
    expect(deep('Walk me through how you would guarantee at-least-once processing with deduplication downstream.'))
      .toBe(CATEGORIES.SYSTEM_DESIGN);
    expect(deep('What does idempotency buy you in a retry-heavy system?')).toBe(CATEGORIES.SYSTEM_DESIGN);
  });

  it('a Spark job that got slower → ml_data, not other', () => {
    // Missed because the only Spark pattern was "build a spark…". A
    // DEBUGGING question about Spark matched nothing.
    expect(deep('A Spark job that used to run in 20 minutes now takes 3 hours. Nothing changed in the code. What do you look at, in order?'))
      .toBe(CATEGORIES.ML_DATA);
  });

  it('naming the platform is enough — the verb is not what makes it a data question', () => {
    expect(deep('You are ingesting from Kafka into Snowflake and downstream reports start showing duplicate rows right after a deploy. How do you find the cause?'))
      .toBe(CATEGORIES.ML_DATA);
    expect(deep('How would you backfill three years of history into a live Iceberg table?')).toBe(CATEGORIES.ML_DATA);
  });

  it('"walk me through your background" is behavioral, not a clarifier', () => {
    // 77 characters, so the short-interrogative last resort caught the
    // opening question of most interviews.
    expect(deep('Walk me through your background and what you have spent most of your time on.'))
      .toBe(CATEGORIES.BEHAVIORAL);
  });

  it('"what is a technical decision you got wrong" is behavioral, not a definition', () => {
    expect(deep('Be honest. What is a technical decision you made that turned out to be wrong, and what did it cost?'))
      .toBe(CATEGORIES.BEHAVIORAL);
  });

  it('behavioral framing still outranks the new technology patterns', () => {
    // The new platform list is broad on purpose; it must not swallow a
    // STAR question that happens to name a tool.
    expect(deep('Tell me about a time a Kafka consumer group rebalanced during peak load.'))
      .toBe(CATEGORIES.BEHAVIORAL);
    expect(deep('Describe a situation where a Snowflake bill surprised you.')).toBe(CATEGORIES.BEHAVIORAL);
  });

  it('"how would you approach" stays out of system_design', () => {
    // Deliberately excluded from the article-free design pattern: this
    // shape is overwhelmingly interpersonal.
    expect(deep('How would you approach a difficult conversation with a teammate?'))
      .not.toBe(CATEGORIES.SYSTEM_DESIGN);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE CLASSIFIER IS ONLY HALF OF IT.
//
//  The server's category never reaches the model — it selects reasoning
//  effort and sizes the cover, nothing else. The model picks its answer
//  SHAPE from the taxonomy in the response-rules prompt, and that taxonomy
//  is where "1-2 sentences max" actually lives. Fixing the classifier while
//  leaving the prompt alone would change the effort dial and not one word
//  of the answer.
//
//  Measured on the shipped prompt with the real resume, real gpt-5.6,
//  reasoning_effort 'none':
//     before  90 words / 4 sentences   after  128 words / 6 sentences
//     before  70 words / 2 sentences   after  131 words / 5 sentences
//  TTFT unchanged (both arms 750-3500ms; +589 tokens on ~13,200).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('the answer-shape taxonomy has somewhere to put a practice question', () => {
  const fs = require('node:fs');
  const rules = fs.readFileSync(
    new URL('../../services/aiProxyService.ts', import.meta.url), 'utf8',
  );

  it('defines a practice / process-ownership shape', () => {
    expect(rules).toContain('PRACTICE / PROCESS OWNERSHIP');
  });

  it('gives it a real budget, not the short-form one', () => {
    const block = rules.slice(
      rules.indexOf('PRACTICE / PROCESS OWNERSHIP'),
      rules.indexOf('UNIVERSAL SHORT-FORMS:'),
    );
    expect(block).toMatch(/Total: 5-7 sentences/);
    // The five beats that separate someone who ran it from someone who
    // watched it run. Losing any one of them collapses the shape back
    // toward a definition.
    for (const beat of ['THE CONTROL', 'THE MECHANISM', 'THE SIGNAL', 'THE FAILURE MODE', 'THE LIMIT']) {
      expect(block, `the ${beat} beat is what makes this answer senior`).toContain(beat);
    }
  });

  it('tells the model that short does not mean clarifier', () => {
    const block = rules.slice(rules.indexOf('UNIVERSAL SHORT-FORMS:'));
    expect(block).toMatch(/CANNOT be understood without the previous turn/);
    expect(
      block,
      'without this, a nine-word question that names a document is answered in two sentences',
    ).toMatch(/is NOT a clarifier no matter how few words/);
  });
});
