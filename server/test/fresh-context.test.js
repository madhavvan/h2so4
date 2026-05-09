// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  freshContext — unit tests
//
//  The classifier is the most important piece — false positives
//  burn Brave queries, false negatives miss the retrieval value.
//  We test:
//    1. classify() positive cases (all major tool families)
//    2. classify() specificity-pattern positives ("what tabs", etc.)
//    3. classify() negative cases (concepts, behavioral, generic)
//    4. buildQuery() normalization
//    5. formatContext() shape + truncation
//    6. enrichTranscript() with mocked search — null when not classified,
//       null when no results, populated context when both succeed
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { enrichTranscript, classify, buildQuery, formatContext, detectAuthorityDomains, _test } =
  require('../src/services/freshContext.js');
const { rerankByAuthority, ENTITY_AUTHORITY } = _test;

describe('classify — Path 1: tool + specificity (positive)', () => {
  // Tool name + UI/API/config specificity. These are the "fresh-data
  // genuinely helps" cases — UI tabs change with releases, API params
  // drift between versions, dashboards get redesigned.
  const toolPlusSpecificity = [
    'what tabs do you see in the AWS Glue dashboard?',
    'what parameters does PySpark groupBy take?',
    'what tabs are in the Snowflake console?',
    'what menus are in the Datadog dashboard?',
    'what fields does AWS DynamoDB have?',
    'what arguments does pandas merge take?',
    'what options does dbt run support?',
    'what env vars does Airflow expect?',
    'what flags does Docker compose accept?',
    'what methods does PyTorch DataLoader expose?',
    'what properties does the Kubernetes scheduler have?',
    'what hooks does React 19 introduce?',
    'what options does Terraform plan have?',
    'what commands does kafka-console-consumer accept?',
    'what arguments does the FastAPI Depends function take?',
  ];

  for (const q of toolPlusSpecificity) {
    it(`fires for "${q.slice(0, 60)}..." (tool + specificity)`, () => {
      expect(classify(q)).toBe(true);
    });
  }
});

describe('classify — Path 2: UPDATE_SIGNALS alone (positive)', () => {
  // Strong update signals fire even without an explicit tool match —
  // Brave's relevance ranker picks up the entity from context.
  const updateSignalQuestions = [
    "what's new in Python 3.13?",
    "what's new in pandas?",
    "what's new in PyTorch 2.0",
    'what is the latest version of Postgres?',
    'latest features in Snowflake',
    'newest features in Kubernetes',
    'newest version of Airflow',
    'what was deprecated in Airflow 2.5',
    'has been removed in Spark 4',
    'has been added in the latest pandas',
    'in the latest version of dbt',
    'in the latest release of Next.js',
  ];

  for (const q of updateSignalQuestions) {
    it(`fires for "${q.slice(0, 60)}..." (update signal)`, () => {
      expect(classify(q)).toBe(true);
    });
  }
});

describe('classify — negative: tool-only conceptual (model knows these)', () => {
  // Tool names without specificity → skip. The model has these conceptually
  // from training data; firing Brave wastes a query.
  const toolOnlyConcepts = [
    'tell me about Apache Spark',
    'explain Apache Kafka',
    'how does Snowflake handle micro-partitions?',
    'walk me through a dbt project structure',
    'explain Airflow XComs',
    'describe Databricks Delta Lake',
    'how does BigQuery clustering work?',
    'explain Kafka exactly-once semantics',
    'how does Postgres handle MVCC?',
    'walk me through a Next.js app router',
    'what is FastAPI dependency injection?',
    'explain Terraform modules',
    'how does Lambda cold start work?',
    'explain SageMaker pipelines',
    'how does Redshift differ from Snowflake?',
    'walk me through DynamoDB partition key design',
    'explain S3 multipart upload',
    'I worked with Snowflake at my last role',
    'tell me about your AWS Glue experience',
  ];

  for (const q of toolOnlyConcepts) {
    it(`SKIPS "${q.slice(0, 60)}..." (tool only, conceptual)`, () => {
      expect(classify(q)).toBe(false);
    });
  }
});

