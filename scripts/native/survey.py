# ~/.claude の記録の形を数える（読むだけ。中身の文は出さない）。段1（#96）の設計の検算に使う。
# 使い方: python3 -I scripts/native/survey.py [~/.claude]
import collections, glob, json, os, sys, time

root = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/.claude")
P = os.path.join(root, "projects")
now = time.time()
t0 = time.time()

# 1. sub-agent の meta.json の形（キーの組）と、親の jsonl の有無
metas = glob.glob(os.path.join(P, "*", "*", "subagents", "*.meta.json"))
keysets = collections.Counter()
kinds = collections.Counter()
orphan_age = collections.Counter()
have_age = collections.Counter()
bad = collections.Counter()
def age_bucket(sec):
    d = sec / 86400
    return "<1d" if d < 1 else "<7d" if d < 7 else "<30d" if d < 30 else ">=30d"
for m in metas:
    try:
        d = json.load(open(m))
    except Exception as e:
        bad["meta: JSON でない"] += 1
        continue
    if not isinstance(d, dict):
        bad["meta: object でない"] += 1
        continue
    keysets[tuple(sorted(d.keys()))] += 1
    kinds[(d.get("agentType") is not None, d.get("taskKind"), "finished" in d)] += 1
    sub = os.path.dirname(m)
    sess = os.path.dirname(sub)
    parent = sess + ".jsonl"
    age = age_bucket(now - os.stat(m).st_mtime)
    (have_age if os.path.exists(parent) else orphan_age)[age] += 1
t1 = time.time()

# 2. sub-agent の jsonl の先頭行の形
agent_jsonls = glob.glob(os.path.join(P, "*", "*", "subagents", "agent-*.jsonl"))
first = collections.Counter()
no_meta = 0
sid_match = collections.Counter()
for f in agent_jsonls:
    if not os.path.exists(f[:-len(".jsonl")] + ".meta.json"):
        no_meta += 1
    try:
        with open(f, "rb") as fh:
            line = fh.readline()
        d = json.loads(line)
    except Exception:
        bad["agent jsonl: 先頭行が JSON でない（空を含む）"] += 1
        continue
    first[(d.get("type"), d.get("isSidechain"), "agentId" in d, "sessionId" in d)] += 1
    sess_dir = os.path.basename(os.path.dirname(os.path.dirname(f)))
    sid_match[d.get("sessionId") == sess_dir] += 1
t2 = time.time()

print("meta.json", len(metas), "本", f"{t1-t0:.2f}s")
for k, v in keysets.most_common(): print("  keys", v, k)
for k, v in kinds.most_common(): print("  (agentTypeあり, taskKind, finishedあり)", k, v)
print("  親 jsonl あり の年齢", dict(have_age))
print("  親 jsonl なし の年齢", dict(orphan_age))
print("agent jsonl", len(agent_jsonls), "本", f"{t2-t1:.2f}s", "meta なし", no_meta)
for k, v in first.most_common(): print("  先頭 (type, isSidechain, agentIdあり, sessionIdあり)", k, v)
print("  先頭行の sessionId が置き場のディレクトリ名と同じ", dict(sid_match))
print("想定外", dict(bad))

# 3. workflow の agent（subagents/workflows/wf_*/agent-*.jsonl）
wf = glob.glob(os.path.join(P, "*", "*", "subagents", "workflows", "*", "agent-*.jsonl"))
wf_meta = glob.glob(os.path.join(P, "*", "*", "subagents", "workflows", "*", "*.meta.json"))
wf_other = [f for f in glob.glob(os.path.join(P, "*", "*", "subagents", "workflows", "*", "*")) if not (f.endswith(".jsonl") or f.endswith(".meta.json"))]
print("workflow の agent jsonl", len(wf), "本 meta", len(wf_meta), "本 それ以外のファイル", collections.Counter(os.path.basename(f).split(".")[-1] for f in wf_other))

# 4. 生きているセッション（sessions/<pid>.json）と、その jsonl、sub-agent
t3 = time.time()
live = []
for f in glob.glob(os.path.join(root, "sessions", "*.json")):
    try:
        d = json.load(open(f))
        os.kill(d["pid"], 0)
    except Exception:
        continue
    live.append(d)
types = collections.Counter()
sizes = []
subs = collections.Counter()
for d in live:
    enc = "".join(c if c.isalnum() else "-" for c in d["cwd"])
    base = os.path.join(P, enc, d["sessionId"])
    p = base + ".jsonl"
    if not os.path.exists(p):
        subs["jsonl が見つからない"] += 1
        continue
    sizes.append(os.path.getsize(p))
    for f in [p] + glob.glob(os.path.join(base, "subagents", "**", "agent-*.jsonl"), recursive=True):
        with open(f, "rb") as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except Exception:
                    types["(JSON でない行)"] += 1
                    continue
                types[o.get("type")] += 1
    for m in glob.glob(os.path.join(base, "subagents", "**", "*.meta.json"), recursive=True):
        meta = json.load(open(m))
        j = m[:-len(".meta.json")] + ".jsonl"
        mt = os.stat(j).st_mtime if os.path.exists(j) else 0
        subs[("finished" if "finished" in meta else "finishedなし", "直近10分" if now - mt < 600 else "10分より前")] += 1
print("生きているセッション", len(live), "jsonl の大きさ(MB)", sorted(round(s / 1e6, 1) for s in sizes), f"{time.time()-t3:.2f}s")
print("  行の type", dict(types))
print("  sub-agent", dict(subs))
