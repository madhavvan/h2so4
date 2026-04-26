"""
End-to-end simulation of the Train Model pipeline.

Mirrors trainClaudeModel() in services/claudeService.ts:
  Stage 1 — Claude extracts tech keywords from resume + JD (no web search)
  Stage 2 — parallel web_search calls (concurrency 5) build tech-state lines
  Stage 3 — aggregate into the cached card

Reports per-keyword timing, total wall-clock, and prints the final card so we
can eyeball quality before the user hits the button in the running app.
"""

import os
import re
import sys
import time
import json
import asyncio
from anthropic import AsyncAnthropic

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ── Load API key ─────────────────────────────────────────────
ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "server", ".env")
api_key = None
with open(ENV_PATH, "r", encoding="utf-8") as f:
    for line in f:
        if line.startswith("ANTHROPIC_API_KEY="):
            api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
if not api_key:
    sys.exit("ANTHROPIC_API_KEY not found in server/.env")

client = AsyncAnthropic(api_key=api_key)

# ── Sample resume + JD (mirrors a real Venu-shaped profile) ──
SAMPLE_RESUME = """
Pentala Venu Madhav
Senior Data Engineer / Software Engineer

EXPERIENCE
G-Tech Services, Indianapolis (2024-2025)
- Built CDC pipelines from PostgreSQL 14 to Databricks lakehouse using Debezium + Kafka
- Migrated batch ETL jobs from Apache Airflow 1.x to Airflow 2.7 on AWS MWAA
- Authored PySpark 3.3 jobs on Databricks runtime 11.x for healthcare claims data
- Implemented near-real-time fraud detection on Apache Kafka with consumer groups + KSQL

Indiana University, Indianapolis (2023-2025) - MS Health Informatics
- Capstone: streaming patient-vitals pipeline using Apache Kafka, Flink 1.16, PostgreSQL
- Coursework in Apache Spark, Hadoop, Snowflake, dbt

SKILLS
Python, PySpark, Apache Airflow, Apache Kafka, PostgreSQL, MongoDB,
AWS Lambda, AWS S3, AWS Glue, Snowflake, Databricks, Docker, Kubernetes,
Terraform, dbt, Apache Iceberg, Delta Lake, Spark Streaming
"""

SAMPLE_JD = """
Senior Data Engineer — JPMorgan Chase, NYC

We're hiring a Senior Data Engineer to build the next generation of our real-time
fraud detection platform.

REQUIREMENTS
- 4+ years building production data pipelines at scale
- Strong PySpark / Apache Spark experience (Spark 3.x or 4.x)
- Apache Kafka in production — exactly-once semantics, schema registry, KSQL
- Modern lakehouse architectures: Apache Iceberg, Delta Lake, or Apache Hudi
- AWS or GCP — Lambda, S3, EMR, or equivalent GCP services
- Workflow orchestration: Apache Airflow 2.x preferred
- PostgreSQL, distributed transactions, CDC patterns (Debezium)
- dbt, Snowflake, or BigQuery for the analytical layer

NICE TO HAVE
- Apache Flink for streaming workloads
- Kubernetes for pipeline orchestration
- Terraform for infrastructure as code
"""

# ── Mirror the prompts in services/claudeService.ts ──────────
TODAY = time.strftime("%Y-%m-%d")


def sanitize(tech: str, raw: str):
    s = re.sub(r"\s+", " ", raw.replace("*", "")).strip()
    matches = list(re.finditer(re.escape(tech) + r"\s*:", s, re.IGNORECASE))
    if not matches:
        return f"{tech}: {s}"[:800]
    last = matches[-1]
    out = s[last.start():].split(" --- ")[0].strip()
    return out[:800]


async def extract_keywords(resume: str, jd: str):
    prompt = f"""Extract the 15 most relevant specific technologies, frameworks, libraries, platforms, databases, cloud services, or DevOps tools mentioned in the RESUME and JOB DESCRIPTION below.

Return ONLY a JSON array of strings. No commentary. No markdown fences. Prioritize tools that appear in BOTH resume and JD.

Use canonical names (e.g. "PySpark", "PostgreSQL", "Apache Airflow", "AWS Lambda", "Kubernetes"). Do NOT include generic terms like "SQL", "REST API", "Python" alone.

RESUME:
{resume}

JOB DESCRIPTION:
{jd}

Output ONLY the JSON array of 15 items."""
    res = await client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
    )
    text = "".join(b.text for b in res.content if b.type == "text").strip()
    m = re.search(r"\[[\s\S]*?\]", text)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
        return [s.strip() for s in arr if isinstance(s, str) and s.strip()][:15]
    except Exception:
        return []