describe('classify — negative: specificity without tool (Brave cannot help)', () => {
  // Specificity words alone are too ambiguous — "what tabs are in the
  // dashboard" without naming the dashboard product won't get useful
  // results from Brave.
  const specificityNoTool = [
    'what tabs are in the dashboard?',
    'what fields does this form have?',
    'what menus are available?',
    'what parameters are supported?',
    'what options does this take?',
    'what arguments do I need?',
  ];

  for (const q of specificityNoTool) {
    it(`SKIPS "${q.slice(0, 60)}..." (specificity but no tool)`, () => {
      expect(classify(q)).toBe(false);
    });
  }
});

describe('classify — negative: concepts, behavioral, generic', () => {
  const conceptQuestions = [
    'what is a hashmap?',
    'explain recursion',
    'what is the time complexity of quicksort?',
    'what is the difference between a process and a thread?',
    'tell me about a time you debugged a tricky issue',
    'how would you push back on a deadline?',
    'what are your strengths?',
    'walk me through your background',
    'why do you want this role?',
    'describe a hard design problem you solved',
    'what is REST?',
    'explain object-oriented programming',
    'what is Big O notation?',
    'how do hash tables work?',
    'compare arrays and linked lists',
    'what is dynamic programming?',
    'what is a binary search tree?',
    'why is the sky blue?',
    'profits dropped 20%, what could it be?',
  ];

  for (const q of conceptQuestions) {
    it(`SKIPS "${q.slice(0, 60)}..." (concept/behavioral)`, () => {
      expect(classify(q)).toBe(false);
    });
  }

  it('returns false for empty string', () => {
    expect(classify('')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(classify(null)).toBe(false);
    expect(classify(undefined)).toBe(false);
  });

  it('returns false for very short input', () => {
    expect(classify('hi')).toBe(false);
  });
});

describe('buildQuery', () => {
  it('trims and normalizes whitespace', () => {
    expect(buildQuery('  what   tabs  in  glue?  ')).toBe('what tabs in glue?');
  });

  it('caps length at 200 chars', () => {
    const long = 'a'.repeat(500);
    expect(buildQuery(long).length).toBe(200);
  });

  it('handles non-string input gracefully', () => {
    expect(buildQuery(null)).toBe('');
    expect(buildQuery(undefined)).toBe('');
  });
});

describe('formatContext', () => {
  it('returns null for empty results', () => {
    expect(formatContext([])).toBeNull();
    expect(formatContext(null)).toBeNull();
  });

  it('produces a FRESH_CONTEXT block with all results', () => {
    const results = [
      { title: 'AWS Glue Console', description: 'Tables and Crawlers section', url: 'https://docs.aws.amazon.com/glue' },
      { title: 'Glue Tutorial', description: 'Get started with Glue', url: 'https://example.com/glue' },
    ];
    const block = formatContext(results);
    expect(block).toMatch(/<FRESH_CONTEXT>/);
    expect(block).toMatch(/<\/FRESH_CONTEXT>/);
    expect(block).toMatch(/AWS Glue Console/);
    expect(block).toMatch(/Tables and Crawlers section/);
    expect(block).toMatch(/internalize/);
    expect(block).toMatch(/Do NOT cite/);
  });

  it('caps at 3 results', () => {
    const results = Array(10).fill(null).map((_, i) => ({
      title: `Title ${i}`,
      description: `Desc ${i}`,
      url: `https://x.example/${i}`,
    }));
    const block = formatContext(results);
    expect(block).toMatch(/Title 0/);
    expect(block).toMatch(/Title 1/);
    expect(block).toMatch(/Title 2/);
    expect(block).not.toMatch(/Title 3/);
    expect(block).not.toMatch(/Title 4/);
  });

  it('truncates long titles and descriptions', () => {
    const results = [{
      title: 'T'.repeat(500),
      description: 'D'.repeat(2000),
      url: '',
    }];
    const block = formatContext(results);
    // Title bounded to 200, description bounded to 500
    const titleMatch = block.match(/T+/);
    expect(titleMatch[0].length).toBeLessThanOrEqual(200);
    const descMatch = block.match(/D+/);
    expect(descMatch[0].length).toBeLessThanOrEqual(500);
  });
});

describe('enrichTranscript', () => {
  it('returns null when classifier rejects', async () => {
    const result = await enrichTranscript('what is a hashmap?');
    expect(result).toBeNull();
  });

  it('returns null when search returns empty results', async () => {
    // We can't easily mock searchWithCache here without module-level mocks,
    // but we can hit the no-api-key + no-cache path which yields empty.
    // This requires no BRAVE_API_KEY in the test env — defensive: unset it.
    const oldKey = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    try {
      const result = await enrichTranscript('what tabs in AWS Glue dashboard?');
      // Without an API key AND without cache, freshContext sees empty results
      // and returns null. (The block instruction docs this fallback path.)
      expect(result).toBeNull();
    } finally {
      if (oldKey !== undefined) process.env.BRAVE_API_KEY = oldKey;
    }
  });
});

describe('TOOL_PATTERNS / SPECIFICITY / UPDATE_SIGNALS coverage smoke', () => {
  // Belt-and-suspenders: pull the actual pattern arrays and verify shape.
  const { TOOL_PATTERNS, SPECIFICITY_PATTERNS, UPDATE_SIGNALS } = _test;

  it('TOOL_PATTERNS is well populated', () => {
    expect(TOOL_PATTERNS.length).toBeGreaterThan(10);
  });

  it('SPECIFICITY_PATTERNS is well populated', () => {
    expect(SPECIFICITY_PATTERNS.length).toBeGreaterThanOrEqual(3);
  });

  it('UPDATE_SIGNALS is well populated', () => {
    expect(UPDATE_SIGNALS.length).toBeGreaterThanOrEqual(5);
  });

  it('all patterns are valid RegExp', () => {
    for (const p of TOOL_PATTERNS) expect(p).toBeInstanceOf(RegExp);
    for (const p of SPECIFICITY_PATTERNS) expect(p).toBeInstanceOf(RegExp);
    for (const p of UPDATE_SIGNALS) expect(p).toBeInstanceOf(RegExp);
  });
});

describe('detectAuthorityDomains', () => {
  it('returns null for non-tool transcripts', () => {
    expect(detectAuthorityDomains('what is a hashmap?')).toBeNull();
    expect(detectAuthorityDomains('tell me about a tough deadline')).toBeNull();
    expect(detectAuthorityDomains('')).toBeNull();
    expect(detectAuthorityDomains(null)).toBeNull();
  });

  const cases = [
    ['what tabs in AWS Glue dashboard',           'docs.aws.amazon.com'],
    ['walk me through GCP BigQuery',              'cloud.google.com'],
    ['explain Azure Synapse',                     'learn.microsoft.com'],
    ['Snowflake micro-partitions',                'docs.snowflake.com'],
    ['Databricks Delta Lake',                     'docs.databricks.com'],
    ['ClickHouse vs DuckDB',                      'clickhouse.com'],
    ['dbt incremental model',                     'docs.getdbt.com'],
    ['Airflow XComs',                             'airflow.apache.org'],
    ['Dagster asset materialization',             'docs.dagster.io'],
    ['PySpark groupBy parameters',                'spark.apache.org'],
    ['Kafka consumer groups',                     'kafka.apache.org'],
    ['Postgres MVCC',                             'postgresql.org'],
    ['MySQL replication',                         'dev.mysql.com'],
    ['MongoDB aggregation',                       'mongodb.com'],
    ['Redis clustering',                          'redis.io'],
    ['ElasticSearch shard rebalance',             'elastic.co'],
    ['TensorFlow tf.data',                        'tensorflow.org'],
    ['PyTorch DataLoader',                        'pytorch.org'],
    ['scikit-learn pipelines',                    'scikit-learn.org'],
    ['Hugging Face transformers',                 'huggingface.co'],
    ['LangChain agents',                          'python.langchain.com'],
    ['MLflow tracking',                           'mlflow.org'],
    ['pandas merge',                              'pandas.pydata.org'],
    ['NumPy broadcasting',                        'numpy.org'],
    ['Polars LazyFrame',                          'pola.rs'],
    ['Next.js app router',                        'nextjs.org'],
    ['Django ORM',                                'docs.djangoproject.com'],
    ['FastAPI dependency injection',              'fastapi.tiangolo.com'],
    ['Docker compose',                            'docs.docker.com'],
    ['Kubernetes scheduler',                      'kubernetes.io'],
    ['Terraform modules',                         'developer.hashicorp.com'],
    ['Datadog tracing',                           'docs.datadoghq.com'],
    ['Prometheus query',                          'prometheus.io'],
    ['Python 3.13 features',                      'docs.python.org'],
    ['Node.js streams',                           'nodejs.org'],
  ];

  for (const [transcript, expectedDomain] of cases) {
    it(`detects "${transcript}" → ${expectedDomain}`, () => {
      const domains = detectAuthorityDomains(transcript);
      expect(domains).not.toBeNull();
      expect(domains).toContain(expectedDomain);
    });
  }

  it('ENTITY_AUTHORITY is non-empty and well-formed', () => {
    expect(ENTITY_AUTHORITY.length).toBeGreaterThan(20);
    for (const entry of ENTITY_AUTHORITY) {
      expect(entry.match).toBeInstanceOf(RegExp);
      expect(Array.isArray(entry.domains)).toBe(true);
      expect(entry.domains.length).toBeGreaterThan(0);
      for (const d of entry.domains) expect(typeof d).toBe('string');
    }
  });
});

describe('rerankByAuthority', () => {
  const sample = [
    { title: 'Random Blog 1', description: '', url: 'https://medium.com/some-post' },
    { title: 'AWS Docs',      description: '', url: 'https://docs.aws.amazon.com/glue/dashboard' },
    { title: 'StackOverflow', description: '', url: 'https://stackoverflow.com/q/123' },
    { title: 'AWS Tutorial',  description: '', url: 'https://aws.amazon.com/getting-started/glue' },
    { title: 'Reddit Thread', description: '', url: 'https://reddit.com/r/aws/comments/abc' },
  ];

  it('pushes authority domain matches to the top', () => {
    const ranked = rerankByAuthority(sample, ['docs.aws.amazon.com', 'aws.amazon.com']);
    // First two should now be the AWS results
    expect(ranked[0].title).toBe('AWS Docs');
    expect(ranked[1].title).toBe('AWS Tutorial');
    // Remaining three preserve original order
    expect(ranked[2].title).toBe('Random Blog 1');
    expect(ranked[3].title).toBe('StackOverflow');
    expect(ranked[4].title).toBe('Reddit Thread');
  });

  it('preserves original order when no authority match', () => {
    const ranked = rerankByAuthority(sample, ['docs.snowflake.com']);
    expect(ranked).toEqual(sample);
  });

  it('preserves original order when ALL results are authority', () => {
    const allAuth = [
      { title: 'A', url: 'https://docs.aws.amazon.com/1' },
      { title: 'B', url: 'https://aws.amazon.com/2' },
    ];
    const ranked = rerankByAuthority(allAuth, ['docs.aws.amazon.com', 'aws.amazon.com']);
    expect(ranked).toEqual(allAuth);
  });

  it('no-ops with null/empty domains', () => {
    expect(rerankByAuthority(sample, null)).toEqual(sample);
    expect(rerankByAuthority(sample, [])).toBe(sample); // arr.length < 2 path doesn't trigger; null returns as-is
  });

  it('no-ops on tiny result sets', () => {
    expect(rerankByAuthority([], ['docs.aws.amazon.com'])).toEqual([]);
    expect(rerankByAuthority([sample[0]], ['docs.aws.amazon.com'])).toEqual([sample[0]]);
  });

  it('domain matching is case-insensitive', () => {
    const mixed = [
      { title: 'A', url: 'https://Docs.AWS.Amazon.COM/page' },
      { title: 'B', url: 'https://medium.com' },
    ];
    const ranked = rerankByAuthority(mixed, ['docs.aws.amazon.com']);
    expect(ranked[0].title).toBe('A');
  });
});

describe('enrichTranscript with authority re-ranking (end-to-end with mocked search)', () => {
  // Mock the searchWithCache via searchProvider's _searchFn injection.
  // freshContext calls searchWithCache which honors options._searchFn —
  // that's our seam.

  it('puts authoritative results first when transcript names a known tool', async () => {
    const fakeFetch = async () => ([
      { title: 'SEO Blog', description: 'Glue tutorial blog', url: 'https://medium.com/glue' },
      { title: 'AWS Glue Console docs', description: 'Tabs in console', url: 'https://docs.aws.amazon.com/glue/latest/dg/console.html' },
      { title: 'Random Forum', description: 'Glue discussion', url: 'https://stackoverflow.com/q/glue' },
      { title: 'AWS Glue Tutorial', description: 'Get started', url: 'https://aws.amazon.com/glue/getting-started' },
    ]);

    // We need an in-memory DB so searchWithCache can run.
    const Database = require('better-sqlite3');
    const { _test: spTest } = require('../src/services/searchProvider.js');
    const db = new Database(':memory:');
    spTest.initSchema(db);

    const result = await enrichTranscript('what tabs in AWS Glue dashboard', {
      _db: db,
      _searchFn: fakeFetch,
      apiKey: 'k',
      deepFetch: false,  // skip deep-fetch in this test — covered separately
    });

    expect(result).not.toBeNull();
    expect(result.authority).toBe('docs.aws.amazon.com');
    // Top sources must be the AWS docs results first
    expect(result.sources[0]).toContain('docs.aws.amazon.com');
    expect(result.sources[1]).toContain('aws.amazon.com');
    // FRESH_CONTEXT block must mention the authoritative title first
    expect(result.context.indexOf('AWS Glue Console docs')).toBeLessThan(
      result.context.indexOf('SEO Blog')
    );
  });

  it('preserves Brave order when no authority match (e.g., generic query)', async () => {
    const fakeFetch = async () => ([
      { title: 'First', description: '', url: 'https://example.com/1' },
      { title: 'Second', description: '', url: 'https://example.com/2' },
      { title: 'Third', description: '', url: 'https://example.com/3' },
    ]);

    const Database = require('better-sqlite3');
    const { _test: spTest } = require('../src/services/searchProvider.js');
    const db = new Database(':memory:');
    spTest.initSchema(db);

    // Use a transcript that triggers classify (UPDATE_SIGNAL "what's new in")
    // but doesn't match any ENTITY_AUTHORITY entry.
    const result = await enrichTranscript("what's new in this latest release", {
      _db: db,
      _searchFn: fakeFetch,
      apiKey: 'k',
      deepFetch: false,
    });

    expect(result).not.toBeNull();
    expect(result.authority).toBeNull();
    // Order matches the fake fetch order
    expect(result.sources[0]).toContain('/1');
    expect(result.sources[1]).toContain('/2');
    expect(result.sources[2]).toContain('/3');
  });
});

describe('enrichTranscript with deep-fetch enabled (mocked page fetcher)', () => {
  function setupDb() {
    const Database = require('better-sqlite3');
    const { _test: spTest } = require('../src/services/searchProvider.js');
    const db = new Database(':memory:');
    spTest.initSchema(db);
    return db;
  }

  it('injects DEEP SOURCE block when top URL fetch succeeds', async () => {
    const db = setupDb();
    const fakeSearch = async () => ([
      { title: 'AWS Glue Console', description: 'short snippet', url: 'https://docs.aws.amazon.com/glue/console.html' },
      { title: 'Some Blog', description: '', url: 'https://medium.com/x' },
    ]);
    const fakePageFetch = async (url) => {
      if (url.includes('docs.aws.amazon.com')) {
        return {
          ok: true,
          text: 'Full extracted page content with detailed information about Tables, Crawlers, Jobs, Triggers, Workflows, Data Quality, Schema Registry tabs in the Glue console.',
        };
      }
      return { ok: false, error: 'should not be called' };
    };

    const result = await enrichTranscript('what tabs in AWS Glue dashboard', {
      _db: db,
      _searchFn: fakeSearch,
      _fetchFn: fakePageFetch,
      apiKey: 'k',
    });

    expect(result).not.toBeNull();
    expect(result.deepFetch).not.toBeNull();
    expect(result.deepFetch.contentLength).toBeGreaterThan(50);
    // DEEP SOURCE block is in the context
    expect(result.context).toMatch(/DEEP SOURCE/);
    expect(result.context).toContain('Tables, Crawlers, Jobs');
    // Snippets section is also present
    expect(result.context).toMatch(/ADDITIONAL SNIPPETS/);
  });

  it('falls back to snippets-only when deep-fetch fails', async () => {
    const db = setupDb();
    const fakeSearch = async () => ([
      { title: 'Page A', description: 'snippet A', url: 'https://example.com/a' },
      { title: 'Page B', description: 'snippet B', url: 'https://example.com/b' },
    ]);
    const fakePageFetch = async () => ({ ok: false, error: 'http_503', text: '' });

    const result = await enrichTranscript('what tabs in AWS Glue', {
      _db: db,
      _searchFn: fakeSearch,
      _fetchFn: fakePageFetch,
      apiKey: 'k',
    });

    expect(result).not.toBeNull();
    expect(result.context).not.toMatch(/DEEP SOURCE/);
    expect(result.context).toContain('snippet A');
    expect(result.deepFetch).toBeTruthy();
    expect(result.deepFetch.error).toBe('http_503');
  });

  it('skips deep-fetch when options.deepFetch is false', async () => {
    const db = setupDb();
    const fakeSearch = async () => ([
      { title: 'Doc', description: '', url: 'https://docs.aws.amazon.com/x' },
    ]);
    const fakePageFetch = vi.fn();

    const result = await enrichTranscript('what tabs in AWS Glue', {
      _db: db,
      _searchFn: fakeSearch,
      _fetchFn: fakePageFetch,
      apiKey: 'k',
      deepFetch: false,
    });

    expect(fakePageFetch).not.toHaveBeenCalled();
    expect(result.deepFetch).toBeNull();
    expect(result.context).not.toMatch(/DEEP SOURCE/);
  });
});

describe('enrichTranscript — cacheOnly mode (chat-time fast path)', () => {
  function setupDb() {
    const Database = require('better-sqlite3');
    const { _test: spTest } = require('../src/services/searchProvider.js');
    const db = new Database(':memory:');
    spTest.initSchema(db);
    return db;
  }

  it('returns null when cache is empty and cacheOnly:true (no live fetch)', async () => {
    const db = setupDb();
    const fakeSearch = vi.fn();
    const fakePageFetch = vi.fn();

    const result = await enrichTranscript('what tabs in AWS Glue dashboard', {
      _db: db,
      _searchFn: fakeSearch,
      _fetchFn: fakePageFetch,
      apiKey: 'k',
      cacheOnly: true,
    });

    expect(result).toBeNull();
    expect(fakeSearch).not.toHaveBeenCalled();
    expect(fakePageFetch).not.toHaveBeenCalled();
  });

  it('serves warm cache hit even with cacheOnly:true', async () => {
    const db = setupDb();
    // Pre-warm the search cache with what the prefetch endpoint would have written.
    const Database = require('better-sqlite3');
    const { _test: spTest } = require('../src/services/searchProvider.js');
    const query = 'what tabs in AWS Glue dashboard';
    const fp = spTest.fingerprint(query);
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`).run(
      fp, query, 'brave',
      JSON.stringify([
        { title: 'AWS Glue', description: 'snippet', url: 'https://docs.aws.amazon.com/glue/x' },
      ]),
      now,
    );
    // Pre-warm the page cache too.
    db.prepare(`INSERT INTO page_cache VALUES (?, ?, ?, ?)`).run(
      spTest.fingerprint('https://docs.aws.amazon.com/glue/x'),
      'https://docs.aws.amazon.com/glue/x',
      'Pre-fetched page content from earlier prefetch.',
      now,
    );

    const fakeSearch = vi.fn();
    const fakePageFetch = vi.fn();

    const result = await enrichTranscript(query, {
      _db: db,
      _searchFn: fakeSearch,
      _fetchFn: fakePageFetch,
      apiKey: 'k',
      cacheOnly: true,
    });

    expect(result).not.toBeNull();
    expect(result.cached).toBe(true);
    expect(result.context).toMatch(/DEEP SOURCE/);
    expect(result.context).toContain('Pre-fetched page content');
    expect(fakeSearch).not.toHaveBeenCalled();
    expect(fakePageFetch).not.toHaveBeenCalled();
  });

  it('serves snippets-only when search cache is warm but page cache is cold (cacheOnly)', async () => {
    const db = setupDb();
    const Database = require('better-sqlite3');
    const { _test: spTest } = require('../src/services/searchProvider.js');
    const query = "what's new in pandas";
    const fp = spTest.fingerprint(query);
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`).run(
      fp, query, 'brave',
      JSON.stringify([
        { title: 'Pandas', description: 'snippet from cache', url: 'https://pandas.pydata.org/x' },
      ]),
      now,
    );
    // Note: NO entry in page_cache for that URL — this simulates the
    // case where the prefetch ran searchWithCache but the page fetch
    // was still in flight when the chat call landed.

    const fakeSearch = vi.fn();
    const fakePageFetch = vi.fn();

    const result = await enrichTranscript(query, {
      _db: db,
      _searchFn: fakeSearch,
      _fetchFn: fakePageFetch,
      apiKey: 'k',
      cacheOnly: true,
    });

    expect(result).not.toBeNull();
    expect(result.context).toContain('snippet from cache');
    // No DEEP SOURCE because page cache was cold and we didn't fall through to live fetch
    expect(result.context).not.toMatch(/DEEP SOURCE/);
    expect(fakeSearch).not.toHaveBeenCalled();
    expect(fakePageFetch).not.toHaveBeenCalled();
  });
});

