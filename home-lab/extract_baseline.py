import sys,re,json
from html.parser import HTMLParser
html=open(sys.argv[1]).read()
class P(HTMLParser):
    def __init__(s):
        super().__init__(); s.stack=[]; s.title=''; s.metas={}; s.heads=[]; s.links=[]; s.text=[]; s.cur=None; s.skip=0; s.ld=[]; s.inld=False; s.alts=[]; s.imgs=[]
    def handle_starttag(s,t,a):
        a=dict(a)
        if t in('script','style','noscript'):
            s.skip+=1; s.inld = t=='script' and a.get('type')=='application/ld+json'
        if t=='meta' and (a.get('name') or a.get('property')): s.metas[a.get('name') or a.get('property')]=a.get('content')
        if t=='link' and a.get('rel')=='alternate': s.alts.append((a.get('hreflang'),a.get('href')))
        if t=='link' and a.get('rel')=='canonical': s.alts.append(('canonical',a.get('href')))
        if t=='a' and a.get('href'): s.links.append(a['href'])
        if t=='img': s.imgs.append({k:a.get(k) for k in('src','alt','width','height','loading')})
        if t in('h1','h2','h3','title'): s.cur=[t,'']
    def handle_endtag(s,t):
        if t in('script','style','noscript'): s.skip-=1; s.inld=False
        if s.cur and t==s.cur[0]:
            if t=='title': s.title=s.cur[1].strip()
            else: s.heads.append((t,' '.join(s.cur[1].split())))
            s.cur=None
    def handle_data(s,d):
        if s.inld: s.ld.append(d); return
        if s.skip: return
        if s.cur: s.cur[1]+=d
        s.text.append(d)
p=P(); p.feed(html)
words=' '.join(' '.join(p.text).split()).split(' ')
out={'title':p.title,'description':p.metas.get('description'),'og':{k:v for k,v in p.metas.items() if k.startswith(('og:','twitter:','robots'))},'headings':p.heads,'first150':' '.join(words[:150]),'word_count':len(words),'internal_links':sorted(set(l for l in p.links if l.startswith('/') or 'mcpemails.com' in l)),'external_links':sorted(set(l for l in p.links if l.startswith('http') and 'mcpemails.com' not in l)),'alternates':p.alts,'images':p.imgs,'jsonld':[json.loads(x) for x in p.ld if x.strip()]}
print(json.dumps(out,indent=1,ensure_ascii=False))
