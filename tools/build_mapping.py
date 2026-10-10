#!/usr/bin/env python3
"""Rebuild data/mapping.json: NeetCode problem slug -> LeetCode problem (+ signature fixes).

Sources (all public, no login needed):
  1. https://neetcode.io/practice -> main.<hash>.js          -> the "NeetCode All" table: LeetCode link, NeetCode
                                                                slug (ncLink) and roadmap topic of every problem
  2. https://neetcode.io/api/getProblemListFunctionHttp      -> every NeetCode problem slug
  3. https://neetcode.io/api/getProblemMetadataFunctionHttp  -> per problem: LeetCode-style title, video id, starter code
  4. https://leetcode.com/api/problems/all/                  -> LeetCode title / slug / question_id / premium
  5. https://www.youtube.com/oembed                          -> video title "... - Leetcode 217 - ..." (fallback)
  6. https://leetcode.com/graphql                            -> LeetCode code snippets per language

Match order: NeetCode's own table (ncLink -> LeetCode link), then for problems missing from it the
title (normalised: letters+digits only), then the LeetCode number parsed from the YouTube title.

Entry fields: s = LeetCode slug, n = LeetCode number, q = LeetCode question_id, p = LeetCode Premium,
t = LeetCode title, k = NeetCode roadmap topic (needed to tick it), f = signature fixes (below),
o = 1 for "NeetCode All" problems that have no NeetCode editor (NeetCode only links to LeetCode).
Those are keyed by their LeetCode slug and can only be ticked on NeetCode, never submitted there.

Signature fixes (`f` field): NeetCode's starter code is compared with LeetCode's snippet for every
language; differing class/method names become rename pairs, and JavaScript/TypeScript solutions
written as `class Solution` get top-level function shims (LeetCode calls plain functions there).
Problems whose starter is hidden for anonymous users (NeetCode Pro) or whose LeetCode snippet is
premium-only get no `f` entry; the extension computes those live when needed.

Usage:
  python tools/build_mapping.py                 # writes data/mapping.json
  python tools/build_mapping.py --curl          # use the curl binary instead of urllib (corporate proxies)
  python tools/build_mapping.py --workers 8
"""
import argparse
import concurrent.futures as cf
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

NC_SITE = 'https://neetcode.io'
NC_LIST = 'https://neetcode.io/api/getProblemListFunctionHttp'
NC_META = 'https://neetcode.io/api/getProblemMetadataFunctionHttp'
LC_ALL = 'https://leetcode.com/api/problems/all/'
LC_GQL = 'https://leetcode.com/graphql'
YT_OEMBED = 'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json'
UA = 'Mozilla/5.0 (neetbridge mapping builder)'

NC2LC = {'python': 'python3', 'java': 'java', 'cpp': 'cpp', 'javascript': 'javascript', 'typescript': 'typescript',
         'csharp': 'csharp', 'go': 'golang', 'kotlin': 'kotlin', 'swift': 'swift', 'rust': 'rust', 'c': 'c',
         'ruby': 'ruby', 'scala': 'scala', 'dart': 'dart'}

KEYWORDS = set('''if for while switch return new delete sizeof typeof instanceof throw catch try else do case default
function class def self this super init constructor len range print push_back main
List Optional Dict Set Tuple Deque vector string map unordered_map unordered_set set pair queue deque stack priority_queue
int long double float bool char void auto var let const fn pub impl struct type func mut Vec String Option Box HashMap
Integer Boolean Character Array ArrayList HashSet LinkedList Math Object Number Any Int Bool Double Unit
override public private protected static final abstract readonly export import require operator
ListNode TreeNode Node GraphNode NestedInteger Interval Point Employee TreeNodeWithNext'''.split())

USE_CURL = False


# ----------------------------------------------------------------------------- http

