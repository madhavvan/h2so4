// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Fresh Context Orchestrator — classify → search → format
//
//  When a transcript lands in the chat input, this module decides
//  whether the question is the kind the model would benefit from
//  retrieved, current evidence on (e.g. "what tabs are in the AWS
//  Glue dashboard?", "what's new in Python 3.13?", "PySpark groupBy
//  parameters?"). For those questions, it issues a Brave search and
//  formats the top snippets into a FRESH_CONTEXT block that gets
//  appended to the system prompt before the model is called.
//
//  The classifier is deterministic regex — zero LLM cost, ~1ms.
//  Conservative on false positives (we'd rather skip retrieval than
//  burn a Brave query on "what is recursion?"). The patterns target:
//    1. Named tools/libraries/platforms with stale-prone specifics
//       (AWS services, Snowflake, dbt, PySpark, pandas, ...)
//    2. Question shapes that imply UI / parameter / version specifics
//       ("what tabs", "what's new in", "latest version", ...)
//
//  Patterns explicitly EXCLUDED:
//    - General CS concepts (hashmap, recursion, big-O, sorting)
//    - Architectural topics (microservices, monoliths, DDD)
//    - Behavioral / situational questions
//    - Pure SQL/code-writing questions where the model already
//      knows the language
//  Why excluded: the model is rock-solid on concepts; it's only
//  product/tool/UI-specific questions where retrieval pays off.
//
//  Future extensions (not in MVP):
//    - Tiny-LLM entity extractor for ambiguous transcripts (~150ms)
//    - Per-tool authority filtering (force AWS docs domain when entity
//      is "AWS X")
//    - User-resume tool list as additional classifier hits (i.e. if
//      user's resume mentions Glue, lower threshold for Glue questions)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const { searchWithCache, fetchPageContentWithCache } = require('./searchProvider');

// ── Tool / library / platform patterns ──
// If ANY of these match the transcript, we classify as "needs context."
// Word-boundary anchored so "react" doesn't match "reactor" etc.
//
// Note: groups are organized by family for readability, but the engine
// treats them as a flat OR. Adding a tool means adding to the right
// group (or a new group below).
const TOOL_PATTERNS = [
  // ── AWS ──
  /\b(aws\s+)?(glue|lambda|redshift|athena|kinesis|dynamo\s*db|emr|sagemaker|cloudwatch|api\s+gateway|step\s+functions|eventbridge|secrets\s+manager|app\s+runner|cloudfront|route\s*53)\b/i,
  /\b(s3|ec2|ecs|eks|sqs|sns|iam|kms|aurora|neptune|opensearch|msk|elasticache)\b/i,

  // ── GCP ──
  /\b(big\s*query|dataflow|pub\s*\/?\s*sub|cloud\s+(functions|run|storage|sql|composer|spanner|tasks|build|dataproc))\b/i,
  /\b(gke|vertex\s+ai|bigtable|firestore|datastream)\b/i,

  // ── Azure ──
  /\bazure\s+(synapse|data\s+factory|functions|cosmos\s+db|blob|sql\s+database|databricks|ml\s+studio|event\s+hubs|service\s+bus)\b/i,
  /\b(aks)\b/i,

  // ── Data warehouses + lakehouses ──
  /\b(snowflake|databricks|clickhouse|duck\s*db|presto|trino)\b/i,

  // ── Data orchestration / ELT ──
  /\b(dbt|airflow|dagster|prefect|luigi|airbyte|fivetran|stitch)\b/i,

  // ── Streaming + processing ──
  /\b(spark|pyspark|flink|kafka|pulsar|storm|beam|samza)\b/i,

  // ── Databases ──
  /\b(postgres(?:ql)?|mysql|mongo\s*db|cassandra|redis|elasticsearch|cockroach\s*db|scylla)\b/i,

  // ── ML / AI frameworks ──
  /\b(tensorflow|pytorch|scikit\s*-?\s*learn|sklearn|hugging\s*face|langchain|llama\s*index|mlflow|weights\s+(?:and|&)\s+biases|wandb|kubeflow|ray\s+(serve|train|tune)|jax|fastai)\b/i,

  // ── Web frameworks / runtimes ──
  /\b(react(?:js|\.dev)?|vue(?:\.?js)?|angular|svelte(?:\s*kit)?)\b/i,
  /\b(next\.?js|nuxt|remix|astro|gatsby)\b/i,
  /\b(deno|bun|express|fastapi|flask|django|rails|spring\s+boot|laravel|asp\.?net)\b/i,

  // ── Data libraries ──
  /\b(pandas|numpy|polars|dask|vaex|matplotlib|seaborn|plotly|altair|streamlit|gradio)\b/i,

  // ── DevOps / infra ──
  /\b(docker|kubernetes|k8s|terraform|ansible|helm|pulumi|argo\s*cd|fluxcd|crossplane)\b/i,
  /\b(github\s+actions|gitlab\s+ci|jenkins|circle\s*ci|travis\s*ci|tekton|drone\s*ci)\b/i,

  // ── Observability / monitoring ──
  /\b(datadog|new\s+relic|prometheus|grafana|opentelemetry|jaeger|zipkin|sentry)\b/i,

  // ── Version-specific language questions ──
  /\bpython\s*3\.\d/i,
  /\bnode\s*\d{2,}/i,
  /\bjava\s*\d{2,}/i,
  /\b\.net\s*\d/i,
];

