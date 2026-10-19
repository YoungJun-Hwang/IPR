"""Bounded public-store image screening. Matches are review leads, not legal findings."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import re
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from statistics import median
from urllib.parse import urldefrag, urljoin, urlsplit
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree

from bs4 import BeautifulSoup
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field

Image.MAX_IMAGE_PIXELS = 16_000_000
POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix='ipr-scan')
CREATE_LOCK = threading.Lock()
PRODUCT = re.compile(r'/(?:products?|goods|items?|p|dp)/|[?&](?:product_no|goodsNo|goods_no|item_id)=', re.I)
CATEGORY = re.compile(r'/(?:collections?|categories|category)/|/(?:product|goods)/list|[?&](?:cate_no|category|category_id)=', re.I)
SKIP = re.compile(r'/(?:cart|checkout|account|login|search|wishlist)(?:/|\?|$)', re.I)


class Reference(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    image: str = Field(max_length=2_800_000)


class ScanInput(BaseModel):
    site_url: str = Field(max_length=2048)
    references: list[Reference] = Field(min_length=1, max_length=3)
    max_products: int = Field(default=20, ge=1, le=50)
    max_categories: int = Field(default=5, ge=1, le=10)
    threshold: int = Field(default=88, ge=75, le=100)


def connect(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=20)
    con.row_factory = sqlite3.Row
    con.execute('CREATE TABLE IF NOT EXISTS scans (id TEXT PRIMARY KEY, created TEXT NOT NULL, payload TEXT NOT NULL)')
    return con


def get_scan(path, scan_id):
    with connect(path) as con:
        row = con.execute('SELECT payload FROM scans WHERE id=?', (scan_id,)).fetchone()
    return json.loads(row['payload']) if row else None


def put_scan(path, scan):
    with connect(path) as con:
        con.execute('INSERT OR REPLACE INTO scans VALUES (?,?,?)', (scan['id'], scan['created'], json.dumps(scan, ensure_ascii=False)))


def list_scans(path):
    with connect(path) as con:
        rows = con.execute("SELECT id, created, json_extract(payload, '$.site_url') AS site_url, json_extract(payload, '$.status') AS status, json_extract(payload, '$.stage') AS stage, json_extract(payload, '$.counts') AS counts FROM scans ORDER BY created DESC LIMIT 30").fetchall()
    # Extract summaries in SQLite rather than loading every saved image thumbnail.
    return [{**dict(row), 'counts':json.loads(row['counts'])} for row in rows]


def recover_scans(path):
    with connect(path) as con:
        rows = con.execute("SELECT payload FROM scans WHERE json_extract(payload, '$.status') IN ('queued','running')").fetchall()
    for row in rows:
        scan = json.loads(row['payload'])
        if scan['status'] in ('queued', 'running'):
            scan.update(status='failed', stage='서버 재시작으로 점검이 중단되었습니다. 새 점검을 시작해 주세요.')
            put_scan(path, scan)


@lru_cache(maxsize=1)
def weights():
    return [[math.cos((2*x+1)*u*math.pi/64) for x in range(32)] for u in range(8)]


def image_features(data):
    if len(data) > 2*1024*1024:
        raise ValueError('이미지는 2MB 이하여야 합니다.')
    try:
        with Image.open(io.BytesIO(data)) as opened:
            if opened.format not in ('PNG','JPEG','GIF','WEBP'):
                raise ValueError('PNG, JPEG, GIF, WebP 이미지만 지원합니다.')
            if opened.width * opened.height > 16_000_000:
                raise ValueError('이미지 해상도는 1,600만 화소 이하여야 합니다.')
            image = ImageOps.exif_transpose(opened).convert('RGBA')
            background = Image.new('RGBA', image.size, 'white')
            image = Image.alpha_composite(background, image).convert('RGB')
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ValueError('해석 가능한 이미지 파일을 등록해 주세요.')
    pixels = list(image.convert('L').resize((32,32), Image.Resampling.LANCZOS).get_flattened_data())
    w = weights()
    horizontal = [[sum(pixels[y*32+x]*w[u][x] for x in range(32)) for u in range(8)] for y in range(32)]
    coefficients = [sum(horizontal[y][u]*w[v][y] for y in range(32)) for v in range(8) for u in range(8)]
    cutoff = median(coefficients[1:])
    phash = ''.join('1' if value > cutoff else '0' for value in coefficients[1:])
    # Flat images produce unstable low-information matches; never flag them by pHash alone.
    average = sum(pixels)/len(pixels)
    informative = sum((value-average)**2 for value in pixels)/len(pixels) > 16
    image.thumbnail((180,180))
    out = io.BytesIO()
    image.save(out, 'PNG')
    return {'sha256':hashlib.sha256(data).hexdigest(), 'phash':phash, 'informative':informative,
            'thumbnail':'data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()}


def similarity(left, right):
    if left['sha256'] == right['sha256']:
        return 100.0, '동일 이미지 파일'
    if not left['informative'] or not right['informative']:
        return None, '특징이 부족한 이미지'
    distance = sum(a != b for a,b in zip(left['phash'],right['phash']))
    return round((1-distance/63)*100, 1), 'pHash 시각적 유사성'


def normalized_link(base, value, origin):
    try:
        target = urldefrag(urljoin(base, value))[0]
        parts = urlsplit(target)
        if parts.scheme not in ('https','http') or parts.username or parts.password or parts.netloc.lower() != origin:
            return None
        if SKIP.search(target):
            return None
        return target
    except (ValueError, TypeError):
        return None


def json_nodes(value):
    if isinstance(value, list):
        for child in value:
            yield from json_nodes(child)
    elif isinstance(value, dict):
        yield value
        for key in ('@graph','itemListElement','item'):
            if key in value:
                yield from json_nodes(value[key])


def parse_listing(html, base, origin, category='전체'):
    soup = BeautifulSoup(html,'html.parser')
    categories, products, next_pages = [], [], []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            nodes = list(json_nodes(json.loads(script.get_text())))
        except (ValueError, TypeError):
            continue
        for node in nodes:
            types = node.get('@type', [])
            types=[types] if isinstance(types,str) else types if isinstance(types,list) else []
            if 'Product' in types:
                url = normalized_link(base,node.get('url') or base,origin)
                if url: products.append({'url':url,'category':str(node.get('category') or category)[:120]})
            elif 'ListItem' in types:
                value = node.get('url') or (node.get('item',{}).get('url') if isinstance(node.get('item'),dict) else node.get('item'))
                url = normalized_link(base,value,origin) if value else None
                if url: products.append({'url':url,'category':category})
    for anchor in soup.select('a[href]'):
        url = normalized_link(base,anchor.get('href'),origin)
        if not url: continue
        label = anchor.get_text(' ',strip=True)[:120] or '카테고리'
        if CATEGORY.search(url) and (not PRODUCT.search(url) or re.search(r'/(?:product|goods)/list',url,re.I)):
            categories.append({'url':url,'name':label})
        elif PRODUCT.search(url):
            products.append({'url':url,'category':category})
        elif anchor.find('img') and url != base and not anchor.find_parent('nav') and not anchor.find_parent('header'):
            products.append({'url':url,'category':category})
        if 'next' in anchor.get('rel',[]): next_pages.append(url)
    return categories, products, next_pages


def product_data(html, base):
    soup = BeautifulSoup(html,'html.parser')
    name = soup.find('meta',property='og:title')
    name = name.get('content') if name else (soup.h1.get_text(' ',strip=True) if soup.h1 else (soup.title.get_text(' ',strip=True) if soup.title else '상품'))
    images, category = [], None
    for script in soup.select('script[type="application/ld+json"]'):
        try: nodes = list(json_nodes(json.loads(script.get_text())))
        except (ValueError,TypeError): continue
        for node in nodes:
            types=node.get('@type',[])
            if 'Product' not in ([types] if isinstance(types,str) else types if isinstance(types,list) else []): continue
            name=node.get('name') or name
            category=node.get('category') or category
            raw=node.get('image',[])
            for value in (raw if isinstance(raw,list) else [raw]):
                source = value.get('url') or value.get('contentUrl') if isinstance(value,dict) else value
                if isinstance(source,str):images.append(urljoin(base,source))
    for tag in soup.select('meta[property="og:image"], img[src], img[data-src]'):
        source=tag.get('content') or tag.get('data-src') or tag.get('src')
        if source and not source.startswith('data:'):
            images.append(urljoin(base,source))
    images=list(dict.fromkeys(value for value in images if urlsplit(value).scheme in ('http','https')))[:3]
    return str(name or '상품')[:300], str(category)[:120] if category else None, images


def start_scan(path, body, fetcher):
    site=urlsplit(body.site_url)
    if site.scheme not in ('https','http') or not site.hostname or site.username or site.password or site.port not in (None,80,443):
        raise ValueError('공개 쇼핑몰의 http 또는 https 주소를 입력해 주세요.')
    references=[]
    for ref in body.references:
        try: raw=base64.b64decode(ref.image,validate=True)
        except ValueError: raise ValueError('권리 기준 이미지 형식이 올바르지 않습니다.')
        references.append({'name':ref.name,**image_features(raw)})
    with CREATE_LOCK:
        with connect(path) as con:
            active=con.execute("SELECT COUNT(*) FROM scans WHERE json_extract(payload, '$.status') IN ('queued','running')").fetchone()[0]
        if active>=2:
            raise ValueError('동시에 2개까지만 점검할 수 있습니다. 진행 중인 점검이 끝난 뒤 다시 시작해 주세요.')
        scan={'id':uuid.uuid4().hex,'created':datetime.now(timezone.utc).isoformat(),'site_url':body.site_url,'status':'queued',
              'stage':'점검 대기','threshold':body.threshold,'references':[{'name':r['name'],'thumbnail':r['thumbnail']} for r in references],
              'counts':{'discovered':0,'checked':0,'candidates':0,'unverified':0},'categories':[],'products':[],
              'warnings':['pHash 점수는 이미지 구조의 유사도이며 침해 확률이 아닙니다. 상표·캐릭터의 의미 인식, 디자인권 범위·판매 허가 확인은 수행하지 않습니다.',
                          f'최대 {body.max_categories}개 카테고리·{body.max_products}개 상품의 제한된 공개 HTML 표본입니다. 전체 쇼핑몰 점검을 보장하지 않습니다.']}
        put_scan(path,scan)
        POOL.submit(run_scan,path,scan['id'],body,references,fetcher)
    return scan


def run_scan(path,scan_id,body,references,fetcher,delay=0.35):
    scan=get_scan(path,scan_id)
    start=time.monotonic()
    origin=urlsplit(body.site_url).netloc.lower()
    robots=None
    budget=0
    def save(stage=None):
        if stage:scan['stage']=stage
        put_scan(path,scan)
    def fetch(url,content='text/html',check_robots=True):
        nonlocal budget
        if time.monotonic()-start>240 or budget>=180:
            raise TimeoutError('수집 시간 또는 요청 수 제한에 도달했습니다.')
        if check_robots and urlsplit(url).netloc.lower()==origin and robots and not robots.can_fetch('IPR-Review',url):
            raise ValueError('robots.txt에서 수집을 허용하지 않는 주소입니다.')
        time.sleep(delay)
        budget+=1
        return fetcher(url,content)
    try:
        scan['status']='running';save('쇼핑몰 수집 정책 확인')
        robots_url=urljoin(body.site_url,'/robots.txt')
        robots=RobotFileParser(robots_url)
        try:
            raw,_,_=fetch(robots_url,'text/',False)
            robots.parse(raw.decode('utf-8',errors='replace').splitlines())
        except ValueError as exc:
            if 'HTTP 404' not in str(exc):raise ValueError('robots.txt 확인에 실패해 수집을 중단했습니다. '+str(exc))
            robots.parse([])
        crawl_delay=robots.crawl_delay('IPR-Review') or 0
        request_rate=robots.request_rate('IPR-Review')
        if request_rate and request_rate.requests:
            crawl_delay=max(crawl_delay,request_rate.seconds/request_rate.requests)
        delay=max(delay,crawl_delay)
        if delay>30:
            raise ValueError('robots.txt의 요청 간격이 30초를 초과해 자동 점검을 중단했습니다.')
        if not robots.can_fetch('IPR-Review',body.site_url):
            raise ValueError('이 쇼핑몰은 robots.txt에서 수집을 허용하지 않습니다.')
        html,_,base=fetch(body.site_url)
        if urlsplit(base).netloc.lower()!=origin:
            raise ValueError('쇼핑몰이 다른 도메인으로 이동했습니다. 이동 후의 주소를 입력해 주세요.')
        categories,products,_=parse_listing(html,base,origin)
        unique_categories={}
        for category in categories:
            unique_categories.setdefault(category['url'],category)
        queue=list(unique_categories.values())[:body.max_categories]
        visited={base}
        scan['categories']=[{'name':c['name'],'url':c['url']} for c in queue]
        save('카테고리별 상품 주소 수집')
        pages=0
        while queue and pages<body.max_categories*2:
            cat=queue.pop(0)
            if cat['url'] in visited:continue
            visited.add(cat['url']);pages+=1
            try:
                data,_,final=fetch(cat['url'])
                if urlsplit(final).netloc.lower()!=origin:continue
                _,found,next_pages=parse_listing(data,final,origin,cat['name'])
                products.extend(found)
                queue.extend({'url':url,'name':cat['name']} for url in next_pages[:1] if url not in visited)
            except TimeoutError:raise
            except Exception:
                scan['warnings'].append(f"카테고리 수집 실패: {cat['name']}. 이 범위는 미점검입니다.")
        if not products:
            save('사이트맵에서 상품 주소 탐색')
            sitemap_urls=[urljoin(body.site_url,'/sitemap.xml')]
            seen_maps=set()
            for _ in range(3):
                if not sitemap_urls:break
                target=sitemap_urls.pop(0)
                if target in seen_maps:continue
                seen_maps.add(target)
                try:
                    data,_,_=fetch(target,'xml')
                    if b'<!DOCTYPE' in data.upper():continue
                    root=ElementTree.fromstring(data)
                    for element in root.iter():
                        if element.tag.rsplit('}',1)[-1]!='loc':continue
                        url=normalized_link(target,element.text or '',origin)
                        if not url:continue
                        if urlsplit(url).path.endswith('.xml'):sitemap_urls.append(url)
                        elif PRODUCT.search(url):products.append({'url':url,'category':'사이트맵'})
                except TimeoutError:raise
                except Exception:scan['warnings'].append('사이트맵 일부를 읽지 못했습니다.')
        # Prefer category-specific discovery over homepage's generic labels.
        unique={}
        for product in products:
            if product['url'] not in unique or product['category']!='전체':unique[product['url']]=product
        scan['counts']['discovered']=len(unique)
        targets=list(unique.values())[:body.max_products]
        if not targets:
            raise ValueError('지원되는 공개 상품 링크를 찾지 못했습니다. 동적·로그인 쇼핑몰은 전용 연동이 필요합니다.')
        for index,item in enumerate(targets):
            save(f"상품 이미지 점검 {index+1}/{len(targets)}")
            product={'url':item['url'],'name':'상품','category':item['category'],'thumbnail':'','state':'unverified','score':None,'reference_name':'','reason':'','checked_images':0,'errors':[]}
            try:
                data,_,final=fetch(item['url'])
                if urlsplit(final).netloc.lower()!=origin:raise ValueError('다른 도메인으로 이동한 상품입니다.')
                name,category,images=product_data(data,final)
                product.update(name=name,category=category or item['category'])
                best=None
                for image_url in images:
                    try:
                        raw,_,_=fetch(image_url,'image/')
                        features=image_features(raw)
                        product['checked_images']+=1
                        if not product['thumbnail']:product['thumbnail']=features['thumbnail']
                        for reference in references:
                            score,reason=similarity(features,reference)
                            if score is not None and (best is None or score>best[0]):
                                best=(score,reason,reference['name'],features['thumbnail'],image_url)
                    except TimeoutError:raise
                    except Exception:product['errors'].append('상품 이미지 하나를 읽지 못했습니다.')
                if best:
                    score,reason,ref_name,thumb,image_url=best
                    product.update(score=score,reference_name=ref_name,reason=reason,thumbnail=thumb,image_url=image_url,
                                   state='candidate' if score>=body.threshold else ('partial' if product['errors'] else 'below_threshold'))
                elif product['checked_images']:
                    product['errors'].append('이미지 특징이 부족해 유사도를 산정하지 못했습니다.')
                else:product['errors'].append('비교 가능한 상품 이미지가 없습니다.')
            except TimeoutError:raise
            except Exception as exc:
                product['errors'].append(str(exc) if isinstance(exc,ValueError) else '상품 페이지 수집에 실패했습니다.')
            scan['products'].append(product)
            scan['counts']['checked']+=1
            scan['counts']['candidates']+=product['state']=='candidate'
            scan['counts']['unverified']+=bool(product['errors']) or product['state'] in ('unverified','partial')
            save()
        scan.update(status='complete',stage='제한된 범위의 자동 점검 완료')
    except Exception as exc:
        scan.update(status='failed',stage=str(exc) if isinstance(exc,(ValueError,TimeoutError)) else '네트워크 또는 이미지 처리 오류로 점검이 중단되었습니다.')
    finally:
        scan['request_count']=budget
        scan['products'].sort(key=lambda item: (item['state']=='candidate',item['score'] if item['score'] is not None else -1),reverse=True)
        save()