def http_text(url, body=None, headers=None):
    headers = headers or {}
    if USE_CURL:
        cmd = ['curl', '-s', '--max-time', '60', '-A', UA, url]
        for k, v in headers.items():
            cmd += ['-H', f'{k}: {v}']
        if body is not None:
            cmd += ['-X', 'POST', '-H', 'content-type: application/json', '-d', json.dumps(body)]
        return subprocess.run(cmd, capture_output=True).stdout.decode('utf-8', 'replace')
    req = urllib.request.Request(url, headers={'User-Agent': UA, **headers})
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header('content-type', 'application/json')
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode('utf-8', 'replace')


def http(url, body=None, headers=None):
    return json.loads(http_text(url, body, headers))


def unwrap(j):
    if isinstance(j, dict):
        if 'data' in j:
            return j['data']
        if 'result' in j:
            return j['result']
    return j


def norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def nc_table():
    """NeetCode All: the problem table compiled into the site bundle, as a list of dicts like
    {problem, pattern, link: 'two-sum/', code: '0001-two-sum', ncLink: 'two-integer-sum/', ...}."""
    html = http_text(NC_SITE + '/practice')
    main = re.search(r'main\.[0-9a-f]+\.js', html)
    if not main:
        raise RuntimeError('main.<hash>.js not found on neetcode.io/practice')
    js = http_text(f'{NC_SITE}/{main.group(0)}')
    rows = []
    for m in re.finditer(r'\{problem:"', js):
        body = js[m.start() + 1:js.index('}', m.start())]
        row = {}
        for k, v in re.findall(r'(\w+):("(?:[^"\\]|\\.)*"|!0|!1)', body):
            row[k] = json.loads(v) if v.startswith('"') else v == '!0'
        if row.get('link') and row.get('pattern'):
            rows.append(row)
    return rows


def nc_meta(slug):
    for _ in range(3):
        try:
            d = unwrap(http(NC_META, {'data': {'problemId': slug}})) or {}
            if d.get('name'):
                vid = re.search(r'embed/([\w-]+)', d.get('video') or '')
                return slug, {'name': d['name'].strip(), 'video': vid.group(1) if vid else None,
                              'starter': d.get('starterCode') if isinstance(d.get('starterCode'), dict) else None}
        except Exception:
            pass
    return slug, {'name': None, 'video': None, 'starter': None}


def lc_snippets(slug):
    q = {'query': 'query q($s:String!){question(titleSlug:$s){codeSnippets{langSlug code}}}', 'variables': {'s': slug}}
    for _ in range(3):
        try:
            d = http(LC_GQL, q, {'referer': f'https://leetcode.com/problems/{slug}/'})
            snippets = (d.get('data') or {}).get('question') or {}
            snippets = snippets.get('codeSnippets') or []
            return slug, {c['langSlug']: c['code'] for c in snippets}
        except Exception:
            pass
    return slug, {}


def yt_title(vid):
    try:
        return http(YT_OEMBED.format(vid=vid)).get('title')
    except Exception:
        return None


# ----------------------------------------------------------------------------- signature fixes
# Mirror of src/sigfix.js (extractIdents / computeFix). Keep the two in sync.

def strip_comments(code, lang):
    if lang == 'python3':
        return re.sub(r'#.*', '', code)
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.S)
    return re.sub(r'//.*', '', code)


