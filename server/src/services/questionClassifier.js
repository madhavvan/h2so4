// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  QUESTION CLASSIFIER — categorize the candidate's incoming transcript
//
//  Used by:
//    1. Auto reasoning_effort selection — coding gets 'low', system
//       design gets 'medium', behavioral/clarifier get 'none'.
//    2. (Future) Auto model routing.
//
//  Priority order is the key design decision:
//    BEHAVIORAL (framing) → ML_DATA → CODING → SYSTEM_DESIGN
//    → STRATEGY_CASE → QUANTITATIVE → CONCEPT → CLARIFIER → OTHER.
//
//  Why this order:
//    - BEHAVIORAL framing wins always ("tell me about a time you used
//      Spark" is behavioral, not data).
//    - ML/data BEFORE system design: "build a fraud detection model"
//      and "build a search ranking system" are ML, even though the
//      latter mentions "system".
//    - CODING before system design: "implement a search algorithm" is
//      a code question.
//    - CONCEPT before CLARIFIER: "what is a hashmap?" is a concept
//      question, not a clarifier (even though it's short + interrogative).
//    - CLARIFIER last: short interrogative fallback only when nothing
//      else matched.
//
//  Pure regex — fast, deterministic, no LLM cost.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Behavioral ──
// Strongest framing signals — STAR-L territory. Always wins.
const BEHAVIORAL_PATTERNS = [
  /\btell me about a time\b/i,
  /\bdescribe a (situation|time|case|scenario|conflict|disagreement)\b/i,
  /\bwalk me through a (project|time|situation)\b/i,
  /\bgive me an example of\b/i,
  /\bhow (do|did) you (handle|deal with|resolve|navigate|approach)\s+(a|an|conflict|difficult|disagreement|deadline)\b/i,
  /\b(your|a) (biggest|hardest|toughest|most challenging) (challenge|project|deadline|conflict)\b/i,
  /\bwhat are your (strengths|weaknesses)\b/i,
  /\bwhy do you want\b/i,
  /\btell me about yourself\b/i,
  /\b(your|a) (proudest|most rewarding) (project|achievement|moment)\b/i,
  /\bhave you ever\b/i,
  // "Walk me through your background" is the opening question of most
  // interviews and it was landing on CLARIFIER — it is 77 characters, so
  // the short-interrogative fallback caught it before anything else did.
  /\bwalk me through your (background|experience|resume|cv|career|journey|work)\b/i,
  /\btell me about your (background|experience|career|journey)\b/i,
  // "What is a technical decision you made that turned out to be wrong?"
  // was classified CONCEPT, by the "what is a…" definition pattern.
  /\bwhat (is|was) (a|the|your) (technical |engineering |design )?(decision|call|choice|mistake|failure|regret)\b/i,
  /\b(decision|call|choice|bet) (you|i) made that (turned out|was|went|did ?n.t)\b/i,
];

// ── ML / data ──
// Specific tech keywords. Listed before SYSTEM_DESIGN so "build a model"
// and "search ranking system" land here even with "system" in the text.
const ML_DATA_PATTERNS = [
  /\b(machine learning|ml model|train(ing)? (a |the )?(model|classifier|neural))\b/i,
  /\b(neural network|deep learning|cnn|rnn|lstm|transformer|attention)\b/i,
  /\b(fraud detection|recommend(er|ation)|search ranking|classifier|regression model|anomaly detection)\b/i,
  /\b(feature (engineering|store)|data (pipeline|warehouse|lake|lakehouse)|etl|elt|airflow|dbt)\b/i,
  /\bbuild (a |an |the )?spark\b/i,
  /\bA\/B test(ing)?\b/i,
  /\bcohort (analysis|retention)\b/i,
  /\b(precision|recall|f1|auc|roc|confusion matrix)\b/i,
  /\bhow would you (build|train|evaluate|deploy) (a |the )?(model|classifier|recommender|pipeline|search ranking|fraud detection|data pipeline)\b/i,

  // ── Named data-platform technology ──
  // The list above only recognised a data question by the words "data
  // pipeline", "etl", "airflow", "dbt", or the phrase "build a spark".
  // So "you are ingesting from Kafka into Snowflake and downstream
  // reports start showing duplicate rows right after a deploy" — a
  // senior data-engineering question in the exact words an interviewer
  // uses — matched NOTHING and fell through to `other`, which means
  // auto-effort gave it no reasoning at all and the cover gave it the
  // shortest opener. Naming the platform is signal enough on its own;
  // the verb is not the thing that makes it a data question.
  /\b(kafka|snowflake|spark|pyspark|flink|databricks|redshift|big\s*query|kinesis|iceberg|delta lake|hudi|presto|trino|clickhouse|dagster|prefect|fivetran|airbyte|debezium|athena|glue|emr|synapse)\b/i,
  /\b(cdc|change data capture|backfill(ing|s)?|upsert|merge into|slowly changing dimension|scd\d?|partition(ing|ed| key| pruning)|schema (evolution|drift|registry)|columnar|parquet|avro)\b/i,

  // ── The shape of a data incident ──
  // Something that used to work is now slow, or the numbers are wrong.
  // Half of what a data engineer is actually interviewed on, and none of
  // it was here.
  /\b(used to (run|take|complete|finish)|now takes|got (slower|slow)|\d+x slower|regress(ed|ion)|degrad(ed|ation|ing))\b/i,
  /\b(duplicate rows|row counts?|data quality|silent (row )?loss|reconcil(e|iation|ing)|stale data|numbers (are|look|were) (wrong|off)|dashboard is wrong)\b/i,
];

