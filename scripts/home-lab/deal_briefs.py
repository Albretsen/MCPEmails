#!/usr/bin/env python3
"""Deal the 10 Homepage Lab briefs from home-lab/ideas.json.

LLMs fall back on the same defaults, so the briefs are dealt by this script,
not invented. Standard library only. Deterministic: the same seed and inputs
always give byte-identical output.

Usage (from the repo root):
  python3 -I scripts/home-lab/deal_briefs.py [--seed N] [--ideas home-lab/ideas.json]
      [--out home-lab/briefs] [--bold 3] [--tone mixed|light|dark|both]
      [--must-haves "providers,pricing,..."] [--incompatible home-lab/incompatible.json]

How a deal works:
  * For each category the ideas are shuffled with random.Random(<derived seed>)
    and handed out round-robin, one per brief, each idea at most once per deal.
    So no two briefs share any idea, which covers layout, hero and visual_style.
  * `--bold N` briefs are marked bold. Only bold briefs may receive ideas
    flagged `bold: true`, and each bold brief gets a bold wildcard.
  * Tone: `mixed` deals 4 light, 3 dark and 3 "both" briefs; an idea whose
    `tone` is light or dark goes only to a brief of that tone ("both" briefs
    take only tone-neutral ideas).
  * incompatible.json holds the hard exclusions:
      "pairs": [["layout-03", "hero-07"], ...]  never in the same brief;
      "exclude": ["wildcard-09", ...]           ideas that break a hard rule
                                                (e.g. the SEO word count), never dealt;
      "families": {"layout-01": "document", ...} and "max_per_family": {"document": 2}
                                                so the 10 briefs do not look alike.
  * If a deal breaks a constraint it is re-dealt with the next derived seed
    ("<seed>:<attempt>"), so the result still depends only on the seed.
  * Each brief also gets a `variant_seed` for the builder's own small choices.
"""

import argparse
import json
import os
import random
import sys
import time

CATEGORIES = [
    'layout', 'hero', 'visual_style', 'typography', 'narrative', 'proof',
    'asset_use', 'motion', 'section_order', 'voice', 'wildcard',
]
BRIEFS = 10
DEFAULT_MUST_HAVES = [
    'providers', 'pricing', 'security and where data is stored (Stockholm)', 'reviews',
    'FAQ', 'how it works', 'Business per person',
]


def tones_for(mode, rng):
    if mode == 'mixed':
        tones = ['light'] * 4 + ['dark'] * 3 + ['both'] * 3
        rng.shuffle(tones)
        return tones
    return [mode] * BRIEFS


def tone_ok(idea, tone):
    t = idea.get('tone', 'any') or 'any'
    if t == 'any':
        return True
    return t == tone