def extract_idents(code, lang):
    code = strip_comments(code or '', lang)
    names = []
    if lang == 'python3':
        names += [('class', m) for m in re.findall(r'^class\s+(\w+)', code, re.M)]
        names += [('fn', m) for m in re.findall(r'^\s*def\s+(\w+)\s*\(', code, re.M) if m != '__init__']
    elif lang == 'golang':
        names += [('class', m) for m in re.findall(r'^type\s+(\w+)\s+struct', code, re.M)]
        names += [('fn', m) for m in re.findall(r'^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(', code, re.M) if m != 'Constructor']
    elif lang == 'rust':
        names += [('class', m) for m in re.findall(r'^(?:impl|struct)\s+(\w+)', code, re.M)]
        names += [('fn', m) for m in re.findall(r'^\s*(?:pub\s+)?fn\s+(\w+)\s*\(', code, re.M) if m != 'new']
    elif lang in ('javascript', 'typescript'):
        names += [('class', m) for m in re.findall(r'\bclass\s+(\w+)', code)]
        for m in re.findall(r'(?:var|let|const)\s+(\w+)\s*=\s*(?:function|\(|async)', code):
            names.append(('class', m) if m[0].isupper() else ('fn', m))
        names += [('fn', m) for m in re.findall(r'\bfunction\s+(\w+)\s*\(', code)]
        names += [('fn', m) for m in re.findall(r'\w+\.prototype\.(\w+)\s*=', code)]
        for m in re.findall(r'^\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{', code, re.M):
            if m not in ('constructor', 'if', 'for', 'while', 'switch', 'catch') and m not in KEYWORDS:
                names.append(('fn', m))
    else:
        names += [('class', m) for m in re.findall(r'\bclass\s+(\w+)', code)]
        for m in re.findall(r'(\w+)\s*\([^()]*\)\s*(?:const\s*)?(?::\s*\w+\s*)?\{', code):
            if m not in KEYWORDS and not m.startswith('__'):
                names.append(('fn', m))
    out, seen = [], set()
    for k, n in names:
        if (k, n) not in seen:
            seen.add((k, n))
            out.append((k, n))
    return out


def compute_fix(nc_code, lc_code, lang):
    """Returns a fix dict, {} when nothing differs, None when the shapes cannot be aligned."""
    if not nc_code or not lc_code:
        return None
    a = extract_idents(nc_code, lang)
    b = extract_idents(lc_code, lang)
    a_cls = [n for k, n in a if k == 'class']
    b_cls = [n for k, n in b if k == 'class']
    a_fn = [n for k, n in a if k == 'fn']
    b_fn = [n for k, n in b if k == 'fn']
    wrap_class = None
    if lang in ('javascript', 'typescript') and len(a_cls) == 1 and not b_cls:
        wrap_class, a_cls = a_cls[0], []
    a_fn = [n for n in a_fn if n not in a_cls]
    b_fn = [n for n in b_fn if n not in b_cls]
    if len(a_cls) != len(b_cls) or len(a_fn) != len(b_fn):
        return None
    r = [[x, y] for x, y in zip(a_cls + a_fn, b_cls + b_fn) if x != y]
    fix = {}
    if r:
        fix['r'] = r
    if wrap_class:
        fix['w'] = b_fn
        if wrap_class != 'Solution':
            fix['c'] = wrap_class
    return fix


# ----------------------------------------------------------------------------- main