// ── Coding ──
// Action-verb-driven. The verb-then-target pattern uses a non-greedy
// gap to allow hyphenated and modifier words between (e.g.
// "find the first non-repeating character" — `non-repeating` breaks
// \w+ on its hyphen). Bare data-structure mentions alone are NOT coding
// (concept-shape can ask "what is a hashmap?").
const CODING_PATTERNS = [
  /\b(implement|write|code|build) (a |an )?(function|class|method|algorithm|program)\b/i,
  /\bgiven (an? |the )?(array|string|list|tree|graph|matrix|integer)\b/i,
  /\b(reverse|sort|find|search|merge|count|return)\b[^.?!]*?\b(array|list|string|tree|node|element|character|number|sum|max|min|substring|index|key|value|integer|digit|word)\b/i,
  /\b(time|space) complexity\b/i,
  /\bbig.?o (notation|of)\b/i,
  /\b(reverse a string|fibonacci|factorial|palindrome|anagram|missing number|move zer|longest substring|longest common|two sum|valid parentheses)\b/i,
  /\bsolve this (problem|leetcode)\b/i,
  /\bwrite a (sql )?query\b/i,
  /\bSQL (query|to find|that returns)\b/i,
  /\b(implement|build) (a |an )?(linked list|hash ?map|binary tree|binary search|trie|priority queue|graph)\b/i,
];

// ── System design ──
// Architecture / scaling / distributed-system shape.
const SYSTEM_DESIGN_PATTERNS = [
  /\b(design|build|create) (a|an) (rate limit|cache|url shortener|chat|messaging|notification|search engine|recommend|uber|twitter|instagram|tinder|whatsapp|payment|distributed|scalable|fault.?tolerant|database|queue|api gateway|load balancer|cdn|key.?value|object storage)/i,
  /\bsystem design\b/i,
  /\b(scal(e|ability|ing)|throughput|latency budget|p99|p95|sla|sli|slo|capacity planning)\b/i,
  /\b(microservice|monolith|event.?driven|cqrs|saga|sharding|replication|consistency|partition tolerance|cap theorem)\b/i,
  // NOTE: 'pipeline' is intentionally NOT in this exclusion — a "streaming
  // pipeline" / "ingestion pipeline" design question IS system design.
  // A "data pipeline" still routes to ML_DATA, which is checked first.
  /\bhow would you (design|build|create|architect) (a|an) (?!.*\b(model|classifier|recommender|fraud|neural|embedding)\b)/i,
  /\barchitect (a|an|the) (\w+\s+){0,3}(system|service|platform|application)\b/i,
  /\b(distributed|fault.?tolerant|highly available|high.?throughput) (system|service|architecture)\b/i,

  // ── Delivery and consistency semantics ──
  // The vocabulary of the hardest distributed-design questions, and none
  // of it was here. "How would you design exactly-once delivery into a
  // warehouse whose sink is not idempotent?" is about as canonical as a
  // hard data-infra design question gets, and it classified as `other`.
  /\b(exactly.?once|at.?least.?once|at.?most.?once|idempoten\w+|dedup\w*|back.?pressure|ordering guarantee|delivery (semantics|guarantee)|two.?phase commit|quorum|leader election)\b/i,

  // ── "How would you design X" where X has no article ──
  // The pattern above requires "(a|an)" IMMEDIATELY after the verb, so
  // every question about designing an uncountable noun — delivery,
  // ingestion, failover, consistency, access control, disaster recovery
  // — missed it entirely. Same ML exclusion as above, and deliberately
  // NOT extended to "approach": "how would you approach a difficult
  // conversation" is behavioral, not architecture.
  /\bhow would you (design|architect|structure)\b(?!.*\b(model|classifier|recommender|fraud|neural|embedding)\b)/i,
];