def deal_once(ideas_by_cat, derived_seed, bold_count, tone_mode, incompatible, families, max_per_family):
    rng = random.Random(derived_seed)
    bold_set = set(rng.sample(range(BRIEFS), bold_count))
    tones = tones_for(tone_mode, rng)
    # Bold briefs pick first in every category, so they can claim bold ideas.
    order = sorted(range(BRIEFS), key=lambda i: (i not in bold_set, i))
    picks = [{} for _ in range(BRIEFS)]
    for cat in CATEGORIES:
        pool = list(ideas_by_cat[cat])
        rng.shuffle(pool)
        for b in order:
            bold = b in bold_set
            want_bold = bold and cat == 'wildcard'
            choice = None
            for idea in pool:
                if not tone_ok(idea, tones[b]):
                    continue
                if not bold and idea.get('bold'):
                    continue
                if want_bold and not idea.get('bold'):
                    continue
                choice = idea
                break
            if choice is None:
                return None, f'no {cat} idea fits brief {b + 1} (bold={bold}, tone={tones[b]})'
            pool.remove(choice)
            picks[b][cat] = choice
    family_counts = {}
    for b in range(BRIEFS):
        for idea in picks[b].values():
            fam = families.get(idea['id'])
            if fam:
                family_counts[fam] = family_counts.get(fam, 0) + 1
    for fam, n in family_counts.items():
        if n > max_per_family.get(fam, BRIEFS):
            return None, f'{n} briefs share the {fam} family (max {max_per_family[fam]})'
    for b in range(BRIEFS):
        ids = {p['id'] for p in picks[b].values()}
        for x, y in incompatible:
            if x in ids and y in ids:
                return None, f'brief {b + 1} pairs incompatible {x} + {y}'
    briefs = []
    for b in range(BRIEFS):
        briefs.append({
            'bold': b in bold_set,
            'tone': tones[b],
            'variant_seed': rng.randrange(2 ** 31),
            'ideas': {cat: picks[b][cat] for cat in CATEGORIES},
        })
    return briefs, None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--seed', type=int, default=None)
    ap.add_argument('--ideas', default='home-lab/ideas.json')
    ap.add_argument('--out', default='home-lab/briefs')
    ap.add_argument('--bold', type=int, default=3)
    ap.add_argument('--tone', default='mixed', choices=['mixed', 'light', 'dark', 'both'])
    ap.add_argument('--must-haves', default=','.join(DEFAULT_MUST_HAVES))
    ap.add_argument('--incompatible', default='home-lab/incompatible.json')
    ap.add_argument('--max-attempts', type=int, default=500)
    args = ap.parse_args()

    seed = args.seed if args.seed is not None else int(time.time())
    print(f'seed: {seed}')
    if not 0 <= args.bold <= BRIEFS:
        sys.exit('--bold must be between 0 and 10')

    data = json.load(open(args.ideas))
    ideas = data['ideas'] if isinstance(data, dict) else data
    ideas_by_cat = {c: [] for c in CATEGORIES}
    for idea in ideas:
        if idea.get('category') in ideas_by_cat:
            ideas_by_cat[idea['category']].append(idea)
    for c in CATEGORIES:
        if len(ideas_by_cat[c]) < BRIEFS:
            sys.exit(f'category {c} has {len(ideas_by_cat[c])} ideas; needs at least {BRIEFS}')
        # A stable starting order, so the shuffle depends only on the seed.
        ideas_by_cat[c].sort(key=lambda i: i['id'])

    incompatible, exclude, families, max_per_family = [], set(), {}, {}
    if os.path.exists(args.incompatible):
        rules = json.load(open(args.incompatible))
        incompatible = [tuple(p) for p in rules.get('pairs', [])]
        exclude = set(rules.get('exclude', []))
        families = rules.get('families', {})
        max_per_family = rules.get('max_per_family', {})
    for c in CATEGORIES:
        ideas_by_cat[c] = [i for i in ideas_by_cat[c] if i['id'] not in exclude]
    must_haves = [m.strip() for m in args.must_haves.split(',') if m.strip()]

    briefs = None
    for attempt in range(args.max_attempts):
        derived = f'{seed}:{attempt}'
        briefs, why = deal_once(ideas_by_cat, derived, args.bold, args.tone, incompatible, families, max_per_family)
        if briefs:
            break
        print(f'attempt {attempt} rejected: {why}')
    if not briefs:
        sys.exit(f'no valid deal in {args.max_attempts} attempts')
    print(f'dealt on attempt {attempt} (derived seed "{derived}")')

    os.makedirs(args.out, exist_ok=True)
    rows = []
    for i, brief in enumerate(briefs, start=1):
        vid = f'v{i:02d}'
        out = {
            'variant': vid,
            'seed': seed,
            'derived_seed': derived,
            'variant_seed': brief['variant_seed'],
            'bold': brief['bold'],
            'tone': brief['tone'],
            'must_haves': must_haves,
            'ideas': {
                cat: {k: v for k, v in idea.items() if k in ('id', 'idea', 'why', 'url', 'tone', 'bold')}
                for cat, idea in brief['ideas'].items()
            },
        }
        with open(os.path.join(args.out, f'{vid}.json'), 'w') as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
            f.write('\n')
        ids = brief['ideas']
        rows.append(
            f"| {vid} | {'yes' if brief['bold'] else ''} | {brief['tone']} | {ids['layout']['idea']} | "
            f"{ids['hero']['idea']} | {ids['visual_style']['idea']} | {ids['typography']['idea']} | "
            f"{ids['wildcard']['idea']} |"
        )
    with open(os.path.join(args.out, 'summary.md'), 'w') as f:
        f.write('# Homepage Lab briefs\n\n')
        f.write(f'Seed `{seed}`, dealt on attempt {attempt} (derived seed `{derived}`). '
                f'Bold briefs: {args.bold}. Tone mode: {args.tone}.\n')
        f.write(f'Re-deal with `python3 -I scripts/home-lab/deal_briefs.py --seed {seed}`. Never hand-edit a brief.\n\n')
        f.write('| Variant | Bold | Tone | Layout | Hero | Visual style | Typography | Wildcard |\n')
        f.write('|---|---|---|---|---|---|---|---|\n')
        f.write('\n'.join(r.replace('\n', ' ') for r in rows) + '\n')
    print(f'wrote {BRIEFS} briefs and summary.md to {args.out}')


if __name__ == '__main__':
    main()
