"""Builds data/plazas.json — the national toll-plaza table the app loads in the browser.

Why this exists (RCA, Sep 2026): the in-browser toll engine only had ~40
hand-seeded plazas. When the Toll API did not answer, a Pahasu -> Rithala quote
missed the Luharali plaza (NH-34, between Sikandrabad and Dadri) and fell to a
per-km guess. The browser now carries the full national set.

Precedence, per location (plazas within 1.5 km are the same plaza):
 1. NHAI official dataset (toll-api/data/india_tolls_raw_1674.json) — current FY rates
 2. FleetHub national merged set (toll-api/data/plazas-*-national.json)
Hand-verified corridor plazas in index.html are merged on top by the app.

NHAI vehicle classes -> FleetHub types:
 car  -> car rate (Car/Jeep/Van)       suv  -> car rate (Innova/Ertiga are Car/Jeep/Van)
 tempo, minibus -> LCV rate (NHAI: LCV / LGV / Mini Bus)       bus -> Bus/Truck rate
"""
import json, math, glob, datetime, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def hav(a, b):
    R = 6371; p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1]-a[1]); dp = p2-p1
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(h))
def num(x):
    try: v = float(x); return v if v > 0 else None
    except: return None
out = []
STOPW = {'toll','plaza','side','bypass','approach','expwy','close','loop','road','the','nh'}
def words(n, main_only=False):
    n = (n or '').lower()
    if main_only: n = re.sub(r'\(.*?\)', ' ', n)
    return {w for w in re.findall(r'[a-z]+', n) if len(w) > 3 and w not in STOPW}
def same_plaza(a_name, a, b_name, b):
    """Same physical plaza: within 2.5 km, or within 8 km sharing a name
    (datasets place the same plaza up to ~2 km apart, and the old seed used
    rounded coordinates). Counting it twice doubles the toll."""
    d = hav(a, b)
    if d < 2.5: return True
    if d < 8 and (words(a_name, True) & words(b_name) or words(b_name, True) & words(a_name)): return True
    return False
def near(lat, lng, name=''):
    for o in out:
        if abs(o['lat']-lat) < 0.1 and abs(o['lng']-lng) < 0.1 and same_plaza(o['name'], (o['lat'], o['lng']), name, (lat, lng)):
            return o
    return None
raw = json.load(open(os.path.join(ROOT, 'toll-api/data/india_tolls_raw_1674.json')))
for r in raw:
    if r.get('active') is False: continue
    lat, lng = num(r.get('latitude')), num(r.get('longitude'))
    car, lcv, bus = num(r.get('car_single')), num(r.get('lcv_single')), num(r.get('bus_single'))
    if not (lat and lng and car) or not (6 < lat < 37 and 68 < lng < 98): continue
    if near(lat, lng, r.get('tollplaza_name')): continue
    lcv = lcv or round(car*1.6); bus = bus or round(car*3.3)
    out.append({'id': 'nhai_%s' % r.get('tollplaza_id'), 'name': (r.get('tollplaza_name') or '').strip(),
                'hw': ('NH-' + str(r['nh_no'])) if r.get('nh_no') else '', 'st': (r.get('state_name') or '').title(),
                'lat': round(lat, 6), 'lng': round(lng, 6),
                'car': int(car), 'suv': int(car), 'tempo': int(lcv), 'minibus': int(lcv), 'bus': int(bus), 'src': 'nhai'})
nat_files = sorted(glob.glob(os.path.join(ROOT, 'toll-api/data/plazas-*-national.json')))
nat = json.load(open(nat_files[-1]))['plazas']
for p in nat:
    lat, lng, rt = p.get('lat'), p.get('lng'), p.get('rates') or {}
    if not isinstance(lat, (int, float)) or not rt.get('car'): continue
    if near(lat, lng, p.get('name')): continue
    car = rt['car']; lcv = rt.get('lcv') or round(car*1.6); bus = rt.get('bus2') or round(car*3.3)
    out.append({'id': p['id'], 'name': p.get('name', ''), 'hw': p.get('highway') or '', 'st': p.get('state') or '',
                'lat': round(lat, 6), 'lng': round(lng, 6),
                'car': int(car), 'suv': int(car), 'tempo': int(lcv), 'minibus': int(lcv), 'bus': int(bus), 'src': 'fleethub'})
version = 'national-' + datetime.date.today().isoformat()
json.dump({'version': version, 'count': len(out), 'plazas': out},
          open(os.path.join(ROOT, 'data/plazas.json'), 'w'), separators=(',', ':'))
print(version, len(out), 'plazas')