def main():
    global USE_CURL
    ap = argparse.ArgumentParser()
    ap.add_argument('--curl', action='store_true', help='fetch with the curl binary instead of urllib')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent.parent / 'data' / 'mapping.json'))
    args = ap.parse_args()
    USE_CURL = args.curl

    print('fetching NeetCode All table ...')
    table = nc_table()
    by_nc = {r['ncLink'].strip('/'): r for r in table if r.get('ncLink')}
    link_only = [r for r in table if not r.get('ncLink')]
    print(f'  {len(table)} problems: {len(by_nc)} with a NeetCode editor, {len(link_only)} linking to LeetCode only')

    print('fetching NeetCode problem list ...')
    nc_list = unwrap(http(NC_LIST, {'data': {}})) or {}
    listed = {k for k, v in nc_list.items() if isinstance(v, dict) and v.get('tag') == 'NeetCode150'}
    slugs = sorted(listed | set(by_nc))
    print(f'  {len(listed)} LeetCode-style problems on NeetCode, {len(slugs)} together with the table')

    print('fetching LeetCode problem list ...')
    lc = http(LC_ALL)['stat_status_pairs']
    by_norm, by_num, by_slug = {}, {}, {}
    for x in lc:
        s = x['stat']
        e = {'s': s['question__title_slug'], 'n': s['frontend_question_id'], 'q': s['question_id'],
             'p': 1 if x['paid_only'] else 0, 't': s['question__title']}
        by_norm[norm(e['t'])] = e
        by_num[e['n']] = e
        by_slug[e['s']] = e
    print(f'  {len(lc)} problems on LeetCode')

    def from_table(row):
        num = re.match(r'\d+', row.get('code') or '')
        return by_slug.get(row['link'].strip('/')) or (by_num.get(int(num.group(0))) if num else None)

    print('fetching NeetCode metadata (title, video, starter code) ...')
    with cf.ThreadPoolExecutor(args.workers) as ex:
        meta = dict(ex.map(nc_meta, slugs))

    mapping, topics, need_yt = {}, {}, []
    for slug in slugs:
        row = by_nc.get(slug)
        hit = from_table(row) if row else None
        if hit:
            topics[slug] = row['pattern']
        else:
            hit = by_norm.get(norm(meta[slug]['name']))
        if hit:
            mapping[slug] = dict(hit)
        else:
            need_yt.append(slug)
    print(f'  matched by table: {len(topics)}, by title: {len(mapping) - len(topics)}, trying YouTube for {len(need_yt)}')

    with cf.ThreadPoolExecutor(args.workers) as ex:
        titles = dict(zip(need_yt, ex.map(lambda s: yt_title(meta[s]['video']) if meta[s]['video'] else None, need_yt)))
    unmapped = []
    for slug in need_yt:
        m = re.search(r'leetcode\s*#?\s*(\d+)', titles.get(slug) or '', re.I)
        hit = by_num.get(int(m.group(1))) if m else None
        if hit:
            mapping[slug] = dict(hit)
        else:
            unmapped.append((slug, meta[slug]['name']))

    print('fetching LeetCode code snippets ...')
    with cf.ThreadPoolExecutor(args.workers) as ex:
        snippets = dict(ex.map(lc_snippets, [v['s'] for v in mapping.values()]))

    fixed_problems = 0
    unaligned = []
    for slug, entry in mapping.items():
        starter = meta[slug]['starter']
        lcsn = snippets.get(entry['s']) or {}
        if not starter or not lcsn:
            continue
        fixes = {}
        for nclang, code in starter.items():
            lclang = NC2LC.get(nclang)
            if not lclang or lclang not in lcsn:
                continue
            fix = compute_fix(code, lcsn[lclang], lclang)
            if fix is None:
                unaligned.append((slug, lclang))
            elif fix:
                fixes[lclang] = fix
        if fixes:
            entry['f'] = fixes
            fixed_problems += 1
    for slug, topic in topics.items():
        mapping[slug]['k'] = topic

    # NeetCode All problems without a NeetCode editor: keyed by LeetCode slug, tick-only
    taken = {v['s'] for v in mapping.values()}
    lc_only = 0
    for row in link_only:
        hit = from_table(row)
        if not hit:
            unmapped.append((row['link'], row.get('problem')))
        elif hit['s'] in mapping or hit['s'] in taken:
            print(f'  skipped link-only {hit["s"]}: already mapped')
        else:
            mapping[hit['s']] = dict(hit, k=row['pattern'], o=1)
            lc_only += 1

    ordered = dict(sorted(mapping.items(), key=lambda kv: (kv[1]['n'], kv[0])))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w', encoding='utf-8') as f:
        f.write('{\n' + ',\n'.join(f'  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False, separators=(",", ":"))}'
                                    for k, v in ordered.items()) + '\n}\n')
    print(f'wrote {out}: {len(ordered)} entries ({len(ordered) - lc_only} with a NeetCode editor, {lc_only} tick-only), '
          f'{sum(v["p"] for v in ordered.values() if not v.get("o"))} of the editor ones LeetCode premium, '
          f'{fixed_problems} with signature fixes, {sum(1 for v in ordered.values() if "k" not in v)} without topic')
    if unaligned:
        print(f'{len(unaligned)} problem/language pairs could not be aligned (extension falls back to a heuristic):')
        for slug, lang in unaligned[:30]:
            print(f'  {slug} [{lang}]')
    if unmapped:
        print('UNMAPPED:')
        for slug, name in unmapped:
            print(f'  {slug}  ({name})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
