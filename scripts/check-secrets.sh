#!/usr/bin/env bash
# Secrets validator for drakkenheim-map (audit item M3).
#
# Checks, in order:
#   1. Every "gmText" field in data/*.json (staged/index version AND working
#      tree version) must be either "" or an object with "enc": true.
#      A plaintext string there means an unencrypted campaign secret.
#   2. If .git/forbidden-patterns exists (one pattern per line, LOCAL ONLY,
#      never committed), staged content must not contain any of them.
#
# Exit 0 = clean, exit 1 = secrets would leak. Run standalone from anywhere
# inside the repo, or via the pre-push hook.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1

fail=0

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

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "SECRETS CHECK FAILED: plaintext GM secrets detected." >&2
  echo "Encrypt gmText via the editor (must be \"\" or {enc:true,...}) before pushing." >&2
  exit 1
fi
echo "secrets check: OK"
