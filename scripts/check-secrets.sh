#!/usr/bin/env bash
# Secrets validator for drakkenheim-map (audit item M3; Ф5 closes the M3-MINOR
# gap — deploy.sh now gates on the actual assembled deploy directory, not a
# git-index proxy for it).
#
# Two modes:
#   scripts/check-secrets.sh            git-index mode (local / pre-push):
#     data/*.json from `git ls-files`, checked both at HEAD (`git show :file`)
#     and in the worktree. Forbidden-patterns grep runs over staged content
#     (`git grep --cached`).
#   scripts/check-secrets.sh <dir>      directory mode (deploy gate):
#     every *.json under <dir> on disk — no git involved. Forbidden-patterns
#     grep runs directly over <dir>. This is what deploy.sh points at the
#     staged deploy directory (temporary, pre-upload) after assembling it and
#     before the operator confirmation prompt — it validates the bytes that
#     are actually about to ship, not a stand-in for them.
#
# Both modes check:
#   1. Every "gmText" field must be either "" or an object with "enc": true.
#      A plaintext string there means an unencrypted campaign secret.
#   2. If .git/forbidden-patterns exists (one pattern per line, LOCAL ONLY,
#      never committed), the relevant content must not contain any of them.
#
# Exit 0 = clean, exit 1 = secrets would leak. Run standalone from anywhere
# inside the repo, via the pre-push hook, or from deploy.sh.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1

fail=0
TARGET_DIR="${1:-}"

# Python program is passed via -c so stdin stays free for the JSON content.
PYCODE=$(cat <<'PY'
import json, sys
label = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception as e:
    print(f"  [{label}] unreadable JSON: {e}", file=sys.stderr)
    sys.exit(1)
bad = []
def walk(o, loc):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "gmText":
                if not (v == "" or (isinstance(v, dict) and v.get("enc") is True)):
                    bad.append((loc + "/gmText", repr(v)[:70]))
            walk(v, f"{loc}/{k}")
    elif isinstance(o, list):
        for i, x in enumerate(o):
            walk(x, f"{loc}[{i}]")
walk(data, "")
for loc, v in bad:
    print(f"  [{label}] PLAINTEXT gmText at {loc}: {v}", file=sys.stderr)
sys.exit(1 if bad else 0)
PY
)

validate_json() {
  # $1 = label, stdin = JSON content
  python3 -c "$PYCODE" "$1"
}

if [ -n "$TARGET_DIR" ]; then
  if [ ! -d "$TARGET_DIR" ]; then
    echo "ABORT: directory-mode target not found: $TARGET_DIR" >&2
    exit 1
  fi

  while IFS= read -r -d '' f; do
    if ! validate_json "dir:$f" < "$f"; then fail=1; fi
  done < <(find "$TARGET_DIR" -type f -name '*.json' -print0)

  patfile="$(git rev-parse --git-dir)/forbidden-patterns"
  if [ -f "$patfile" ]; then
    if grep -rIn -f "$patfile" "$TARGET_DIR"; then
      echo "  forbidden pattern found in deploy directory content (see matches above)" >&2
      fail=1
    fi
  else
    echo "note: $patfile not found — passphrase grep skipped (structural check still ran)" >&2
  fi
else
  for f in $(git ls-files -- 'data/*.json'); do
    if ! git show ":$f" | validate_json "index:$f"; then fail=1; fi
    if [ -f "$f" ] && ! validate_json "worktree:$f" < "$f"; then fail=1; fi
  done

  patfile="$(git rev-parse --git-dir)/forbidden-patterns"
  if [ -f "$patfile" ]; then
    if git grep --cached -I -n -f "$patfile" -- . ; then
      echo "  forbidden pattern found in staged content (see matches above)" >&2
      fail=1
    fi
  else
    echo "note: $patfile not found — passphrase grep skipped (structural check still ran)" >&2
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "SECRETS CHECK FAILED: plaintext GM secrets detected." >&2
  echo "Encrypt gmText via the editor (must be \"\" or {enc:true,...}) before pushing." >&2
  exit 1
fi
echo "secrets check: OK"