// ── Strategy / case interview ──
// `s?` allows plurals (profits, users) — common in real questions.
const STRATEGY_CASE_PATTERNS = [
  /\b(profit|revenue|conversion|retention|churn|engagement|user|dau|mau|wau)s?\s+(is|are|has|have|dropped|down|fell|spiked|up|grew)\b/i,
  /\bshould we (enter|launch|build|kill|pivot|acquire|expand)/i,
  /\bwhat (could|would|might) (be )?causing\b/i,
  /\bhow (would|do) you (prioritize|decide between|assess)/i,
  /\bbusiness case\b/i,
  /\bgo.?to.?market\b/i,
  /\b(market sizing|tam|sam|som)\b/i,
];

// ── Quantitative / estimation ──
const QUANTITATIVE_PATTERNS = [
  /\bestimate (the |how many)/i,
  /\bhow many (people|users|cars|piano|gas station|google|search)/i,
  /\bmarket siz(e|ing)\b/i,
  /\b(fermi|napkin) (estimate|math)\b/i,
  /\bwhat would you measure\b/i,
];

// ── Concept / definition ──
// "what is X" / "explain Y" / "how does X work" / "compare A and B".
const CONCEPT_PATTERNS = [
  /\bwhat (is|are) (a |an |the )?[a-z]/i,
  /\bexplain (what )?[a-z]/i,
  /\b(define|definition of)\b/i,
  /\b(difference|differences) between\b/i,
  /\b(compare|comparison) [a-z]+ (and|vs|versus|with) [a-z]/i,
  /\bhow does (a |an |the )?[\w\s\-]+? work\b/i,
  /\bwhy (is|are|does|do) (a |an |the )?[a-z]/i,
];

// ── Clarifier ──
// Short follow-up. Only fires if NOTHING else matched (last resort).
function isClarifier(text) {
  if (text.length > 80) return false;
  if (/\b(why|how|what|when|where|which|can|could|would)\b/i.test(text)) return true;
  return false;
}

const CATEGORIES = Object.freeze({
  CODING:         'coding',
  SYSTEM_DESIGN:  'system_design',
  ML_DATA:        'ml_data',
  BEHAVIORAL:     'behavioral',
  CONCEPT:        'concept',
  QUANTITATIVE:   'quantitative',
  STRATEGY_CASE:  'strategy_case',
  CLARIFIER:      'clarifier',
  OTHER:          'other',
});

function anyMatch(patterns, text) {
  for (const p of patterns) if (p.test(text)) return true;
  return false;
}

function classifyQuestion(transcript) {
  const text = String(transcript || '').trim();
  if (text.length === 0) return { category: CATEGORIES.OTHER, confidence: 'low' };

  if (anyMatch(BEHAVIORAL_PATTERNS, text))      return { category: CATEGORIES.BEHAVIORAL,    confidence: 'high' };
  if (anyMatch(ML_DATA_PATTERNS, text))         return { category: CATEGORIES.ML_DATA,       confidence: 'high' };
  if (anyMatch(CODING_PATTERNS, text))          return { category: CATEGORIES.CODING,        confidence: 'high' };
  if (anyMatch(SYSTEM_DESIGN_PATTERNS, text))   return { category: CATEGORIES.SYSTEM_DESIGN, confidence: 'high' };
  if (anyMatch(STRATEGY_CASE_PATTERNS, text))   return { category: CATEGORIES.STRATEGY_CASE, confidence: 'high' };
  if (anyMatch(QUANTITATIVE_PATTERNS, text))    return { category: CATEGORIES.QUANTITATIVE,  confidence: 'high' };
  if (anyMatch(CONCEPT_PATTERNS, text))         return { category: CATEGORIES.CONCEPT,       confidence: 'medium' };
  if (isClarifier(text))                        return { category: CATEGORIES.CLARIFIER,     confidence: 'medium' };
  return { category: CATEGORIES.OTHER, confidence: 'low' };
}

module.exports = {
  classifyQuestion,
  CATEGORIES,
  _test: {
    BEHAVIORAL_PATTERNS, CODING_PATTERNS, SYSTEM_DESIGN_PATTERNS,
    ML_DATA_PATTERNS, STRATEGY_CASE_PATTERNS, QUANTITATIVE_PATTERNS,
    CONCEPT_PATTERNS, isClarifier,
  },
};
