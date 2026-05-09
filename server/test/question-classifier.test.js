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
  it('exports the 9 documented categories', () => {
    expect(Object.values(CATEGORIES).sort()).toEqual([
      'behavioral', 'clarifier', 'coding', 'concept',
      'ml_data', 'other', 'quantitative', 'strategy_case', 'system_design',
    ]);
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
