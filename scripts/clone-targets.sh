#!/usr/bin/env bash
# Clones the real-world projects the Phase 0 gate measures against.
set -u
mkdir -p targets && cd targets
for r in vercel/commerce shadcn-ui/ui dubinc/dub calcom/cal.com; do
  n=$(basename "$r")
  [ -d "$n" ] && { echo "have $n"; continue; }
  echo "cloning $r"
  git clone --depth 1 --single-branch -q "https://github.com/$r.git" "$n"
done
