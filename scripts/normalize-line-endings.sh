#!/usr/bin/env bash
# One-time line-ending normalization for this repo.
#
# WHY THIS IS A SEPARATE COMMIT
# -----------------------------
# 18 tracked files are stored with CRLF in git while the rest are LF. Once
# .gitattributes declares `* text=auto eol=lf`, the next `git add` of any of
# those 18 rewrites every line of it. That is unavoidable — converting a
# mixed-ending repo to LF costs exactly one whole-file-rewrite commit.
#
# What you can control is WHICH commit pays it. Land your functional work
# first, then run this. Otherwise a 655-line change to electron/main.cjs
# arrives as a 7,500-line diff and nobody can review it.
#
# USAGE
#   1. Commit (or stash) your functional changes FIRST. This script refuses
#      to run if the tree is dirty, for exactly that reason.
#   2. bash scripts/normalize-line-endings.sh
#   3. Review, then commit the result on its own.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "ERROR: working tree has uncommitted changes."
  echo
  echo "Commit or stash them first. Mixing a renormalization with real edits is"
  echo "the exact problem this script exists to avoid — you would not be able to"
  echo "tell a whitespace rewrite from a logic change in the review."
  echo
  git status --short --untracked-files=no
  exit 1
fi

if [ ! -f .gitattributes ]; then
  echo "ERROR: .gitattributes is missing — it is what makes this stick."
  exit 1
fi

echo "Files currently stored with CRLF in the index:"
git ls-files --eol | grep 'i/crlf' | awk '{print "  " $4}' || echo "  (none — already normalized)"
echo

echo "Renormalizing..."
git add --renormalize .

echo
echo "Staged result:"
git diff --cached --stat | tail -20

cat <<'EOF'

Next:

  git commit -m "chore: normalize line endings to LF (no functional change)"

Then keep `git blame` readable by teaching it to skip this commit:

  git rev-parse HEAD >> .git-blame-ignore-revs
  git config blame.ignoreRevsFile .git-blame-ignore-revs
  git add .git-blame-ignore-revs
  git commit -m "chore: ignore the line-ending commit in git blame"

EOF
