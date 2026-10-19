"""Does bounded scale-in (3 tranches, same R_max) change expectancy versus one entry? (in-sample study)

Uses the pickled events produced by radar.movers_study.collect (fade-long events after a 30m drop) and the 5m klines.
Both variants risk exactly 1 R_max if the stop is hit; costs are charged on every filled quantity (0.08% round trip);
limit tranches are assumed filled at their price when the low touches them (optimistic: no adverse selection).
usage: PYTHONPATH=. python3 -m radar.scale_in_study   (expects /tmp/tn/movers/{events.pkl,klines})
"""
import pickle, random
from collections import defaultdict
from radar import movers_study as ms
ev=pickle.load(open('/tmp/tn/movers/events.pkl','rb')); data=ms.load('/tmp/tn/movers/klines')
idx={s:{r[0]:i for i,r in enumerate(rows)} for s,rows in data.items()}
COST=0.0008  # round trip on every filled quantity
W=(0.25,0.35,0.40); F=(0.0,0.4,0.8)   # tranche weights; depth as fraction of the stop distance
def single(rows,i,sp,hold=12):
    entry=rows[i][1]; sl=entry*(1-sp); q=1.0/(entry*sp)  # R_max = 1 unit
    for j in range(i,min(i+hold,len(rows)-1)+1):
        if rows[j][3]<=sl: return -1.0-q*entry*COST
    ex=rows[min(i+hold,len(rows)-1)][4]
    return q*(ex-entry)-q*entry*COST
def scale(rows,i,sp,hold=12):
    entry=rows[i][1]; sl=entry*(1-sp)
    P=[entry*(1-f*sp) for f in F]
    avg=sum(w*p for w,p in zip(W,P)); Q=1.0/(avg-sl)
    qs=[w*Q for w in W]; filled=[True,False,False]; pnl=0.0
    for j in range(i,min(i+hold,len(rows)-1)+1):
        for k in (1,2):
            if not filled[k] and rows[j][3]<=P[k]: filled[k]=True
        if rows[j][3]<=sl:
            cost=sum(q*p*COST for q,p,f in zip(qs,P,filled) if f)
            return -sum(q*(p-sl) for q,p,f in zip(qs,P,filled) if f)-cost
    ex=rows[min(i+hold,len(rows)-1)][4]
    cost=sum(q*p*COST for q,p,f in zip(qs,P,filled) if f)
    return sum(q*(ex-p) for q,p,f in zip(qs,P,filled) if f)-cost
for T in (5.0,):
  for tier in ('all',):
    es=[e for e in ev if e['w']=='30m' and e['T']==T and e['mode']=='fade' and e['mdir']==-1]
    for sp in (0.04,0.08):
        res={'single':defaultdict(list),'scale':defaultdict(list)}
        for e in es:
            rows=data[e['sym']]; i=idx[e['sym']][e['t']]+1
            res['single'][e['t']//86400000].append(single(rows,i,sp))
            res['scale'][e['t']//86400000].append(scale(rows,i,sp))
        for name in ('single','scale'):
            xs=[x for v in res[name].values() for x in v]; n=len(xs); m=sum(xs)/n
            ci=ms.cluster_ci(res[name]); worst=sorted(xs)[:max(1,n//100)]
            print(f'T={T}% stop={sp*100:.0f}% {name:6s} n={n} mean={m:+.4f} R_max CI=[{ci[0]:+.3f},{ci[1]:+.3f}] winrate={sum(1 for x in xs if x>0)/n:.0%} min={min(xs):+.2f} p1={sorted(xs)[n//100]:+.2f}')
