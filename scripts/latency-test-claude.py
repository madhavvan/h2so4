"""
Latency + behavior test for the Claude path.

Hits Anthropic directly with a system prompt that mirrors what claudeService.ts
ships (minus the full persona/resume bulk — uses a representative shorter persona
so we measure CHANGE between question types, not the absolute prompt floor).

Reports: time-to-first-token, full-completion time, whether web_search fired,
and the first sentence of the answer. One row per question.
"""

import os
import re
import sys
import time
from anthropic import Anthropic

# Windows console default cp1252 chokes on arrows / em-dashes; force UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ── Load API key from server/.env ────────────────────────────
ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "server", ".env")
api_key = None
with open(ENV_PATH, "r", encoding="utf-8") as f:
    for line in f:
        if line.startswith("ANTHROPIC_API_KEY="):
            api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
if not api_key:
    sys.exit("ANTHROPIC_API_KEY not found in server/.env")

client = Anthropic(api_key=api_key)

# ── Mirror the prompt structure shipped in claudeService.ts ──
TODAY = time.strftime("%Y-%m-%d")

WEB_SEARCH_INSTRUCTIONS = """
=== WEB SEARCH (silent — interviewer never sees it) ===

SEARCH IMMEDIATELY (before drafting your answer) when the question contains ANY of these signals:
- A version question: "what version", "current version", "latest version", "which version", "what's X at now"
- A present-tense anchor: "now", "currently", "today", "right now", "these days", "recently", "as of"
- A price / number / statistic question: "how much does X cost", "how many", "what's the latency / throughput / pricing of"
- A "what's new in X" / "what did X release" / "is X out yet" question
- A current-options comparison: "X vs Y in 2026", "right now what's better", "which is the standard now"

When the question has BOTH past and present parts (e.g. "what version were you using, and what is it now?"):
- Answer the past from your own context (resume / experience).
- SEARCH the present part — do not guess. Do not hedge with "I think" on a current version.
- Stitch into one natural sentence: "Back then we were on X. Right now it's around Y."

DO NOT search for:
- Behavioral questions ("tell me about a time")
- Pure conceptual fundamentals (theory, definitions, big-O, CAP)
- Questions about your own resume / past projects (answer from context)
- Pure design / architecture questions ("how would you design X")
- Opinions on approaches you have lived experience with

MAXIMUM 1 search per question. After one search call, commit to the answer.

Weave findings naturally — never narrate the search:
- "Right now it's around v3.5, give or take a patch"
- "Last I checked, ~$0.20 per million calls"
- "Currently most teams are on X..."

NEVER say: "I searched", "let me check", "according to", "based on the search results", "as of my knowledge cutoff", "I read that".
"""

DEPTH_LAYER = f"""
=== CLAUDE OVERRIDES ===

Today is {TODAY}.

ANSWER EVERY input — including "okay", "mm", "right", "got it", "yeah". For acknowledgments, give a brief 1-2 sentence elaboration of the previous turn. NEVER output "..." or "Listening..." — that rule is OFF for Claude only.

If the interviewer anchors to a past time ("back in 2020", "at your last job"), answer in that era's stack — not today's.
"""

# Representative candidate persona — kept short so the test isolates per-question
# behavior change, not absolute floor latency. Real app prompt is ~3-4x larger.
PERSONA = """
You are the candidate in a live interview. You are NOT an AI assistant — you are this person, answering in real time.

=== WHO YOU ARE ===
Senior data/software engineer, 4+ years experience. MS in Health Informatics from Indiana University (2025). Hands-on with Python, PySpark, Airflow, Kafka, Postgres, AWS, Databricks. Past projects at Indiana University and a contract role at G-Tech Services involving healthcare data pipelines, ETL on Spark, CDC into a lakehouse.

=== VOICE ===
20+ years hands-on engineer voice. Opinion or recalled specific FIRST. War stories beat definitions. Specific tools + versions ("Postgres 14" not "a database"). Engineer slang ok ("bit me", "footgun", "the gotcha is"). 1-2 substantive points, not 7 bullets. Hedge intelligently. No preamble, no "great question".

=== KNOWLEDGE BOUNDARIES ===
Don't fabricate specific numbers, outages, or projects not in the context above. Hedge honestly when thin: "haven't gone deep on that — closest I've done is X."
"""

NOISE_GATE = """
=== NOISE GATE ===
If the input is silence, background noise, or meaningless acknowledgments ("mm", "okay", "right", "got it"), output EXACTLY: ...
Otherwise answer.
"""

OUTPUT_RULE = """
Output format: emit ONLY the answer text. No preamble, no "Here's my response:", no reasoning, no meta.
"""

# Build full system prompt — Claude overrides are LAST so they win against the
# noise gate (per the "highest priority" framing).
SYSTEM_PROMPT = (
    PERSONA + NOISE_GATE + WEB_SEARCH_INSTRUCTIONS + DEPTH_LAYER + OUTPUT_RULE
)

