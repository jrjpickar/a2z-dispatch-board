#!/usr/bin/env bash
# Netlify "ignore" check: exit 0 skips the build (no deploy, no credits),
# exit 1 builds. Skips only when a push changes nothing but docs, tests or
# Make blueprint samples. Anything else (or anything unclear) builds.
set -u
prev="${CACHED_COMMIT_REF:-}"; cur="${COMMIT_REF:-HEAD}"
# First deploy, manual "Trigger deploy", or a commit Netlify can't see: build.
if [ -z "$prev" ] || [ "$prev" = "$cur" ] || ! git cat-file -e "$prev^{commit}" 2>/dev/null; then exit 1; fi
if git diff --quiet "$prev" "$cur" -- . \
  ':(exclude)*.md' ':(exclude)*.txt' ':(exclude)test/**' ':(exclude)make-blueprints/**'; then
  echo "Only docs, tests or blueprints changed. Skipping the deploy to save Netlify credits."
  exit 0
fi
exit 1