async def research_one(tech: str, sem: asyncio.Semaphore):
    """Research one tech with web_search + 1 retry on failure."""
    async with sem:
        prompt = f'''You are a research assistant. Output ONLY a factsheet line, nothing else. No preamble. No "Based on..." / "Here is..." / "Let me...". No markdown. No bullets.

Use web_search ONCE to verify the latest version of {tech} as of {TODAY}.

Output exactly this format on ONE line:
{tech}: latest stable version is X (date if known). <one notable recent change in the last ~12 months>. <pricing or "pricing n/a">. Gotcha: <one specific issue experienced engineers hit>.

If search fails, output: {tech}: research failed.

START THE RESPONSE WITH "{tech}:" — no other prefix.'''
        t_start = time.time()
        for attempt in range(2):
            try:
                res = await client.messages.create(
                    model="claude-sonnet-4-6",
                    max_tokens=400,
                    messages=[{"role": "user", "content": prompt}],
                    tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 1}],
                    temperature=0.5,
                )
                text = "".join(b.text for b in res.content if b.type == "text").strip()
                cleaned = sanitize(tech, text)
                if not cleaned or "research failed" in cleaned.lower():
                    if attempt == 0:
                        await asyncio.sleep(2.5)
                        continue
                    return tech, f"{tech}: (failed)", time.time() - t_start, False
                return tech, cleaned, time.time() - t_start, True
            except Exception as e:
                if attempt == 0:
                    await asyncio.sleep(2.5)
                    continue
                return tech, f"{tech}: (failed — {e})", time.time() - t_start, False
        return tech, f"{tech}: (failed)", time.time() - t_start, False


async def main():
    print(f"=== TRAIN-MODEL SIMULATION — {TODAY} ===")
    print(f"Sample resume: ~{len(SAMPLE_RESUME)} chars")
    print(f"Sample JD:     ~{len(SAMPLE_JD)} chars")
    print("=" * 60)

    # Stage 1
    t0 = time.time()
    print("\n[Stage 1] Extracting tech keywords (no web search)...")
    sys.stdout.flush()
    keywords = await extract_keywords(SAMPLE_RESUME, SAMPLE_JD)
    s1 = time.time() - t0
    print(f"  → {len(keywords)} keywords extracted in {s1:.2f}s")
    print(f"  → Keywords: {', '.join(keywords)}")
    sys.stdout.flush()

    if not keywords:
        sys.exit("No keywords extracted — aborting.")

    # Stage 2 — parallel research (concurrency 2 — Anthropic web_search
    # rate-limits aggressively under burst; 2 workers stay clean).
    print(f"\n[Stage 2] Researching {len(keywords)} technologies (concurrency=2, web_search ON, max_uses=1, retry=1)...")
    sys.stdout.flush()
    sem = asyncio.Semaphore(2)
    t1 = time.time()
    results = await asyncio.gather(*(research_one(k, sem) for k in keywords))
    s2 = time.time() - t1

    successes = [r for r in results if r[3]]
    failures = [r for r in results if not r[3]]

    print(f"  → {len(successes)}/{len(keywords)} succeeded in {s2:.2f}s wall-clock")
    if failures:
        print(f"  → {len(failures)} failed:")
        for tech, _, _, _ in failures:
            print(f"      - {tech}")
    print("  → Per-tech latencies:")
    for tech, _, elapsed, ok in sorted(results, key=lambda r: r[2]):
        marker = "✓" if ok else "✗"
        print(f"      {marker} {tech:<25} {elapsed:.2f}s")
    sys.stdout.flush()

    # Stage 3 — aggregate
    print(f"\n[Stage 3] Aggregating into tech-state card...")
    sys.stdout.flush()
    cards = [r[1] for r in successes]
    final_card = (
        f"=== CURRENT TECH STATE (researched {TODAY}) ===\n"
        "Fresh, web-researched intel on the technologies in your resume + JD. "
        "Use these CURRENT facts when answering — they override your training data. "
        "Stay silent about how you know — these are things you've \"been keeping up with\".\n\n"
        + "\n".join(cards)
    )

    print(f"  → Card length: {len(final_card)} chars")
    print(f"\n--- FINAL TECH-STATE CARD (would be cached + injected into system prompt) ---")
    print(final_card)
    print(f"--- END CARD ---")

    total = time.time() - t0
    print(f"\n=== SUMMARY ===")
    print(f"  Total wall-clock: {total:.1f}s")
    print(f"  Stage 1 (extract):  {s1:.2f}s")
    print(f"  Stage 2 (research): {s2:.2f}s ({len(successes)}/{len(keywords)})")
    print(f"  Stage 3 (assemble): instant")
    print(f"  Card size: {len(final_card)} chars")
    if successes:
        avg_per = sum(r[2] for r in successes) / len(successes)
        print(f"  Avg per-tech (sequential equivalent): {avg_per:.2f}s")
        print(f"  Speedup from parallelism (5 workers): {(avg_per * len(keywords)) / s2:.1f}x")


if __name__ == "__main__":
    asyncio.run(main())