// ── Update signals ──
// Strong "this is about something recent / version-specific" indicators.
// These fire ALONE — no tool match required — because they almost always
// involve a tool/library the user named, and Brave's relevance ranker
// picks up the entity from context.
//
// Why these get the "alone" privilege: the model's training data is
// stale on version-specific facts. "What's new in Python 3.13" or
// "deprecated in Airflow 2.5" are exactly the cases where retrieval
// pays off most — even if our regex didn't catch the exact tool name.
const UPDATE_SIGNALS = [
  /\bwhat'?s?\s+new\s+in\b/i,
  /\blatest\s+(version|features|release|update|api)\b/i,
  /\bnewest\s+(version|features|release|update)\b/i,
  /\bdeprecated\s+(in|since|after|before)\b/i,
  /\bhas\s+(been\s+)?(removed|deprecated|added|introduced)\s+in\b/i,
  /\bin\s+the\s+latest\s+(version|release)\b/i,
  /\b(today'?s?|current|recent)\s+(version|features|api|ui|console)\s+of\b/i,
];

// ── Specificity patterns ──
// Question shapes that ask about UI / parameter / config specifics.
// These fire ONLY when paired with a tool match. "What tabs are in the
// dashboard" alone is too ambiguous for Brave to help; "what tabs in
// AWS Glue dashboard" is clear.
const SPECIFICITY_PATTERNS = [
  /\bwhat\s+(tabs|fields|screens|menus|sections|panels|buttons|widgets|tiles|cards)\b/i,
  /\bwhat\s+(parameters|arguments|options|flags|methods|properties|attributes|hooks)\b/i,
  /\bwhat\s+(commands|cli\s+options|env\s+vars|environment\s+variables)\b/i,
  /\b(dashboard|console|admin\s+panel|web\s+ui)\s+(tabs|sections|layout)\b/i,
];

// ── Authority domain map ──
// When a transcript names a known tool/library/platform, we know
// where its canonical documentation lives. We pass that list to the
// re-ranker so search results from those domains float to the top of
// the FRESH_CONTEXT block. Brave's default ranking is good but sometimes
// SEO-spam blogs outrank docs.aws.amazon.com — re-ranking fixes that.
//
// Rules for entries:
//   - Match must be specific enough to avoid false matches (use word
//     boundaries, prefer multi-word forms when the single word is too
//     generic, e.g. "spring boot" not "spring")
//   - Domains are listed by authority preference (most-canonical first).
//     The re-ranker treats any URL containing ANY listed domain as a
//     match — partial match is fine because URLs vary.
//   - Keep this list focused on tools where stale model knowledge is
//     a real risk (UIs, API params, version-specific features). General
//     concepts like "REST" or "OOP" don't need authority docs.
const ENTITY_AUTHORITY = [
  // ── Cloud platforms ──
  { match: /\b(aws|amazon\s+web\s+services)\b/i,                 domains: ['docs.aws.amazon.com', 'aws.amazon.com'] },
  { match: /\b(gcp|google\s+cloud)\b/i,                          domains: ['cloud.google.com', 'developers.google.com'] },
  { match: /\bazure\b/i,                                         domains: ['learn.microsoft.com', 'docs.microsoft.com', 'azure.microsoft.com'] },

  // ── Data warehouses + lakehouses ──
  { match: /\bsnowflake\b/i,                                     domains: ['docs.snowflake.com'] },
  { match: /\bdatabricks\b/i,                                    domains: ['docs.databricks.com', 'databricks.com'] },
  { match: /\bredshift\b/i,                                      domains: ['docs.aws.amazon.com'] },
  { match: /\bbig\s*query\b/i,                                   domains: ['cloud.google.com'] },
  { match: /\b(clickhouse|click\s+house)\b/i,                    domains: ['clickhouse.com'] },
  { match: /\bduck\s*db\b/i,                                     domains: ['duckdb.org'] },

  // ── Data orchestration / ELT ──
  { match: /\bdbt\b/i,                                           domains: ['docs.getdbt.com'] },
  { match: /\bairflow\b/i,                                       domains: ['airflow.apache.org'] },
  { match: /\bdagster\b/i,                                       domains: ['docs.dagster.io'] },
  { match: /\bprefect\b/i,                                       domains: ['docs.prefect.io'] },
  { match: /\bairbyte\b/i,                                       domains: ['docs.airbyte.com'] },

  // ── Streaming + processing ──
  { match: /\b(spark|pyspark)\b/i,                               domains: ['spark.apache.org'] },
  { match: /\bflink\b/i,                                         domains: ['flink.apache.org'] },
  { match: /\bkafka\b/i,                                         domains: ['kafka.apache.org'] },
  { match: /\bpulsar\b/i,                                        domains: ['pulsar.apache.org'] },

  // ── Databases ──
  { match: /\bpostgres(?:ql)?\b/i,                               domains: ['postgresql.org'] },
  { match: /\bmysql\b/i,                                         domains: ['dev.mysql.com', 'mysql.com'] },
  { match: /\bmongo\s*db\b/i,                                    domains: ['mongodb.com'] },
  { match: /\bcassandra\b/i,                                     domains: ['cassandra.apache.org'] },
  { match: /\bredis\b/i,                                         domains: ['redis.io'] },
  { match: /\belasticsearch\b/i,                                 domains: ['elastic.co'] },
  { match: /\bcockroach\s*db\b/i,                                domains: ['cockroachlabs.com'] },

  // ── ML / AI frameworks ──
  { match: /\btensorflow\b/i,                                    domains: ['tensorflow.org'] },
  { match: /\bpytorch\b/i,                                       domains: ['pytorch.org'] },
  { match: /\b(scikit\s*-?\s*learn|sklearn)\b/i,                 domains: ['scikit-learn.org'] },
  { match: /\bhugging\s*face\b/i,                                domains: ['huggingface.co'] },
  { match: /\blangchain\b/i,                                     domains: ['python.langchain.com', 'js.langchain.com', 'docs.langchain.com'] },
  { match: /\bllama\s*index\b/i,                                 domains: ['docs.llamaindex.ai'] },
  { match: /\bmlflow\b/i,                                        domains: ['mlflow.org'] },
  { match: /\b(weights\s+(?:and|&)\s+biases|wandb)\b/i,          domains: ['docs.wandb.ai'] },
  { match: /\bkubeflow\b/i,                                      domains: ['kubeflow.org'] },
  { match: /\bjax\b/i,                                           domains: ['jax.readthedocs.io'] },

  // ── Data libraries ──
  { match: /\bpandas\b/i,                                        domains: ['pandas.pydata.org'] },
  { match: /\bnumpy\b/i,                                         domains: ['numpy.org'] },
  { match: /\bpolars\b/i,                                        domains: ['pola.rs', 'docs.pola.rs'] },
  { match: /\bdask\b/i,                                          domains: ['docs.dask.org'] },
  { match: /\bmatplotlib\b/i,                                    domains: ['matplotlib.org'] },
  { match: /\bseaborn\b/i,                                       domains: ['seaborn.pydata.org'] },
  { match: /\bplotly\b/i,                                        domains: ['plotly.com'] },
  { match: /\bstreamlit\b/i,                                     domains: ['docs.streamlit.io'] },

  // ── Web frameworks ──
  { match: /\bnext\.?js\b/i,                                     domains: ['nextjs.org'] },
  { match: /\bnuxt\b/i,                                          domains: ['nuxt.com'] },
  { match: /\bremix\b/i,                                         domains: ['remix.run'] },
  { match: /\b(reactjs|react\.dev|^react\b|\sreact\b)\b/i,       domains: ['react.dev', 'reactjs.org'] },
  { match: /\bvue(?:\.?js)?\b/i,                                 domains: ['vuejs.org'] },
  { match: /\bangular\b/i,                                       domains: ['angular.dev', 'angular.io'] },
  { match: /\bsvelte(?:\s*kit)?\b/i,                             domains: ['svelte.dev'] },
  { match: /\bdjango\b/i,                                        domains: ['docs.djangoproject.com'] },
  { match: /\bfastapi\b/i,                                       domains: ['fastapi.tiangolo.com'] },
  { match: /\bflask\b/i,                                         domains: ['flask.palletsprojects.com'] },
  { match: /\bspring\s+boot\b/i,                                 domains: ['spring.io', 'docs.spring.io'] },
  { match: /\brails\b/i,                                         domains: ['guides.rubyonrails.org'] },

  // ── Runtimes / languages with version-specific behavior ──
  { match: /\bpython\s*3\.\d/i,                                  domains: ['docs.python.org'] },
  { match: /\bnode\.?js\b/i,                                     domains: ['nodejs.org'] },
  { match: /\bdeno\b/i,                                          domains: ['deno.land', 'docs.deno.com'] },
  { match: /\bbun\b/i,                                           domains: ['bun.sh'] },

  // ── DevOps / infra ──
  { match: /\bdocker\b/i,                                        domains: ['docs.docker.com'] },
  { match: /\b(kubernetes|k8s)\b/i,                              domains: ['kubernetes.io'] },
  { match: /\bterraform\b/i,                                     domains: ['developer.hashicorp.com', 'registry.terraform.io'] },
  { match: /\bansible\b/i,                                       domains: ['docs.ansible.com'] },
  { match: /\bhelm\b/i,                                          domains: ['helm.sh'] },
  { match: /\bargo\s*cd\b/i,                                     domains: ['argo-cd.readthedocs.io'] },
  { match: /\bgithub\s+actions\b/i,                              domains: ['docs.github.com'] },

  // ── Observability ──
  { match: /\bdatadog\b/i,                                       domains: ['docs.datadoghq.com'] },
  { match: /\bnew\s+relic\b/i,                                   domains: ['docs.newrelic.com'] },
  { match: /\bprometheus\b/i,                                    domains: ['prometheus.io'] },
  { match: /\bgrafana\b/i,                                       domains: ['grafana.com'] },
  { match: /\bopentelemetry\b/i,                                 domains: ['opentelemetry.io'] },
];

// Returns the authority domains for the most-specific tool match, or
// null when no entry in the map matches. Iteration order matters when
// multiple entries could match (e.g. "AWS Redshift" matches both AWS
// generic and Redshift specific) — Redshift is later in the list and
// not specifically prioritized, but we walk top-down and return the
// first match. AWS is listed first so it wins for "what is AWS X" type
// questions; if you want Redshift-specific docs to win, the question
// usually contains "Redshift" without "AWS", and the redshift entry's
// match still hits.
function detectAuthorityDomains(transcript) {
  const text = String(transcript || '');
  for (const entry of ENTITY_AUTHORITY) {
    if (entry.match.test(text)) return entry.domains;
  }
  return null;
}

// Classify the transcript. Returns true ONLY when fresh-context retrieval
// is genuinely worth firing — false otherwise. Saves Brave queries on
// the long tail of "tell me about X" / "explain Y" / "how does Z work"
// conceptual questions where the model already knows the answer cold.
//
// Two paths to true:
//   1. UPDATE_SIGNALS match alone — anything mentioning latest / new /
//      deprecated, regardless of whether we identified a specific tool.
//   2. TOOL_PATTERNS + SPECIFICITY_PATTERNS together — a known tool is
//      named AND the question shape is asking about UI/API/config
//      specifics that change over time.
//
// Tool-only matches WITHOUT specificity return false:
//   - "tell me about Apache Spark" — model knows Spark conceptually
//   - "explain Postgres MVCC" — stable concept, model has it
//   - "walk me through dbt project structure" — conceptual / stable
function classify(transcript) {
  const text = String(transcript || '');
  if (text.length < 5) return false;  // Too short to be a real question

  // Path 1: strong update signals fire alone.
  for (const p of UPDATE_SIGNALS) if (p.test(text)) return true;

  // Path 2: tool match required, AND a specificity signal must also be present.
  const hasTool = TOOL_PATTERNS.some(p => p.test(text));
  if (!hasTool) return false;
  return SPECIFICITY_PATTERNS.some(p => p.test(text));
}

// Build a search query from the transcript. Brave handles natural-language
// queries well, so MVP just normalizes whitespace and caps length. Adding
// targeted entity extraction is a future optimization if quality is poor.
function buildQuery(transcript) {
  return String(transcript || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Format search results + optional deep-fetched page content into a
// FRESH_CONTEXT block. The block has up to two sections:
//
//   1. DEEP SOURCE — when deepContent is present, this is ~3000 chars
//      of clean main text from the top authority result. Gives the
//      model rich raw material (paragraphs, lists, specifics) instead
//      of just the 200-300 char Brave snippet.
//   2. ADDITIONAL SNIPPETS — top 3 Brave results with title + snippet.
//      Gives breadth across multiple sources even when one is deep.
//
// When deepContent is absent (older callers, or deep-fetch failed),
// the block falls back to snippets-only — graceful degradation, same
// shape the model already learned to handle.
function formatContext(results, deepContent) {
  const haveResults = results && results.length > 0;
  const haveDeep = !!(deepContent && deepContent.text);
  if (!haveResults && !haveDeep) return null;

  const parts = [];

  if (haveDeep) {
    const title = String(deepContent.title || '').slice(0, 200);
    parts.push(`DEEP SOURCE — extracted from ${title || 'top result'} today:\n${deepContent.text}`);
  }

  if (haveResults) {
    const blocks = results.slice(0, 3).map((r, i) => {
      const title = String(r.title || '').slice(0, 200);
      const desc = String(r.description || '').slice(0, 500);
      const url = String(r.url || '');
      return `[${i + 1}] ${title}\n${desc}${url ? `\n(${url})` : ''}`;
    });
    parts.push(haveDeep ? `ADDITIONAL SNIPPETS:\n${blocks.join('\n\n')}` : blocks.join('\n\n'));
  }

  return `<FRESH_CONTEXT>
Today's snapshot from authoritative sources. Treat as your refreshed memory — internalize and speak naturally as a candidate who has used this tool recently. Do NOT cite "according to source 1" or quote URLs in your answer. The candidate voice is broken when sources are visible.

${parts.join('\n\n')}
</FRESH_CONTEXT>`;
}

// Re-rank search results by authority. If the transcript names a tool
// with known canonical docs, results from those domains float to the
// top — preserving Brave's relative ordering within each group (stable
// partition). When no authority match exists, the original Brave
// ranking is returned unchanged.
//
// Why this matters: Brave's general-web ranking sometimes promotes
// SEO blog posts over docs.aws.amazon.com for AWS questions. This
// re-rank ensures the canonical source wins when one exists.
function rerankByAuthority(results, authorityDomains) {
  if (!authorityDomains || !Array.isArray(results) || results.length < 2) {
    return results;
  }
  const lowerDomains = authorityDomains.map(d => d.toLowerCase());
  const isAuth = (r) => {
    const u = String(r?.url || '').toLowerCase();
    return lowerDomains.some(d => u.includes(d));
  };
  const auth = results.filter(isAuth);
  const rest = results.filter(r => !isAuth(r));
  // If everything (or nothing) is authority, no shuffle needed.
  if (auth.length === 0 || rest.length === 0) return results;
  return [...auth, ...rest];
}

// Main entry point. Always async because retrieval IS async — even cache
// hits go through searchWithCache + fetchPageContentWithCache. Returns
// null when the classifier negative-matches OR there's nothing to inject.
//
// Returns { context, sources, cached, stale, authority, deepFetch } on
// success. `deepFetch` describes the top page that was fetched (or null
// when deep-fetch was disabled / failed / had no URL to fetch).
//
// Pipeline:
//   1. classify() — fast regex check, bypass if not tool-specific
//   2. searchWithCache() — Brave search, cached 24h
//   3. rerankByAuthority() — push canonical docs to the top
//   4. fetchPageContentWithCache() — extract main content from top URL,
//      cached 7 days. Skipped when options.deepFetch === false.
//   5. formatContext() — render DEEP SOURCE + snippets block
//
// Latency budget on cold paths: ~500ms (Brave) + ~700ms (page fetch) =
// ~1.2s total. On warm paths (both caches hit): ~10ms.
async function enrichTranscript(transcript, options = {}) {
  if (!classify(transcript)) return null;

  const query = buildQuery(transcript);
  const result = await searchWithCache(query, options);

  if (!result.results || result.results.length === 0) return null;

  // Authority re-ranking step — push canonical-docs results to the top
  // BEFORE deep-fetch picks the top URL to extract.
  const authorityDomains = detectAuthorityDomains(transcript);
  const ranked = rerankByAuthority(result.results, authorityDomains);

  // Deep-fetch the top result's page content. Skipped when:
  //   - options.deepFetch === false (caller opt-out, e.g. tests)
  //   - top result has no URL
  //   - fetch fails AND no stale cache (graceful degradation —
  //     formatContext still renders snippets-only)
  let deepContent = null;
  let deepFetchInfo = null;
  if (options.deepFetch !== false && ranked.length > 0) {
    const topUrl = ranked[0]?.url;
    if (topUrl) {
      const pageResult = await fetchPageContentWithCache(topUrl, options);
      if (pageResult.ok && pageResult.text) {
        deepContent = {
          url: topUrl,
          title: ranked[0].title,
          text: pageResult.text,
        };
        deepFetchInfo = {
          url: topUrl,
          cached: !!pageResult.cached,
          stale: !!pageResult.stale,
          contentLength: pageResult.text.length,
        };
      } else if (pageResult.error) {
        deepFetchInfo = { url: topUrl, error: pageResult.error, contentLength: 0 };
      }
    }
  }

  const context = formatContext(ranked, deepContent);
  if (!context) return null;

  return {
    context,
    sources: ranked.slice(0, 3).map(r => r.url).filter(Boolean),
    cached: !!result.cached,
    stale: !!result.stale,
    skipped: result.skipped || null,
    authority: authorityDomains ? authorityDomains[0] : null,
    deepFetch: deepFetchInfo,
  };
}

module.exports = {
  enrichTranscript,
  classify,
  buildQuery,
  formatContext,
  detectAuthorityDomains,
  // Internals exposed for testing
  _test: { TOOL_PATTERNS, SPECIFICITY_PATTERNS, UPDATE_SIGNALS, ENTITY_AUTHORITY, rerankByAuthority },
};
