"""Move a compose file's inline environment block into an env_file, without ever printing a value.

Reads docker-compose.yml, writes .env.compose (0600) with the KEY=value pairs, and leaves the
compose file pointing at it. Prints only counts and key names, never values.
"""
import os, re, sys, shutil

COMPOSE = "docker-compose.yml"
ENVFILE = ".env.compose"

src = open(COMPOSE, encoding="utf-8").read().splitlines(keepends=False)

start = None
for i, line in enumerate(src):
    if re.fullmatch(r"( +)environment:", line):
        start = i
        indent = len(line) - len(line.lstrip())
        break
if start is None:
    print("no inline environment block - nothing to do")
    sys.exit(0)

item = " " * (indent + 4)
end = start + 1
pairs = []
while end < len(src):
    line = src[end]
    if not line.startswith(item) or line.strip().startswith("-"):
        break
    m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
    if not m:
        break
    key, val = m.group(1), m.group(2).strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
        val = val[1:-1]
    pairs.append((key, val))
    end += 1

if not pairs:
    print("environment block is empty - nothing to do")
    sys.exit(0)

shutil.copy2(COMPOSE, COMPOSE + ".before-envfile")

fd = os.open(ENVFILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("# The bot's settings and secrets. Moved out of docker-compose.yml so that a file which\n"
            "# is tracked by git can never carry a token. Never commit this one.\n")
    for key, val in pairs:
        f.write(f"{key}={val}\n")

out = src[:start] + [" " * indent + "env_file:", " " * (indent + 4) + "- " + ENVFILE] + src[end:]
open(COMPOSE, "w", encoding="utf-8").write("\n".join(out) + "\n")

print(f"moved {len(pairs)} settings into {ENVFILE} (0600)")
print("keys:", " ".join(k for k, _ in pairs))