# ── Test questions ───────────────────────────────────────────
QUESTIONS = [
    # No search expected — fast target (~2-3s)
    ("NO-SEARCH",   "Tell me about a time you debugged a tough production bug."),
    ("NO-SEARCH",   "What's CAP theorem in plain language?"),
    ("NO-SEARCH",   "How would you design a URL shortener for 100M users?"),
    ("NOISE-GATE",  "okay"),
    ("NOISE-GATE",  "right"),
    # Search expected — slower target (~6-10s)
    ("SEARCH",      "what's the pyspark version you were using and now?"),
    ("SEARCH",      "What's the latest stable version of PostgreSQL right now?"),
    ("SEARCH",      "How much does AWS Lambda cost per million invocations these days?"),
    ("SEARCH",      "Iceberg vs Delta Lake vs Hudi in 2026 — which is the standard now?"),
]


def run_one(category: str, question: str):
    """Stream one question, measure latency, detect search use."""
    print(f"\n[{category}] Q: {question}")
    sys.stdout.flush()

    start = time.time()
    first_token_at = None
    search_fired = False
    full_text_parts = []

    with client.messages.stream(
        model="claude-sonnet-4-6",
        max_tokens=4000,
        system=[{
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": question}],
        tools=[{
            "type": "web_search_20260209",
            "name": "web_search",
            "max_uses": 2,
        }],
        temperature=0.7,
    ) as stream:
        for event in stream:
            t = event.type
            if t == "content_block_start":
                block = getattr(event, "content_block", None)
                if block and getattr(block, "type", None) == "server_tool_use":
                    if getattr(block, "name", None) == "web_search":
                        search_fired = True
            elif t == "content_block_delta":
                delta = getattr(event, "delta", None)
                if delta and getattr(delta, "type", None) == "text_delta":
                    if first_token_at is None:
                        first_token_at = time.time()
                    full_text_parts.append(delta.text)

    end = time.time()
    full_text = "".join(full_text_parts).strip()
    first_sentence = re.split(r"(?<=[.!?])\s", full_text, maxsplit=1)[0][:280]

    ttft = (first_token_at - start) if first_token_at else None
    total = end - start

    ttft_s = f"{ttft:.2f}s" if ttft is not None else "(no text)"
    print(f"  → time-to-first-token: {ttft_s}")
    print(f"  → total:               {total:.2f}s")
    print(f"  → search fired:        {'YES' if search_fired else 'no'}")
    print(f"  → first sentence:      {first_sentence!r}")
    sys.stdout.flush()
    return {
        "category": category,
        "question": question,
        "ttft": ttft,
        "total": total,
        "search": search_fired,
        "first_sentence": first_sentence,
    }


def main():
    print(f"=== LATENCY TEST — {TODAY} ===")
    print(f"Model: claude-sonnet-4-6")
    print(f"Tool: web_search_20260209 (max_uses=2)")
    print(f"System prompt size: {len(SYSTEM_PROMPT)} chars")
    print(f"=" * 60)

    # Prime the cache so the first measured call isn't a cache miss.
    print("\n[priming cache — not measured]")
    sys.stdout.flush()
    run_one("PRIME", "what is a hash table")

    results = []
    for category, q in QUESTIONS:
        results.append(run_one(category, q))

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"{'Cat':<11} {'TTFT':>6} {'Total':>7} {'Search':>7}  Question")
    print("-" * 60)
    for r in results:
        ttft = f"{r['ttft']:.1f}s" if r["ttft"] is not None else "—"
        print(f"{r['category']:<11} {ttft:>6} {r['total']:>6.1f}s {('YES' if r['search'] else 'no'):>7}  {r['question'][:50]}")

    # Verdict
    print("\nVERDICT:")
    no_search_avg_ttft = [r["ttft"] for r in results if r["category"] == "NO-SEARCH" and r["ttft"]]
    search_avg_ttft = [r["ttft"] for r in results if r["category"] == "SEARCH" and r["ttft"]]
    if no_search_avg_ttft:
        print(f"  No-search TTFT: avg {sum(no_search_avg_ttft)/len(no_search_avg_ttft):.2f}s (target ≤3s)")
    if search_avg_ttft:
        print(f"  Search TTFT:    avg {sum(search_avg_ttft)/len(search_avg_ttft):.2f}s (target ≤8s)")
    wrong_search = [r for r in results if r["category"] == "SEARCH" and not r["search"]]
    spurious_search = [r for r in results if r["category"] == "NO-SEARCH" and r["search"]]
    if wrong_search:
        print(f"  ⚠ {len(wrong_search)} SEARCH question(s) did NOT search:")
        for r in wrong_search:
            print(f"      - {r['question']}")
    if spurious_search:
        print(f"  ⚠ {len(spurious_search)} NO-SEARCH question(s) searched anyway:")
        for r in spurious_search:
            print(f"      - {r['question']}")
    noise_responses = [r for r in results if r["category"] == "NOISE-GATE"]
    silent = [r for r in noise_responses if r["first_sentence"].strip() in ("...", "")]
    if silent:
        print(f"  ⚠ {len(silent)} NOISE-GATE question(s) returned silence:")
        for r in silent:
            print(f"      - {r['question']!r}")


if __name__ == "__main__":
    main()