describe('formatContext with deepContent', () => {
  it('renders DEEP SOURCE first, then ADDITIONAL SNIPPETS', () => {
    const results = [
      { title: 'A', description: 'snippet a', url: 'https://example.com/a' },
      { title: 'B', description: 'snippet b', url: 'https://example.com/b' },
    ];
    const deepContent = {
      url: 'https://docs.example.com',
      title: 'Authoritative Page',
      text: 'This is the deeply extracted page content.',
    };
    const block = formatContext(results, deepContent);
    expect(block).toMatch(/DEEP SOURCE/);
    expect(block).toContain('Authoritative Page');
    expect(block).toContain('This is the deeply extracted page content.');
    expect(block).toMatch(/ADDITIONAL SNIPPETS/);
    expect(block).toContain('snippet a');
    expect(block.indexOf('DEEP SOURCE')).toBeLessThan(block.indexOf('ADDITIONAL SNIPPETS'));
  });

  it('renders snippets-only when deepContent is null', () => {
    const block = formatContext([{ title: 'X', description: 'y', url: '' }], null);
    expect(block).not.toMatch(/DEEP SOURCE/);
    expect(block).not.toMatch(/ADDITIONAL SNIPPETS/);
    expect(block).toContain('X');
  });

  it('renders deep-only when results is empty', () => {
    const deepContent = { url: 'u', title: 'Title', text: 'Deep text' };
    const block = formatContext([], deepContent);
    expect(block).toMatch(/DEEP SOURCE/);
    expect(block).toContain('Deep text');
    expect(block).not.toMatch(/ADDITIONAL SNIPPETS/);
  });

  it('returns null when both empty', () => {
    expect(formatContext([], null)).toBeNull();
    expect(formatContext(null, null)).toBeNull();
  });
});
